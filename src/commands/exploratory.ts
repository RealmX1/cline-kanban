import { readFile } from "node:fs/promises";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import type {
	RuntimeIngestExploratorySessionMapUpdateRequest,
	RuntimeIngestExploratorySessionMapUpdateResponse,
} from "../core/api-contract";
import { mergeAbortSignals } from "../core/cli-process-guards";
import { buildKanbanRuntimeUrl, getRuntimeFetch } from "../core/runtime-endpoint";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext } from "../state/workspace-state";
import { KANBAN_HOOK_TASK_ID_ENV, KANBAN_HOOK_WORKSPACE_ID_ENV } from "../terminal/hook-runtime-context";
import type { RuntimeAppRouter } from "../trpc/app-router";
import { deliverHookIngestWithRetry } from "./hooks";

// Exploratory Mode（蓝图 .plan/docs/exploratory-mode-session-map-and-findings-store.md §B.2）：
// agent 写回 session map 的 CLI 通道。读-改-写协议 = get-session-map 拿现状集合 + 投影签名，
// 再 ingest-map-update 提交整份修订提案，过服务端 apply 漏斗。
//
// 与 hooks ingest 的关键差异：exploratory.* / conversationTree.* 都是 workspaceProcedure，
// workspace scope 走 `x-kanban-workspace-id` 请求头（hooks.ingest 是 input 带 workspaceId 的
// plain procedure，形态不同，不能照抄）。

interface ExploratoryScopeOptions {
	task?: string;
	workspaceId?: string;
	projectPath?: string;
}

export interface ExploratoryCommandScope {
	taskId: string;
	workspaceId: string;
}

