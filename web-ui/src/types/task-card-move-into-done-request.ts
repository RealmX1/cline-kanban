import type { RuntimeTaskCardActionMoveIntoDoneRequest } from "@/runtime/types";

export type TaskCommentToAppendWhenMovingIntoDone = NonNullable<
	RuntimeTaskCardActionMoveIntoDoneRequest["taskCommentToAppendWhenMovingIntoDone"]
>;

export type TaskCardMoveIntoDoneRequestHandler = (
	taskId: string,
	options?: { requestTaskCommentBeforeMovingIntoDone: true },
) => void;
