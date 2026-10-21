import type { TaskCommentEntry } from "@/types";

// 只应用本次编辑的增删改，保留对话框打开后由其他入口追加的评论（例如结案评论）。
export function mergeTaskCommentEditsIntoLatestTaskComments(
	latestEntries: TaskCommentEntry[],
	originalEntries: TaskCommentEntry[],
	editedEntries: TaskCommentEntry[],
): TaskCommentEntry[] {
	const originalById = new Map(originalEntries.map((entry) => [entry.taskCommentEntryId, entry]));
	const editedById = new Map(editedEntries.map((entry) => [entry.taskCommentEntryId, entry]));
	const merged = latestEntries
		.filter((entry) => !originalById.has(entry.taskCommentEntryId) || editedById.has(entry.taskCommentEntryId))
		.map((entry) => {
			const edited = editedById.get(entry.taskCommentEntryId);
			const original = originalById.get(entry.taskCommentEntryId);
			return edited && edited.commentText !== original?.commentText ? edited : entry;
		});
	const retainedIds = new Set(merged.map((entry) => entry.taskCommentEntryId));
	for (const edited of editedEntries) {
		if (
			!retainedIds.has(edited.taskCommentEntryId) &&
			edited.commentText !== originalById.get(edited.taskCommentEntryId)?.commentText
		)
			merged.push(edited);
	}
	return merged;
}
