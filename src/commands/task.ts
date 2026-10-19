import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { loadRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeKanbanCliTaskBoardMutationKind,
	RuntimeKanbanCliTaskBoardMutationRequest,
	RuntimeKanbanCliTaskBoardMutationResponse,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAgentSessionInitializationReuseMode,
	RuntimeTaskCardActionMoveIntoDoneResponse,
	RuntimeTaskClineSettings,
	RuntimeTaskSessionSummary,
	RuntimeTaskWorkspaceGitStatus,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX,
	runtimeAgentIdSchema,
	runtimeClineReasoningEffortSchema,
	runtimeTaskAgentPermissionModeSchema,
	runtimeTaskAgentSessionInitializationReuseModeSchema,
	runtimeTaskWorktreeModeSchema,
} from "../core/api-contract";
import {
	mergeAbortSignals,
	resolveCliHardTimeoutMs,
	resolveCliTrpcTimeoutMs,
	safeStringify,
} from "../core/cli-process-guards";
import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	KANBAN_CLI_INVOCATION_ENVIRONMENT_ACTOR_CLAIMS_REQUEST_HEADER_NAME,
} from "../core/kanban-cli-invocation-environment-actor-claims";
import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import { resolveSessionFacets } from "../core/session-activity";
import { DEFAULT_TASK_AGENT_PERMISSION_MODE } from "../core/task-agent-permission-mode";
import { resolveTaskDescriptionLastUpdatedAt } from "../core/task-board-mutations";
import {
	buildTaskAgentSessionInitialization,
	buildTaskClineSettingsForCreate,
	cloneTaskClineSettings,
	type ParsedTaskClineReasoningEffort,
} from "../core/task-card-field-patch-resolution";
import { resolveMainTaskConversationSessionSummary } from "../core/task-main-conversation-session-binding";
import type {
	TaskMessageInjectionRecord,
	TaskMessageTerminalDeliveryFailureReason,
	TaskMessageTerminalDeliveryStatus,
} from "../core/task-message-injection-ledger";
import {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	isTaskMessageTerminalDeliveryStatusSettled,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../core/task-message-injection-ledger";
import { resolveProjectInputPath } from "../projects/project-path";
import {
	detectGitRepositoryInfo,
	getTaskWorktreesHomePath,
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	resolveWorkspacePath,
} from "../state/workspace-state";
import { MAX_WAIT_FOR_AGENT_IDLE_UPPER_BOUND_MS } from "../trpc/agent-idle-gated-programmatic-task-chat-message-enqueue";
import type { RuntimeAppRouter } from "../trpc/app-router";
import { retryCliRuntimeRequestWhileKanbanRuntimeRestarts } from "./cli-runtime-request-retry-while-kanban-runtime-restarts";
import {
	resolveTaskCreateEffectiveSettings,
	type TaskCreateRequestedSettings,
} from "./task-create-effective-settings-resolution";

const KANBAN_CLI_PACKAGE_VERSION_FOR_ACTOR_CLAIMS =
	typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

const LIST_TASK_COLUMNS = ["backlog", "in_progress", "review", "validation", "trash"] as const;
type ListTaskColumn = (typeof LIST_TASK_COLUMNS)[number];
type TaskCommandTarget = { taskId?: string; column?: ListTaskColumn };

type ResolvedTaskCommandTarget =
	| {
			kind: "task";
			taskId: string;
	  }
	| {
			kind: "column";
			column: ListTaskColumn;
	  };

import {
	addPostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
	type PostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
	parsePostDeployVerificationDoneEntryClosureFromCliOptions,
} from "./post-deploy-verification-unchecked-item-closure-reason-cli-options";

type JsonRecord = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

export function printJson(payload: unknown): void {
	process.stdout.write(`${safeStringify(payload, 2)}\n`);
}

function parseListColumn(value: string | undefined): ListTaskColumn | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "done") {
		return "trash";
	}
	if (
		value === "backlog" ||
		value === "in_progress" ||
		value === "review" ||
		value === "validation" ||
		value === "trash"
	) {
		return value;
	}
	throw new Error(`Invalid column "${value}". Expected one of: ${LIST_TASK_COLUMNS.join(", ")}, done.`);
}

function parseAutoReviewMode(value: string | undefined): "commit" | "pr" | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "commit" || value === "pr") {
		return value;
	}
	throw new Error(`Invalid auto review mode "${value}". Expected: commit, pr.`);
}

const VALID_WORKTREE_MODES = runtimeTaskWorktreeModeSchema.options;
const VALID_TASK_AGENT_PERMISSION_MODES = runtimeTaskAgentPermissionModeSchema.options;

function parseWorktreeMode(value: string | undefined): RuntimeTaskWorktreeMode | undefined {
	if (value === undefined) {
		return undefined;
	}
	const result = runtimeTaskWorktreeModeSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(`Invalid worktree mode "${value}". Expected one of: ${VALID_WORKTREE_MODES.join(", ")}.`);
}

function parseTaskAgentPermissionMode(value: string | undefined): RuntimeTaskAgentPermissionMode | undefined {
	if (value === undefined) {
		return undefined;
	}
	const result = runtimeTaskAgentPermissionModeSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(
		`Invalid task agent permission mode "${value}". Expected one of: ${VALID_TASK_AGENT_PERMISSION_MODES.join(", ")}.`,
	);
}

function parseOptionalWorktreeModeOrInherit(value: string | undefined): RuntimeTaskWorktreeMode | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "inherit") {
		return null;
	}
	return parseWorktreeMode(value);
}

function parseOptionalStringOrInherit(value: string | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "inherit") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

const VALID_AGENT_IDS = runtimeAgentIdSchema.options;

function parseAgentId(value: string | undefined): RuntimeAgentId | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	const result = runtimeAgentIdSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error(`Invalid agent ID "${value}". Expected one of: ${VALID_AGENT_IDS.join(", ")}, default.`);
}

function parseOptionalStringOrDefault(value: string | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	return value;
}

function parseTaskClineReasoningEffort(value: string | undefined): ParsedTaskClineReasoningEffort {
	if (value === undefined) {
		return undefined;
	}
	if (value === "inherit") {
		return null;
	}
	if (value === "default") {
		return "default";
	}
	const result = runtimeClineReasoningEffortSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error("Invalid Cline reasoning effort. Expected one of: default, low, medium, high, xhigh, inherit.");
}

function formatTaskClineSettings(settings?: RuntimeTaskClineSettings): JsonRecord {
	if (settings === undefined) {
		return {};
	}
	return {
		clineSettings: cloneTaskClineSettings(settings) ?? {},
	};
}

function resolveTaskCommandTarget(input: TaskCommandTarget, commandName: string): ResolvedTaskCommandTarget {
	const taskId = input.taskId?.trim();
	const column = input.column;
	if (taskId && column) {
		throw new Error(`${commandName} accepts exactly one of --task-id or --column.`);
	}
	if (taskId) {
		return {
			kind: "task",
			taskId,
		};
	}
	if (column) {
		return {
			kind: "column",
			column,
		};
	}
	throw new Error(`${commandName} requires either --task-id or --column.`);
}

export function createRuntimeTrpcClient(workspaceId: string | null) {
	const trpcTimeoutMs = resolveCliTrpcTimeoutMs();
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => ({
					...(workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
					// dd2db 1a：每个 CLI 请求都带调用环境行动者声明，由 runtime 解析出是哪个工作单元发起的。
					[KANBAN_CLI_INVOCATION_ENVIRONMENT_ACTOR_CLAIMS_REQUEST_HEADER_NAME]:
						encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
							collectKanbanCliInvocationEnvironmentActorClaims({
								environment: process.env,
								invokingKanbanCliCodeVersion: KANBAN_CLI_PACKAGE_VERSION_FOR_ACTOR_CLAIMS,
								invokingProcessWorkingDirectory: process.cwd(),
							}),
						),
				}),
				// runtime 热重启的几秒里，确定没发出的请求等它回来再发（只在有重启证据时；见该函数）。
				fetch: (url, options) =>
					retryCliRuntimeRequestWhileKanbanRuntimeRestarts(async () => {
						const runtimeFetch = await getRuntimeFetch();
						const signal = mergeAbortSignals(options?.signal, AbortSignal.timeout(trpcTimeoutMs));
						return runtimeFetch(url, { ...options, signal });
					}),
			}),
		],
	});
}

async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
) {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

async function resolveWorkspaceRepoPath(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, options);
	return workspace.repoPath;
}

async function ensureRuntimeWorkspace(workspaceRepoPath: string): Promise<string> {
	const runtimeClient = createRuntimeTrpcClient(null);
	const added = await runtimeClient.projects.add.mutate({
		path: workspaceRepoPath,
	});
	if (!added.ok || !added.project) {
		throw new Error(added.error ?? `Could not register project ${workspaceRepoPath} in Kanban runtime.`);
	}
	return added.project.id;
}

type RuntimeKanbanCliTaskBoardMutationResponseOfKind<
	TKanbanCliTaskBoardMutationKind extends RuntimeKanbanCliTaskBoardMutationKind,
> = Extract<
	RuntimeKanbanCliTaskBoardMutationResponse,
	{ kanbanCliTaskBoardMutationKind: TKanbanCliTaskBoardMutationKind }
>;

// dd2db 1a.2b：create 只经 runtime procedure 落盘，由 runtime 按本进程随请求发出的行动者声明头解析行动者、写进
// 关系账本；广播也由 runtime 在写成后自己做。update / start / done / delete 走 taskCardAction.*（连同停会话、删
// worktree、清草稿与 checkpoint ref 的整条收尾链都在 runtime 里执行，CLI 只做参数解析与输出格式化）。
// runtime 不可达时 tRPC 调用直接抛错、命令以 exit 1 失败（fail closed）——这里刻意没有「回退到直接写盘」的分支。
async function applyKanbanCliTaskBoardMutationThroughRuntime<
	TKanbanCliTaskBoardMutationKind extends RuntimeKanbanCliTaskBoardMutationKind,
>(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	request: Extract<
		RuntimeKanbanCliTaskBoardMutationRequest,
		{ kanbanCliTaskBoardMutationKind: TKanbanCliTaskBoardMutationKind }
	>,
): Promise<RuntimeKanbanCliTaskBoardMutationResponseOfKind<TKanbanCliTaskBoardMutationKind>> {
	const response = await runtimeClient.workspace.applyKanbanCliTaskBoardMutation.mutate(request);
	if (response.kanbanCliTaskBoardMutationKind !== request.kanbanCliTaskBoardMutationKind) {
		throw new Error(
			`Kanban runtime answered a "${request.kanbanCliTaskBoardMutationKind}" board mutation with a "${response.kanbanCliTaskBoardMutationKind}" response.`,
		);
	}
	return response as RuntimeKanbanCliTaskBoardMutationResponseOfKind<TKanbanCliTaskBoardMutationKind>;
}

function findTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { task: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) {
			return {
				task,
				columnId: column.id,
			};
		}
	}
	return null;
}

function formatTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
	workspaceGitStatus: RuntimeTaskWorkspaceGitStatus | null = null,
): JsonRecord {
	return formatTaskRecordWithSessionSummary(
		task,
		columnId,
		resolveMainTaskConversationSessionSummary(task, state.sessions),
		workspaceGitStatus,
	);
}

// 写动词迁到 runtime procedure 之后，CLI 手里没有整份 state，只有 runtime 回传的卡片、列与盘上会话摘要。
function formatTaskRecordWithSessionSummary(
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
	session: RuntimeTaskSessionSummary | null,
	workspaceGitStatus: RuntimeTaskWorkspaceGitStatus | null = null,
): JsonRecord {
	const sessionFacets = session ? resolveSessionFacets(session) : null;
	return {
		id: task.id,
		// 卡片 schema 的 transform 已把 title 归一成「卡片上实际显示的标题」（缺省时由 prompt 派生），
		// 这里直接透出，让 CLI 消费方看到的标题与看板一致。
		title: task.title,
		prompt: task.prompt,
		column: columnId,
		baseRef: task.baseRef,
		startInPlanMode: task.startInPlanMode,
		taskAgentPermissionMode: task.taskAgentPermissionMode ?? DEFAULT_TASK_AGENT_PERMISSION_MODE,
		autoReviewEnabled: task.autoReviewEnabled === true,
		autoReviewMode: task.autoReviewMode ?? "commit",
		taskCommentEntries: task.taskCommentEntries ?? [],
		...(task.agentId ? { agentId: task.agentId } : {}),
		...formatTaskClineSettings(task.clineSettings),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		// Backlog 的排序键（只在 Description 内容变化时推进）；老卡片缺字段时按同一回落规则解析后透出。
		taskDescriptionLastUpdatedAt: resolveTaskDescriptionLastUpdatedAt(task),
		workspaceGitStatus,
		session:
			session && sessionFacets
				? {
						// Stage 4：`state` 是 projectLegacyState(facets) 派生投影（向后兼容保留）；additively 补三 facet
						// （双轴真相源，经 resolveSessionFacets 解析，旧盘无 facet 时即时派生，恒自洽）。
						state: session.state,
						turnOwner: sessionFacets.turnOwner,
						liveness: sessionFacets.liveness,
						userTurnKind: sessionFacets.userTurnKind,
						agentId: session.agentId,
						pid: session.pid,
						startedAt: session.startedAt,
						updatedAt: session.updatedAt,
						lastOutputAt: session.lastOutputAt,
						reviewReason: session.reviewReason,
						exitCode: session.exitCode,
					}
				: null,
	};
}

function findTasksInColumn(
	state: RuntimeWorkspaceStateResponse,
	columnId: ListTaskColumn,
): Array<{ task: RuntimeBoardCard; columnId: RuntimeBoardColumnId }> {
	const column = state.board.columns.find((candidate) => candidate.id === columnId);
	if (!column) {
		return [];
	}
	return column.cards.map((task) => ({
		task,
		columnId: column.id,
	}));
}

async function listTasks(input: { cwd: string; projectPath?: string; column?: ListTaskColumn }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const [state, taskWorkspaceGitStatusesResponse] = await Promise.all([
		runtimeClient.workspace.getState.query(),
		runtimeClient.workspace.getTaskWorkspaceGitStatuses.query(),
	]);

	const tasks = state.board.columns.flatMap((boardColumn) => {
		if (!input.column && boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) =>
			formatTaskRecord(
				state,
				task,
				boardColumn.id,
				taskWorkspaceGitStatusesResponse.taskWorkspaceGitStatuses[task.id] ?? null,
			),
		);
	});

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		column: input.column ?? null,
		tasks,
		count: tasks.length,
	};
}

// 「task get」：按 task ID 取回单条任务的只读快照。存在的意义是补上「别的 agent 拿到一个 task ID
// （或一条 worktree 路径）之后该怎么找回这个任务」这一段——task list 要求调用方自己在整块 JSON 里筛，
// 而任务标题既不唯一也会随 prompt 编辑而变，ID 才是唯一可靠的引用键。
// dd2db 1b：当前（或推断的）project 里没有这张卡时，经 runtime 的全局 task 身份登记簿跨 project 解析。
// 显式传了 --project-path 就不替调用方换 project，只在报错里指出它实际在哪。
async function getTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const explicitProjectPath = input.projectPath?.trim() || undefined;
	let workspace: Awaited<ReturnType<typeof resolveRuntimeWorkspace>> | null = null;
	let workspaceResolutionFailureMessage: string | null = null;
	try {
		workspace = await resolveRuntimeWorkspace(explicitProjectPath, input.cwd, { autoCreateIfMissing: false });
	} catch (error) {
		if (explicitProjectPath) {
			throw error;
		}
		workspaceResolutionFailureMessage = toErrorMessage(error);
	}
	if (workspace) {
		const taskInWorkspace = await getTaskFromRuntimeWorkspace(workspace, input.taskId);
		if (taskInWorkspace) {
			return taskInWorkspace;
		}
	}
	const notFoundMessage = workspace
		? `Task "${input.taskId}" was not found in workspace ${workspace.repoPath}`
		: `Task "${input.taskId}" could not be looked up in the current directory (${workspaceResolutionFailureMessage})`;
	const kanbanBoardCardIdentityCandidates = await createRuntimeTrpcClient(null)
		.workUnit.resolveKanbanBoardCardIdentityByBareTaskId.query({ bareTaskId: input.taskId })
		.then((response) => response.kanbanBoardCardIdentityCandidates)
		.catch(() => null);
	if (!kanbanBoardCardIdentityCandidates || kanbanBoardCardIdentityCandidates.length === 0) {
		throw new Error(
			kanbanBoardCardIdentityCandidates === null
				? `${notFoundMessage}, and the cross-project lookup through the Kanban runtime is unavailable.`
				: `${notFoundMessage}, and no other project knows this task id.`,
		);
	}
	const describeCandidateLocations = () =>
		kanbanBoardCardIdentityCandidates
			.map(
				(candidate) =>
					`${candidate.workspaceRepositoryPath ?? candidate.kanbanBoardCard.workspaceId}${candidate.permanentlyRemovedFromBoardAt !== null ? " (permanently removed)" : ""}`,
			)
			.join(", ");
	if (explicitProjectPath) {
		throw new Error(
			`${notFoundMessage}; it is known in: ${describeCandidateLocations()}. Omit --project-path to resolve it across projects.`,
		);
	}
	const liveCandidates = kanbanBoardCardIdentityCandidates.filter(
		(candidate) => candidate.permanentlyRemovedFromBoardAt === null,
	);
	if (liveCandidates.length === 0) {
		// 墓碑：卡已永久删除，id 仍能解析出它是什么、在哪、何时删的。
		return {
			ok: true,
			taskPermanentlyRemovedFromBoard: true,
			permanentlyRemovedTaskIdentityTombstones: kanbanBoardCardIdentityCandidates,
		};
	}
	const [onlyLiveCandidate, ...otherLiveCandidates] = liveCandidates;
	if (!onlyLiveCandidate || otherLiveCandidates.length > 0) {
		throw new Error(
			`Task id "${input.taskId}" matches more than one Kanban task card (${describeCandidateLocations()}); pass --project-path to choose one.`,
		);
	}
	// 以下只有唯一一个活卡候选：定位或读取不到它时如实报「在哪、为何读不到」，绝不误报「匹配多张卡」。
	const onlyLiveCandidateRepositoryPath = onlyLiveCandidate.workspaceRepositoryPath;
	if (!onlyLiveCandidateRepositoryPath) {
		throw new Error(
			`${notFoundMessage}; the global task identity registry places it in workspace ${onlyLiveCandidate.kanbanBoardCard.workspaceId}, which is not a project the Kanban runtime currently knows (no repository path is recorded for it), so it cannot be read across projects. Add that project to Kanban and pass --project-path <that project's path> to read it.`,
		);
	}
	const describeCrossProjectReadFailure = (failureReason: string) =>
		`${notFoundMessage}; the cross-project lookup through the global task identity registry places it in ${onlyLiveCandidateRepositoryPath}, but reading it there failed: ${failureReason}`;
	let taskInOwningWorkspace: JsonRecord | null;
	try {
		const owningWorkspace = await resolveRuntimeWorkspace(onlyLiveCandidateRepositoryPath, input.cwd, {
			autoCreateIfMissing: false,
		});
		taskInOwningWorkspace = await getTaskFromRuntimeWorkspace(owningWorkspace, input.taskId);
	} catch (error) {
		throw new Error(describeCrossProjectReadFailure(toErrorMessage(error)));
	}
	if (!taskInOwningWorkspace) {
		throw new Error(
			describeCrossProjectReadFailure(
				"that project's board has no task with this id (the card may have been moved away, or the registry may lag behind the board).",
			),
		);
	}
	return { ...taskInOwningWorkspace, resolvedAcrossProjectsThroughGlobalTaskIdentityRegistry: true };
}

async function getTaskFromRuntimeWorkspace(
	workspace: Awaited<ReturnType<typeof resolveRuntimeWorkspace>>,
	taskId: string,
): Promise<JsonRecord | null> {
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const found = findTaskRecord(state, taskId);
	if (!found) {
		return null;
	}

	// worktree 路径与 HEAD 状态由运行时给出而非本地拼接：调用方通常正是为了「进到那个目录去」才来查的，
	// 顺带还能知道 worktree 是否仍然存在。取不到时不让整条命令失败——任务本身的信息仍然有用。
	const taskWorkspaceInfo = await runtimeClient.workspace.getTaskContext
		.query({
			taskId: found.task.id,
			baseRef: found.task.baseRef,
			...(found.task.worktreeMode ? { worktreeMode: found.task.worktreeMode } : {}),
		})
		.catch(() => null);

	// C5（dd2db 1b 起）：只输出记录型邻域；门段落在阶段 3 加入。关系读不到不让整条命令失败，如实给出原因。
	const workUnitRelationNeighborhood = await runtimeClient.workUnit.getRelationNeighborhoodSummary
		.query({
			workUnit: {
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
				bareTaskId: found.task.id,
				workspaceId: workspace.workspaceId,
			},
		})
		.then((response) => ({
			recordedRelationCount: response.recordedRelations.length,
			renderedNeighborhoodSummaryText: response.renderedNeighborhoodSummaryText,
		}))
		.catch((error: unknown) => ({ neighborhoodUnavailableReason: toErrorMessage(error) }));

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		task: formatTaskRecord(state, found.task, found.columnId),
		taskWorkspace: taskWorkspaceInfo,
		workUnitRelationNeighborhood,
	};
}

interface TaskCreateCommandInput {
	cwd: string;
	title?: string;
	prompt: string;
	projectPath?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId;
	clineSettings?: RuntimeTaskClineSettings;
	taskAgentSessionInitialization?: RuntimeTaskAgentSessionInitialization;
	parentSessionId?: string;
	worktreeMode?: RuntimeTaskWorktreeMode;
	prepFilePath?: string;
	/** 见 `--expect-resolved-settings-fingerprint`：不匹配就不建卡。 */
	expectResolvedSettingsFingerprint?: string;
}

