import { spawn } from "node:child_process";
import { appendFileSync, closeSync, constants, fsyncSync, openSync } from "node:fs";
import { copyFile, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import {
	type CodexAppServerRequestPort,
	readCodexConversationTurns,
	verifyRestoredCodexConversationPrefix,
} from "../../src/codex-native-session-protocol/codex-native-conversation-history";
import { fingerprint, frozenNativeHistorySchema, summarizeNewTurnUsage } from "./experiment-contract";
import { batchManifestSchema, verifyFrozenBatch } from "./frozen-source-snapshot";
import {
	createOwnedModelEndpointProxySandboxRule,
	prepareProcessIsolation,
	probeProcessIsolation,
} from "./macos-experiment-process-isolation";
import {
	type ApprovedModelEndpoint,
	approvedModelEndpointSchema,
	startModelEndpointEgressProxy,
} from "./model-endpoint-egress-proxy";
import {
	assertOwnedExperimentRoot,
	createPrivateDirectory,
	isolatedProcessEnvironment,
	isWithin,
	readJson,
	withExperimentOperationLease,
	writeDurableJson,
} from "./persistent-experiment-storage";

const frameSchema = z
	.object({
		id: z.union([z.string(), z.number()]).optional(),
		method: z.string().optional(),
		params: z.record(z.string(), z.unknown()).optional(),
		result: z.unknown().optional(),
		error: z.unknown().optional(),
	})
	.passthrough();
export type NativeProtocolFrame = z.infer<typeof frameSchema>;

export async function createIsolatedNativeClient(input: {
	binary: string;
	cwd: string;
	profilePath: string;
	environment: NodeJS.ProcessEnv;
	evidenceDirectory: string;
	modelEndpoints?: ApprovedModelEndpoint[];
}) {
	await createPrivateDirectory(input.evidenceDirectory);
	const journal = openSync(join(input.evidenceDirectory, "native-protocol.jsonl"), "a", 0o600);
	let stderr: number;
	try {
		stderr = openSync(join(input.evidenceDirectory, "native-stderr.log"), "a", 0o600);
	} catch (error) {
		closeSync(journal);
		throw error;
	}
	let modelProxy: Awaited<ReturnType<typeof startModelEndpointEgressProxy>> | undefined;
	let profilePath = input.profilePath;
	let environment = input.environment;
	try {
		modelProxy = input.modelEndpoints?.length
			? await startModelEndpointEgressProxy(input.modelEndpoints, input.evidenceDirectory)
			: undefined;
		if (modelProxy) {
			profilePath = join(input.evidenceDirectory, `native-model-proxy-${modelProxy.port}-sandbox.sb`);
			await writeFile(
				profilePath,
				(await readFile(input.profilePath, "utf8")) + createOwnedModelEndpointProxySandboxRule(modelProxy.port),
				{ mode: 0o600 },
			);
			const proxyUrl = `http://127.0.0.1:${modelProxy.port}`;
			environment = {
				...input.environment,
				HTTP_PROXY: proxyUrl,
				HTTPS_PROXY: proxyUrl,
				http_proxy: proxyUrl,
				https_proxy: proxyUrl,
				NO_PROXY: "",
				no_proxy: "",
			};
		}
	} catch (error) {
		closeSync(journal);
		closeSync(stderr);
		await modelProxy?.close();
		throw error;
	}
	const frames: NativeProtocolFrame[] = [];
	const pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	let sequence = 0;
	let closed = false;
	const child = spawn(
		"/usr/bin/sandbox-exec",
		["-f", profilePath, input.binary, "app-server", "--listen", "stdio://"],
		{
			cwd: input.cwd,
			env: environment,
			detached: true,
			stdio: ["pipe", "pipe", stderr],
		},
	);
	const stdin = child.stdin;
	const stdout = child.stdout;
	if (!stdin || !stdout) {
		child.kill("SIGKILL");
		closeSync(journal);
		closeSync(stderr);
		await modelProxy?.close();
		throw new Error("原生连接没有建立管道");
	}
	const record = (direction: string, frame: unknown) => {
		appendFileSync(journal, `${JSON.stringify({ recordedAt: Date.now(), direction, frame })}\n`);
		fsyncSync(journal);
	};
	const send = (frame: unknown) => {
		record("sent", frame);
		stdin.write(`${JSON.stringify(frame)}\n`);
	};
	const rejectAll = (error: Error) => {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	};
	const lines = createInterface({ input: stdout });
	lines.on("line", (line) => {
		let frame: NativeProtocolFrame;
		try {
			frame = frameSchema.parse(JSON.parse(line));
		} catch {
			record("invalid", line);
			return;
		}
		record("received", frame);
		frames.push(frame);
		const request = pending.get(String(frame.id));
		if (request) {
			pending.delete(String(frame.id));
			clearTimeout(request.timer);
			if (frame.error) request.reject(new Error(`原生请求被拒：${JSON.stringify(frame.error)}`));
			else request.resolve(frame.result);
		} else if (frame.id !== undefined && frame.method)
			send({ id: frame.id, error: { code: -32601, message: "实验不允许外部审批、问答或扩展工具" } });
	});
	child.on("error", (error) => rejectAll(error));
	stdin.on("error", (error) => rejectAll(error));
	child.once("close", () => {
		closed = true;
		rejectAll(new Error("隔离原生进程已退出，先对账再重试"));
	});
	const client = {
		frames,
		async request(method: string, params: Record<string, unknown>): Promise<unknown> {
			if (closed) throw new Error("原生进程已退出");
			return await new Promise((resolveRequest, reject) => {
				const id = `${process.pid}-${++sequence}`;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`原生请求超时：${method}`));
				}, 60_000);
				pending.set(id, { resolve: resolveRequest, reject, timer });
				send({ id, method, params });
			});
		},
		async waitForTurn(threadId: string, turnId: string, timeoutMs: number | null) {
			const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
			while (deadline === null || Date.now() < deadline) {
				const result = [...frames]
					.reverse()
					.find(
						(frame) =>
							frame.method === "turn/completed" &&
							frame.params?.threadId === threadId &&
							z.object({ id: z.string() }).safeParse(frame.params.turn).data?.id === turnId,
					);
				if (result) return result;
				if (closed) throw new Error("回合结束前原生进程退出");
				await delay(200);
			}
			throw new Error("实验原生回合达到固定截止时间；保留未知提交记录");
		},
		async close() {
			stdin.end();
			for (let attempt = 0; attempt < 20 && !closed; attempt++) await delay(100);
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			for (let attempt = 0; attempt < 20 && !closed; attempt++) await delay(100);
			rejectAll(new Error("隔离原生连接关闭"));
			lines.close();
			closeSync(journal);
			closeSync(stderr);
			await modelProxy?.close();
		},
	};
	try {
		await client.request("initialize", {
			clientInfo: { name: "isolated-merge-order-experiment", version: "1" },
			capabilities: { experimentalApi: true },
		});
		send({ method: "initialized" });
		return client;
	} catch (error) {
		await client.close();
		throw error;
	}
}

