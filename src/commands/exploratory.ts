import { readFile } from "node:fs/promises";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import type {
	RuntimeIngestExploratoryFindingCandidateRequest,
	RuntimeIngestExploratoryFindingCandidateResponse,
} from "../core/api-contract";
import { mergeAbortSignals } from "../core/cli-process-guards";
import { buildKanbanRuntimeUrl, getRuntimeFetch } from "../core/runtime-endpoint";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext } from "../state/workspace-state";
import { KANBAN_HOOK_TASK_ID_ENV, KANBAN_HOOK_WORKSPACE_ID_ENV } from "../terminal/hook-runtime-context";
import type { RuntimeAppRouter } from "../trpc/app-router";
import { retryCliRuntimeRequestWhileKanbanRuntimeRestarts } from "./cli-runtime-request-retry-while-kanban-runtime-restarts";
import { deliverHookIngestWithRetry } from "./hooks";

// Exploratory Mode（蓝图 .plan/docs/exploratory-mode-session-map-and-findings-store.md §D）：
// agent 侧的 CLI 通道——get-findings 列出现有 finding、ingest-finding-candidate 提交建议
// （落库即待人确认）、get-exploration-thread-graph 读出这次探索的会话结构图。
// 旧的 session map 读-改-写通道（get-session-map / ingest-map-update）已退役：会话结构改由
// 独立包 agent-conversation-exploration-thread-graph 的 work-branch 作业维护，agent 不再手写结构
// （宿主胶水见 docs/exploratory-mode-host-integration.md）。
//
// **结构图只有读通道，没有写通道**，这是刻意的非对称：图由 fork 出的分身作业单独维护，
// agent 手写结构正是 session map 时代退役掉的那条路。读是纯投影合成、零 fork、零成本，
// 想读多少次都行；真正花钱的 requestExplorationThreadGraphMaintenance 只暴露给 UI 的显式点击，
// 不进 CLI——否则 agent 可以在自己的回合里反复烧掉 fork 预算（重型会话一次 ≈ $4.5）。
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

// ingest-finding-candidate 的廉价校验：只锁白名单四键的形状；provenance link 字段级
// 完整校验（linkKind 枚举、三元约束、长度上限）交给服务端 schema——它的
// TRPCClientError message 会原样透传到 stderr。
export interface ExploratoryFindingCandidatePayload {
	clientProposalId: string;
	findingTitle: string;
	findingBodyMarkdown: string;
	provenanceLinks: unknown[];
}

