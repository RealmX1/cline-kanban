import { randomUUID } from "node:crypto";
import type { RuntimeBoardData } from "../core/api-contract";
import type { AppendTaskCommentRequest } from "../core/task-indexing-support-contract";
import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { taskIndexingMaterialRequirementsFingerprint } from "./incoming-work-item-relation-analysis";

/** 在 board 锁内只追加最新备注，不把客户端整份旧数组写回。 */
export function appendTaskCommentToLatestTaskCard(
	board: RuntimeBoardData,
	input: AppendTaskCommentRequest & {
		taskCommentEntryId: string;
		expectedRequirementsFingerprint?: string;
		workspaceId: string;
	},
	now: number,
) {
	const column = board.columns.find((entry) => entry.cards.some((card) => card.id === input.taskId));
	const task = column?.cards.find((card) => card.id === input.taskId);
	if (!task || !column) throw new Error(`找不到任务 ${input.taskId}。`);
	if (input.taskIncarnationCreatedAtEpochMs !== undefined && task.createdAt !== input.taskIncarnationCreatedAtEpochMs)
		throw new Error("任务 incarnation 已变化，拒绝向新身份追加旧发现。");
	if (
		input.expectedRequirementsFingerprint &&
		taskIndexingMaterialRequirementsFingerprint({
			taskReference: {
				workUnitType: "kanban_board_card",
				workspaceId: input.workspaceId,
				taskId: task.id,
				taskIncarnationCreatedAtEpochMs: task.createdAt,
			},
			title: task.title ?? "",
			prompt: task.prompt,
			columnId: column.id,
		}) !== input.expectedRequirementsFingerprint
	)
		throw new Error("任务要求在写入备注前已变化，拒绝过时分诊。");
	const existing = task.taskCommentEntries?.find((comment) => comment.taskCommentEntryId === input.taskCommentEntryId);
	if (existing) {
		if (existing.commentText !== input.commentText) throw new Error("同一备注 id 对应不同正文，未覆盖已有备注。");
		return { board, appended: false, comment: existing };
	}
	const comment = {
		taskCommentEntryId: input.taskCommentEntryId,
		commentText: input.commentText,
		createdAt: now,
		updatedAt: now,
	};
	return {
		board: {
			...board,
			columns: board.columns.map((entry) =>
				entry === column
					? {
							...entry,
							cards: entry.cards.map((card) =>
								card === task
									? {
											...card,
											taskCommentEntries: [...(card.taskCommentEntries ?? []), comment],
											updatedAt: now,
										}
									: card,
							),
						}
					: entry,
			),
		},
		appended: true,
		comment,
	};
}

export async function appendTaskCommentThroughRuntimeBoardMutation(input: {
	scope: RuntimeTrpcWorkspaceScope;
	request: AppendTaskCommentRequest;
	intent: TaskMutationIntentWithResolvedActor;
	expectedRequirementsFingerprint?: string;
	broadcastState: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}) {
	const request = {
		...input.request,
		taskCommentEntryId: input.request.taskCommentEntryId ?? `task-comment-${randomUUID()}`,
		workspaceId: input.scope.workspaceId,
		expectedRequirementsFingerprint: input.expectedRequirementsFingerprint,
	};
	const result = await mutateWorkspaceState(input.scope.workspacePath, input.intent, (state) => {
		const result = appendTaskCommentToLatestTaskCard(state.board, request, Date.now());
		return {
			board: result.board,
			value: { appended: result.appended, comment: result.comment },
			save: result.appended,
		};
	});
	if (result.saved) await input.broadcastState(input.scope.workspaceId, input.scope.workspacePath);
	return result.value;
}
