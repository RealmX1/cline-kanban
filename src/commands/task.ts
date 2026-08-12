import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";
import { loadRuntimeConfig } from "../config/runtime-config";
import type {
	RuntimeAgentId,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardDependency,
	RuntimeClineReasoningEffort,
	RuntimeTaskAgentPermissionMode,
	RuntimeTaskAgentSessionInitialization,
	RuntimeTaskAgentSessionInitializationReuseMode,
	RuntimeTaskClineSettings,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	runtimeAgentIdSchema,
	runtimeClineReasoningEffortSchema,
	runtimeTaskAgentPermissionModeSchema,
	runtimeTaskAgentSessionInitializationReuseModeSchema,
	runtimeTaskAgentSessionInitializationSchema,
	runtimeTaskWorktreeModeSchema,
} from "../core/api-contract";
import { mergeAbortSignals, resolveCliTrpcTimeoutMs, safeStringify } from "../core/cli-process-guards";
import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import { resolveSessionFacets } from "../core/session-activity";
import {
	DEFAULT_TASK_AGENT_PERMISSION_MODE,
	resolveTaskAgentPermissionModeFromLegacyAutonomousFlag,
} from "../core/task-agent-permission-mode";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	getTaskColumnId,
	moveTaskToColumn,
	type RuntimeAddTaskDependencyResult,
	removeTaskDependency,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../core/task-board-mutations";
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
import { loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeAppRouter } from "../trpc/app-router";

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

interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeWorkspaceStateResponse["board"];
	value: T;
}

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

type ParsedTaskClineReasoningEffort = RuntimeClineReasoningEffort | "default" | null | undefined;

export function buildTaskAgentSessionInitialization(input: {
	agentId: RuntimeAgentId | null | undefined;
	sourceSessionId: string | null | undefined;
	sourceSessionReuseMode: RuntimeTaskAgentSessionInitializationReuseMode | undefined;
	existingTaskAgentId?: RuntimeAgentId;
	existing?: RuntimeTaskAgentSessionInitialization;
}): RuntimeTaskAgentSessionInitialization | null | undefined {
	if (input.sourceSessionId === undefined && input.sourceSessionReuseMode === undefined) {
		if (
			input.agentId !== undefined &&
			input.existing !== undefined &&
			input.agentId !== input.existing.sourceAgentId
		) {
			return null;
		}
		return undefined;
	}
	if (input.sourceSessionId === null) {
		return null;
	}
	if (
		input.sourceSessionId === undefined &&
		input.agentId !== undefined &&
		input.existing !== undefined &&
		input.agentId !== input.existing.sourceAgentId
	) {
		throw new Error(
			"Changing the session reuse mode while switching agents also requires --agent-session-initialization-id.",
		);
	}
	const sourceSessionId = input.sourceSessionId ?? input.existing?.sourceSessionId;
	const sourceAgentId = input.agentId ?? input.existingTaskAgentId ?? input.existing?.sourceAgentId;
	if (!sourceSessionId || (sourceAgentId !== "claude" && sourceAgentId !== "codex" && sourceAgentId !== "cursor")) {
		throw new Error("Agent session initialization requires --agent-id claude, codex, or cursor and a session UUID.");
	}
	return runtimeTaskAgentSessionInitializationSchema.parse({
		sourceAgentId,
		sourceSessionId,
		sourceSessionReuseMode:
			input.sourceSessionReuseMode ?? input.existing?.sourceSessionReuseMode ?? "resume_existing_session",
		sourceSessionWorkingDirectoryPath: input.existing?.sourceSessionWorkingDirectoryPath,
	});
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

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

function formatTaskClineSettings(settings?: RuntimeTaskClineSettings): JsonRecord {
	if (settings === undefined) {
		return {};
	}
	return {
		clineSettings: cloneTaskClineSettings(settings) ?? {},
	};
}

function buildTaskClineSettingsForCreate(input: {
	providerId?: string;
	modelId?: string;
	reasoningEffort?: ParsedTaskClineReasoningEffort;
}): RuntimeTaskClineSettings | undefined {
	const providerId = input.providerId?.trim();
	const modelId = input.modelId?.trim();
	const reasoningEffort = input.reasoningEffort === null ? undefined : input.reasoningEffort;
	if (!providerId && !modelId && reasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
	};
}

function buildTaskClineSettingsForUpdate(
	currentSettings: RuntimeTaskClineSettings | undefined,
	input: {
		providerId?: string | null;
		modelId?: string | null;
		reasoningEffort?: ParsedTaskClineReasoningEffort;
	},
): RuntimeTaskClineSettings | null | undefined {
	if (input.providerId === undefined && input.modelId === undefined && input.reasoningEffort === undefined) {
		return undefined;
	}
	const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
	let preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;

	if (input.providerId !== undefined) {
		const providerId = input.providerId?.trim();
		if (providerId) {
			nextSettings.providerId = providerId;
		} else {
			delete nextSettings.providerId;
		}
	}

	if (input.modelId !== undefined) {
		const modelId = input.modelId?.trim();
		if (modelId) {
			nextSettings.modelId = modelId;
		} else {
			delete nextSettings.modelId;
		}
	}

	if (input.reasoningEffort !== undefined) {
		if (input.reasoningEffort === "default") {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = true;
		} else if (input.reasoningEffort === null) {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = false;
		} else {
			nextSettings.reasoningEffort = input.reasoningEffort;
		}
	}

	if (
		nextSettings.providerId === undefined &&
		nextSettings.modelId === undefined &&
		nextSettings.reasoningEffort === undefined &&
		!preserveEmptyOverride
	) {
		return null;
	}

	return nextSettings;
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
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					const signal = mergeAbortSignals(options?.signal, AbortSignal.timeout(trpcTimeoutMs));
					return runtimeFetch(url, { ...options, signal });
				},
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

async function notifyRuntimeWorkspaceStateUpdated(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
): Promise<void> {
	await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);
}

