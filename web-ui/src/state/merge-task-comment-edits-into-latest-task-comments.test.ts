import { expect, it } from "vitest";
import { mergeTaskCommentEditsIntoLatestTaskComments } from "./merge-task-comment-edits-into-latest-task-comments";

const original = { taskCommentEntryId: "original", commentText: "旧评论", createdAt: 1, updatedAt: 1 };
const appended = { taskCommentEntryId: "completion", commentText: "之后追加的结案评论", createdAt: 2, updatedAt: 2 };
it("编辑与删除只作用于原有评论，保留后来追加的评论", () => {
	expect(
		mergeTaskCommentEditsIntoLatestTaskComments(
			[original, appended],
			[original],
			[{ ...original, commentText: "修改后的评论" }],
		),
	).toEqual([{ ...original, commentText: "修改后的评论" }, appended]);
	expect(mergeTaskCommentEditsIntoLatestTaskComments([original, appended], [original], [])).toEqual([appended]);
});
