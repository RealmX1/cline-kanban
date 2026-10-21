import { describe, expect, it } from "vitest";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { addTaskToColumn } from "../../../src/core/task-board-mutations";
import { appendTaskCommentToLatestTaskCard } from "../../../src/task-indexing-support/append-task-comment-to-latest-task-card";

describe("独立任务备注追加", () => {
	it("追加保留最新并发备注、原 prompt，重试不重复写入", () => {
		const empty: RuntimeBoardData = { columns: [{ id: "backlog", title: "Backlog", cards: [] }] };
		const { board } = addTaskToColumn(
			empty,
			"backlog",
			{
				taskId: "task",
				prompt: "完整原始要求",
				baseRef: "main",
				taskCommentEntries: [
					{ taskCommentEntryId: "concurrent", commentText: "并发新增", createdAt: 1, updatedAt: 1 },
				],
			},
			() => "unused",
			1,
		);
		const request = {
			workspaceId: "project",
			taskId: "task",
			taskIncarnationCreatedAtEpochMs: 1,
			taskCommentEntryId: "finding",
			commentText: "关联发现",
		};
		const one = appendTaskCommentToLatestTaskCard(board, request, 2);
		expect(one.board.columns[0]?.cards[0]?.prompt).toBe("完整原始要求");
		expect(one.board.columns[0]?.cards[0]?.taskCommentEntries?.map((entry) => entry.commentText)).toEqual([
			"并发新增",
			"关联发现",
		]);
		expect(appendTaskCommentToLatestTaskCard(one.board, request, 3).appended).toBe(false);
		expect(() => appendTaskCommentToLatestTaskCard(one.board, { ...request, commentText: "另一条发现" }, 3)).toThrow(
			"不同正文",
		);
		expect(() =>
			appendTaskCommentToLatestTaskCard(one.board, { ...request, taskIncarnationCreatedAtEpochMs: 999 }, 3),
		).toThrow("incarnation");
	});
});
