import type {
	RuntimeKanbanCliTaskBoardMutationKind,
	RuntimeKanbanCliTaskBoardMutationRequest,
	RuntimeKanbanCliTaskBoardMutationResponse,
} from "../core/api-contract";
import { addTaskToColumn } from "../core/task-board-mutations";
import type {
	KanbanActorResolutionLookups,
	KanbanRequestOriginActorEvidence,
} from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "./app-router";
import { runPureTaskBoardMutationRejectingInvalidInputAsBadRequest } from "./task-card-action-api";

// `workspace.applyKanbanCliTaskBoardMutation` 的 runtime 侧实现（dd2db 1a.2b），现在只剩 `kanban task create` 一种：
// 先按请求头上的 CLI 行动者声明解析行动者，再在 board 锁内对**最新** board 建卡，写成后像其他 runtime 写入一样广播。
// update / start / done / delete 已收编进 `taskCardAction.*`（src/trpc/task-card-action-api.ts），连同它们的
// 会话 / worktree / 草稿 / checkpoint ref 收尾一起由 runtime 执行。

export interface KanbanCliTaskBoardMutationApiDependencies {
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	// 测试注入用；缺省为读 workspace 索引与 board.json 的生产实现。
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
}

// 意图种类沿用迁移前 CLI 直接写盘时的命名，账本读侧据此把迁移前后的同一动词对齐。
const TASK_MUTATION_INTENT_KIND_BY_KANBAN_CLI_TASK_BOARD_MUTATION_KIND = {
	create_backlog_task_card: "kanban_cli_task_create",
} as const satisfies Record<RuntimeKanbanCliTaskBoardMutationKind, string>;

export async function applyKanbanCliTaskBoardMutation(
	deps: KanbanCliTaskBoardMutationApiDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	request: RuntimeKanbanCliTaskBoardMutationRequest,
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
): Promise<RuntimeKanbanCliTaskBoardMutationResponse> {
	const taskMutationIntentWithResolvedActor = await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
		taskMutationIntentKind:
			TASK_MUTATION_INTENT_KIND_BY_KANBAN_CLI_TASK_BOARD_MUTATION_KIND[request.kanbanCliTaskBoardMutationKind],
		kanbanRequestOriginActorEvidence,
		kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
	});

	const fieldValues = request.backlogTaskCardFieldValuesResolvedByKanbanCli;
	// Y-EVENT-12：id 由 runtime 对全局 task 身份登记簿分配；漏斗在锁内再校验一次。
	const allocatedTaskIdForNewBacklogTaskCard = await allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable(
		{
			requestingWorkspaceId: workspaceScope.workspaceId,
		},
	);
	const mutation = await mutateWorkspaceState(
		workspaceScope.workspacePath,
		taskMutationIntentWithResolvedActor,
		(state) => {
			const created = runPureTaskBoardMutationRejectingInvalidInputAsBadRequest(() =>
				addTaskToColumn(
					state.board,
					"backlog",
					{
						title: fieldValues.title,
						prompt: fieldValues.prompt,
						startInPlanMode: fieldValues.startInPlanMode,
						ompAgentSessionTransportForNewTasks: fieldValues.ompAgentSessionTransportForNewTasks,
						workspaceDefaultAgentIdForNewTasks: fieldValues.workspaceDefaultAgentIdForNewTasks,
						taskAgentPermissionMode: fieldValues.taskAgentPermissionMode,
						autoReviewEnabled: fieldValues.autoReviewEnabled,
						autoReviewMode: fieldValues.autoReviewMode,
						agentId: fieldValues.agentId,
						clineSettings: fieldValues.clineSettings,
						taskAgentSessionInitialization: fieldValues.taskAgentSessionInitialization,
						baseRef: fieldValues.baseRef,
						parentSessionId: fieldValues.parentSessionId,
						worktreeMode: fieldValues.worktreeMode,
						prepFilePath: fieldValues.prepFilePath,
						...(allocatedTaskIdForNewBacklogTaskCard !== null
							? { taskId: allocatedTaskIdForNewBacklogTaskCard }
							: {}),
					},
					() => globalThis.crypto.randomUUID(),
				),
			);
			return { board: created.board, value: created.task };
		},
	);
	if (mutation.saved) {
		void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
		void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
	}
	return { kanbanCliTaskBoardMutationKind: "create_backlog_task_card", createdBacklogTaskCard: mutation.value };
}
