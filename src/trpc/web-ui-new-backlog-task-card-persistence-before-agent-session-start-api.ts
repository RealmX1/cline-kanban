import type {
	RuntimeBoardCard,
	RuntimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequest,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import type {
	KanbanActorResolutionLookups,
	KanbanRequestOriginActorEvidence,
} from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "./app-router";

// `workspace.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart` 的 runtime 侧实现（cf427）。
//
// Web UI 建卡仍是乐观的（本地 setBoard 立刻可见），但同时调用这里：runtime 在 board 锁内对**最新**盘上 board
// 做 read-modify-write，把新卡插进 backlog 顶部，不走整板保存的 revision CAS——所以并发的 hook、其他客户端的
// 保存、CLI 写入都不会让这次落盘冲突失败。浏览器拿到确认后才放行 agent 启动；runtime 的 startTaskSession
// 另有一道「宿主卡必须已在盘上」的门兜住不走这条路的旧 bundle 客户端。

export interface WebUiNewBacklogTaskCardPersistenceApiDependencies {
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	// 测试注入用；缺省为读 workspace 索引与 board.json 的生产实现。
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
}

function collectTaskCardIdsOnBoard(board: RuntimeWorkspaceStateResponse["board"]): Set<string> {
	const taskCardIdsOnBoard = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			taskCardIdsOnBoard.add(card.id);
		}
	}
	return taskCardIdsOnBoard;
}

export async function persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart(
	deps: WebUiNewBacklogTaskCardPersistenceApiDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	request: RuntimePersistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStartRequest,
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
): Promise<RuntimeWorkspaceStateResponse> {
	// 行动者解析与整板保存一致：页面 nonce 先解析为「来自页面」，再由逐卡标注细化成用户手势 / 浏览器自动流转。
	const taskMutationIntentWithResolvedActor = {
		...(await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
			taskMutationIntentKind: "web_ui_new_backlog_task_cards_persisted_before_agent_session_start",
			kanbanRequestOriginActorEvidence,
			kanbanActorResolutionLookups: deps.kanbanActorResolutionLookups,
		})),
		webUiBoardMutationInitiatorAnnotationsForTaskMutationEventCapture:
			request.newBacklogTaskCardsCreatedFromWebUi.map((card) => ({
				taskId: card.id,
				annotatedBoardMutationKind: "task_card_created_on_board" as const,
				boardMutationInitiator: request.boardMutationInitiatorOfNewBacklogTaskCards,
			})),
	};
	const mutation = await mutateWorkspaceState(
		workspaceScope.workspacePath,
		taskMutationIntentWithResolvedActor,
		(state) => {
			const taskCardIdsAlreadyOnBoard = collectTaskCardIdsOnBoard(state.board);
			const taskCardIdsInsertedByThisRequest = new Set<string>();
			const newBacklogTaskCardsNotYetOnBoard: RuntimeBoardCard[] = [];
			for (const card of request.newBacklogTaskCardsCreatedFromWebUi) {
				// 已在盘上（重试，或浏览器的整板保存先到了）：幂等跳过，不拿浏览器这份覆盖盘上较新的版本。
				if (taskCardIdsAlreadyOnBoard.has(card.id) || taskCardIdsInsertedByThisRequest.has(card.id)) {
					continue;
				}
				taskCardIdsInsertedByThisRequest.add(card.id);
				newBacklogTaskCardsNotYetOnBoard.push(card);
			}
			if (newBacklogTaskCardsNotYetOnBoard.length === 0) {
				return { board: state.board, value: null, save: false };
			}
			if (!state.board.columns.some((column) => column.id === "backlog")) {
				throw new Error(`Workspace board at ${workspaceScope.workspacePath} has no backlog column.`);
			}
			return {
				board: {
					...state.board,
					columns: state.board.columns.map((column) =>
						column.id === "backlog"
							? { ...column, cards: [...newBacklogTaskCardsNotYetOnBoard, ...column.cards] }
							: column,
					),
				},
				value: null,
			};
		},
	);
	if (mutation.saved) {
		void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath);
		void deps.broadcastRuntimeProjectsUpdated(workspaceScope.workspaceId);
	}
	return mutation.state;
}