const threadResponseSchema = z
	.object({
		thread: z.object({
			id: z.string(),
			path: z.string(),
			cwd: z.string(),
			forkedFromId: z.string().nullable().optional(),
		}),
		model: z.string(),
		reasoningEffort: z.string().nullable().optional(),
		approvalPolicy: z.string(),
	})
	.passthrough();

export async function prepareNativeConfiguration(input: {
	root: string;
	groupDirectory: string;
	configurationSourceHome: string;
	binary: string;
	model: string;
	effort: string;
	readOnlyWorkingDirectory?: string;
	reuseVerifiedProcessIsolationProfile?: boolean;
}) {
	await assertOwnedExperimentRoot(input.root, input.groupDirectory);
	const configuration = parseToml(await readFile(join(input.configurationSourceHome, "config.toml"), "utf8"));
	const providerName = typeof configuration.model_provider === "string" ? configuration.model_provider : undefined;
	const providers = z
		.record(z.string(), z.record(z.string(), z.unknown()))
		.optional()
		.parse(configuration.model_providers);
	const provider = providerName ? providers?.[providerName] : undefined;
	const baseUrl = typeof provider?.base_url === "string" ? new URL(provider.base_url) : null;
	const endpointPort = baseUrl ? Number(baseUrl.port || (baseUrl.protocol === "https:" ? 443 : 80)) : undefined;
	const modelEndpoints = z.array(approvedModelEndpointSchema).parse(
		baseUrl
			? [{ hostname: baseUrl.hostname, port: endpointPort }]
			: [
					{ hostname: "api.openai.com", port: 443 },
					{ hostname: "chatgpt.com", port: 443 },
				],
	);
	const runtimeExecutables = [input.binary, process.execPath];
	const nativeCodeModeHost = join(dirname(input.binary), "codex-code-mode-host");
	if (!(await stat(nativeCodeModeHost)).isFile()) throw new Error("归档的 Codex 缺少配套 codex-code-mode-host");
	runtimeExecutables.push(nativeCodeModeHost);
	if (!input.reuseVerifiedProcessIsolationProfile) await probeProcessIsolation(input.root, input.groupDirectory);
	const isolation = input.reuseVerifiedProcessIsolationProfile
		? {
				environment: isolatedProcessEnvironment(
					join(input.groupDirectory, "isolated-home"),
					join(input.groupDirectory, "isolated-temporary-files"),
				),
				profilePath: join(input.groupDirectory, "experiment-process-sandbox.sb"),
			}
		: await prepareProcessIsolation(
				input.root,
				input.groupDirectory,
				runtimeExecutables,
				input.readOnlyWorkingDirectory ? [input.readOnlyWorkingDirectory] : [],
			);
	if (!input.reuseVerifiedProcessIsolationProfile)
		await writeFile(
			isolation.profilePath,
			`${await readFile(isolation.profilePath, "utf8")}; approved-model-endpoints ${JSON.stringify(modelEndpoints)}\n`,
			{ mode: 0o600 },
		);
	const codexHome = isolation.environment.CODEX_HOME;
	if (!codexHome) throw new Error("私有 CODEX_HOME 缺失");
	await createPrivateDirectory(codexHome);
	await createPrivateDirectory(String(isolation.environment.CODEX_SQLITE_HOME));
	const frozenConfiguration = {
		model: input.model,
		model_reasoning_effort: input.effort,
		approval_policy: "never",
		sandbox_mode: "read-only",
		web_search: "disabled",
		features: { multi_agent: false, memories: false, hooks: false, apps: false, plugins: false },
		...(providerName ? { model_provider: providerName, model_providers: { [providerName]: provider } } : {}),
		...(typeof configuration.service_tier === "string" ? { service_tier: configuration.service_tier } : {}),
	};
	const frozenConfigurationText = stringifyToml(frozenConfiguration);
	const frozenConfigurationPath = join(codexHome, "config.toml");
	try {
		await writeFile(frozenConfigurationPath, frozenConfigurationText, { mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await readFile(frozenConfigurationPath, "utf8")) !== frozenConfigurationText)
			throw new Error("私有会话的冻结配置发生变化；不能原地覆盖");
	}
	try {
		await copyFile(
			join(input.configurationSourceHome, "auth.json"),
			join(codexHome, "auth.json"),
			constants.COPYFILE_EXCL,
		);
	} catch (error) {
		if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	}
	if (typeof provider?.env_key === "string" && process.env[provider.env_key])
		isolation.environment[provider.env_key] = process.env[provider.env_key];
	if (process.env.OPENAI_API_KEY) isolation.environment.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
	await writeDurableJson(join(input.groupDirectory, "native-configuration-evidence.json"), {
		binary: await realpath(input.binary),
		configurationSha256: fingerprint(stringifyToml(frozenConfiguration)),
		model: input.model,
		effort: input.effort,
		endpoint: baseUrl ? { hostname: baseUrl.hostname, port: endpointPort } : null,
		modelEndpoints,
		configurationDifferences: [
			"私有 HOME/CODEX_HOME/SQLITE",
			"read-only 初始沙箱",
			"关闭插件、hooks、memory、apps 与子 Agent",
			"操作系统隔离只开放当前实验组",
		],
	});
	return { ...isolation, codexHome, modelEndpoints };
}

