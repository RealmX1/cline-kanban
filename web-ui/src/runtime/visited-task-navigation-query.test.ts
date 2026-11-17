import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVisitedTaskNavigationTarget } from "@/runtime/visited-task-navigation-query";
import type { VisitedTaskHistoryEntry } from "@/state/visited-task-navigation-history";

const { query, readCard } = vi.hoisted(() => ({ query: vi.fn(), readCard: vi.fn() }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workUnit: {
			resolveKanbanBoardCardIdentityByBareTaskId: { query },
		},
	}),
}));
vi.mock("@/runtime/task-card-action-query", () => ({ readTaskCardWithBoardColumnInWorkspace: readCard }));

const entry: VisitedTaskHistoryEntry = {
	workspaceId: "one",
	taskId: "same",
	taskIncarnationCreatedAtEpochMs: 100,
	titleSnapshot: "旧标题",
	projectNameSnapshot: "项目一",
	lastVisitedAtEpochMs: 1,
	unavailable: false,
};
const identity = (workspaceId: string, incarnation = 100) => ({
	workspaceId,
	taskId: "same",
	taskIncarnationCreatedAtEpochMs: incarnation,
});
function snapshot(incarnation = 100) {
	return {
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: { taskCard: { id: "same", createdAt: incarnation, title: "最新标题" } },
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	readCard.mockResolvedValue(snapshot());
});

describe("访问历史的精确任务定位", () => {
	it("跨项目同号不混淆，迁移沿登记别名定位当前项目并保留 canonical 身份", async () => {
		query.mockResolvedValue({
			kanbanBoardCardIdentityCandidates: [
				{ kanbanBoardCard: identity("unrelated"), permanentlyRemovedFromBoardAt: null },
				{
					kanbanBoardCard: identity("two"),
					canonicalKanbanBoardCard: identity("one"),
					workspaceIdsUsedByTaskIncarnation: ["one", "two"],
					permanentlyRemovedFromBoardAt: null,
				},
			],
		});
		const result = await resolveVisitedTaskNavigationTarget(entry, new AbortController().signal);
		expect(result).toMatchObject({
			outcome: "available",
			currentWorkspaceId: "two",
			entry: { workspaceId: "one", titleSnapshot: "最新标题" },
		});
		expect(readCard).toHaveBeenCalledWith("two", "same", undefined, expect.any(AbortSignal));
	});

	it("删除重建只标记原任务不可用，不能选同号新任务或其他项目任务", async () => {
		query.mockResolvedValue({
			kanbanBoardCardIdentityCandidates: [
				{ kanbanBoardCard: identity("one"), permanentlyRemovedFromBoardAt: 200 },
				{ kanbanBoardCard: identity("one", 300), permanentlyRemovedFromBoardAt: null },
			],
		});
		expect(await resolveVisitedTaskNavigationTarget(entry, new AbortController().signal)).toEqual({
			outcome: "unavailable",
		});
		expect(readCard).not.toHaveBeenCalled();
	});

	it("身份查询暂不可用时可用精确看板快照补证，网络失败保持未知", async () => {
		query.mockRejectedValue(new Error("账本暂不可用"));
		expect(await resolveVisitedTaskNavigationTarget(entry, new AbortController().signal)).toMatchObject({
			outcome: "available",
			currentWorkspaceId: "one",
		});
		readCard.mockRejectedValue(new Error("断连"));
		await expect(resolveVisitedTaskNavigationTarget(entry, new AbortController().signal)).rejects.toThrow("断连");
	});

	it("没有身份记录时仍验证 incarnation，重建不能通过", async () => {
		query.mockResolvedValue({ kanbanBoardCardIdentityCandidates: [] });
		readCard.mockResolvedValue(snapshot(300));
		expect(await resolveVisitedTaskNavigationTarget(entry, new AbortController().signal)).toEqual({
			outcome: "unavailable",
		});
	});

	it("身份登记含糊或不可读且原卡缺失时保持未知，不误标为删除", async () => {
		query.mockResolvedValue({
			kanbanBoardCardIdentityCandidates: [
				{ kanbanBoardCard: identity("one"), permanentlyRemovedFromBoardAt: null },
				{
					kanbanBoardCard: identity("two"),
					canonicalKanbanBoardCard: identity("one"),
					permanentlyRemovedFromBoardAt: null,
				},
			],
		});
		await expect(resolveVisitedTaskNavigationTarget(entry, new AbortController().signal)).rejects.toThrow("歧义");
		query.mockRejectedValue(new Error("账本不可读"));
		readCard.mockResolvedValue({ taskCardLookupOutcome: "task_card_not_found_on_workspace_board" });
		await expect(resolveVisitedTaskNavigationTarget(entry, new AbortController().signal)).rejects.toThrow(
			"暂时无法核验",
		);
	});
});