function toTaskCreateRequestedSettings(input: TaskCreateCommandInput): TaskCreateRequestedSettings {
	return {
		title: input.title,
		prompt: input.prompt,
		baseRef: input.baseRef,
		startInPlanMode: input.startInPlanMode,
		taskAgentPermissionMode: input.taskAgentPermissionMode,
		autoReviewEnabled: input.autoReviewEnabled,
		autoReviewMode: input.autoReviewMode,
		agentId: input.agentId,
		clineSettings: input.clineSettings,
		taskAgentSessionInitialization: input.taskAgentSessionInitialization,
		parentSessionId: input.parentSessionId,
		worktreeMode: input.worktreeMode,
		prepFilePath: input.prepFilePath,
	};
}

/**
 * `--preview`：把「这条命令真跑起来会建出什么」算出来，**不建卡、不注册项目**。
 *
 * 只读到什么程度：不调用 `ensureRuntimeWorkspace`（那是 tRPC `projects.add`，一次写入），也不走
 * `loadWorkspaceContext` 的 autoCreateIfMissing 路径（它会写工作区索引）。项目还没注册进 Kanban 时
 * 不报错，改成一条告警继续预览——那恰恰是最需要先看一眼的场景。它也不需要运行时服务器在跑。
 *
 * 唯一可能落盘的东西：`loadRuntimeConfig` 在**首次**运行时会 bootstrap 全局 `~/.cline/kanban/config.json`
 * （探测默认 agent 并写下）。那是任何一条 `kanban` 命令都会做的全局初始化，与本次预览要预览的东西
 * （看板、项目注册表、任务 worktree）无关，且幂等；不为它单造一条只读配置加载路径。
 */
async function previewTaskCreate(input: TaskCreateCommandInput): Promise<JsonRecord> {
	const registeredWorkspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	}).catch(() => null);

	const workspaceRepoPath =
		registeredWorkspace?.repoPath ??
		(await resolveWorkspacePath(
			(input.projectPath ?? "").trim() ? resolveProjectInputPath(input.projectPath ?? "", input.cwd) : input.cwd,
		));
	// 未注册的项目没有看板可读，现有任务视为空——这正确：它一张卡都还没有。
	// 读看板而不是整份 state：后者会重跑一遍 detectGitRepositoryInfo，而 git 现状上面已经拿到了。
	const existingBoardColumns = registeredWorkspace
		? (await loadWorkspaceBoardById(registeredWorkspace.workspaceId)).columns
		: [];

	const effectiveSettings = await resolveTaskCreateEffectiveSettings({
		workspaceRepoPath,
		workspaceId: registeredWorkspace?.workspaceId ?? null,
		isProjectRegisteredInKanban: registeredWorkspace !== null,
		wasProjectPathExplicitlyRequested: (input.projectPath ?? "").trim().length > 0,
		repositoryGitInfo: registeredWorkspace?.git ?? detectGitRepositoryInfo(workspaceRepoPath),
		existingBoardColumns,
		runtimeConfig: await loadRuntimeConfig(workspaceRepoPath),
		requested: toTaskCreateRequestedSettings(input),
	});

	return {
		ok: true,
		preview: true,
		taskCreated: false,
		resolvedSettings: effectiveSettings.resolvedSettings,
		// resolvedSettings.baseRef.source 只分到「显式 / 记忆 / 从 git 状态推出」三档；具体是默认分支、
		// 当前分支还是分支列表第一条，差别足以改变调用方要不要干预，所以细分保留在这里。
		baseRefProvenance: effectiveSettings.baseRefResolution.provenance,
		resolvedSettingsFingerprint: effectiveSettings.resolvedSettingsFingerprint,
		warnings: effectiveSettings.warnings,
		needsAttention: effectiveSettings.needsAttention,
		// 预览拿不到 taskId，所以给不出确切的 worktree 路径；给出父目录 + 模式，足以判断「会不会动主 checkout」。
		taskWorkspaceParentDirectory: getTaskWorktreesHomePath(),
		notes: [
			"Nothing was created. Re-run without --preview to create the task.",
			"Pass --expect-resolved-settings-fingerprint <resolvedSettingsFingerprint> on the real create to fail closed if anything drifted in between.",
			"--base-ref is a one-shot override; it never changes the base ref remembered for this project.",
		],
	};
}

async function createTask(input: TaskCreateCommandInput): Promise<JsonRecord> {
	// 复用这一次已经解析出来的 workspace context，而不是再走一趟 loadWorkspaceState：后者内部会重跑
	// detectGitRepositoryInfo（4 个以上同步 git 子进程），在建卡这条本就要跑一遍的路径上等于把 git
	// 探测的开销翻倍——机器一忙就是好几秒。看板另外单独读一次（纯文件读，不碰 git）。
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd);
	const workspaceRepoPath = workspace.repoPath;
	const [runtimeConfig, boardBeforeCreate] = await Promise.all([
		loadRuntimeConfig(workspaceRepoPath),
		loadWorkspaceBoardById(workspace.workspaceId),
	]);
	const effectiveSettings = await resolveTaskCreateEffectiveSettings({
		workspaceRepoPath,
		workspaceId: workspace.workspaceId,
		isProjectRegisteredInKanban: true,
		wasProjectPathExplicitlyRequested: (input.projectPath ?? "").trim().length > 0,
		repositoryGitInfo: workspace.git,
		existingBoardColumns: boardBeforeCreate.columns,
		runtimeConfig,
		requested: toTaskCreateRequestedSettings(input),
	});

	// 指纹校验刻意排在 ensureRuntimeWorkspace（tRPC `projects.add`，一次写入）**之前**：一次 fail closed
	// 的建卡应当什么都没改，而不是「卡没建成、项目却已经被登记进看板」。
	const expectedFingerprint = (input.expectResolvedSettingsFingerprint ?? "").trim();
	if (expectedFingerprint && expectedFingerprint !== effectiveSettings.resolvedSettingsFingerprint) {
		// fail closed 必须同时体现在 JSON 与退出码上：调用方通常先看退出码再解析输出，只返回
		// `ok:false` 会让一次「没建成」在 shell 层面看起来和成功一模一样。
		process.exitCode = 1;
		return {
			ok: false,
			taskCreated: false,
			error:
				"Resolved task settings changed since the preview: expected fingerprint " +
				`${expectedFingerprint}, got ${effectiveSettings.resolvedSettingsFingerprint}. Nothing was created.`,
			resolvedSettings: effectiveSettings.resolvedSettings,
			baseRefProvenance: effectiveSettings.baseRefResolution.provenance,
			resolvedSettingsFingerprint: effectiveSettings.resolvedSettingsFingerprint,
			warnings: effectiveSettings.warnings,
			needsAttention: effectiveSettings.needsAttention,
		};
	}

	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	const resolvedBaseRef = effectiveSettings.resolvedSettings.baseRef.value;
	if (!resolvedBaseRef) {
		throw new Error("Could not determine task base branch for this workspace.");
	}
	// effective settings 已在本进程解析完（指纹校验也已通过），runtime 只负责分配 task id 并落盘。
	const createMutation = await applyKanbanCliTaskBoardMutationThroughRuntime(runtimeClient, {
		kanbanCliTaskBoardMutationKind: "create_backlog_task_card",
		backlogTaskCardFieldValuesResolvedByKanbanCli: {
			title: input.title,
			prompt: input.prompt,
			startInPlanMode: effectiveSettings.resolvedSettings.startInPlanMode.value,
			ompAgentSessionTransportForNewTasks: runtimeConfig.ompAgentSessionTransportForNewTasks,
			// --agent-id 省略时这张卡实际会跑工作区默认 agent；固化判据要看后者，否则
			// 「工作区默认是 omp」的新卡不落通道，之后改全局默认会反向改掉它。
			workspaceDefaultAgentIdForNewTasks: runtimeConfig.selectedAgentId,
			taskAgentPermissionMode: effectiveSettings.resolvedSettings.requestedTaskAgentPermissionMode.value,
			autoReviewEnabled: input.autoReviewEnabled,
			autoReviewMode: input.autoReviewMode,
			agentId: input.agentId,
			clineSettings: input.clineSettings,
			taskAgentSessionInitialization: input.taskAgentSessionInitialization,
			baseRef: resolvedBaseRef,
			parentSessionId: input.parentSessionId,
			worktreeMode: input.worktreeMode,
			prepFilePath: input.prepFilePath,
		},
	});
	const created = createMutation.createdBacklogTaskCard;

	return {
		ok: true,
		taskCreated: true,
		// 「从不拦」的代价是偏差只能事后揭示，所以真实建卡的响应也带上这三样：调用方不必先跑一次
		// --preview 才能发现权限档是全放行、或 base ref 用的是这个项目记住的那条分支。
		resolvedSettings: effectiveSettings.resolvedSettings,
		baseRefProvenance: effectiveSettings.baseRefResolution.provenance,
		resolvedSettingsFingerprint: effectiveSettings.resolvedSettingsFingerprint,
		warnings: effectiveSettings.warnings,
		needsAttention: effectiveSettings.needsAttention,
		task: {
			id: created.id,
			column: "backlog",
			workspacePath: workspaceRepoPath,
			title: created.title,
			prompt: created.prompt,
			baseRef: created.baseRef,
			startInPlanMode: created.startInPlanMode,
			taskAgentPermissionMode: created.taskAgentPermissionMode ?? DEFAULT_TASK_AGENT_PERMISSION_MODE,
			autoReviewEnabled: created.autoReviewEnabled === true,
			autoReviewMode: created.autoReviewMode ?? "commit",
			...(created.agentId ? { agentId: created.agentId } : {}),
			...formatTaskClineSettings(created.clineSettings),
			...(created.taskAgentSessionInitialization
				? { taskAgentSessionInitialization: created.taskAgentSessionInitialization }
				: {}),
			...(created.parentSessionId ? { parentSessionId: created.parentSessionId } : {}),
			worktreeMode: created.worktreeMode ?? "branch",
			...(created.prepFilePath ? { prepFilePath: created.prepFilePath } : {}),
		},
	};
}

