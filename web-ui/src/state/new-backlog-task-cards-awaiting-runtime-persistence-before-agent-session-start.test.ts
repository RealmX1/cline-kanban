import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkspaceStateResponse } from "@/runtime/types";
import {
	beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart,
	resetNewBacklogTaskCardsAwaitingRuntimePersistenceForTests,
	subscribeToWorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntime,
	waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart,
} from "@/state/new-backlog-task-cards-awaiting-runtime-persistence-before-agent-session-start";
import type { BoardCard } from "@/types";

const persistNewBacklogTaskCardsMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/new-backlog-task-card-persistence-before-agent-session-start-query", () => ({
	persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart: persistNewBacklogTaskCardsMock,
}));

function createCard(taskId: string): BoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: `Prompt ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

const persistedWorkspaceState = { revision: 7 } as RuntimeWorkspaceStateResponse;

describe("new backlog task cards awaiting runtime persistence before agent session start", () => {
	beforeEach(() => {
		persistNewBacklogTaskCardsMock.mockReset();
		resetNewBacklogTaskCardsAwaitingRuntimePersistenceForTests();
	});

	afterEach(() => {
		resetNewBacklogTaskCardsAwaitingRuntimePersistenceForTests();
	});

	it("不是本页面新建的卡立即放行，不发请求", async () => {
		expect(
			await waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart({
				workspaceId: "project-a",
				taskCard: createCard("old01"),
			}),
		).toEqual({ ok: true });
		expect(persistNewBacklogTaskCardsMock).not.toHaveBeenCalled();
	});

	it("在 runtime 确认落盘之前不放行；确认后放行并把落盘后的快照交给订阅者", async () => {
		const deferred = createDeferred<RuntimeWorkspaceStateResponse>();
		persistNewBacklogTaskCardsMock.mockReturnValueOnce(deferred.promise);
		const listener = vi.fn();
		subscribeToWorkspaceStateAfterNewBacklogTaskCardsPersistedByRuntime(listener);

		beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
			workspaceId: "project-a",
			newBacklogTaskCardsCreatedFromWebUi: [createCard("new01"), createCard("new02")],
			boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
		});
		expect(persistNewBacklogTaskCardsMock).toHaveBeenCalledOnce();

		let released = false;
		const waiting = waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart({
			workspaceId: "project-a",
			taskCard: createCard("new02"),
		}).then((outcome) => {
			released = true;
			return outcome;
		});
		await Promise.resolve();
		expect(released).toBe(false);

		deferred.resolve(persistedWorkspaceState);
		expect(await waiting).toEqual({ ok: true });
		expect(listener).toHaveBeenCalledWith({
			workspaceId: "project-a",
			workspaceStateAfterNewBacklogTaskCardsPersisted: persistedWorkspaceState,
		});
		// 已确认的卡退出登记：之后再启动不再等、也不再发请求。
		expect(
			await waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart({
				workspaceId: "project-a",
				taskCard: createCard("new01"),
			}),
		).toEqual({ ok: true });
		expect(persistNewBacklogTaskCardsMock).toHaveBeenCalledOnce();
	});

	it("首次落盘失败时，启动入口以当前卡片重试一次；重试成功才放行", async () => {
		persistNewBacklogTaskCardsMock
			.mockRejectedValueOnce(new Error("runtime unreachable"))
			.mockResolvedValueOnce(persistedWorkspaceState);
		beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
			workspaceId: "project-a",
			newBacklogTaskCardsCreatedFromWebUi: [createCard("new01")],
			boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
		});
		const currentCard = { ...createCard("new01"), title: "renamed before start" };

		expect(
			await waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart({
				workspaceId: "project-a",
				taskCard: currentCard,
			}),
		).toEqual({ ok: true });
		expect(persistNewBacklogTaskCardsMock).toHaveBeenCalledTimes(2);
		expect(persistNewBacklogTaskCardsMock.mock.calls[1]?.[0]).toMatchObject({
			workspaceId: "project-a",
			newBacklogTaskCardsCreatedFromWebUi: [currentCard],
		});
	});

	it("重试仍失败：不放行，并带回失败原因（调用方据此不启动 agent）", async () => {
		persistNewBacklogTaskCardsMock
			.mockRejectedValueOnce(new Error("runtime unreachable"))
			.mockRejectedValueOnce(new Error("still unreachable"));
		beginPersistingNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
			workspaceId: "project-a",
			newBacklogTaskCardsCreatedFromWebUi: [createCard("new01")],
			boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
		});

		expect(
			await waitForNewTaskCardPersistedByRuntimeBeforeAgentSessionStart({
				workspaceId: "project-a",
				taskCard: createCard("new01"),
			}),
		).toEqual({ ok: false, message: "still unreachable" });
	});
});