async function updateRuntimeWorkspaceState<T>(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	workspaceRepoPath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const mutationResponse = await mutateWorkspaceState(workspaceRepoPath, (state) => {
		const mutation = mutate(state);
		return {
			board: mutation.board,
			value: mutation.value,
		};
	});

	if (mutationResponse.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	return mutationResponse.value;
}

function resolveTaskBaseRef(state: RuntimeWorkspaceStateResponse): string {
	return state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0]?.name ?? "";
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
): JsonRecord {
	const session = state.sessions[task.id] ?? null;
	const sessionFacets = session ? resolveSessionFacets(session) : null;
	return {
		id: task.id,
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

function formatDependencyRecord(
	state: RuntimeWorkspaceStateResponse,
	dependency: RuntimeBoardDependency,
): Record<string, unknown> {
	return {
		id: dependency.id,
		backlogTaskId: dependency.fromTaskId,
		backlogTaskColumn: getTaskColumnId(state.board, dependency.fromTaskId),
		linkedTaskId: dependency.toTaskId,
		linkedTaskColumn: getTaskColumnId(state.board, dependency.toTaskId),
		createdAt: dependency.createdAt,
	};
}

function getLinkFailureMessage(reason: RuntimeAddTaskDependencyResult["reason"]): string {
	if (reason === "same_task") {
		return "A task cannot be linked to itself.";
	}
	if (reason === "duplicate") {
		return "These tasks are already linked.";
	}
	if (reason === "trash_task") {
		return "Links cannot include done tasks.";
	}
	if (reason === "non_backlog") {
		return "Links require at least one backlog task.";
	}
	return "One or both tasks could not be found.";
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
	const state = await runtimeClient.workspace.getState.query();

	const tasks = state.board.columns.flatMap((boardColumn) => {
		if (!input.column && boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) => formatTaskRecord(state, task, boardColumn.id));
	});

	return {
		ok: true,
		workspacePath: workspace.repoPath,
		column: input.column ?? null,
		tasks,
		dependencies: state.board.dependencies.map((dependency) => formatDependencyRecord(state, dependency)),
		count: tasks.length,
	};
}

async function stopTaskRuntimeSession(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<void> {
	await runtimeClient.runtime.stopTaskSession
		.mutate({
			taskId,
		})
		.catch(() => null);
}

async function deleteTaskWorkspace(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<{ removed: boolean; error?: string }> {
	try {
		const deleted = await runtimeClient.workspace.deleteWorktree.mutate({
			taskId,
		});
		return {
			removed: deleted.removed,
			error: deleted.ok ? undefined : deleted.error,
		};
	} catch (error) {
		return {
			removed: false,
			error: toErrorMessage(error),
		};
	}
}

async function createTask(input: {
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
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeConfig = await loadRuntimeConfig(workspaceRepoPath);
	const created = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		const resolvedBaseRef = (input.baseRef ?? "").trim() || resolveTaskBaseRef(state);
		if (!resolvedBaseRef) {
			throw new Error("Could not determine task base branch for this workspace.");
		}
		const result = addTaskToColumn(
			state.board,
			"backlog",
			{
				title: input.title,
				prompt: input.prompt,
				startInPlanMode: input.startInPlanMode ?? runtimeConfig.newTaskStartInPlanModeByDefault,
				taskAgentPermissionMode:
					input.taskAgentPermissionMode ??
					resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(runtimeConfig.agentAutonomousModeEnabled),
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
			() => globalThis.crypto.randomUUID(),
		);
		return {
			board: result.board,
			value: result.task,
		};
	});

	return {
		ok: true,
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
	const updated = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskRecord = findTaskRecord(runtimeState, input.taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const nextTaskClineSettings = buildTaskClineSettingsForUpdate(taskRecord.task.clineSettings, {
			providerId: input.clineProviderId,
			modelId: input.clineModelId,
			reasoningEffort: input.clineReasoningEffort,
		});
		const builtTaskAgentSessionInitialization = buildTaskAgentSessionInitialization({
			agentId: input.agentId,
			sourceSessionId: input.taskAgentSessionInitializationId,
			sourceSessionReuseMode: input.taskAgentSessionInitializationMode,
			existingTaskAgentId: taskRecord.task.agentId,
			existing: taskRecord.task.taskAgentSessionInitialization,
		});
		const nextTaskAgentSessionInitialization =
			builtTaskAgentSessionInitialization === null ? null : builtTaskAgentSessionInitialization;

		const updatedTask = updateTask(runtimeState.board, input.taskId, {
			title: input.title ?? taskRecord.task.title,
			prompt: input.prompt ?? taskRecord.task.prompt,
			baseRef: input.baseRef ?? taskRecord.task.baseRef,
			startInPlanMode: input.startInPlanMode ?? taskRecord.task.startInPlanMode,
			taskAgentPermissionMode: input.taskAgentPermissionMode ?? taskRecord.task.taskAgentPermissionMode,
			autoReviewEnabled: input.autoReviewEnabled ?? taskRecord.task.autoReviewEnabled === true,
			autoReviewMode: input.autoReviewMode ?? taskRecord.task.autoReviewMode ?? "commit",
			agentId: input.agentId,
			clineSettings: nextTaskClineSettings,
			taskAgentSessionInitialization: nextTaskAgentSessionInitialization,
			parentSessionId: input.parentSessionId,
			worktreeMode: input.worktreeMode,
			prepFilePath: input.prepFilePath,
		});
		if (!updatedTask.updated || !updatedTask.task) {
			throw new Error(`Task "${input.taskId}" could not be updated.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: updatedTask.board,
		};

		return {
			board: updatedTask.board,
			value: formatTaskRecord(nextState, updatedTask.task, taskRecord.columnId),
		};
	});

	return {
		ok: true,
		task: updated,
		workspacePath: workspaceRepoPath,
	};
}

async function linkTasks(input: {
	cwd: string;
	taskId: string;
	linkedTaskId: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const dependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const linked = addTaskDependency(runtimeState.board, input.taskId, input.linkedTaskId);
		if (!linked.added || !linked.dependency) {
			throw new Error(getLinkFailureMessage(linked.reason));
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: linked.board,
		};
		return {
			board: linked.board,
			value: formatDependencyRecord(nextState, linked.dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		dependency,
	};
}

async function unlinkTasks(input: { cwd: string; dependencyId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removedDependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const dependency =
			runtimeState.board.dependencies.find((candidate) => candidate.id === input.dependencyId) ?? null;
		if (!dependency) {
			throw new Error(`Dependency "${input.dependencyId}" was not found in workspace ${workspaceRepoPath}.`);
		}

		const unlinked = removeTaskDependency(runtimeState.board, input.dependencyId);
		if (!unlinked.removed) {
			throw new Error(`Dependency "${input.dependencyId}" could not be removed.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: unlinked.board,
		};
		return {
			board: unlinked.board,
			value: formatDependencyRecord(nextState, dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedDependency,
	};
}

async function startTask(input: { cwd: string; taskId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const fromColumnId = getTaskColumnId(runtimeState.board, input.taskId);
	if (!fromColumnId) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	if (fromColumnId !== "backlog" && fromColumnId !== "in_progress") {
		throw new Error(
			`Task "${input.taskId}" is in "${fromColumnId}" and can only be started from backlog or in_progress.`,
		);
	}

	const currentRecord = findTaskRecord(runtimeState, input.taskId);
	const task = currentRecord?.task;
	if (!task) {
		throw new Error(`Task "${input.taskId}" could not be resolved.`);
	}

	const existingSession = runtimeState.sessions[task.id] ?? null;
	// 旧 `state==="running"` → facet 真相源 turnOwner==="agent"（running 是 agent 回合唯一来源，严格等价）。
	const shouldStartSession = !existingSession || resolveSessionFacets(existingSession).turnOwner !== "agent";

	if (shouldStartSession) {
		const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
			taskId: task.id,
			baseRef: task.baseRef,
			worktreeMode: task.worktreeMode,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Could not ensure task worktree.");
		}

		const started = await runtimeClient.runtime.startTaskSession.mutate(buildCliTaskSessionStartRequest(task));
		if (!started.ok || !started.summary) {
			throw new Error(started.error ?? "Could not start task session.");
		}
	}

	const moved = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (latestState) => {
		const movement = moveTaskToColumn(latestState.board, input.taskId, "in_progress");
		if (!movement.task) {
			throw new Error(`Task "${input.taskId}" could not be resolved.`);
		}
		if (!movement.moved) {
			return {
				board: latestState.board,
				value: movement,
			};
		}
		return {
			board: movement.board,
			value: movement,
		};
	});

	if (!moved.moved) {
		return {
			ok: true,
			message: `Task "${input.taskId}" is already in progress.`,
			task: {
				id: task.id,
				prompt: task.prompt,
				column: "in_progress",
				workspacePath: workspaceRepoPath,
			},
		};
	}

	return {
		ok: true,
		task: {
			id: task.id,
			prompt: task.prompt,
			column: "in_progress",
			workspacePath: workspaceRepoPath,
		},
	};
}

export function buildCliTaskSessionStartRequest(task: RuntimeBoardCard): RuntimeTaskSessionStartRequest {
	return {
		taskId: task.id,
		prompt: task.prompt,
		taskTitle: task.title,
		startInPlanMode: task.startInPlanMode,
		taskAgentPermissionMode: task.taskAgentPermissionMode,
		baseRef: task.baseRef,
		agentId: task.agentId,
		clineSettings: task.clineSettings,
		taskAgentSessionInitialization: task.taskAgentSessionInitialization,
		parentSessionId: task.parentSessionId,
		worktreeMode: task.worktreeMode,
		prepFilePath: task.prepFilePath,
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

export interface TrashTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	autoStartedTasks: JsonRecord[];
	worktreeDeleted: boolean;
	worktreeDeleteError?: string;
	alreadyInTrash: boolean;
}

interface TrashTaskMutationValue {
	task: JsonRecord;
	previousColumnId: ListTaskColumn;
	readyTaskIds: string[];
	alreadyInTrash: boolean;
}

function columnCanHaveLiveTaskSession(columnId: ListTaskColumn): boolean {
	return columnId === "in_progress" || columnId === "review" || columnId === "validation";
}

// deployment CLI（verification-complete / -confirm 移列）复用其完整副作用链：
// notifyStateUpdated（server reload）→ 按列门控 stopTaskSession → 自动启动就绪 linked 任务 → deleteWorktree。
export async function trashTaskById(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	workspaceRepoPath: string;
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
}): Promise<TrashTaskExecutionResult> {
	const mutation = await mutateWorkspaceState<TrashTaskMutationValue>(input.workspaceRepoPath, (latestState) => {
		const latestRecord = findTaskRecord(latestState, input.taskId);
		if (!latestRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${input.workspaceRepoPath}.`);
		}
		if (latestRecord.columnId === "trash") {
			return {
				board: latestState.board,
				value: {
					task: formatTaskRecord(latestState, latestRecord.task, latestRecord.columnId),
					previousColumnId: latestRecord.columnId,
					readyTaskIds: [] as string[],
					alreadyInTrash: true,
				},
				save: false,
			};
		}

		const trashed = trashTaskAndGetReadyLinkedTaskIds(latestState.board, input.taskId);
		if (!trashed.moved || !trashed.task) {
			throw new Error(`Task "${input.taskId}" could not be moved to done.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...latestState,
			board: trashed.board,
		};
		return {
			board: trashed.board,
			value: {
				task: formatTaskRecord(nextState, trashed.task, "trash"),
				previousColumnId: latestRecord.columnId,
				readyTaskIds: trashed.readyTaskIds,
				alreadyInTrash: false,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(input.runtimeClient);
	}

	if (mutation.value.alreadyInTrash) {
		return {
			task: mutation.value.task,
			taskId: input.taskId,
			previousColumnId: mutation.value.previousColumnId,
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeDeleted: false,
			alreadyInTrash: true,
		};
	}

	if (columnCanHaveLiveTaskSession(mutation.value.previousColumnId)) {
		await stopTaskRuntimeSession(input.runtimeClient, input.taskId);
	}

	const autoStartedTasks: JsonRecord[] = [];
	for (const readyTaskId of mutation.value.readyTaskIds) {
		const started = await startTask({
			cwd: input.cwd,
			taskId: readyTaskId,
			projectPath: input.projectPath,
		});
		autoStartedTasks.push(started);
	}

	const deletedWorkspace = await deleteTaskWorkspace(input.runtimeClient, input.taskId);

	return {
		task: mutation.value.task,
		taskId: input.taskId,
		previousColumnId: mutation.value.previousColumnId,
		readyTaskIds: mutation.value.readyTaskIds,
		autoStartedTasks,
		worktreeDeleted: deletedWorkspace.removed,
		worktreeDeleteError: deletedWorkspace.error,
		alreadyInTrash: false,
	};
}

async function trashTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task done");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		const trashed = await trashTaskById({
			cwd: input.cwd,
			taskId: target.taskId,
			projectPath: input.projectPath,
			workspaceRepoPath,
			runtimeClient,
		});
		if (trashed.alreadyInTrash) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already done.`,
				task: trashed.task,
				workspacePath: workspaceRepoPath,
				readyTaskIds: [],
				autoStartedTasks: [],
			};
		}
		return {
			ok: true,
			task: trashed.task,
			workspacePath: workspaceRepoPath,
			readyTaskIds: trashed.readyTaskIds,
			autoStartedTasks: trashed.autoStartedTasks,
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
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeCleanup: [],
			count: 0,
		};
	}

	const results: TrashTaskExecutionResult[] = [];
	for (const { task } of targetTasks) {
		results.push(
			await trashTaskById({
				cwd: input.cwd,
				taskId: task.id,
				projectPath: input.projectPath,
				workspaceRepoPath,
				runtimeClient,
			}),
		);
	}

	const trashedTasks = results.filter((result) => !result.alreadyInTrash);
	const alreadyTrashedTasks = results.filter((result) => result.alreadyInTrash);

	return {
		ok: true,
		column: target.column,
		workspacePath: workspaceRepoPath,
		trashedTasks: trashedTasks.map((result) => result.task),
		alreadyTrashedTasks: alreadyTrashedTasks.map((result) => result.task),
		readyTaskIds: [...new Set(trashedTasks.flatMap((result) => result.readyTaskIds))],
		autoStartedTasks: trashedTasks.flatMap((result) => result.autoStartedTasks),
		worktreeCleanup: trashedTasks.map((result) => ({
			taskId: result.taskId,
			removed: result.worktreeDeleted,
			error: result.worktreeDeleteError,
		})),
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
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const latestTargetRecords =
			target.kind === "task"
				? (() => {
						const record = findTaskRecord(latestState, target.taskId);
						if (!record) {
							throw new Error(`Task "${target.taskId}" was not found in workspace ${workspaceRepoPath}.`);
						}
						return [record];
					})()
				: findTasksInColumn(latestState, target.column);

		if (latestTargetRecords.length === 0) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deleted = deleteTasksFromBoard(
			latestState.board,
			latestTargetRecords.map(({ task }) => task.id),
		);
		if (!deleted.deleted) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deletedTasks = latestTargetRecords.map(({ task, columnId }) =>
			formatTaskRecord(latestState, task, columnId),
		);
		const taskIdsRequiringStop = latestTargetRecords
			.filter(({ columnId }) => columnCanHaveLiveTaskSession(columnId))
			.map(({ task }) => task.id);
		return {
			board: deleted.board,
			value: {
				deletedTaskIds: deleted.deletedTaskIds,
				taskIdsRequiringStop,
				deletedTasks,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	if (mutation.value.deletedTaskIds.length === 0) {
		return {
			ok: true,
			workspacePath: workspaceRepoPath,
			column: target.kind === "column" ? target.column : null,
			deletedTasks: [],
			count: 0,
		};
	}

	await Promise.all(
		mutation.value.taskIdsRequiringStop.map(async (taskId) => await stopTaskRuntimeSession(runtimeClient, taskId)),
	);

	const workspaceCleanupResults = await Promise.all(
		mutation.value.deletedTaskIds.map(async (taskId) => ({
			taskId,
			...(await deleteTaskWorkspace(runtimeClient, taskId)),
		})),
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		column: target.kind === "column" ? target.column : null,
		deletedTasks: mutation.value.deletedTasks,
		count: mutation.value.deletedTaskIds.length,
		worktreeCleanup: workspaceCleanupResults,
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
	};
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
}): Promise<TaskMessageCommandResult> {
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
	const timeoutMs = input.waitTimeoutMs ?? TASK_MESSAGE_TERMINAL_STATUS_WAIT_DEFAULT_TIMEOUT_MS;
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

	// 已经是终态：取消无事可做，如实回报当时的真实结果。
	if (isTaskMessageTerminalDeliveryStatusSettled(before.terminal_delivery_status)) {
		return buildCancelResult(before);
	}

	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	await runtimeClient.runtime.cancelTaskChatDelivery.mutate({ taskId, idempotencyKey });
	// 真相以账本为准：取消成功时 runtime 已经经同一把锁把记录写成
	// delivery_failed{cancelled_before_delivery}；取消晚到则记录已是（或即将是）某个 delivered 终态。
	const after = await readTaskMessageRecordOrThrow(ledgerPath, taskId, idempotencyKey);
	return buildCancelResult(after);
}

function buildCancelResult(record: TaskMessageInjectionRecord): TaskMessageCancelCommandResult {
	const cancelledByUs =
		record.terminal_delivery_status === "delivery_failed" &&
		record.terminal_delivery_failure_reason === "cancelled_before_delivery";
	return {
		ok: true,
		task_id: record.task_id,
		idempotency_key: record.idempotency_key,
		cancel_result: cancelledByUs ? "cancelled_before_delivery" : "already_delivered",
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
			}) => {
				await runTaskCommand(
					async () =>
						await createTask({
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
						}),
				);
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

	task
		.command("trash")
		.alias("done")
		.description("Move a task or an entire column to done and clean up task workspaces.")
		.option("--task-id <id>", "Task ID.")
		.option(
			"--column <column>",
			"Column to move to done: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await trashTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

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
		.option("--wait-timeout-ms <ms>", "Timeout for --wait-for-terminal-status. Defaults to 30000.")
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
		.command("link")
		.description("Link two tasks so one task waits on another.")
		.requiredOption("--task-id <id>", "One of the two task IDs to link.")
		.requiredOption("--linked-task-id <id>", "The other task ID to link.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.addHelpText(
			"after",
			[
				"",
				"Dependency direction:",
				"  If both linked tasks are in backlog, Kanban preserves the order you pass:",
				"  --task-id waits on --linked-task-id, and on the board the arrow points into",
				"  --linked-task-id.",
				"  Once only one linked task remains in backlog, Kanban reorients the saved link",
				"  so the backlog task is the waiting dependent task and the other task is the",
				"  prerequisite.",
				"  When the prerequisite finishes review and moves to done, the waiting backlog",
				"  task becomes ready to start.",
				"",
			].join("\n"),
		)
		.action(async (options: { taskId: string; linkedTaskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await linkTasks({
						cwd: process.cwd(),
						taskId: options.taskId,
						linkedTaskId: options.linkedTaskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("unlink")
		.description("Remove an existing dependency link.")
		.requiredOption("--dependency-id <id>", "Dependency ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { dependencyId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await unlinkTasks({
						cwd: process.cwd(),
						dependencyId: options.dependencyId,
						projectPath: options.projectPath,
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
