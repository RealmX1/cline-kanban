import { describe, expect, it } from "vitest";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import {
	applyTaskStickerEntryMutationToTaskCard,
	preservePersistedTaskStickerEntriesAgainstIncomingBoardSnapshot,
} from "../../../src/core/task-sticker-entry-mutation";

const originalCard: RuntimeBoardCard = {
	id: "sticker-task",
	prompt: "任务正文",
	title: "便签任务",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 10,
	updatedAt: 20,
	taskDescriptionLastUpdatedAt: 15,
	taskCommentEntries: [{ taskCommentEntryId: "comment", commentText: "原评论", createdAt: 11, updatedAt: 11 }],
};

function createSticker(card = originalCard, taskStickerEntryId = "first", stickerText = "第一行\n第二行") {
	return applyTaskStickerEntryMutationToTaskCard(card, { operation: "create", taskStickerEntryId, stickerText }, 30);
}

describe("Task 多便签逐条修改", () => {
	it("旧整板快照移列保留最新便签，重建任务不继承旧代际条目", () => {
		const saved = createSticker();
		const persisted = { columns: [{ id: "backlog" as const, title: "Backlog", cards: [saved] }] };
		const moved = { columns: [{ id: "review" as const, title: "Review", cards: [originalCard] }] };
		expect(
			preservePersistedTaskStickerEntriesAgainstIncomingBoardSnapshot(persisted, moved).columns[0]?.cards[0]
				?.taskStickerEntries,
		).toEqual(saved.taskStickerEntries);
		const recreated = {
			...moved,
			columns: [{ id: "review" as const, title: "Review", cards: [{ ...originalCard, createdAt: 100 }] }],
		};
		expect(
			preservePersistedTaskStickerEntriesAgainstIncomingBoardSnapshot(persisted, recreated).columns[0]?.cards[0]
				?.taskStickerEntries,
		).toBeUndefined();
	});
	it("新建默认展开，独立编辑与折叠保留其他便签和任务活动时间", () => {
		const first = createSticker();
		const both = createSticker(first, "second", "另一张便签");
		const collapsed = applyTaskStickerEntryMutationToTaskCard(
			both,
			{
				operation: "set_collapsed",
				taskStickerEntryId: "first",
				isCollapsed: true,
			},
			40,
		);
		const edited = applyTaskStickerEntryMutationToTaskCard(
			collapsed,
			{
				operation: "update_text",
				taskStickerEntryId: "first",
				expectedStickerText: "第一行\n第二行",
				stickerText: "修改正文",
			},
			50,
		);
		expect(first.taskStickerEntries?.[0]?.isCollapsed).toBe(false);
		expect(edited.taskStickerEntries).toEqual([
			{ taskStickerEntryId: "first", stickerText: "修改正文", isCollapsed: true, createdAt: 30, updatedAt: 50 },
			both.taskStickerEntries?.[1],
		]);
		expect(edited.updatedAt).toBe(20);
		expect(edited.taskDescriptionLastUpdatedAt).toBe(15);
		expect(edited.taskCommentEntries).toEqual(originalCard.taskCommentEntries);
	});

	it("重复创建、正文保存和折叠请求均为幂等", () => {
		const first = createSticker();
		expect(createSticker(first)).toBe(first);
		const mutation = {
			operation: "update_text" as const,
			taskStickerEntryId: "first",
			expectedStickerText: "第一行\n第二行",
			stickerText: "已保存",
		};
		const edited = applyTaskStickerEntryMutationToTaskCard(first, mutation, 40);
		expect(applyTaskStickerEntryMutationToTaskCard(edited, mutation, 50)).toBe(edited);
		expect(
			applyTaskStickerEntryMutationToTaskCard(
				edited,
				{
					operation: "set_collapsed",
					taskStickerEntryId: "first",
					isCollapsed: false,
				},
				60,
			),
		).toBe(edited);
		expect(createSticker(edited)).toBe(edited);
	});

	it("同一便签并发修改或删除拒绝覆盖，其他便签可以独立修改", () => {
		const both = createSticker(createSticker(), "second", "第二张");
		const edited = applyTaskStickerEntryMutationToTaskCard(
			both,
			{
				operation: "update_text",
				taskStickerEntryId: "first",
				expectedStickerText: "第一行\n第二行",
				stickerText: "别人保存的内容",
			},
			40,
		);
		expect(() =>
			applyTaskStickerEntryMutationToTaskCard(
				edited,
				{
					operation: "update_text",
					taskStickerEntryId: "first",
					expectedStickerText: "第一行\n第二行",
					stickerText: "我的草稿",
				},
				50,
			),
		).toThrow(/已被修改/);
		expect(() =>
			applyTaskStickerEntryMutationToTaskCard(
				edited,
				{
					operation: "delete",
					taskStickerEntryId: "first",
					expectedStickerText: "第一行\n第二行",
				},
				50,
			),
		).toThrow(/已被修改/);
		expect(
			applyTaskStickerEntryMutationToTaskCard(
				edited,
				{
					operation: "update_text",
					taskStickerEntryId: "second",
					expectedStickerText: "第二张",
					stickerText: "独立修改",
				},
				50,
			).taskStickerEntries?.[0],
		).toEqual(edited.taskStickerEntries?.[0]);
	});

	it("删除重试无副作用，迟到的创建重试不会复活已删除便签", () => {
		const deleted = applyTaskStickerEntryMutationToTaskCard(
			createSticker(),
			{
				operation: "delete",
				taskStickerEntryId: "first",
				expectedStickerText: "第一行\n第二行",
			},
			40,
		);
		expect(deleted.taskStickerEntries).toEqual([]);
		expect(deleted.taskStickerDeletedEntryIds).toEqual(["first"]);
		expect(createSticker(deleted)).toBe(deleted);
		expect(
			applyTaskStickerEntryMutationToTaskCard(
				deleted,
				{
					operation: "delete",
					taskStickerEntryId: "first",
					expectedStickerText: "第一行\n第二行",
				},
				50,
			),
		).toBe(deleted);
		expect(() =>
			applyTaskStickerEntryMutationToTaskCard(
				deleted,
				{
					operation: "set_collapsed",
					taskStickerEntryId: "first",
					isCollapsed: true,
				},
				50,
			),
		).toThrow(/已被删除/);
	});
});
