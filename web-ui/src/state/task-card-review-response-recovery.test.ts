import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "@/runtime/types";
import { moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import { resetPendingTaskCardCommandBoardOverlayStore } from "@/stores/pending-task-card-command-board-overlay-store";
import {
	clearAllTaskCardActionCommandsInFlight,
	readTaskCardActionCommandKindInFlight,
} from "@/stores/task-card-action-commands-in-flight-store";

const snapshot: RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries = {
	taskCard: {
		id: "task",
		title: "隔离任务",
		prompt: "测试",
		createdAt: 7,
		updatedAt: 8,
		startInPlanMode: false,
		baseRef: "main",
	},
	boardColumnIdContainingTaskCard: "review",
	taskSessionSummaryLiveInRuntimeProcessMemory: null,
	taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
};
const request = { workspaceId: "review-recovery", taskId: "task", expectedTaskIncarnationCreatedAtEpochMs: 7 };
function jsonResponse(data: unknown) {
	return new Response(JSON.stringify({ result: { data } }), { headers: { "content-type": "application/json" } });
}
beforeEach(() => {
	vi.useFakeTimers();
	clearAllTaskCardActionCommandsInFlight();
});
afterEach(() => {
	resetPendingTaskCardCommandBoardOverlayStore();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Review 响应丢失的权威状态回查", () => {
	it.each(["gateway", "connection_reset"])(
		"%s：服务端已成功，回查采用同一 incarnation 的快照且不重发动作",
		async (fault) => {
			const observedRequests: Array<{ url: URL; body: string | null }> = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = new URL(String(input), "http://isolated.test");
					observedRequests.push({ url, body: init?.body ? String(init.body) : null });
					if (url.pathname.includes("moveTaskCardIntoReview")) {
						if (fault === "connection_reset") throw new TypeError("ECONNRESET");
						return new Response("Bad Gateway", { status: 502 });
					}
					return jsonResponse({
						taskCardLookupOutcome: "task_card_found_on_workspace_board",
						taskCardSnapshot: snapshot,
					});
				}),
			);
			const pending = moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime(request);
			await vi.runAllTimersAsync();
			const result = await pending;
			expect(result).toMatchObject({
				taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
				response: {
					taskCardSnapshotAfterAction: snapshot,
					taskCardWasMovedIntoReviewColumnByThisAction: false,
				},
			});
			expect(observedRequests.filter(({ url }) => url.pathname.includes("moveTaskCardIntoReview"))).toHaveLength(1);
			const reads = observedRequests.filter(({ url }) => url.pathname.includes("readTaskCardWithBoardColumn"));
			expect(reads).toHaveLength(1);
			expect(reads[0]?.url.searchParams.get("batch")).toBeNull();
			expect(reads[0]?.url.searchParams.get("input")).toContain('"expectedTaskIncarnationCreatedAtEpochMs":7');
			expect(readTaskCardActionCommandKindInFlight(request.workspaceId, request.taskId)).toBeNull();
		},
	);
	it.each(["unavailable", "not_review", "different_incarnation", "timeout"])(
		"%s：三次有限回查后明确未知并释放操作入口",
		async (condition) => {
			let mutations = 0;
			const queryTimes: number[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: RequestInfo | URL) => {
					if (String(input).includes("moveTaskCardIntoReview")) {
						mutations++;
						throw new TypeError("ECONNRESET");
					}
					queryTimes.push(Date.now());
					if (condition === "unavailable") throw new TypeError("ECONNRESET");
					if (condition === "timeout") return new Promise<Response>(() => {});
					return jsonResponse({
						taskCardLookupOutcome: "task_card_found_on_workspace_board",
						taskCardSnapshot: {
							...snapshot,
							...(condition === "not_review"
								? { boardColumnIdContainingTaskCard: "in_progress" }
								: { taskCard: { ...snapshot.taskCard, createdAt: 99 } }),
						},
					});
				}),
			);
			const pending = moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime(request);
			await vi.runAllTimersAsync();
			expect(await pending).toMatchObject({
				taskCardActionCommandExecutionOutcome: "command_failed",
				commandFailureMessage: expect.stringContaining("结果未知"),
			});
			expect(mutations).toBe(1);
			expect(queryTimes).toHaveLength(3);
			const deadline = condition === "timeout" ? 8_000 : 0;
			expect(queryTimes[1]! - queryTimes[0]!).toBe(deadline + 400);
			expect(queryTimes[2]! - queryTimes[1]!).toBe(deadline + 1_200);
			expect(readTaskCardActionCommandKindInFlight(request.workspaceId, request.taskId)).toBeNull();
		},
	);
	it("明确的业务拒绝直接呈现，不回查或重发", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "任务身份已变化",
							code: -32009,
							data: { code: "CONFLICT", httpStatus: 409 },
						},
					}),
					{ status: 409, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const pending = moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime(request);
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({
			taskCardActionCommandExecutionOutcome: "command_failed",
			commandFailureMessage: "任务身份已变化",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