const forkOperationSchema = z.object({
	status: z.enum(["prepared", "submitting", "completed"]),
	parentSessionId: z.string(),
	childSessionId: z.string().optional(),
	childTranscriptPath: z.string().optional(),
	startedAt: z.number(),
	completedAt: z.number().optional(),
});

/** 每个操作拥有单独私有原生存储；回执丢失后从持久分身对账，绝不盲目重发 fork。 */
async function ensureNativeTaskForkWithOperationLeaseHeld(input: {
	root: string;
	groupDirectory: string;
	taskId: string;
	workingDirectory: string;
	binary: string;
	configurationSourceHome: string;
}) {
	const batch = await verifyFrozenBatch(input.root);
	const task = batch.tasks.find((entry) => entry.taskId === input.taskId);
	if (!task) throw new Error("任务不属于冻结批次");
	await assertOwnedExperimentRoot(input.root, input.workingDirectory);
	const configuration = await prepareNativeConfiguration({
		...input,
		readOnlyWorkingDirectory: input.workingDirectory,
		model: task.nativeHistory.model,
		effort: task.nativeHistory.effort,
	});
	return ensureFrozenNativeTaskForkWithPreparedConfiguration({ ...input, configuration });
}

export type FrozenNativeForkClient = Pick<Awaited<ReturnType<typeof createIsolatedNativeClient>>, "request" | "close">;
export type FrozenNativeForkDependencies = {
	createClient?: (input: Parameters<typeof createIsolatedNativeClient>[0]) => Promise<FrozenNativeForkClient>;
	verifyRegisteredContinuation?: (input: {
		client: CodexAppServerRequestPort;
		childSessionId: string;
		expectedTurnIds: string[];
		initialChildTurnsSha256: string;
	}) => Promise<void>;
};