async function updateTaskCommand(input: {
	cwd: string;
	taskId: string;
	title?: string;
	projectPath?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	taskAgentPermissionMode?: RuntimeTaskAgentPermissionMode;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId | null;
	clineProviderId?: string | null;
	clineModelId?: string | null;
	clineReasoningEffort?: ParsedTaskClineReasoningEffort;
	taskAgentSessionInitializationId?: string | null;
	taskAgentSessionInitializationMode?: RuntimeTaskAgentSessionInitializationReuseMode;
	parentSessionId?: string | null;
	worktreeMode?: RuntimeTaskWorktreeMode | null;
	prepFilePath?: string | null;
}): Promise<JsonRecord> {
	if (
		input.title === undefined &&
		input.prompt === undefined &&
		input.baseRef === undefined &&
		input.startInPlanMode === undefined &&
		input.taskAgentPermissionMode === undefined &&
		input.autoReviewEnabled === undefined &&
		input.autoReviewMode === undefined &&
		input.agentId === undefined &&
		input.clineProviderId === undefined &&
		input.clineModelId === undefined &&
		input.clineReasoningEffort === undefined &&
		input.taskAgentSessionInitializationId === undefined &&
		input.taskAgentSessionInitializationMode === undefined &&
		input.parentSessionId === undefined &&
		input.worktreeMode === undefined &&
		input.prepFilePath === undefined
	) {
		throw new Error("task update requires at least one field to change.");
	}

	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	// 只传原始输入：与卡片现值的合并在 runtime 的 board 锁内对最新卡片进行，CLI 这边不做读-改-写，
	// 否则两次读写之间别人的更新会被这次整卡回写抹掉。
	const updated = await runtimeClient.taskCardAction.updateTaskCardFieldValues.mutate({
		taskId: input.taskId,
		taskCardFieldUpdate: {
			taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
			kanbanCliTaskCardFieldUpdateRawInput: {
				title: input.title,
				prompt: input.prompt,
				baseRef: input.baseRef,
				startInPlanMode: input.startInPlanMode,
				taskAgentPermissionMode: input.taskAgentPermissionMode,
				autoReviewEnabled: input.autoReviewEnabled,
				autoReviewMode: input.autoReviewMode,
				agentId: input.agentId,
				clineProviderId: input.clineProviderId,
				clineModelId: input.clineModelId,
				clineReasoningEffort: input.clineReasoningEffort,
				taskAgentSessionInitializationId: input.taskAgentSessionInitializationId,
				taskAgentSessionInitializationMode: input.taskAgentSessionInitializationMode,
				parentSessionId: input.parentSessionId,
				worktreeMode: input.worktreeMode,
				prepFilePath: input.prepFilePath,
			},
		},
	});
	const updatedTaskCardSnapshot = updated.taskCardSnapshotAfterAction;

	return {
		ok: true,
		task: formatTaskRecordWithSessionSummary(
			updatedTaskCardSnapshot.taskCard,
			updatedTaskCardSnapshot.boardColumnIdContainingTaskCard,
			updatedTaskCardSnapshot.taskSessionSummaryPersistedInWorkspaceSessionsFile,
		),
		workspacePath: workspaceRepoPath,
	};
}

async function startTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	// runtime 一次做完：只收 backlog / in_progress 的卡 → 先移列到 in_progress → ensure worktree → 起会话
	// （会话已在 agent 回合就不重复起）。卡不存在 / 所在列不允许时 runtime 抛错，原文案与迁移前 CLI 本地报错一致。
	const started = await runtimeClient.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress.mutate({
		taskId: input.taskId,
	});
	// 执行期失败时卡已留在 in_progress（backlog 单向）；命令照旧以失败退出，带回 runtime 给的原因。
	if (
		started.agentSessionStartOutcome === "task_worktree_ensure_failed" ||
		started.agentSessionStartOutcome === "agent_session_start_failed"
	) {
		throw new Error(
			started.agentSessionStartFailureMessage ??
				(started.agentSessionStartOutcome === "task_worktree_ensure_failed"
					? "Could not ensure task worktree."
					: "Could not start task session."),
		);
	}
	const startedTaskCard = started.taskCardSnapshotAfterAction.taskCard;
	const startedTaskRecord = {
		id: startedTaskCard.id,
		prompt: startedTaskCard.prompt,
		column: "in_progress",
		workspacePath: workspaceRepoPath,
	};

	if (!started.taskCardWasMovedIntoInProgressColumnByThisAction) {
		return {
			ok: true,
			message: `Task "${input.taskId}" is already in progress.`,
			task: startedTaskRecord,
		};
	}

	return {
		ok: true,
		task: startedTaskRecord,
	};
}

// 「park」：标记一个已 dispatch 后台工作、正等其完成的 in-progress 终端 agent 任务，使它结束本轮发出的裸 Stop
// 不再被误判为「等用户审查」而误发通知。供外部编排（RVF / 自研 Kanban）在让 agent 结束这一轮**之前** await。
async function parkTask(input: {
	cwd: string;
	taskId: string;
	label?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const label = input.label?.trim() || undefined;
	const response = await runtimeClient.runtime.parkTaskAwaitingDispatchedBackgroundWork.mutate({
		taskId: input.taskId,
		...(label ? { label } : {}),
	});
	if (!response.ok) {
		throw new Error(response.error ?? `Could not park task "${input.taskId}".`);
	}
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		taskId: input.taskId,
		parked: true,
		...(label ? { label } : {}),
	};
}

// 「unpark」：显式清 park（兜底，供不走 followup 的恢复路径）。幂等——未 parked 也成功返回。
async function unparkTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const response = await runtimeClient.runtime.unparkTaskAwaitingDispatchedBackgroundWork.mutate({
		taskId: input.taskId,
	});
	if (!response.ok) {
		throw new Error(response.error ?? `Could not unpark task "${input.taskId}".`);
	}
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		taskId: input.taskId,
		parked: false,
	};
}

// 「is-parked」：查询某任务当前是否 parked（源自运行时内存 getSummary 的 sidecar）。RVF stop-hook 先查 Kanban、
// 查询出错才回落旧文件启发式，Kanban 在分歧时权威。
async function isTaskParkedCommand(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const response = await runtimeClient.runtime.isTaskParkedAwaitingDispatchedBackgroundWork.query({
		taskId: input.taskId,
	});
	if (!response.ok) {
		throw new Error(response.error ?? `Could not query park state for task "${input.taskId}".`);
	}
	return {
		ok: true,
		workspacePath: workspace.repoPath,
		taskId: input.taskId,
		parked: response.parked,
		label: response.label,
		sinceMs: response.sinceMs,
	};
}

interface TrashTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	worktreeDeleted: boolean;
	worktreeDeleteError?: string;
	alreadyInTrash: boolean;
}

function toTrashTaskExecutionResult(
	taskId: string,
	movedIntoDone: RuntimeTaskCardActionMoveIntoDoneResponse,
): TrashTaskExecutionResult {
	const movedTaskCardSnapshot = movedIntoDone.taskCardSnapshotAfterAction;
	return {
		task: formatTaskRecordWithSessionSummary(
			movedTaskCardSnapshot.taskCard,
			"trash",
			movedTaskCardSnapshot.taskSessionSummaryPersistedInWorkspaceSessionsFile,
		),
		taskId,
		previousColumnId: movedIntoDone.boardColumnIdOfTaskCardBeforeAction,
		worktreeDeleted: movedIntoDone.taskWorktreeDeletionResult?.taskWorktreeWasRemoved ?? false,
		worktreeDeleteError: movedIntoDone.taskWorktreeDeletionResult?.taskWorktreeDeletionErrorMessage ?? undefined,
		alreadyInTrash: movedIntoDone.taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan,
	};
}

// 移入 Done 的整条副作用链（Post-Deploy Verification 门禁 → 移列 → 停 agent 会话与详情 shell 终端 → 删 worktree）都在 runtime 的
// taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree 里执行；CLI 只把响应摊成旧 JSON 字段。
// 受门禁的任务有未勾核对项而没给原因时 runtime 拒绝（PRECONDITION_FAILED + 机读前缀），这里转成可读的拒绝而不是整条命令失败。
type TrashTaskByIdOutcome =
	| { trashTaskByIdOutcomeKind: "moved_into_done_or_already_done"; trashed: TrashTaskExecutionResult }
	| {
			trashTaskByIdOutcomeKind: "rejected_by_post_deploy_verification_done_entry_gate";
			taskId: string;
			postDeployVerificationDoneEntryGateRejectionMessage: string;
	  };

async function trashTaskById(input: {
	taskId: string;
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
	postDeployVerificationDoneEntryClosure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined;
}): Promise<TrashTaskByIdOutcome> {
	try {
		const movedIntoDone =
			await input.runtimeClient.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree.mutate({
				taskId: input.taskId,
				...(input.postDeployVerificationDoneEntryClosure
					? { postDeployVerificationDoneEntryClosure: input.postDeployVerificationDoneEntryClosure }
					: {}),
			});
		return {
			trashTaskByIdOutcomeKind: "moved_into_done_or_already_done",
			trashed: toTrashTaskExecutionResult(input.taskId, movedIntoDone),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			!message.includes(
				POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX,
			)
		) {
			throw error;
		}
		return {
			trashTaskByIdOutcomeKind: "rejected_by_post_deploy_verification_done_entry_gate",
			taskId: input.taskId,
			postDeployVerificationDoneEntryGateRejectionMessage: `${message
				.slice(
					message.indexOf(
						POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX,
					) +
						POST_DEPLOY_VERIFICATION_DONE_ENTRY_REQUIRES_UNCHECKED_ITEM_CLOSURE_REASONS_ERROR_MESSAGE_PREFIX.length,
				)
				.trim()} Re-run with --closure-reason-for-all-unchecked-items <code> [--closure-reason-text <text>] or --closure-reasons-file <path>.`,
		};
	}
}

