import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
	lockedFileSystem,
} from "../fs/locked-file-system";
import { resolveGlobalKimiCodeHome } from "./kimi-hook-config";
import { stripAnsi } from "./output-utils";

const KIMI_MANAGED_PROVIDER_ID = "managed:kimi-code";
const KIMI_MODEL_CATALOG_REFRESH_TIMEOUT_MS = 45_000;

const kimiServerModelCatalogItemSchema = z.object({
	provider: z.string().min(1),
	model: z.string().min(1),
	display_name: z.string().optional(),
	max_context_size: z.number().int().positive(),
});

export type KimiServerModelCatalogItem = z.infer<typeof kimiServerModelCatalogItemSchema>;

class KimiManagedModelSelectionError extends Error {}

/** 只接受官方稳定标准/Pro 产品；版本、Pro 档与上下文依次排序，目录顺序不参与决策。 */
export function selectLatestKimiManagedStableModel(
	items: readonly KimiServerModelCatalogItem[],
): KimiServerModelCatalogItem {
	const candidates = items.flatMap((item) => {
		const match = item.model.match(/^kimi-code\/k(\d+(?:\.\d+)*)(-pro)?(?:-\d+k)?$/i);
		if (
			item.provider !== KIMI_MANAGED_PROVIDER_ID ||
			!match ||
			/highspeed|preview/i.test(item.display_name ?? "") ||
			!Number.isSafeInteger(item.max_context_size) ||
			item.max_context_size <= 0
		) {
			return [];
		}
		return [{ item, version: match[1].split(".").map(BigInt), isPro: Boolean(match[2]) }];
	});
	candidates.sort((left, right) => {
		for (let index = 0; index < Math.max(left.version.length, right.version.length); index += 1) {
			const leftSegment = left.version[index] ?? 0n;
			const rightSegment = right.version[index] ?? 0n;
			if (leftSegment !== rightSegment) return leftSegment > rightSegment ? -1 : 1;
		}
		return (
			Number(right.isPro) - Number(left.isPro) ||
			right.item.max_context_size - left.item.max_context_size ||
			left.item.model.localeCompare(right.item.model)
		);
	});
	const selected = candidates[0]?.item;
	if (!selected) throw new KimiManagedModelSelectionError("Kimi 官方目录没有可选择的稳定标准/Pro 模型。");
	return selected;
}

/**
 * 使用 Kimi 自己的 loopback API 刷新 OAuth 目录。每次启动重新读取，不把旧目录或旧默认值用作兜底。
 * 服务原始输出和认证 token 只在内存中消费，任何错误均不携带上游正文或凭证。
 */
