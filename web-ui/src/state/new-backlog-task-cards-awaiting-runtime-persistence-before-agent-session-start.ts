// 浏览器新建、正等 runtime 确认落盘的卡片登记（cf427）。
//
// 建卡仍是乐观的：本地 setBoard 立刻可见。同时向 runtime 发起「先落盘」请求（board 锁内对最新 board 插卡，
// 不走整板保存的 revision CAS），并在这里按 (workspaceId, taskId) 登记这次请求。启动 agent 的入口
// （kickoffTaskInProgress）先等登记的结果：落盘确认之前绝不启动——否则卡片一旦被整板重水合抹掉，
// agent 就成了搜不到、进不了 Focus 的孤儿会话。runtime 的 startTaskSession 另有同义的门兜底。
//
// 落盘成功后的 workspace 快照广播给订阅者（useWorkspaceSync 按三方判定吸收它：远端只多了自己建的卡，
// 不覆盖本地 board，只前进 revision 与基线）。

import type { WebUiBoardMutationInitiator } from "@runtime-kanban-web-ui-page-load-request-origin-nonce";

import { persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart } from "@/runtime/new-backlog-task-card-persistence-before-agent-session-start-query";
import type { RuntimeWorkspaceStateResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

export type NewTaskCardRuntimePersistenceOutcome = { ok: true } | { ok: false; message: string };

export type WorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListener = (input: {
	workspaceId: string;
	workspaceStateAfterNewBacklogTaskCardsPersisted: RuntimeWorkspaceStateResponse;
}) => void;

const newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey = new Map<
	string,
	Promise<NewTaskCardRuntimePersistenceOutcome>
>();
const workspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListeners =
	new Set<WorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListener>();

function buildWorkspaceAndTaskKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}\u0000${taskId}`;
}

export function subscribeToWorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntime(
	listener: WorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListener,
): () => void {
	workspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListeners.add(listener);
	return () => {
		workspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListeners.delete(listener);
	};
}

export function beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart(input: {
	workspaceId: string;
	newBacklogTaskCardsCreatedFromWebUi: BoardCard[];
	boardMutationInitiatorOfNewBacklogTaskCards: WebUiBoardMutationInitiator;
}): void {
	if (input.newBacklogTaskCardsCreatedFromWebUi.length === 0) {
		return;
	}
	const persistenceRequest: Promise<NewTaskCardRuntimePersistenceOutcome> =
		persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart(input).then(
			(workspaceStateAfterNewBacklogTaskCardsPersisted) => {
				for (const listener of workspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListeners) {
					listener({ workspaceId: input.workspaceId, workspaceStateAfterNewBacklogTaskCardsPersisted });
				}
				return { ok: true };
			},
			(error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }),
		);
	for (const card of input.newBacklogTaskCardsCreatedFromWebUi) {
		const key = buildWorkspaceAndTaskKey(input.workspaceId, card.id);
		const settledRequest = persistenceRequest.then((outcome) => {
			// 落盘成功即退出登记（之后启动不必再等）；失败的保留，供启动入口以当前卡片重试一次。
			if (outcome.ok && newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey.get(key) === settledRequest) {
				newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey.delete(key);
			}
			return outcome;
		});
		newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey.set(key, settledRequest);
	}
}

// 启动 agent 前调用。不是本页面新建的卡（或早已确认落盘）立即放行；在途的等它；上次失败的以当前卡片重试一次。
export async function waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart(input: {
	workspaceId: string;
	taskCard: BoardCard;
}): Promise<NewTaskCardRuntimePersistenceOutcome> {
	const key = buildWorkspaceAndTaskKey(input.workspaceId, input.taskCard.id);
	const pendingRequest = newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey.get(key);
	if (!pendingRequest) {
		return { ok: true };
	}
	const outcome = await pendingRequest;
	if (outcome.ok) {
		return outcome;
	}
	if (newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey.get(key) === pendingRequest) {
		beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
			workspaceId: input.workspaceId,
			newBacklogTaskCardsCreatedFromWebUi: [input.taskCard],
			boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
		});
	}
	return (await newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey.get(key)) ?? { ok: true };
}

// 仅供测试：清空登记与订阅。
export function resetNewBacklogTaskCardsAwaitingRuntimePersistenceForTests(): void {
	newTaskCardRuntimePersistenceRequestByWorkspaceAndTaskKey.clear();
	workspaceStateAfterNewBacklogTaskCardsPersistedByRuntimeListeners.clear();
}