async function trashTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
	postDeployVerificationDoneEntryClosure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task done");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		const outcome = await trashTaskById({
			taskId: target.taskId,
			runtimeClient,
			postDeployVerificationDoneEntryClosure: input.postDeployVerificationDoneEntryClosure,
		});
		if (outcome.trashTaskByIdOutcomeKind === "rejected_by_post_deploy_verification_done_entry_gate") {
			return {
				ok: false,
				error: outcome.postDeployVerificationDoneEntryGateRejectionMessage,
				rejectedByPostDeployVerificationDoneEntryGate: true,
				workspacePath: workspaceRepoPath,
			};
		}
		const trashed = outcome.trashed;
		if (trashed.alreadyInTrash) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already done.`,
				task: trashed.task,
				workspacePath: workspaceRepoPath,
			};
		}
		return {
			ok: true,
			task: trashed.task,
			workspacePath: workspaceRepoPath,
			worktreeDeleted: trashed.worktreeDeleted,
			worktreeDeleteError: trashed.worktreeDeleteError,
		};
	}

	const initialState = await runtimeClient.workspace.getState.query();
	const targetTasks = findTasksInColumn(initialState, target.column);
	if (targetTasks.length === 0) {
		return {
			ok: true,
			column: target.column,
			workspacePath: workspaceRepoPath,
			trashedTasks: [],
			alreadyTrashedTasks: [],
			worktreeCleanup: [],
			rejectedByPostDeployVerificationDoneEntryGate: [],
			count: 0,
		};
	}

	const results: TrashTaskExecutionResult[] = [];
	const rejectedByPostDeployVerificationDoneEntryGate: Array<{ taskId: string; error: string }> = [];
	for (const { task } of targetTasks) {
		const outcome = await trashTaskById({
			taskId: task.id,
			runtimeClient,
			postDeployVerificationDoneEntryClosure: input.postDeployVerificationDoneEntryClosure,
		});
		if (outcome.trashTaskByIdOutcomeKind === "rejected_by_post_deploy_verification_done_entry_gate") {
			rejectedByPostDeployVerificationDoneEntryGate.push({
				taskId: outcome.taskId,
				error: outcome.postDeployVerificationDoneEntryGateRejectionMessage,
			});
			continue;
		}
		results.push(outcome.trashed);
	}

	const trashedTasks = results.filter((result) => !result.alreadyInTrash);
	const alreadyTrashedTasks = results.filter((result) => result.alreadyInTrash);

	return {
		ok: rejectedByPostDeployVerificationDoneEntryGate.length === 0,
		column: target.column,
		workspacePath: workspaceRepoPath,
		trashedTasks: trashedTasks.map((result) => result.task),
		alreadyTrashedTasks: alreadyTrashedTasks.map((result) => result.task),
		worktreeCleanup: trashedTasks.map((result) => ({
			taskId: result.taskId,
			removed: result.worktreeDeleted,
			error: result.worktreeDeleteError,
		})),
		rejectedByPostDeployVerificationDoneEntryGate,
		count: trashedTasks.length,
	};
}

async function deleteTaskCommand(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task delete");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	// 整条收尾链（board 删卡 → 清编辑草稿 → 清排队 prompt → 停会话 → 删 worktree → 最后批删 turn checkpoint ref）
	// 都在 runtime 的 taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup 里按这个顺序执行。
	const deleted = await runtimeClient.taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup.mutate({
		permanentlyDeletedTaskCardSelection:
			target.kind === "task"
				? {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: [target.taskId],
					}
				: {
						permanentlyDeletedTaskCardSelectionKind: "every_task_card_in_board_column",
						selectedBoardColumnId: target.column,
					},
	});
	const permanentlyDeletedTaskCards = deleted.permanentlyDeletedTaskCards;

	if (permanentlyDeletedTaskCards.length === 0) {
		return {
			ok: true,
			workspacePath: workspaceRepoPath,
			column: target.kind === "column" ? target.column : null,
			deletedTasks: [],
			count: 0,
		};
	}

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		column: target.kind === "column" ? target.column : null,
		deletedTasks: permanentlyDeletedTaskCards.map(
			({
				deletedTaskCard,
				boardColumnIdOfDeletedTaskCardBeforeDeletion,
				taskSessionSummaryPersistedInWorkspaceSessionsFileBeforeDeletion,
			}) =>
				formatTaskRecordWithSessionSummary(
					deletedTaskCard,
					boardColumnIdOfDeletedTaskCardBeforeDeletion,
					taskSessionSummaryPersistedInWorkspaceSessionsFileBeforeDeletion,
				),
		),
		count: permanentlyDeletedTaskCards.length,
		worktreeCleanup: permanentlyDeletedTaskCards.map(({ deletedTaskCard, taskWorktreeDeletionResult }) => ({
			taskId: deletedTaskCard.id,
			removed: taskWorktreeDeletionResult.taskWorktreeWasRemoved,
			error: taskWorktreeDeletionResult.taskWorktreeDeletionErrorMessage ?? undefined,
		})),
	};
}

// 注入账本的读写全部下沉到 src/core/task-message-injection-ledger.ts —— CLI 与 runtime 必须共用
// 同一份真相与同一把跨进程锁，否则 runtime 就无法在 CLI 退出后把 pending 改写成终态。

interface TaskMessageCommandResult extends JsonRecord {
	ok: true;
	task_id: string;
	idempotency_key: string;
	message_id: string;
	terminal_delivery_status: TaskMessageTerminalDeliveryStatus;
	terminal_delivery_failure_reason?: TaskMessageTerminalDeliveryFailureReason;
	terminal_delivery_status_updated_at: string;
	attempt_id?: string;
	turn_id?: string;
	checkpoint_id?: string;
	status?: string;
	// ↓ 仅 --deliver-when-agent-idle 的记录才有。pending 且 gate_passed_at 为 null ⇒ 还卡在 agent 空闲门；
	// 非 null ⇒ 已交给终端投递、卡在终端门。契约：terminal-delivery-interface-contract.md § agent 空闲门控的排队投递。
	agent_idle_wait_deadline_at?: string;
	agent_idle_gate_passed_at?: string | null;
}

function hashPrompt(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function toTaskMessageCommandResult(record: TaskMessageInjectionRecord): TaskMessageCommandResult {
	return {
		ok: true,
		task_id: record.task_id,
		idempotency_key: record.idempotency_key,
		message_id: record.message_id,
		terminal_delivery_status: record.terminal_delivery_status,
		...(record.terminal_delivery_failure_reason
			? { terminal_delivery_failure_reason: record.terminal_delivery_failure_reason }
			: {}),
		terminal_delivery_status_updated_at: record.terminal_delivery_status_updated_at,
		...(record.attempt_id ? { attempt_id: record.attempt_id } : {}),
		...(record.turn_id ? { turn_id: record.turn_id } : {}),
		...(record.checkpoint_id ? { checkpoint_id: record.checkpoint_id } : {}),
		...(record.status ? { status: record.status } : {}),
		...(record.agent_idle_wait_deadline_at
			? {
					agent_idle_wait_deadline_at: record.agent_idle_wait_deadline_at,
					agent_idle_gate_passed_at: record.agent_idle_gate_passed_at ?? null,
				}
			: {}),
	};
}

// --deliver-when-agent-idle 与 --max-wait-for-agent-idle-ms 必须成对出现。等多久是调用方的策略，不给默认值：
// 一个看不见的默认上限，等于替调用方决定「晚问多久就不该再问了」。
export function resolveTaskMessageAgentIdleGateOptions(input: {
	deliverWhenAgentIdle: boolean;
	maxWaitForAgentIdleMs: number | undefined;
	maxWaitForAgentIdleUpperBoundMs: number;
}): { maxWaitForAgentIdleMs: number } | null {
	if (!input.deliverWhenAgentIdle) {
		if (input.maxWaitForAgentIdleMs !== undefined) {
			throw new Error("--max-wait-for-agent-idle-ms requires --deliver-when-agent-idle.");
		}
		return null;
	}
	if (input.maxWaitForAgentIdleMs === undefined) {
		throw new Error("--deliver-when-agent-idle requires --max-wait-for-agent-idle-ms.");
	}
	if (input.maxWaitForAgentIdleMs > input.maxWaitForAgentIdleUpperBoundMs) {
		throw new Error(
			`--max-wait-for-agent-idle-ms must not exceed ${input.maxWaitForAgentIdleUpperBoundMs} (24 hours).`,
		);
	}
	return { maxWaitForAgentIdleMs: input.maxWaitForAgentIdleMs };
}

function resolvePromptInput(input: { prompt?: string; promptFile?: string }): Promise<string> {
	const prompt = input.prompt?.trim();
	const promptFile = input.promptFile?.trim();
	if (prompt && promptFile) {
		throw new Error("task message accepts exactly one of --prompt-file or --prompt.");
	}
	if (promptFile) {
		return readFile(promptFile, "utf8");
	}
	if (prompt) {
		return Promise.resolve(prompt);
	}
	throw new Error("task message requires --prompt-file or --prompt.");
}

async function sendTaskMessageCommand(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	promptFile?: string;
	prompt?: string;
	source: string;
	idempotencyKey: string;
	attemptId?: string;
	waitForTerminalStatus?: boolean;
	waitTimeoutMs?: number;
	deliverWhenAgentIdle?: boolean;
	maxWaitForAgentIdleMs?: number;
}): Promise<TaskMessageCommandResult> {
	const agentIdleGate = resolveTaskMessageAgentIdleGateOptions({
		deliverWhenAgentIdle: input.deliverWhenAgentIdle ?? false,
		maxWaitForAgentIdleMs: input.maxWaitForAgentIdleMs,
		maxWaitForAgentIdleUpperBoundMs: MAX_WAIT_FOR_AGENT_IDLE_UPPER_BOUND_MS,
	});
	const taskId = input.taskId.trim();
	if (!taskId) {
		throw new Error("task message requires --task-id.");
	}
	const source = input.source.trim();
	if (!source) {
		throw new Error("task message requires --source.");
	}
	const idempotencyKey = input.idempotencyKey.trim();
	if (!idempotencyKey) {
		throw new Error("task message requires --idempotency-key.");
	}
	const attemptId = input.attemptId?.trim() || undefined;
	if (attemptId && attemptId !== taskId) {
		throw new Error(`Attempt "${attemptId}" does not belong to task "${taskId}".`);
	}
	const prompt = await resolvePromptInput({ prompt: input.prompt, promptFile: input.promptFile });
	if (!prompt.trim()) {
		throw new Error("task message prompt cannot be empty.");
	}
	const promptSha256 = hashPrompt(prompt);
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const taskRecord = findTaskRecord(state, taskId);
	if (!taskRecord) {
		throw new Error(`Task "${taskId}" was not found in workspace ${workspace.repoPath}.`);
	}

	const ledgerPath = getTaskMessageInjectionLedgerPath(workspace.statePath);

	// agent 空闲门控的排队投递：账本记录由 runtime 在同一次调用里建并入队（理由见
	// src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue.ts 文件头）。CLI 只负责把回执读出来。
	// runtime 够不到 / 版本还没有这个入口时直接报错（ok:false，退出码 1），**不留账本记录**——与立即投递不同，
	// 那边的记录是 CLI 自己先建的，所以得由 CLI 落失败。
	if (agentIdleGate !== null) {
		const enqueueResponse = await runtimeClient.runtime.enqueueAgentIdleGatedProgrammaticTaskChatMessage.mutate({
			taskId,
			text: prompt,
			source,
			idempotencyKey,
			promptSha256,
			...(attemptId ? { attemptId } : {}),
			maxWaitForAgentIdleMs: agentIdleGate.maxWaitForAgentIdleMs,
		});
		if (!enqueueResponse.ok) {
			throw new Error(enqueueResponse.error ?? "enqueueAgentIdleGatedProgrammaticTaskChatMessage failed.");
		}
		return await resolveTaskMessageResult({
			ledgerPath,
			taskId,
			idempotencyKey,
			fallbackRecord: null,
			waitForTerminalStatus: input.waitForTerminalStatus ?? false,
			waitTimeoutMs: input.waitTimeoutMs,
		});
	}

	// 第一段（锁内）：幂等判定 + 落一条 pending。
	// 与旧实现的差别：上一条仍 pending 时**不再报错**。pending 现在是合法的、会自行收敛的状态，
	// 报错反而逼得调用方要么盲等要么换 key 重投——后者恰恰会造成重复投递。
	const preflight = await withTaskMessageInjectionLedgerLock<{
		kind: "existing" | "created";
		record: TaskMessageInjectionRecord;
	}>(ledgerPath, async (records) => {
		const existing = findTaskMessageInjectionRecord(records, taskId, idempotencyKey);
		if (existing) {
			if (existing.prompt_sha256 !== promptSha256) {
				throw new Error(
					`Idempotency conflict for task "${taskId}" and key "${idempotencyKey}": prompt hash differs.`,
				);
			}
			return { result: { kind: "existing", record: existing } };
		}
		const pendingRecord = createPendingTaskMessageInjectionRecord({
			taskId,
			...(attemptId ? { attemptId } : {}),
			source,
			idempotencyKey,
			promptSha256,
			nowIso: new Date().toISOString(),
		});
		return { records: [...records, pendingRecord], result: { kind: "created", record: pendingRecord } };
	});

	// 同 key 已存在：直接返回当前记录，不重新投递（idempotency 的定义）。想重投请换新 key。
	if (preflight.kind === "existing") {
		return await resolveTaskMessageResult({
			ledgerPath,
			taskId,
			idempotencyKey,
			fallbackRecord: preflight.record,
			waitForTerminalStatus: input.waitForTerminalStatus ?? false,
			waitTimeoutMs: input.waitTimeoutMs,
		});
	}

	// 第二段（锁外）：真正投递。锁外是必须的——投递要等 runtime 往返，占着账本锁会把 runtime
	// 自己的终态回写堵死（runtime settle 时要拿同一把锁），直接死锁。
	const settleFailure = async (reason: TaskMessageTerminalDeliveryFailureReason) => {
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId,
			idempotencyKey,
			status: "delivery_failed",
			failureReason: reason,
			nowIso: new Date().toISOString(),
		});
	};

	const chatResponse = await runtimeClient.runtime.sendTaskChatMessage
		.mutate({
			taskId,
			text: prompt,
			mode: "act",
			source,
			idempotencyKey,
			promptSha256,
		})
		.catch(async (error: unknown) => {
			// 调用 runtime 本身失败（进程不可达 / 内部错）。此时投递必定没有发生，且终端会话都活在
			// runtime 进程里——runtime 够不到就等于没有活着的终端会话，故 no_active_terminal_session
			// 是准确的（不是权宜之计）。记录保留而非删除：RVF 因此能区分「失败了」与「从没请求过」。
			await settleFailure("no_active_terminal_session");
			throw error;
		});

	const messageId = chatResponse.message?.id ?? null;
	const summary = chatResponse.summary ?? null;
	if (!chatResponse.ok || !messageId || !summary) {
		await settleFailure(chatResponse.terminalDelivery?.reason ?? "no_active_terminal_session");
		const failureResult = await readTaskMessageRecordOrThrow(ledgerPath, taskId, idempotencyKey);
		return toTaskMessageCommandResult(failureResult);
	}

	// runtime 给了即时终态（Cline SDK 通道摄入即确认）就当场落定；给的是 pending 则原样保留，
	// 由 runtime 在确认链跑完后就地改写——这正是「CLI 已退出不再意味着状态不会变」的那一步。
	const checkpoint = summary.latestTurnCheckpoint ?? null;
	const immediateStatus = chatResponse.terminalDelivery?.status ?? "accepted_pending_submit_confirmation";
	if (isTaskMessageTerminalDeliveryStatusSettled(immediateStatus)) {
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath,
			taskId,
			idempotencyKey,
			status: immediateStatus,
			...(chatResponse.terminalDelivery?.reason ? { failureReason: chatResponse.terminalDelivery.reason } : {}),
			...(checkpoint ? { turnId: String(checkpoint.turn), checkpointId: checkpoint.ref } : {}),
			nowIso: new Date().toISOString(),
		});
	} else if (checkpoint) {
		// 仍 pending，但 turn/checkpoint 已知：先补上，别等终态才写（RVF 可能马上就要用）。
		await withTaskMessageInjectionLedgerLock<null>(ledgerPath, async (records) => {
			const current = findTaskMessageInjectionRecord(records, taskId, idempotencyKey);
			if (!current || isTaskMessageTerminalDeliveryStatusSettled(current.terminal_delivery_status)) {
				return { result: null };
			}
			const withCheckpoint: TaskMessageInjectionRecord = {
				...current,
				turn_id: String(checkpoint.turn),
				checkpoint_id: checkpoint.ref,
			};
			return {
				records: records.map((record) => (record === current ? withCheckpoint : record)),
				result: null,
			};
		});
	}

	return await resolveTaskMessageResult({
		ledgerPath,
		taskId,
		idempotencyKey,
		fallbackRecord: null,
		waitForTerminalStatus: input.waitForTerminalStatus ?? false,
		waitTimeoutMs: input.waitTimeoutMs,
	});
}

const TASK_MESSAGE_TERMINAL_STATUS_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const TASK_MESSAGE_TERMINAL_STATUS_POLL_INTERVAL_MS = 500;
// 等待收敛前要留给「读账本 + 打印 JSON + 遥测 flush + 退出」的余量，别卡着硬超时的最后一刻才收手。
const TASK_MESSAGE_TERMINAL_STATUS_WAIT_HARD_TIMEOUT_MARGIN_MS = 2_000;

// --wait-for-terminal-status 的等待必须留在 CLI 硬超时（KANBAN_CLI_HARD_TIMEOUT_MS，默认 35s）之内。
// `kanban task message` 是非 server-style 调用，cli.ts 会给它装硬超时，到点直接 exit(124) 且 **stdout 一个
// 字节都没有**——在最需要诚实回执的场景反而什么都不返回。而契约要求调用方按 190s 设超时，一旦真传
// `--wait-timeout-ms 190000` 就必然撞上这个杀进程。
// 所以宁可提前收敛：超时不代表失败，返回的仍是当时的真实状态（可能仍是 pending），调用方继续用
// message-status 轮询即可。真要在单次调用里等满 190s，请把 KANBAN_CLI_HARD_TIMEOUT_MS 一并调大——
// 这里读的就是同一个环境变量，调大即自动放开。
export function resolveTaskMessageTerminalStatusWaitBudgetMs(input: {
	requestedWaitTimeoutMs: number;
	cliHardTimeoutMs: number;
	elapsedSinceCliStartMs: number;
	marginMs?: number;
}): number {
	const remaining =
		input.cliHardTimeoutMs -
		input.elapsedSinceCliStartMs -
		(input.marginMs ?? TASK_MESSAGE_TERMINAL_STATUS_WAIT_HARD_TIMEOUT_MARGIN_MS);
	if (remaining <= 0) {
		// 预算已经耗尽：不再等待，直接把当前真实状态吐出去，好过被硬超时杀掉后毫无输出。
		return 0;
	}
	return Math.min(input.requestedWaitTimeoutMs, remaining);
}

async function readTaskMessageRecordOrThrow(
	ledgerPath: string,
	taskId: string,
	idempotencyKey: string,
): Promise<TaskMessageInjectionRecord> {
	const records = await readTaskMessageInjectionLedger(ledgerPath);
	const record = findTaskMessageInjectionRecord(records, taskId, idempotencyKey);
	if (!record) {
		throw new Error("unknown_idempotency_key");
	}
	return record;
}

// --wait-for-terminal-status：阻塞到终态或超时。**超时不代表失败**——返回的仍是当时的真实状态
// （可能仍是 pending），调用方继续用 message-status 轮询即可。轮询账本文件而不是订阅 runtime：
// 账本是唯一真相，且这样即便 runtime 中途重启，读到的也是启动清扫写下的诚实结论。
async function resolveTaskMessageResult(input: {
	ledgerPath: string;
	taskId: string;
	idempotencyKey: string;
	fallbackRecord: TaskMessageInjectionRecord | null;
	waitForTerminalStatus: boolean;
	waitTimeoutMs?: number;
}): Promise<TaskMessageCommandResult> {
	if (!input.waitForTerminalStatus) {
		const record =
			input.fallbackRecord ??
			(await readTaskMessageRecordOrThrow(input.ledgerPath, input.taskId, input.idempotencyKey));
		return toTaskMessageCommandResult(record);
	}
	// process.uptime() 是从进程启动算的，而硬超时的计时器装在 run() 开头（更晚一点点），
	// 故这里的 elapsed 只会略微高估——偏保守，正是我们要的方向。
	const timeoutMs = resolveTaskMessageTerminalStatusWaitBudgetMs({
		requestedWaitTimeoutMs: input.waitTimeoutMs ?? TASK_MESSAGE_TERMINAL_STATUS_WAIT_DEFAULT_TIMEOUT_MS,
		cliHardTimeoutMs: resolveCliHardTimeoutMs(),
		elapsedSinceCliStartMs: process.uptime() * 1000,
	});
	const deadlineAt = Date.now() + timeoutMs;
	let latest = await readTaskMessageRecordOrThrow(input.ledgerPath, input.taskId, input.idempotencyKey);
	while (!isTaskMessageTerminalDeliveryStatusSettled(latest.terminal_delivery_status) && Date.now() < deadlineAt) {
		await new Promise((resolve) => setTimeout(resolve, TASK_MESSAGE_TERMINAL_STATUS_POLL_INTERVAL_MS));
		latest = await readTaskMessageRecordOrThrow(input.ledgerPath, input.taskId, input.idempotencyKey);
	}
	return toTaskMessageCommandResult(latest);
}

async function readTaskMessageStatusCommand(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	idempotencyKey: string;
}): Promise<TaskMessageCommandResult> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, { autoCreateIfMissing: false });
	const record = await readTaskMessageRecordOrThrow(
		getTaskMessageInjectionLedgerPath(workspace.statePath),
		input.taskId.trim(),
		input.idempotencyKey.trim(),
	);
	return toTaskMessageCommandResult(record);
}

interface TaskMessageCancelCommandResult extends JsonRecord {
	ok: true;
	task_id: string;
	idempotency_key: string;
	cancel_result: "cancelled_before_delivery" | "already_delivered";
	terminal_delivery_status: TaskMessageTerminalDeliveryStatus;
	terminal_delivery_failure_reason?: TaskMessageTerminalDeliveryFailureReason;
}

// runtime 侧的权威取消结论（tRPC cancelTaskChatDelivery 的 cancelResult）。比对外契约多一个取值：
// no_pending_delivery —— runtime 内存里根本没有这条在途投递（从未到达、已落定、或已被取代）。
type RuntimeTaskChatDeliveryCancelResult = "cancelled_before_delivery" | "already_delivered" | "no_pending_delivery";

// 账本回写是 fire-and-forget 的：runtime 在投递登记 observer 里 void 掉那次「mkdir + 跨进程加锁 + 读 + 写 +
// rename」，所以 tRPC 响应完全可能先于那次写落盘返回。取消后必须给账本一点收敛时间再读，否则读到的仍是
// accepted_pending_submit_confirmation——明明拦下了却报成已送达，正是本轮要根除的撒谎形态。
// 上界同时覆盖「取消晚了」那条路径上确认链自己落定的预算（契约：2.5s × 4 = 10s）。
const TASK_MESSAGE_CANCEL_LEDGER_SETTLE_TIMEOUT_MS = 12_000;
const TASK_MESSAGE_CANCEL_LEDGER_SETTLE_POLL_INTERVAL_MS = 200;

// 取消是幂等的：对同一 key 重复调用返回相同结果、无副作用。
// 判据只看账本终态与 runtime 的在途登记，不新建取消状态机。
async function cancelTaskMessageCommand(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	idempotencyKey: string;
}): Promise<TaskMessageCancelCommandResult> {
	const taskId = input.taskId.trim();
	const idempotencyKey = input.idempotencyKey.trim();
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, { autoCreateIfMissing: false });
	const ledgerPath = getTaskMessageInjectionLedgerPath(workspace.statePath);
	// 先确认这条记录存在（不存在 → unknown_idempotency_key，退出码 1）。
	const before = await readTaskMessageRecordOrThrow(ledgerPath, taskId, idempotencyKey);

	// 已经是终态：取消无事可做，如实回报当时的真实结果（此时不需要 runtime 的结论）。
	if (isTaskMessageTerminalDeliveryStatusSettled(before.terminal_delivery_status)) {
		return buildTaskMessageCancelResult({ record: before, runtimeCancelResult: null });
	}

	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const cancelResponse = await runtimeClient.runtime.cancelTaskChatDelivery.mutate({ taskId, idempotencyKey });
	if (!cancelResponse.ok) {
		// 取消调用本身失败：此时既不知道拦下没有、也不知道送到没有，只能如实报错（ok:false，退出码 1），
		// 绝不能拿一个编出来的 cancel_result 顶上。
		throw new Error(cancelResponse.error ?? "cancelTaskChatDelivery failed.");
	}
	return await resolveTaskMessageCancelResult({
		runtimeCancelResult: cancelResponse.cancelResult,
		readRecord: async () => await readTaskMessageRecordOrThrow(ledgerPath, taskId, idempotencyKey),
	});
}

// 等账本追上 runtime 已经做出的落定，再按最终记录出回执。等待有界；等不到也不编，照实报当时的状态。
export async function resolveTaskMessageCancelResult(input: {
	runtimeCancelResult: RuntimeTaskChatDeliveryCancelResult;
	readRecord: () => Promise<TaskMessageInjectionRecord>;
	settleTimeoutMs?: number;
	pollIntervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<TaskMessageCancelCommandResult> {
	const now = input.now ?? (() => Date.now());
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadlineAt = now() + (input.settleTimeoutMs ?? TASK_MESSAGE_CANCEL_LEDGER_SETTLE_TIMEOUT_MS);
	const pollIntervalMs = input.pollIntervalMs ?? TASK_MESSAGE_CANCEL_LEDGER_SETTLE_POLL_INTERVAL_MS;
	let record = await input.readRecord();
	while (!isTaskMessageTerminalDeliveryStatusSettled(record.terminal_delivery_status) && now() < deadlineAt) {
		await sleep(pollIntervalMs);
		record = await input.readRecord();
	}
	return buildTaskMessageCancelResult({ record, runtimeCancelResult: input.runtimeCancelResult });
}

// cancel_result 是二值的，它回答的只有一件事：**这条消息是否已经确认进入 agent**。
// 谁造成的、有没有残留，由同一份回执里的 terminal_delivery_status / terminal_delivery_failure_reason 承载。
//
// 为什么不能把「已落定的其他失败」也叫 already_delivered（旧实现的做法）：调用方按契约会据此走「已送达」
// 分支，而消息其实要么根本没投出去（no_active_terminal_session 等），要么还躺在输入框里没确认提交
// （submit_confirmation_budget_exhausted）——那正是 2026-08-08 那 49 分钟事故的形态。
function resolveTaskMessageCancelResultValue(
	status: TaskMessageTerminalDeliveryStatus,
	runtimeCancelResult: RuntimeTaskChatDeliveryCancelResult | null,
): "cancelled_before_delivery" | "already_delivered" {
	// 只有「已确认提交给 agent」的两个终态才算已送达。
	if (status === "delivered_and_submit_confirmed" || status === "delivered_queued_behind_active_agent_turn") {
		return "already_delivered";
	}
	// delivery_failed：无论 reason 是什么都不是「已送达」，一律报未送达。
	if (status === "delivery_failed") {
		return "cancelled_before_delivery";
	}
	// 账本收敛超时仍是 pending：退回 runtime 的权威结论。它是唯一知道「这次取消到底拦下了没有」的一方，
	// 而旧实现把它整个丢弃了。no_pending_delivery（runtime 手里没有在途投递）同样不是「已送达」。
	return runtimeCancelResult === "already_delivered" ? "already_delivered" : "cancelled_before_delivery";
}

export function buildTaskMessageCancelResult(input: {
	record: TaskMessageInjectionRecord;
	runtimeCancelResult: RuntimeTaskChatDeliveryCancelResult | null;
}): TaskMessageCancelCommandResult {
	const { record } = input;
	return {
		ok: true,
		task_id: record.task_id,
		idempotency_key: record.idempotency_key,
		cancel_result: resolveTaskMessageCancelResultValue(record.terminal_delivery_status, input.runtimeCancelResult),
		terminal_delivery_status: record.terminal_delivery_status,
		...(record.terminal_delivery_failure_reason
			? { terminal_delivery_failure_reason: record.terminal_delivery_failure_reason }
			: {}),
	};
}

function parsePositiveIntegerOption(value: string, flagName: string): number {
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid value for ${flagName}: "${value}". Use a positive integer.`);
	}
	return parsed;
}

