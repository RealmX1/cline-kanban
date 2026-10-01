import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../core/api-contract";
import type {
	AgentConversationSessionIdentityKey,
	InterWorkUnitRelationWorkUnitReference,
	KanbanActor,
	OccurredAtConversationTurnReference,
	SystemExecutedCauseOfRuntimeSystemComponentAction,
} from "../core/inter-work-unit-relation-ledger-event-contract";

// board 持久化漏斗（workspace-state.ts）与工作单元间关系账本之间的端口。
// 为什么是注册制而不是直接 import 账本：workspace-state 同时被 CLI 进程加载，而账本只允许在 runtime 进程的
// worker 线程内打开（dd2db §R3 Y-EVENT-1）。runtime 启动时注册实现；未注册的进程（CLI、单测）照常写盘，
// 它们的写入会在 runtime 下一次漏斗通过时被 board diff 检出，记为漏斗外发生（Y-EVENT-2 第 2 步）。

// 漏斗的必填参数（Y-EVENT-2）：每个写 board 的调用点都必须声明意图与已解析的行动者，
// runtime 内不存在「不知道是谁写的」board 写入。
export interface TaskMutationIntentWithResolvedActor {
	taskMutationIntentKind: string;
	resolvedKanbanActor: KanbanActor;
	actorNativeConversationSessionIdentity?: AgentConversationSessionIdentityKey | null;
	actorKanbanTaskConversationSessionId?: string | null;
	actorRepositoryIdentityAtEventTime?: { workspaceId: string; repositoryPath: string } | null;
	onBehalfOfInitiatingWorkUnit?: InterWorkUnitRelationWorkUnitReference | null;
	causedBySystemExecutedCause?: SystemExecutedCauseOfRuntimeSystemComponentAction | null;
	invokingKanbanCliCodeVersion?: string | null;
	occurredAtConversationTurnReference?: OccurredAtConversationTurnReference | null;
	idempotencyKey?: string | null;
}

export interface WorkspaceBoardPersistenceFunnelLockedStateIdentity {
	workspaceId: string;
	workspaceRepositoryPath: string;
}

export interface WorkspaceBoardPersistenceFunnelTaskMutationEventCapture {
	// 第 1、2 步：结算悬挂批次，检出漏斗外变更；首次见到该 workspace 时写激活基线。必须在 board 锁内调用。
	reconcileLedgerWithPersistedBoardWithinBoardLock(
		input: WorkspaceBoardPersistenceFunnelLockedStateIdentity & {
			persistedBoard: RuntimeBoardData;
			// 激活基线时把 sessions 里已有的原生会话身份 sidecar 读成族 2 事件（Y-EVENT-13）。
			persistedSessions: Record<string, RuntimeTaskSessionSummary>;
			persistedBoardFileSha256: string | null;
			persistedBoardRevision: number;
		},
	): Promise<void>;
	// 第 4 步：写盘前把事件记为 pending。没有任何卡片级变化时返回 null。
	recordPendingTaskMutationEventsBeforeBoardFileWrite(
		input: WorkspaceBoardPersistenceFunnelLockedStateIdentity & {
			previousBoard: RuntimeBoardData;
			nextBoard: RuntimeBoardData;
			// 原生会话身份 sidecar 的变化随同一批次记为族 2 事件。
			previousSessions: Record<string, RuntimeTaskSessionSummary>;
			nextSessions: Record<string, RuntimeTaskSessionSummary>;
			nextBoardFileSha256: string;
			nextBoardRevision: number;
			taskMutationIntentWithResolvedActor: TaskMutationIntentWithResolvedActor;
		},
	): Promise<{ pendingBatchId: string } | null>;
	// 第 6 步：三个 JSON 都写完后提交，并在这一刻分配 globalCommittedEventSequence。
	commitPendingTaskMutationEventsAfterBoardFileWrite(input: {
		pendingBatchId: string;
		boardFileSha256: string;
		boardRevision: number;
	}): Promise<void>;
	// 只写 sessions 的身份落盘路径（不经两阶段批次）：落盘之后追加一条族 2 观测，不阻塞调用方。
	recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking(input: {
		workspaceId: string;
		kanbanTaskConversationSessionId: string;
		sessionSummary: RuntimeTaskSessionSummary;
	}): void;
}

let registeredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture: WorkspaceBoardPersistenceFunnelTaskMutationEventCapture | null =
	null;

export function registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(
	capture: WorkspaceBoardPersistenceFunnelTaskMutationEventCapture | null,
): void {
	registeredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture = capture;
}

export function getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(): WorkspaceBoardPersistenceFunnelTaskMutationEventCapture | null {
	return registeredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture;
}

// runtime 自身组件发起的 board 写入（会话启动后回写卡片观测值等）。
export function buildTaskMutationIntentForKanbanRuntimeSystemComponent(
	taskMutationIntentKind: string,
	kanbanRuntimeSystemComponentName: string,
): TaskMutationIntentWithResolvedActor {
	return {
		taskMutationIntentKind,
		resolvedKanbanActor: { kanbanActorKind: "kanban_runtime_system_component", kanbanRuntimeSystemComponentName },
	};
}

// 经 tRPC 进入 runtime 的写入不在这里构造意图：一律按请求发起方证据解析（见
// inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files.ts 的
// resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence）。

// CLI 进程直接写盘（迁到 runtime procedure 之前的过渡形态）。CLI 进程里没有注册账本捕获，这个意图不会被记账；
// 变更由 runtime 下一次漏斗通过时按 board diff 检出为漏斗外发生。
// 1a.2b 之后只剩 `task link` / `task unlink` 还用它，1a.6 删除这两个动词时一并删除。
export function buildTaskMutationIntentForKanbanCliProcessDirectBoardFileWrite(
	taskMutationIntentKind: string,
): TaskMutationIntentWithResolvedActor {
	return {
		taskMutationIntentKind,
		resolvedKanbanActor: {
			kanbanActorKind: "unresolved_actor",
			unresolvedActorReason: "kanban_cli_process_wrote_board_file_directly_before_runtime_procedure_migration",
		},
	};
}