function formatError(error: unknown): string {
	if (error instanceof TRPCClientError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function readTrimmedValue(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

// 单任务作用域纪律（蓝图风险 6）：flag 与 env 同时存在且不一致 → 硬报错，绝不静默选边。
function resolveScopedValue(input: {
	flagValue: string | undefined;
	envValue: string | null;
	flagName: string;
	envName: string;
}): string | null {
	const flagValue = readTrimmedValue(input.flagValue);
	if (flagValue && input.envValue && flagValue !== input.envValue) {
		throw new Error(
			`${input.flagName} ("${flagValue}") conflicts with environment variable ${input.envName} ("${input.envValue}"). ` +
				"Refusing to pick one silently — fix one of them.",
		);
	}
	return flagValue ?? input.envValue;
}

// --project-path → workspaceId：镜像 task.ts 的 resolveRuntimeWorkspace（同一对
// resolveProjectInputPath + loadWorkspaceContext 助手、同一主仓路径语义——从 worktree 发起时
// 按 `kanban task` 系列同款约定由调用方传主仓路径，本层不发明第二套 worktree 翻译）。唯一差别：
// autoCreateIfMissing 恒 false——会话本来就跑在已注册 workspace 里，CLI 不得顺手注册；
// 未注册时 loadWorkspaceContext 抛出的「not added to Kanban yet」原样上抛。
export async function resolveExploratoryWorkspaceIdForProjectPath(projectPath: string, cwd: string): Promise<string> {
	const workspace = await loadWorkspaceContext(resolveProjectInputPath(projectPath, cwd), {
		autoCreateIfMissing: false,
	});
	return workspace.workspaceId;
}

// workspace 三来源的纯函数层：--workspace-id flag > --project-path（解析结果）> env。
// 任意两个来源同时存在且值不一致 → 硬报错，绝不静默选边（与 task 的 flag/env mismatch 同纪律，
// 蓝图风险 6）。candidates 的顺序即优先级——只在「其余来源缺省」时体现为兜底序。
export function resolveExploratoryWorkspaceId(sources: {
	flagValue: string | null;
	projectPathWorkspaceId: string | null;
	envValue: string | null;
}): string {
	const candidates: Array<{ label: string; value: string }> = [];
	if (sources.flagValue) {
		candidates.push({ label: "--workspace-id", value: sources.flagValue });
	}
	if (sources.projectPathWorkspaceId) {
		candidates.push({ label: "--project-path (resolved workspace)", value: sources.projectPathWorkspaceId });
	}
	if (sources.envValue) {
		candidates.push({ label: `environment variable ${KANBAN_HOOK_WORKSPACE_ID_ENV}`, value: sources.envValue });
	}
	const [highestPriority, ...rest] = candidates;
	if (!highestPriority) {
		throw new Error(
			`Missing workspace id. Pass --workspace-id <id>, --project-path <path>, or set ${KANBAN_HOOK_WORKSPACE_ID_ENV}.`,
		);
	}
	for (const candidate of rest) {
		if (candidate.value !== highestPriority.value) {
			throw new Error(
				`${highestPriority.label} ("${highestPriority.value}") conflicts with ${candidate.label} ("${candidate.value}"). ` +
					"Refusing to pick one silently — fix one of them.",
			);
		}
	}
	return highestPriority.value;
}

// task：--task flag > env > 报错（文案同时提示 --task 与 env 两种补法）。
// workspace：--workspace-id flag > --project-path > env > 报错。env 直读 process.env（不解构）——
// parseHookRuntimeContextFromEnv 缺变量即抛，给不了「flag 兜底 env」所需的软读取。
// resolveWorkspaceIdForProjectPath 可注入（单测不碰真实 workspace 索引）；缺省走真实解析，
// cwd 取进程工作目录（与 task.ts 的 resolveRuntimeWorkspace 相同）。
export async function resolveExploratoryCommandScope(
	options: ExploratoryScopeOptions,
	env: NodeJS.ProcessEnv = process.env,
	resolveWorkspaceIdForProjectPath?: (projectPath: string) => Promise<string>,
): Promise<ExploratoryCommandScope> {
	const taskId = resolveScopedValue({
		flagValue: options.task,
		envValue: readTrimmedValue(env[KANBAN_HOOK_TASK_ID_ENV]),
		flagName: "--task",
		envName: KANBAN_HOOK_TASK_ID_ENV,
	});
	if (!taskId) {
		throw new Error(`Missing task id. Pass --task <taskId> or set ${KANBAN_HOOK_TASK_ID_ENV}.`);
	}
	const projectPath = readTrimmedValue(options.projectPath);
	let projectPathWorkspaceId: string | null = null;
	if (projectPath) {
		const resolveProjectPath =
			resolveWorkspaceIdForProjectPath ??
			((path: string) => resolveExploratoryWorkspaceIdForProjectPath(path, process.cwd()));
		projectPathWorkspaceId = await resolveProjectPath(projectPath);
	}
	const workspaceId = resolveExploratoryWorkspaceId({
		flagValue: readTrimmedValue(options.workspaceId),
		projectPathWorkspaceId,
		envValue: readTrimmedValue(env[KANBAN_HOOK_WORKSPACE_ID_ENV]),
	});
	return { taskId, workspaceId };
}

// ---- --payload 三形态 ----

export type ExploratoryPayloadSource =
	| { kind: "inline"; text: string }
	| { kind: "file"; path: string }
	| { kind: "stdin" };

// 内联 JSON 字符串；`@<path>` 读文件；`-` 读 stdin（agent 产长 JSON 的安全路径，免 shell 转义）。
export function resolveExploratoryPayloadSource(payloadArg: string): ExploratoryPayloadSource {
	if (payloadArg === "-") {
		return { kind: "stdin" };
	}
	if (payloadArg.startsWith("@")) {
		const path = payloadArg.slice(1).trim();
		if (!path) {
			throw new Error('Payload file reference "@" is missing a path. Use "@<path>", inline JSON, or "-".');
		}
		return { kind: "file", path };
	}
	return { kind: "inline", text: payloadArg };
}

// 镜像 hooks.ts 的私有 readStdinText（未导出）：TTY 时立即返空，避免悬挂等输入。
async function readStdinText(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return chunks.join("");
}

export async function readExploratoryPayloadText(
	payloadArg: string,
	readStdin: () => Promise<string> = readStdinText,
): Promise<string> {
	const source = resolveExploratoryPayloadSource(payloadArg);
	if (source.kind === "inline") {
		return source.text;
	}
	if (source.kind === "file") {
		try {
			return await readFile(source.path, "utf8");
		} catch (error) {
			throw new Error(`Could not read payload file "${source.path}": ${formatError(error)}`);
		}
	}
	return await readStdin();
}

// ---- payload 廉价校验 ----

// 只锁白名单三键的形状；节点级完整校验（含 referencedFindingId 配对 superRefine、长度/数量上限）
// 交给服务端 schema——它的 TRPCClientError message 会原样透传到 stderr。
export interface ExploratoryMapUpdatePayload {
	clientProposalId: string;
	sourceTurnProjectionSignature: string;
	nodes: unknown[];
}

export function parseExploratoryMapUpdatePayload(payloadText: string): ExploratoryMapUpdatePayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadText);
	} catch (error) {
		throw new Error(`Payload is not valid JSON: ${formatError(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Payload must be a JSON object with clientProposalId, sourceTurnProjectionSignature, and nodes.");
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.clientProposalId !== "string" || record.clientProposalId.trim().length === 0) {
		throw new Error('Payload is missing required string field "clientProposalId".');
	}
	if (
		typeof record.sourceTurnProjectionSignature !== "string" ||
		record.sourceTurnProjectionSignature.trim().length === 0
	) {
		throw new Error('Payload is missing required string field "sourceTurnProjectionSignature".');
	}
	if (!Array.isArray(record.nodes)) {
		throw new Error('Payload field "nodes" must be an array of map node proposals.');
	}
	return {
		clientProposalId: record.clientProposalId,
		sourceTurnProjectionSignature: record.sourceTurnProjectionSignature,
		nodes: record.nodes,
	};
}

// ---- 投递骨架 ----

// 超时/重试三件套镜像 hooks.ts 的 F2 私有常量（DEFAULT_HOOK_INGEST_TIMEOUT_MS /
// HOOK_INGEST_MAX_ATTEMPTS / HOOK_INGEST_RETRY_BACKOFF_MS）——hooks.ts 未导出它们，
// 蓝图「代码事实 6」指定的复用对象是 deliverHookIngestWithRetry 骨架本身，数值在此按同款镜像。
const DEFAULT_EXPLORATORY_INGEST_TIMEOUT_MS = 3500;
const EXPLORATORY_INGEST_MAX_ATTEMPTS = 2;
const EXPLORATORY_INGEST_RETRY_BACKOFF_MS = 250;

// 镜像 hooks.ts 的私有 resolveHookIngestTimeoutMs：同一个 env 变量、同一套解析回落。
function resolveExploratoryIngestTimeoutMs(): number {
	const raw = process.env.KANBAN_HOOK_INGEST_TIMEOUT_MS;
	if (raw === undefined) {
		return DEFAULT_EXPLORATORY_INGEST_TIMEOUT_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_EXPLORATORY_INGEST_TIMEOUT_MS;
	}
	return parsed;
}

// 镜像 hooks.ts 的 ingestHookEvent：createTRPCProxyClient + httpBatchLink +
// buildKanbanRuntimeUrl("/api/trpc") + getRuntimeFetch + mergeAbortSignals，
// 外加 workspaceProcedure 要求的 scope 请求头。
function createExploratoryTrpcClient(workspaceId: string, deliverySignal?: AbortSignal) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				maxItems: 1,
				headers: () => ({ "x-kanban-workspace-id": workspaceId }),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					const mergedSignal = mergeAbortSignals(deliverySignal, options?.signal);
					return runtimeFetch(url, { ...options, signal: mergedSignal });
				},
			}),
		],
	});
}

// deliverHookIngestWithRetry 的判定面锁在 RuntimeHookIngestResponse（{ok, error?}）上，
// 这里用闭包暂存真实响应，把 exploratory mutation 的结果适配成它的两态：
//   - mutation resolve → 投递成功（applied true/false 都算——rejectionReason 是给 agent 的
//     业务信息，两者退出码都为 0）；
//   - TRPCClientError（daemon 可达但 schema/procedure 拒绝）→ {ok:false} 业务拒绝：
//     骨架立即抛、不重试，message 由调用方透传 stderr；
//   - 其它抛出（超时 / daemon 不可达）→ 传输故障，走骨架的有界重试。
export async function deliverExploratorySessionMapUpdate(
	mutate: (signal: AbortSignal) => Promise<RuntimeIngestExploratorySessionMapUpdateResponse>,
	options: { timeoutMs: number; maxAttempts: number; backoffMs: number },
): Promise<RuntimeIngestExploratorySessionMapUpdateResponse> {
	let delivered: RuntimeIngestExploratorySessionMapUpdateResponse | null = null;
	await deliverHookIngestWithRetry(async (signal) => {
		try {
			delivered = await mutate(signal);
			return { ok: true };
		} catch (error) {
			if (error instanceof TRPCClientError) {
				return { ok: false, error: formatError(error) };
			}
			throw error;
		}
	}, options);
	if (!delivered) {
		// 不可达（mutation resolve 必先赋值）；满足 TS 控制流分析的兜底。
		throw new Error("ingestSessionMapUpdate resolved without a response.");
	}
	return delivered;
}

async function ingestSessionMapUpdate(
	scope: ExploratoryCommandScope,
	payload: ExploratoryMapUpdatePayload,
): Promise<RuntimeIngestExploratorySessionMapUpdateResponse> {
	const request: RuntimeIngestExploratorySessionMapUpdateRequest = {
		conversationSessionTaskId: scope.taskId,
		clientProposalId: payload.clientProposalId,
		sourceTurnProjectionSignature: payload.sourceTurnProjectionSignature,
		// 节点形状按契约类型断言——完整校验刻意留给服务端 schema（见 parseExploratoryMapUpdatePayload）。
		nodes: payload.nodes as RuntimeIngestExploratorySessionMapUpdateRequest["nodes"],
	};
	return await deliverExploratorySessionMapUpdate(
		async (signal) => {
			const trpcClient = createExploratoryTrpcClient(scope.workspaceId, signal);
			return await trpcClient.exploratory.ingestSessionMapUpdate.mutate(request);
		},
		{
			timeoutMs: resolveExploratoryIngestTimeoutMs(),
			maxAttempts: EXPLORATORY_INGEST_MAX_ATTEMPTS,
			backoffMs: EXPLORATORY_INGEST_RETRY_BACKOFF_MS,
		},
	);
}

// ---- 子命令实现 ----

async function runGetSessionMap(options: ExploratoryScopeOptions): Promise<void> {
	let scope: ExploratoryCommandScope;
	try {
		scope = await resolveExploratoryCommandScope(options);
	} catch (error) {
		process.stderr.write(`kanban exploratory get-session-map: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		// 一个 client 依次调两个 query：agent 的读-改-写协议要「现状集合 + 当前投影签名」一次拿到。
		const trpcClient = createExploratoryTrpcClient(scope.workspaceId);
		const mapResponse = await trpcClient.exploratory.getSessionMap.query({
			conversationSessionTaskId: scope.taskId,
		});
		const projection = await trpcClient.conversationTree.getConversationSessionTurnProjection.query({
			conversationSessionTaskId: scope.taskId,
		});
		// harnessSource=unavailable_live_terminal_pty 时照常输出（mapCollection 多为 null）——
		// agent 据此判断本会话不可写 map。
		process.stdout.write(
			`${JSON.stringify({
				mapCollection: mapResponse.mapCollection,
				harnessSource: projection.harnessSource,
				turnProjectionSignature: projection.turnProjectionSignature,
				latestTurnNumber: projection.turnProjectionEntries.at(-1)?.turnNumber ?? 0,
			})}\n`,
		);
	} catch (error) {
		process.stderr.write(`kanban exploratory get-session-map: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

async function runIngestMapUpdate(options: ExploratoryScopeOptions & { payload: string }): Promise<void> {
	let scope: ExploratoryCommandScope;
	let payload: ExploratoryMapUpdatePayload;
	try {
		scope = await resolveExploratoryCommandScope(options);
		payload = parseExploratoryMapUpdatePayload(await readExploratoryPayloadText(options.payload));
	} catch (error) {
		process.stderr.write(`kanban exploratory ingest-map-update: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		const response = await ingestSessionMapUpdate(scope, payload);
		// applied=false 时 rejectionReason 必在输出 JSON 里（schema 保证非 null）。
		process.stdout.write(`${JSON.stringify(response)}\n`);
	} catch (error) {
		process.stderr.write(`kanban exploratory ingest-map-update: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

export function registerExploratoryCommand(program: Command): void {
	const exploratory = program
		.command("exploratory")
		.description("Exploratory Mode session map helpers for agent integrations.");

	exploratory
		.command("get-session-map")
		.description("Print the session map collection and turn projection signature as a single JSON object.")
		.option("--task <taskId>", `Conversation session task id (defaults to ${KANBAN_HOOK_TASK_ID_ENV}).`)
		.option("--workspace-id <id>", `Workspace id (defaults to --project-path, then ${KANBAN_HOOK_WORKSPACE_ID_ENV}).`)
		.option(
			"--project-path <path>",
			"Resolve workspace from a registered project path (pass the main repo path when invoking from a task worktree).",
		)
		.action(async (options: ExploratoryScopeOptions) => {
			await runGetSessionMap(options);
		});

	exploratory
		.command("ingest-map-update")
		.description("Deliver a whole-map revision proposal to the runtime apply funnel.")
		.option("--task <taskId>", `Conversation session task id (defaults to ${KANBAN_HOOK_TASK_ID_ENV}).`)
		.option("--workspace-id <id>", `Workspace id (defaults to --project-path, then ${KANBAN_HOOK_WORKSPACE_ID_ENV}).`)
		.option(
			"--project-path <path>",
			"Resolve workspace from a registered project path (pass the main repo path when invoking from a task worktree).",
		)
		.requiredOption(
			"--payload <json>",
			'Map update payload: inline JSON string, "@<path>" to read a file, or "-" to read stdin.',
		)
		.action(async (options: ExploratoryScopeOptions & { payload: string }) => {
			await runIngestMapUpdate(options);
		});
}