function parseOptionalBooleanOption(value: unknown, flagName: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true || value === false) {
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid boolean value for ${flagName}. Use true or false.`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

async function runTaskCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Task command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerTaskCommand(program: Command): void {
	const task = program.command("task").alias("tasks").description("Manage Kanban board tasks from the CLI.");

	task
		.command("list")
		.description("List Kanban tasks for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option(
			"--column <column>",
			"Filter column: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.action(async (options: { projectPath?: string; column?: ListTaskColumn }) => {
			await runTaskCommand(
				async () =>
					await listTasks({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						column: options.column,
					}),
			);
		});

	task
		.command("get")
		.description("Look up a single Kanban task by its task ID, including its task worktree path and state.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await getTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	for (const commandName of ["set-current-work-phase-goal", "clear-current-work-phase-goal"] as const) {
		const command = task.command(commandName).description("按调用环境身份更新当前对话的阶段目标。");
		if (commandName === "set-current-work-phase-goal")
			command.requiredOption("--goal <text>", "阶段目标（最多 160 字）。");
		command.action(async (options: { goal?: string }) => {
			await runTaskCommand(async () => {
				const projectPath = process.env.KANBAN_PROJECT_PATH?.trim();
				if (!projectPath || !process.env.KANBAN_TASK_ID?.trim())
					throw new Error("当前调用环境缺少 Task 身份；不会从 cwd 推测。");
				const workspaceId = await ensureRuntimeWorkspace(projectPath);
				return await createRuntimeTrpcClient(workspaceId).runtime.setCurrentWorkPhaseGoal.mutate({
					goal: commandName === "clear-current-work-phase-goal" ? null : (options.goal ?? ""),
				});
			});
		});
	}

	task
		.command("rename-current-task")
		.description("按调用环境身份给自己的 Task 改名，并记录原因。")
		.requiredOption("--title <text>", "新名称（最多 80 字）。")
		.requiredOption("--reason <text>", "改名原因（最多 500 字）。")
		.action(async (options: { title: string; reason: string }) => {
			await runTaskCommand(async () => {
				const projectPath = process.env.KANBAN_PROJECT_PATH?.trim();
				if (!projectPath || !process.env.KANBAN_TASK_ID?.trim()) {
					throw new Error("当前调用环境缺少 KANBAN_TASK_ID 或 KANBAN_PROJECT_PATH；不会从 cwd 推测。 ");
				}
				const workspaceId = await ensureRuntimeWorkspace(projectPath);
				const renamed = await createRuntimeTrpcClient(workspaceId).taskCardAction.renameCurrentTask.mutate(options);
				return { ok: true, task: renamed.taskCardSnapshotAfterAction.taskCard };
			});
		});

	task
		.command("create")
		.description("Create a task in backlog.")
		.option("--title <text>", "Task title.")
		.requiredOption("--prompt <text>", "Task prompt text.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Task base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option(
			"--task-agent-permission-mode <mode>",
			`Agent permission tier: ${VALID_TASK_AGENT_PERMISSION_MODES.join(" | ")}.`,
		)
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option("--agent-id <id>", "Agent override: cline | claude | codex | droid | gemini | opencode | default.")
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" for workspace default.',
		)
		.option(
			"--cline-model <id>",
			'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" for workspace default.',
		)
		.option(
			"--cline-reasoning-effort <level>",
			"Cline reasoning effort override: default | low | medium | high | xhigh.",
		)
		.option("--agent-session-initialization-id <uuid>", "Existing Claude, Codex, or Cursor session UUID.")
		.option(
			"--agent-session-initialization-mode <mode>",
			"Session reuse mode: resume_existing_session | fork_existing_session.",
		)
		.option("--parent-session-id <uuid>", "Codex parent session id; agent launcher will run `codex fork <uuid>`.")
		.option("--worktree-mode <mode>", `Worktree mode: ${VALID_WORKTREE_MODES.join(" | ")}. Defaults to branch.`)
		.option("--prep-file-path <path>", "Absolute path to a dispatch prep file persisted on the task.")
		.option(
			"--preview",
			"Resolve every effective setting and report warnings without creating anything. Read-only: it does not even register the project.",
		)
		.option(
			"--expect-resolved-settings-fingerprint <hash>",
			"Fail closed (create nothing, exit 1) unless the resolved settings still hash to this value from an earlier --preview.",
		)
		.action(
			async (options: {
				title?: string;
				prompt: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				taskAgentPermissionMode?: string;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				agentId?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
				agentSessionInitializationId?: string;
				agentSessionInitializationMode?: string;
				parentSessionId?: string;
				worktreeMode?: string;
				prepFilePath?: string;
				preview?: boolean;
				expectResolvedSettingsFingerprint?: string;
			}) => {
				await runTaskCommand(async () => {
					const taskCreateCommandInput: TaskCreateCommandInput = {
						cwd: process.cwd(),
						title: options.title,
						prompt: options.prompt,
						projectPath: options.projectPath,
						baseRef: options.baseRef,
						startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
						taskAgentPermissionMode: parseTaskAgentPermissionMode(options.taskAgentPermissionMode),
						autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
						autoReviewMode: options.autoReviewMode,
						agentId: parseAgentId(options.agentId) ?? undefined,
						clineSettings: buildTaskClineSettingsForCreate({
							providerId: parseOptionalStringOrDefault(options.clineProvider) ?? undefined,
							modelId: parseOptionalStringOrDefault(options.clineModel) ?? undefined,
							reasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
						}),
						taskAgentSessionInitialization:
							buildTaskAgentSessionInitialization({
								agentId: parseAgentId(options.agentId),
								sourceSessionId: options.agentSessionInitializationId?.trim() || undefined,
								sourceSessionReuseMode: options.agentSessionInitializationMode
									? runtimeTaskAgentSessionInitializationReuseModeSchema.parse(
											options.agentSessionInitializationMode,
										)
									: undefined,
							}) ?? undefined,
						parentSessionId: options.parentSessionId?.trim() || undefined,
						worktreeMode: parseWorktreeMode(options.worktreeMode),
						prepFilePath: options.prepFilePath?.trim() || undefined,
						expectResolvedSettingsFingerprint: options.expectResolvedSettingsFingerprint?.trim() || undefined,
					};
					return options.preview
						? await previewTaskCreate(taskCreateCommandInput)
						: await createTask(taskCreateCommandInput);
				});
			},
		);

	task
		.command("update")
		.description("Update an existing task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--title <text>", "Replacement task title.")
		.option("--prompt <text>", "Replacement task prompt.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Replacement base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option(
			"--task-agent-permission-mode <mode>",
			`Agent permission tier: ${VALID_TASK_AGENT_PERMISSION_MODES.join(" | ")}.`,
		)
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option(
			"--agent-id <id>",
			'Agent override: cline | claude | codex | droid | gemini | opencode. Use "default" to clear.',
		)
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" to clear.',
		)
		.option("--cline-model <id>", 'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" to clear.')
		.option(
			"--cline-reasoning-effort <level>",
			'Cline reasoning effort override: default | low | medium | high | xhigh. Use "inherit" to clear.',
		)
		.option(
			"--agent-session-initialization-id <uuid>",
			'Existing Claude, Codex, or Cursor session UUID. Use "inherit" to clear.',
		)
		.option(
			"--agent-session-initialization-mode <mode>",
			"Session reuse mode: resume_existing_session | fork_existing_session.",
		)
		.option(
			"--parent-session-id <uuid>",
			'Codex parent session id; agent launcher will run `codex fork <uuid>`. Use "inherit" to clear.',
		)
		.option("--worktree-mode <mode>", `Worktree mode: ${VALID_WORKTREE_MODES.join(" | ")}. Use "inherit" to clear.`)
		.option(
			"--prep-file-path <path>",
			'Absolute path to a dispatch prep file persisted on the task. Use "inherit" to clear.',
		)
		.action(
			async (options: {
				taskId: string;
				title?: string;
				prompt?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				taskAgentPermissionMode?: string;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				agentId?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
				agentSessionInitializationId?: string;
				agentSessionInitializationMode?: string;
				parentSessionId?: string;
				worktreeMode?: string;
				prepFilePath?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskCommand({
							cwd: process.cwd(),
							taskId: options.taskId,
							title: options.title,
							projectPath: options.projectPath,
							prompt: options.prompt,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							taskAgentPermissionMode: parseTaskAgentPermissionMode(options.taskAgentPermissionMode),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							agentId: parseAgentId(options.agentId),
							clineProviderId: parseOptionalStringOrDefault(options.clineProvider),
							clineModelId: parseOptionalStringOrDefault(options.clineModel),
							clineReasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
							taskAgentSessionInitializationId: parseOptionalStringOrInherit(
								options.agentSessionInitializationId,
							),
							taskAgentSessionInitializationMode: options.agentSessionInitializationMode
								? runtimeTaskAgentSessionInitializationReuseModeSchema.parse(
										options.agentSessionInitializationMode,
									)
								: undefined,
							parentSessionId: parseOptionalStringOrInherit(options.parentSessionId),
							worktreeMode: parseOptionalWorktreeModeOrInherit(options.worktreeMode),
							prepFilePath: parseOptionalStringOrInherit(options.prepFilePath),
						}),
				);
			},
		);

	addPostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions(
		task
			.command("trash")
			.alias("done")
			.description(
				"Move a task or an entire column to done and clean up task workspaces. Tasks awaiting Post-Deploy Verification with unchecked items need a closure reason for each.",
			)
			.option("--task-id <id>", "Task ID.")
			.option(
				"--column <column>",
				"Column to move to done: backlog | in_progress | review | done. trash is also accepted.",
				parseListColumn,
			)
			.option("--project-path <path>", "Workspace path. Defaults to current directory workspace."),
	).action(
		async (
			options: {
				taskId?: string;
				column?: ListTaskColumn;
				projectPath?: string;
			} & PostDeployVerificationUncheckedChecklistItemClosureReasonCliOptions,
		) => {
			await runTaskCommand(
				async () =>
					await trashTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
						postDeployVerificationDoneEntryClosure:
							await parsePostDeployVerificationDoneEntryClosureFromCliOptions(options, process.cwd()),
					}),
			);
		},
	);

	task
		.command("delete")
		.description("Permanently delete a task or every task in a column.")
		.option("--task-id <id>", "Task ID to permanently delete.")
		.option(
			"--column <column>",
			"Column to bulk-delete: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await deleteTaskCommand({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("capture-rvf-review-start-boundary")
		.description("捕获当前 Codex 主会话的独立 RVF 开审分界并登记默认自动收尾。")
		.requiredOption("--project-path <path>", "main checkout 路径。")
		.requiredOption("--task-id <id>", "任务 ID。")
		.requiredOption("--decision-token <token>", "RVF 决策 token。")
		.action(async (options: { projectPath: string; taskId: string; decisionToken: string }) => {
			const workspace = await resolveRuntimeWorkspace(options.projectPath, process.cwd(), {
				autoCreateIfMissing: false,
			});
			printJson(
				await createRuntimeTrpcClient(workspace.workspaceId).runtime.captureRvfReviewStartBoundary.mutate({
					taskId: options.taskId,
					decisionToken: options.decisionToken,
				}),
			);
		});
	task
		.command("rvf-automatic-closeout-status")
		.description("查询 RVF 自动恢复与收尾投递的持久状态。")
		.requiredOption("--project-path <path>", "main checkout 路径。")
		.requiredOption("--task-id <id>", "任务 ID。")
		.action(async (options: { projectPath: string; taskId: string }) => {
			const workspace = await resolveRuntimeWorkspace(options.projectPath, process.cwd(), {
				autoCreateIfMissing: false,
			});
			printJson(
				await createRuntimeTrpcClient(workspace.workspaceId).runtime.rvfAutomaticCloseoutStatus.query({
					taskId: options.taskId,
				}),
			);
		});

	task
		.command("message")
		.description("Inject a follow-up user message into an active task agent session.")
		.requiredOption("--project-path <path>", "Workspace path for the Kanban project.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--prompt-file <path>", "UTF-8 file containing the complete follow-up message.")
		.option("--prompt <text>", "Follow-up message text.")
		.requiredOption("--source <source>", "Message source label.")
		.requiredOption("--idempotency-key <key>", "Task-scoped idempotency key.")
		.option("--attempt-id <id>", "Optional task attempt/session ID.")
		.option(
			"--wait-for-terminal-status",
			"Block until the delivery reaches a terminal status (or --wait-timeout-ms elapses). Timing out is not a failure: the reported status is still the true current one.",
		)
		.option(
			"--wait-timeout-ms <ms>",
			"Timeout for --wait-for-terminal-status. Defaults to 30000. Clamped to the CLI hard timeout (KANBAN_CLI_HARD_TIMEOUT_MS, default 35000) minus a small margin, so the command always prints its JSON receipt instead of being killed with exit code 124. Raise KANBAN_CLI_HARD_TIMEOUT_MS to actually wait longer.",
		)
		.option(
			"--deliver-when-agent-idle",
			"Queue the message in Kanban's durable prompt queue and hand it to the terminal only once the agent is idle (not generating, not parked awaiting background work, not waiting on a question/plan/permission). Requires --max-wait-for-agent-idle-ms. The receipt stays accepted_pending_submit_confirmation while queued.",
		)
		.option(
			"--max-wait-for-agent-idle-ms <ms>",
			"With --deliver-when-agent-idle: give up after this many milliseconds (at most 86400000) without the agent becoming idle, settling the receipt as delivery_failed{agent_never_became_idle_before_queued_delivery_deadline}.",
		)
		.action(
			async (options: {
				projectPath: string;
				taskId: string;
				promptFile?: string;
				prompt?: string;
				source: string;
				idempotencyKey: string;
				attemptId?: string;
				waitForTerminalStatus?: boolean;
				waitTimeoutMs?: string;
				deliverWhenAgentIdle?: boolean;
				maxWaitForAgentIdleMs?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await sendTaskMessageCommand({
							cwd: process.cwd(),
							projectPath: options.projectPath,
							taskId: options.taskId,
							promptFile: options.promptFile,
							prompt: options.prompt,
							source: options.source,
							idempotencyKey: options.idempotencyKey,
							attemptId: options.attemptId,
							waitForTerminalStatus: options.waitForTerminalStatus ?? false,
							...(options.waitTimeoutMs
								? { waitTimeoutMs: parsePositiveIntegerOption(options.waitTimeoutMs, "--wait-timeout-ms") }
								: {}),
							deliverWhenAgentIdle: options.deliverWhenAgentIdle ?? false,
							...(options.maxWaitForAgentIdleMs
								? {
										maxWaitForAgentIdleMs: parsePositiveIntegerOption(
											options.maxWaitForAgentIdleMs,
											"--max-wait-for-agent-idle-ms",
										),
									}
								: {}),
						}),
				);
			},
		);

	task
		.command("message-status")
		.description("Read the honest delivery status of a previously injected task message.")
		.requiredOption("--project-path <path>", "Workspace path for the Kanban project.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--idempotency-key <key>", "Task-scoped idempotency key of the injected message.")
		.action(async (options: { projectPath: string; taskId: string; idempotencyKey: string }) => {
			await runTaskCommand(
				async () =>
					await readTaskMessageStatusCommand({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						taskId: options.taskId,
						idempotencyKey: options.idempotencyKey,
					}),
			);
		});

	task
		.command("message-cancel")
		.description("Cancel an in-flight task message delivery that has not reached the terminal yet.")
		.requiredOption("--project-path <path>", "Workspace path for the Kanban project.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--idempotency-key <key>", "Task-scoped idempotency key of the injected message.")
		.action(async (options: { projectPath: string; taskId: string; idempotencyKey: string }) => {
			await runTaskCommand(
				async () =>
					await cancelTaskMessageCommand({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						taskId: options.taskId,
						idempotencyKey: options.idempotencyKey,
					}),
			);
		});

	task
		.command("start")
		.description("Start a task session and move task to in_progress.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await startTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("park")
		.description(
			"Mark a task as awaiting dispatched background work so its next bare Stop does not fire a ready-for-review notification. Await this OK before letting the agent end its turn.",
		)
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--label <text>", "Optional human-readable label (e.g. the dispatched child task id).")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; label?: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await parkTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						label: options.label,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("unpark")
		.description("Explicitly clear a task's awaiting-dispatched-background-work park marker (idempotent).")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await unparkTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("is-parked")
		.description("Report whether a task is currently parked awaiting dispatched background work.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await isTaskParkedCommand({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});
}
