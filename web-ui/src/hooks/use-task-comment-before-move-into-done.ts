import type { TaskClosureRequest } from "@runtime-task-closure-contract";
import { useCallback, useRef, useState } from "react";
import type { BoardCard } from "@/types";
import type { TaskCommentToAppendWhenMovingIntoDone } from "@/types/task-card-move-into-done-request";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";
import { createTaskCommentEntryId } from "@/utils/create-task-comment-entry-id";

interface TaskCommentBeforeMoveIntoDoneRequest {
	workspaceId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs: number;
	taskTitle: string;
	insertAtIndexWithinDoneBoardColumn?: number;
	closureRequestId: string;
	openingRequestIdentity?: symbol;
	expectedTaskUpdatedAtEpochMs: number;
	taskCommentEntryId: string;
	commentText: string;
	closure?: TaskClosureRequest;
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
		(workspaceId: string, card: BoardCard, insertAtIndexWithinDoneBoardColumn?: number) => {
			const existing = requestRef.current;
			if (existing?.phase === "submitting") return;
			const openingRequestIdentity = Symbol("task-closure-opening-request");
			if (
				existing?.workspaceId === workspaceId &&
				existing.taskId === card.id &&
				existing.expectedTaskIncarnationCreatedAtEpochMs === card.createdAt
			) {
				replaceRequest({ ...existing, openingRequestIdentity });
				return;
			}
			replaceRequest({
				workspaceId,
				taskId: card.id,
				expectedTaskIncarnationCreatedAtEpochMs: card.createdAt,
				taskTitle: card.title,
				insertAtIndexWithinDoneBoardColumn,
				closureRequestId: createRandomUuidV4WithInsecureContextFallback(),
				openingRequestIdentity,
				expectedTaskUpdatedAtEpochMs: card.updatedAt,
				taskCommentEntryId: createTaskCommentEntryId(),
				commentText: "",
				phase: "editing",
				errorMessage: null,
			});
		},
		[replaceRequest],
	);
	const prepareSubmission = useCallback(
		(commentText: string, closure?: TaskClosureRequest): TaskCommentToAppendWhenMovingIntoDone | null => {
			const current = requestRef.current;
			const trimmed = commentText.trim() || closure?.details.reason || (closure ? "记录任务结案结果" : "");
			if (!current || current.phase !== "editing" || !trimmed) return null;
			const taskCommentEntryId =
				current.commentText && current.commentText !== trimmed
					? createTaskCommentEntryId()
					: current.taskCommentEntryId;
			replaceRequest({
				...current,
				taskCommentEntryId,
				commentText: trimmed,
				closure,
				phase: "submitting",
				errorMessage: null,
			});
			return {
				taskCommentEntryId,
				commentText: trimmed,
				closure,
				insertAtIndexWithinDoneBoardColumn: current.insertAtIndexWithinDoneBoardColumn,
			};
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
