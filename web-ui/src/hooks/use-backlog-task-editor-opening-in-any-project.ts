import { useCallback, useRef } from "react";

import { notifyError } from "@/components/app-toaster";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";

/**
 * All projects 面板里点 backlog 行（问题 5）：原地打开那张卡的编辑对话框，不切项目、不离开 Focus View、焦点任务不动——
 * 与 This project 里点 backlog 卡同语义。当前项目的卡从本页 board 取（带 overlay，刚保存的改动也在）；其他项目的卡
 * 先只读 `taskCardAction.readTaskCardWithBoardColumn`。读到时卡已离开 backlog（别处刚启动了它），改为正常打开任务。
 */
export function useBacklogTaskEditorOpeningInAnyProject({
	currentProjectId,
	currentProjectDisplayedBoard,
	openTaskEditorForCurrentProjectTaskCardKeepingDetailSelection,
	openTaskEditorForTaskCardInOtherProject,
	openTaskInProject,
}: {
	currentProjectId: string | null;
	currentProjectDisplayedBoard: BoardData;
	openTaskEditorForCurrentProjectTaskCardKeepingDetailSelection: (taskCard: BoardCard) => void;
	openTaskEditorForTaskCardInOtherProject: (workspaceId: string, taskCard: BoardCard) => void;
	openTaskInProject: (workspaceId: string, taskId: string) => void;
}): (workspaceId: string, taskId: string) => void {
	// board 每个推流节拍都换引用；回调经 ref 读最新值，自身保持稳定（它进跨项目面板的宿主 context）。
	const currentProjectDisplayedBoardRef = useRef(currentProjectDisplayedBoard);
	currentProjectDisplayedBoardRef.current = currentProjectDisplayedBoard;

	return useCallback(
		(workspaceId: string, taskId: string) => {
			if (workspaceId === currentProjectId) {
				const selection = findCardSelection(currentProjectDisplayedBoardRef.current, taskId);
				if (selection?.column.id === "backlog") {
					openTaskEditorForCurrentProjectTaskCardKeepingDetailSelection(selection.card);
					return;
				}
				openTaskInProject(workspaceId, taskId);
				return;
			}
			readTaskCardWithBoardColumnInWorkspace(workspaceId, taskId).then(
				(response) => {
					if (response.taskCardLookupOutcome !== "task_card_found_on_workspace_board") {
						notifyError("This task is no longer on its board.");
						return;
					}
					const { taskCard, boardColumnIdContainingTaskCard } = response.taskCardSnapshot;
					if (boardColumnIdContainingTaskCard === "backlog") {
						openTaskEditorForTaskCardInOtherProject(workspaceId, taskCard);
						return;
					}
					openTaskInProject(workspaceId, taskId);
				},
				(error: unknown) => {
					notifyError(`Could not open the task: ${error instanceof Error ? error.message : String(error)}`);
				},
			);
		},
		[
			currentProjectId,
			openTaskEditorForCurrentProjectTaskCardKeepingDetailSelection,
			openTaskEditorForTaskCardInOtherProject,
			openTaskInProject,
		],
	);
}
