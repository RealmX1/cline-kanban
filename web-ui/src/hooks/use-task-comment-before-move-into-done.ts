import { useCallback, useRef, useState } from "react";
import type { BoardCard } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";
import { createTaskCommentEntryId } from "@/utils/create-task-comment-entry-id";

interface TaskCommentBeforeMoveIntoDoneRequest {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs: number;
	taskTitle: string;
	taskCommentEntryId: string;
	commentText: string;
	phase: "editing" | "submitting" | "awaiting_confirmation";
	errorMessage: string | null;
}

// 草稿属于动作宿主而非卡体副本，卡片卸载或进入下一层确认时仍保留。
export function useTaskCommentBeforeMoveIntoDone() {
	const [request, setRequest] = useState<TaskCommentBeforeMoveIntoDoneRequest | null>(null);
	const requestRef = useRef(request);
	const replaceRequest = useCallback((next: TaskCommentBeforeMoveIntoDoneRequest | null) => {
		requestRef.current = next;
		setRequest(next);
	}, []);
	const open = useCallback(
		(workspaceId: string, card: BoardCard) => {
			if (requestRef.current) return;
			replaceRequest({
				workspaceId,
				taskId: card.id,
				expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
				taskTitle: card.title,
				taskCommentEntryId: createTaskCommentEntryId(),
				commentText: "",
				phase: "editing",
				errorMessage: null,
			});
		},
		[replaceRequest],
	);
	const prepareSubmission = useCallback(
		(commentText: string): TaskCommentToAppendWhenMovingIntoDone | null => {
			const current = requestRef.current;
			const trimmed = commentText.trim();
			if (!current || current.phase !== "editing" || !trimmed) return null;
			const taskCommentEntryId =
				current.commentText && current.commentText !== trimmed
					? createTaskCommentEntryId()
					: current.taskCommentEntryId;
			replaceRequest({
				...current,
				taskCommentEntryId,
				commentText: trimmed,
				phase: "submitting",
				errorMessage: null,
			});
			return { taskCommentEntryId, commentText: trimmed };
		},
		[replaceRequest],
	);
	const suspendForConfirmation = useCallback(
		(taskId: string, expectedTaskCommentEntryId?: string) => {
			const current = requestRef.current;
			if (
				current?.taskId === taskId &&
				(!expectedTaskCommentEntryId || current.taskCommentEntryId === expectedTaskCommentEntryId)
			)
				replaceRequest({ ...current, phase: "awaiting_confirmation" });
		},
		[replaceRequest],
	);
	const returnToEditing = useCallback(
		(taskId: string, errorMessage: string | null = null, expectedTaskCommentEntryId?: string) => {
			const current = requestRef.current;
			if (
				current?.taskId === taskId &&
				(!expectedTaskCommentEntryId || current.taskCommentEntryId === expectedTaskCommentEntryId)
			)
				replaceRequest({ ...current, phase: "editing", errorMessage });
		},
		[replaceRequest],
	);
	const complete = useCallback(
		(taskId: string, expectedTaskCommentEntryId?: string) => {
			if (
				requestRef.current?.taskId === taskId &&
				(!expectedTaskCommentEntryId || requestRef.current.taskCommentEntryId === expectedTaskCommentEntryId)
			)
				replaceRequest(null);
		},
		[replaceRequest],
	);
	const cancel = useCallback(() => replaceRequest(null), [replaceRequest]);
	return { request, open, prepareSubmission, suspendForConfirmation, returnToEditing, complete, cancel };
}

export type TaskCommentBeforeMoveIntoDoneController = ReturnType<typeof useTaskCommentBeforeMoveIntoDone>;