export function parseExploratoryFindingCandidatePayload(payloadText: string): ExploratoryFindingCandidatePayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadText);
	} catch (error) {
		throw new Error(`Payload is not valid JSON: ${formatError(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			"Payload must be a JSON object with clientProposalId, findingTitle, findingBodyMarkdown, and provenanceLinks.",
		);
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.clientProposalId !== "string" || record.clientProposalId.trim().length === 0) {
		throw new Error('Payload is missing required string field "clientProposalId".');
	}
	if (typeof record.findingTitle !== "string" || record.findingTitle.trim().length === 0) {
		throw new Error('Payload is missing required string field "findingTitle".');
	}
	if (typeof record.findingBodyMarkdown !== "string" || record.findingBodyMarkdown.trim().length === 0) {
		throw new Error('Payload is missing required string field "findingBodyMarkdown".');
	}
	if (!Array.isArray(record.provenanceLinks)) {
		throw new Error('Payload field "provenanceLinks" must be an array of provenance links.');
	}
	return {
		clientProposalId: record.clientProposalId,
		findingTitle: record.findingTitle,
		findingBodyMarkdown: record.findingBodyMarkdown,
		provenanceLinks: record.provenanceLinks,
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
//   - mutation resolve → 投递成功（applied/ingested false 都算——rejectionReason 是给 agent
//     的 业务信息，两者退出码都为 0）；
//   - TRPCClientError（daemon 可达但 schema/procedure 拒绝）→ {ok:false} 业务拒绝：
//     骨架立即抛、不重试，message 由调用方透传 stderr；
//   - 其它抛出（超时 / daemon 不可达）→ 传输故障，走骨架的有界重试。
// 泛型化：适配逻辑与响应类型零耦合（历史上 map / findings 两个消费者共用，map 通道退役后
// 保留泛型形态，thread graph 相关 mutation 接入时直接复用）。
export async function deliverExploratoryMutation<TResponse>(
	mutate: (signal: AbortSignal) => Promise<TResponse>,
	options: { timeoutMs: number; maxAttempts: number; backoffMs: number },
): Promise<TResponse> {
	let delivered: TResponse | null = null;
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
		throw new Error("exploratory mutation resolved without a response.");
	}
	return delivered;
}

async function ingestFindingCandidate(
	scope: ExploratoryCommandScope,
	payload: ExploratoryFindingCandidatePayload,
): Promise<RuntimeIngestExploratoryFindingCandidateResponse> {
	const request: RuntimeIngestExploratoryFindingCandidateRequest = {
		conversationSessionTaskId: scope.taskId,
		clientProposalId: payload.clientProposalId,
		findingTitle: payload.findingTitle,
		findingBodyMarkdown: payload.findingBodyMarkdown,
		// link 形状按契约类型断言——完整校验刻意留给服务端 schema（见 parseExploratoryFindingCandidatePayload）。
		provenanceLinks: payload.provenanceLinks as RuntimeIngestExploratoryFindingCandidateRequest["provenanceLinks"],
	};
	// runtime 热重启窗口内整次投递再来一遍：clientProposalId 让服务端对重复投递幂等，
	// 所以即便前一次尝试是「超时后再撞上 ECONNREFUSED」也不会落两条。
	return await retryCliRuntimeRequestWhileKanbanRuntimeRestarts(() =>
		deliverExploratoryMutation(
			async (signal) => {
				const trpcClient = createExploratoryTrpcClient(scope.workspaceId, signal);
				return await trpcClient.exploratory.ingestFindingCandidate.mutate(request);
			},
			{
				timeoutMs: resolveExploratoryIngestTimeoutMs(),
				maxAttempts: EXPLORATORY_INGEST_MAX_ATTEMPTS,
				backoffMs: EXPLORATORY_INGEST_RETRY_BACKOFF_MS,
			},
		),
	);
}

// ---- 子命令实现 ----

async function runGetFindings(options: ExploratoryScopeOptions): Promise<void> {
	let scope: ExploratoryCommandScope;
	try {
		// 复用同一 scope 解析：findings 本身是 workspace 级资产（只需要 workspaceId），但
		// agent 运行环境恒有 task/workspace 双注入，统一走同一解析函数不另开第二套
		// workspace-only 解析路径（缺 task 时的报错文案与 map 子命令一致）。
		scope = await resolveExploratoryCommandScope(options);
	} catch (error) {
		process.stderr.write(`kanban exploratory get-findings: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		const trpcClient = createExploratoryTrpcClient(scope.workspaceId);
		const response = await trpcClient.exploratory.getFindings.query({});
		process.stdout.write(`${JSON.stringify({ findings: response.findings })}\n`);
	} catch (error) {
		process.stderr.write(`kanban exploratory get-findings: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

async function runIngestFindingCandidate(options: ExploratoryScopeOptions & { payload: string }): Promise<void> {
	let scope: ExploratoryCommandScope;
	let payload: ExploratoryFindingCandidatePayload;
	try {
		scope = await resolveExploratoryCommandScope(options);
		payload = parseExploratoryFindingCandidatePayload(await readExploratoryPayloadText(options.payload));
	} catch (error) {
		process.stderr.write(`kanban exploratory ingest-finding-candidate: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		const response = await ingestFindingCandidate(scope, payload);
		// ingested=false 时 rejectionReason 必在输出 JSON 里（schema 保证非 null）。
		process.stdout.write(`${JSON.stringify(response)}\n`);
	} catch (error) {
		process.stderr.write(`kanban exploratory ingest-finding-candidate: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

// explorationId 的默认值是本会话的 taskId——主会话场景下两者本就相同（契约：explorationId
// = 主任务卡片 id）。by-the-way 会话有自己的 taskId、其 turn 归在主卡片的图里，所以它必须用
// --exploration-id 显式指向主卡片；默认值在那种场景下只会查出一张空图，不会串到别人的图上。
//
// 这里刻意**不做** scope 解析那套「两来源不一致即硬报错」：--exploration-id 与 taskId 不同
// 恰恰是 by-the-way 会话的正常形态，冲突校验会把唯一的正确用法判成错误。读路径也没有
// 「写错了会污染谁」的风险——读别人的图只是读不到自己的。
export function resolveExplorationIdForThreadGraphRead(input: {
	explicitExplorationId: string | undefined;
	taskId: string;
}): string {
	return readTrimmedValue(input.explicitExplorationId) ?? input.taskId;
}

async function runGetExplorationThreadGraph(
	options: ExploratoryScopeOptions & { explorationId?: string },
): Promise<void> {
	let scope: ExploratoryCommandScope;
	try {
		scope = await resolveExploratoryCommandScope(options);
	} catch (error) {
		process.stderr.write(`kanban exploratory get-exploration-thread-graph: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	const explorationId = resolveExplorationIdForThreadGraphRead({
		explicitExplorationId: options.explorationId,
		taskId: scope.taskId,
	});

	try {
		const trpcClient = createExploratoryTrpcClient(scope.workspaceId);
		const response = await trpcClient.exploratory.getExplorationThreadGraph.query({ explorationId });
		// 整份响应原样输出（view + turnSourceUnavailableSessionIds）：后者是「哪些会话的转录
		// 暂时读不出来」，缺了它，读到的空图会被误读成「还没有任何 turn 归位」。
		process.stdout.write(`${JSON.stringify(response)}\n`);
	} catch (error) {
		process.stderr.write(`kanban exploratory get-exploration-thread-graph: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

export function registerExploratoryCommand(program: Command): void {
	const exploratory = program
		.command("exploratory")
		.description("Exploratory Mode helpers for agent integrations (findings + thread graph).");

	exploratory
		.command("get-findings")
		.description("Print the workspace's findings as JSON. List existing findings before proposing a duplicate.")
		.option("--task <taskId>", `Conversation session task id (defaults to ${KANBAN_HOOK_TASK_ID_ENV}).`)
		.option("--workspace-id <id>", `Workspace id (defaults to --project-path, then ${KANBAN_HOOK_WORKSPACE_ID_ENV}).`)
		.option(
			"--project-path <path>",
			"Resolve workspace from a registered project path (pass the main repo path when invoking from a task worktree).",
		)
		.action(async (options: ExploratoryScopeOptions) => {
			await runGetFindings(options);
		});

	exploratory
		.command("get-exploration-thread-graph")
		.description(
			"Print this exploration's thread graph as JSON (read-only, never forks). " +
				"Use it to look up your own turn numbers before citing them in a finding's provenance links.",
		)
		.option("--task <taskId>", `Conversation session task id (defaults to ${KANBAN_HOOK_TASK_ID_ENV}).`)
		.option("--workspace-id <id>", `Workspace id (defaults to --project-path, then ${KANBAN_HOOK_WORKSPACE_ID_ENV}).`)
		.option(
			"--project-path <path>",
			"Resolve workspace from a registered project path (pass the main repo path when invoking from a task worktree).",
		)
		.option(
			"--exploration-id <id>",
			"Exploration to read (defaults to --task). Pass the main task id from a by-the-way session.",
		)
		.action(async (options: ExploratoryScopeOptions & { explorationId?: string }) => {
			await runGetExplorationThreadGraph(options);
		});

	exploratory
		.command("ingest-finding-candidate")
		.description("Submit a finding suggestion for human confirmation (lands as pending, never auto-active).")
		.option("--task <taskId>", `Conversation session task id (defaults to ${KANBAN_HOOK_TASK_ID_ENV}).`)
		.option("--workspace-id <id>", `Workspace id (defaults to --project-path, then ${KANBAN_HOOK_WORKSPACE_ID_ENV}).`)
		.option(
			"--project-path <path>",
			"Resolve workspace from a registered project path (pass the main repo path when invoking from a task worktree).",
		)
		.requiredOption(
			"--payload <json>",
			'Finding candidate payload: inline JSON string, "@<path>" to read a file, or "-" to read stdin.',
		)
		.action(async (options: ExploratoryScopeOptions & { payload: string }) => {
			await runIngestFindingCandidate(options);
		});
}
