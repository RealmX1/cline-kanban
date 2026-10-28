import type { RuntimeTaskCardActionMoveIntoDoneRequest } from "@/runtime/types";

export type TaskCommentToAppendWhenMovingIntoDone = NonNullable<
	RuntimeTaskCardActionMoveIntoDoneRequest["taskCommentToAppendWhenMovingIntoDone"]
> & {
	closure?: NonNullable<RuntimeTaskCardActionMoveIntoDoneRequest["closure"]>;
	insertAtIndexWithinDoneBoardColumn?: number;
};

export type TaskCardMoveIntoDoneRequestHandler = (
	taskId: string,
	options?: { requestTaskCommentBeforeMovingIntoDone: true },
) => void;