export async function loadRefreshedKimiManagedModelCatalog(
	options: { binary?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<KimiServerModelCatalogItem[]> {
	const env = options.env ?? process.env;
	const abortController = new AbortController();
	const timeoutMs = options.timeoutMs ?? KIMI_MODEL_CATALOG_REFRESH_TIMEOUT_MS;
	const timeout = setTimeout(() => abortController.abort(), timeoutMs);
	try {
		// 锁随 home 落盘，覆盖多个 Kanban runtime；服务退出前不得释放，避免 server.token 被相互覆盖。
		return await lockedFileSystem.withLock(
			{
				path: resolveGlobalKimiCodeHome(env),
				type: "directory",
				lockfileName: ".kanban-kimi-model-catalog-refresh.lock",
				retries: {
					...DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD,
					retries: Math.ceil(
						timeoutMs / DEFAULT_LOCK_ACQUISITION_RETRY_SCHEDULE_COVERING_STALE_THRESHOLD.minTimeout,
					),
					maxRetryTime: timeoutMs,
				},
				onCompromised: () =>
					abortController.abort(new KimiManagedModelSelectionError("Kimi 模型目录刷新互斥锁已失效。")),
			},
			async () =>
				await loadRefreshedKimiManagedModelCatalogWithHomeRefreshLockHeld(
					options.binary ?? "kimi",
					env,
					abortController.signal,
				),
		);
	} catch (error) {
		if (abortController.signal.reason instanceof KimiManagedModelSelectionError) {
			throw abortController.signal.reason;
		}
		if (error instanceof KimiManagedModelSelectionError) throw error;
		throw new KimiManagedModelSelectionError(
			abortController.signal.aborted
				? "Kimi 模型目录刷新超时。"
				: "Kimi 模型目录读取失败，请检查 Kimi CLI 与登录状态。",
		);
	} finally {
		clearTimeout(timeout);
	}
}

async function loadRefreshedKimiManagedModelCatalogWithHomeRefreshLockHeld(
	binary: string,
	env: NodeJS.ProcessEnv,
	abortSignal: AbortSignal,
): Promise<KimiServerModelCatalogItem[]> {
	const serviceWorkingDirectory = await mkdtemp(join(tmpdir(), "kanban-kimi-model-catalog-"));
	try {
		// 等锁与刷新共享总预算；晚于超时取得锁时也绝不再启动子服务。
		abortSignal.throwIfAborted();
		const child = spawn(binary, ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"], {
			cwd: serviceWorkingDirectory,
			env: { ...env, KIMI_CLI_NO_AUTO_UPDATE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stopped = new Promise<void>((resolve) => {
			child.once("close", () => resolve());
			child.once("error", () => resolve());
		});
		try {
			const baseUrl = await new Promise<string>((resolve, reject) => {
				let output = "";
				const cleanupListeners = () => {
					child.stdout.off("data", consumeOutput);
					child.stderr.off("data", consumeOutput);
					child.stdout.resume();
					child.stderr.resume();
					child.off("error", fail);
					child.off("close", fail);
					abortSignal.removeEventListener("abort", fail);
				};
				const fail = () => {
					cleanupListeners();
					reject(new KimiManagedModelSelectionError("Kimi 本地模型服务未能就绪，可能已退出或刷新超时。"));
				};
				const consumeOutput = (chunk: string) => {
					// 按 chunk 累积，兼容 ANSI、多行 banner 与跨 chunk 的 URL；不要混用 readline 与 fd readiness。
					output = (output + chunk).slice(-65_536);
					const match = stripAnsi(output).match(/http:\/\/127\.0\.0\.1:(\d+)\//);
					if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535) return;
					cleanupListeners();
					resolve(`http://127.0.0.1:${match[1]}`);
				};
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", consumeOutput);
				child.stderr.on("data", consumeOutput);
				child.once("error", fail);
				child.once("close", fail);
				abortSignal.addEventListener("abort", fail, { once: true });
				if (abortSignal.aborted) fail();
			});
			const token = (await readFile(join(resolveGlobalKimiCodeHome(env), "server.token"), "utf8")).trim();
			if (!token) throw new KimiManagedModelSelectionError("Kimi 本地模型服务未提供认证 token。");
			const request = async (path: string, method = "GET"): Promise<unknown> => {
				const response = await fetch(`${baseUrl}${path}`, {
					method,
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					...(method === "POST" ? { body: "{}" } : {}),
					signal: abortSignal,
					redirect: "error",
				});
				if (!response.ok) throw new KimiManagedModelSelectionError(`Kimi 模型接口 HTTP ${response.status}。`);
				const envelope = z.object({ code: z.literal(0), data: z.unknown() }).safeParse(await response.json());
				if (!envelope.success) throw new KimiManagedModelSelectionError("Kimi 模型接口返回失败或非法响应。");
				return envelope.data.data;
			};
			const refresh = z
				.object({
					changed: z.array(z.union([z.string(), z.object({ provider_id: z.string() })])),
					unchanged: z.array(z.string()),
					failed: z.array(z.unknown()).max(0),
				})
				.safeParse(await request("/api/v1/providers:refresh_oauth", "POST"));
			if (
				!refresh.success ||
				![
					...refresh.data.changed.map((provider) =>
						typeof provider === "string" ? provider : provider.provider_id,
					),
					...refresh.data.unchanged,
				].includes(KIMI_MANAGED_PROVIDER_ID)
			) {
				throw new KimiManagedModelSelectionError("Kimi 官方 OAuth 模型目录刷新失败，无法选择新会话默认模型。");
			}
			const catalog = z
				.object({ items: z.array(kimiServerModelCatalogItemSchema) })
				.safeParse(await request("/api/v1/models"));
			if (
				!catalog.success ||
				new Set(catalog.data.items.map((item) => item.model)).size !== catalog.data.items.length
			) {
				throw new KimiManagedModelSelectionError("Kimi 模型目录格式非法或包含重复模型。");
			}
			return catalog.data.items;
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
			try {
				await stopped;
			} finally {
				clearTimeout(forceKill);
			}
		}
	} finally {
		await rm(serviceWorkingDirectory, { recursive: true, force: true });
	}
}

export async function resolveKimiLaunchDefaultModelId(
	options: Parameters<typeof loadRefreshedKimiManagedModelCatalog>[0] = {},
): Promise<string> {
	return selectLatestKimiManagedStableModel(await loadRefreshedKimiManagedModelCatalog(options)).model;
}