/** 只提取既有持久 fork 事务；首次分身仍执行生产严格、等长的前缀验证。调用者持有 operation lease。 */
export async function ensureFrozenNativeTaskForkWithPreparedConfiguration(
	input: {
		root: string;
		groupDirectory: string;
		operationDirectory?: string;
		taskId: string;
		workingDirectory: string;
		binary: string;
		configuration: Awaited<ReturnType<typeof prepareNativeConfiguration>>;
	},
	dependencies: FrozenNativeForkDependencies = {},
) {
	const batch = await verifyFrozenBatch(input.root);
	const task = batch.tasks.find((entry) => entry.taskId === input.taskId);
	if (!task) throw new Error("任务不属于冻结批次");
	const configuration = input.configuration;
	const operationDirectory = input.operationDirectory ?? input.groupDirectory;
	await assertOwnedExperimentRoot(input.root, operationDirectory);
	await assertOwnedExperimentRoot(input.root, input.workingDirectory);
	await createPrivateDirectory(operationDirectory);
	const operationPath = join(operationDirectory, "native-fork-operation.json");
	let operation: z.infer<typeof forkOperationSchema>;
	try {
		operation = forkOperationSchema.parse(await readJson(operationPath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		operation = { status: "prepared", parentSessionId: task.nativeHistory.parentSessionId, startedAt: Date.now() };
		await writeDurableJson(operationPath, operation);
	}
	if (operation.parentSessionId !== task.nativeHistory.parentSessionId) throw new Error("已有操作属于不同父会话");
	const resumingCompletedFork = operation.status === "completed";
	const original = join(input.root, "frozen-tasks", input.taskId, "parent-native-history.jsonl");
	const originalIdentity = z
		.object({
			session: z.object({ agentNativeConversationSessionIdentity: z.object({ transcriptPath: z.string() }) }),
		})
		.parse(await readJson(join(input.root, "frozen-tasks", input.taskId, "source-card-and-session.json")))
		.session.agentNativeConversationSessionIdentity;
	const parentPath = join(
		configuration.codexHome,
		"sessions",
		"2026",
		"01",
		"01",
		basename(originalIdentity.transcriptPath),
	);
	await assertOwnedExperimentRoot(input.root, parentPath);
	await createPrivateDirectory(dirname(parentPath));
	try {
		await copyFile(original, parentPath, constants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (
		fingerprint((await readFile(parentPath)).subarray(0, task.nativeHistory.byteLength)) !== task.nativeHistory.sha256
	)
		throw new Error("启动前私有父历史的冻结前缀被改写");
	if (operation.status === "submitting" && !operation.childSessionId) {
		const children: { id: string; path: string }[] = [];
		for (const path of await readdir(join(configuration.codexHome, "sessions"), { recursive: true })) {
			if (!path.endsWith(".jsonl")) continue;
			const absolutePath = join(configuration.codexHome, "sessions", path);
			await assertOwnedExperimentRoot(input.root, absolutePath);
			const metadata = z
				.object({
					type: z.literal("session_meta"),
					payload: z.object({ id: z.string(), forked_from_id: z.string().optional() }),
				})
				.safeParse(JSON.parse((await readFile(absolutePath, "utf8")).split("\n")[0]));
			if (metadata.success && metadata.data.payload.forked_from_id === operation.parentSessionId)
				children.push({ id: metadata.data.payload.id, path: absolutePath });
		}
		if (children.length !== 1) throw new Error("fork 回执未知，私有历史未能唯一恢复；等待原生分身记录补齐，不重发");
		operation.childSessionId = children[0].id;
		operation.childTranscriptPath = children[0].path;
		await writeDurableJson(operationPath, operation);
	}
	const client = await (dependencies.createClient ?? createIsolatedNativeClient)({
		binary: input.binary,
		cwd: input.workingDirectory,
		...configuration,
		evidenceDirectory: operationDirectory,
	});
	try {
		const parent = threadResponseSchema.parse(
			await client.request("thread/resume", {
				threadId: task.nativeHistory.parentSessionId,
				cwd: input.workingDirectory,
				model: task.nativeHistory.model,
				approvalPolicy: "never",
				sandbox: "read-only",
			}),
		);
		if (parent.thread.id !== operation.parentSessionId) throw new Error("载入的父会话身份不一致");
		const turns = await readCodexConversationTurns(client, operation.parentSessionId);
		if (turns.at(-1)?.id !== task.nativeHistory.lastCompletedTurnId || turns.at(-1)?.status !== "completed")
			throw new Error("原生恢复的最终完整回合与冻结边界不一致");
		if (operation.status === "prepared") {
			operation.status = "submitting";
			await writeDurableJson(operationPath, operation);
			const child = threadResponseSchema.parse(
				await client.request("thread/fork", {
					threadId: operation.parentSessionId,
					lastTurnId: task.nativeHistory.lastCompletedTurnId,
					cwd: input.workingDirectory,
					excludeTurns: true,
					model: task.nativeHistory.model,
					approvalPolicy: "never",
					sandbox: "read-only",
				}),
			);
			operation.childSessionId = child.thread.id;
			operation.childTranscriptPath = child.thread.path;
			await writeDurableJson(operationPath, operation);
			if (
				child.thread.forkedFromId !== operation.parentSessionId ||
				child.model !== task.nativeHistory.model ||
				child.approvalPolicy !== "never" ||
				resolve(child.thread.cwd) !== resolve(input.workingDirectory)
			)
				throw new Error("原生 fork 归属、模型或执行配置不一致");
		} else {
			const resumed = threadResponseSchema.parse(
				await client.request("thread/resume", {
					threadId: operation.childSessionId,
					path: operation.childTranscriptPath,
					cwd: input.workingDirectory,
					approvalPolicy: "never",
					sandbox: "read-only",
					model: task.nativeHistory.model,
				}),
			);
			if (
				resumed.thread.id !== operation.childSessionId ||
				resumed.model !== task.nativeHistory.model ||
				resumed.approvalPolicy !== "never" ||
				resolve(resumed.thread.cwd) !== resolve(input.workingDirectory)
			)
				throw new Error("续接分身的身份、模型或执行配置不一致");
		}
		if (
			!operation.childSessionId ||
			operation.childSessionId === operation.parentSessionId ||
			!operation.childTranscriptPath ||
			!isWithin(configuration.codexHome, operation.childTranscriptPath)
		)
			throw new Error("分身身份或路径不安全");
		await assertOwnedExperimentRoot(input.root, operation.childTranscriptPath);
		const proofPath = join(operationDirectory, "fork-inheritance-verification.json");
		if (resumingCompletedFork && dependencies.verifyRegisteredContinuation) {
			const proof = z
				.object({
					verified: z.literal(true),
					parentSessionId: z.string(),
					childSessionId: z.string(),
					turnIds: z.array(z.string()),
					initialChildTurnsSha256: z.string().length(64),
				})
				.parse(await readJson(proofPath));
			if (
				proof.parentSessionId !== operation.parentSessionId ||
				proof.childSessionId !== operation.childSessionId ||
				JSON.stringify(proof.turnIds) !== JSON.stringify(turns.map((turn) => turn.id))
			)
				throw new Error("初次 fork 证明与当前分身归属不一致");
			await dependencies.verifyRegisteredContinuation({
				client,
				childSessionId: operation.childSessionId,
				expectedTurnIds: proof.turnIds,
				initialChildTurnsSha256: proof.initialChildTurnsSha256,
			});
		} else {
			await verifyRestoredCodexConversationPrefix(
				client,
				operation.childSessionId,
				turns.map((turn) => turn.id),
			);
			await writeDurableJson(proofPath, {
				verified: true,
				parentSessionId: operation.parentSessionId,
				childSessionId: operation.childSessionId,
				turnIds: turns.map((turn) => turn.id),
				frozenHistory: task.nativeHistory,
				workingDirectory: input.workingDirectory,
				initialChildTurnsSha256: fingerprint(
					JSON.stringify(await readCodexConversationTurns(client, operation.childSessionId)),
				),
				modelRequestsStarted: 0,
			});
		}
		const resumedParentHistory = await readFile(parentPath);
		if (fingerprint(resumedParentHistory.subarray(0, task.nativeHistory.byteLength)) !== task.nativeHistory.sha256)
			throw new Error("私有父历史的冻结前缀被改写");
		operation.status = "completed";
		operation.completedAt ??= Date.now();
		await writeDurableJson(operationPath, operation);
		return { operation, configuration };
	} finally {
		await client.close();
	}
}

export { summarizeNewTurnUsage, batchManifestSchema, frozenNativeHistorySchema };

export async function ensureNativeTaskFork(input: Parameters<typeof ensureNativeTaskForkWithOperationLeaseHeld>[0]) {
	return withExperimentOperationLease(input.root, input.groupDirectory, () =>
		ensureNativeTaskForkWithOperationLeaseHeld(input),
	);
}
