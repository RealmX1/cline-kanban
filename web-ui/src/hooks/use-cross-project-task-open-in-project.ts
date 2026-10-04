import { useCallback, useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { findCardSelection } from "@/state/board-state";
import type { BoardCard, BoardData } from "@/types";

export interface PendingCrossProjectTaskOpen {
	repoId: string;
	taskId: string;
	// 发起时 Focus View 正开着：在途期间渲染 FocusViewCrossProjectTaskOpenInTransitShell，左栏不闪退成看板。
	originatedFromFocusView: boolean;
}

/**
 * 「在某个项目里打开某个任务」——Board Overview、Spotlight、跨项目切换面板共用的唯一入口。
 *
 * 同项目直接选中；跨项目先切 workspace（原地切，WS 重连），待目标 board 落定后再 setSelectedTaskId——
 * 绕开 project-switch 时 use-detail-task-navigation 的 closeDetail 竞态（见该 hook）。
 * backlog 卡与看板上单击 backlog 卡同语义：打开编辑对话框，不进详情（task-card-business-props.ts）。
 *
 * 在途态的一切收尾决策（选中详情 / 打开 backlog 编辑器 / 判定找不到并提示）都只在 isCurrentProjectBoardSettled
 * 之后做：切项目时 currentProjectId 先于 board 换成目标项目——快照到达那一帧 App 的 board 仍是上一个项目的
 * （applyWorkspaceState 要到其后的 effect 里才 setBoard），而 taskId 只在一个看板内唯一、跨项目会撞号，提前查卡
 * 会命中旧项目的同号卡；backlog 编辑器提前打开还会被切项目途中的 resetTaskEditorState 关掉。
 * 落定在别的项目（导航被顶栏切换器 / popstate 改到第三个项目或切回原项目，或目标切换失败回落）即取消在途态，
 * 不让过渡外壳一直挂着遮住新项目的看板。目标 board 落定却找不到该任务（已被删 / 已被别处永久删除）时同样清掉并提示。
 */
export function useCrossProjectTaskOpenInProject({
	board,
	currentProjectId,
	isDetailViewOpen,
	isCurrentProjectBoardSettled,
	setSelectedTaskId,
	handleSelectProject,
	openBacklogTaskEditor,
}: {
	board: BoardData;
	currentProjectId: string | null;
	isDetailViewOpen: boolean;
	// 当前项目的 board 已是该项目的完整快照（不在切项目 / 等快照 / 等元数据中）。
	isCurrentProjectBoardSettled: boolean;
	setSelectedTaskId: (taskId: string | null) => void;
	handleSelectProject: (projectId: string) => void;
	openBacklogTaskEditor: (card: BoardCard) => void;
}): {
	pendingCrossProjectTaskOpen: PendingCrossProjectTaskOpen | null;
	handleOpenTaskInProject: (repoId: string, taskId: string) => void;
	cancelPendingCrossProjectTaskOpen: () => void;
} {
	const [pendingCrossProjectTaskOpen, setPendingCrossProjectTaskOpen] = useState<PendingCrossProjectTaskOpen | null>(
		null,
	);
	const isDetailViewOpenRef = useRef(isDetailViewOpen);
	isDetailViewOpenRef.current = isDetailViewOpen;
	const latestBoardRef = useRef(board);
	latestBoardRef.current = board;
	const openBacklogTaskEditorRef = useRef(openBacklogTaskEditor);
	openBacklogTaskEditorRef.current = openBacklogTaskEditor;

	const handleOpenTaskInProject = useCallback(
		(repoId: string, taskId: string) => {
			// 刻意不关概览：detail 打开时 home layout 只是 visibility:hidden（非卸载），概览仍在其下；
			// 从 detail 返回（handleBack 清 selectedTaskId）即重现概览——与 Post-Deploy Verification 面板点 task
			// 后返回回到面板的行为一致（避免「从概览点进去、返回却落到普通 board」的困惑）。
			if (repoId === currentProjectId) {
				setPendingCrossProjectTaskOpen(null);
				const selection = findCardSelection(latestBoardRef.current, taskId);
				if (selection?.column.id === "backlog") {
					openBacklogTaskEditorRef.current(selection.card);
					return;
				}
				if (!selection) {
					// 选中一个看板上没有的 id 会让 Focus View 无卡可显、静默关掉——保持当前视图，如实提示（cf427）。
					showAppToast({ intent: "warning", message: "That task is no longer on its project's board." });
					return;
				}
				setSelectedTaskId(taskId);
				return;
			}
			setPendingCrossProjectTaskOpen((previous) => ({
				repoId,
				taskId,
				// 连点两个跨项目任务时，第二次发起那一刻 detail 已因切项目被关掉，但用户仍在过渡外壳里。
				originatedFromFocusView: isDetailViewOpenRef.current || (previous?.originatedFromFocusView ?? false),
			}));
			handleSelectProject(repoId);
		},
		[currentProjectId, handleSelectProject, setSelectedTaskId],
	);

	useEffect(() => {
		// 未落定时 board 可能还是上一个项目的（见顶部注释），任何分支都不能拿它做决策。
		if (!pendingCrossProjectTaskOpen || !isCurrentProjectBoardSettled) {
			return;
		}
		if (currentProjectId !== pendingCrossProjectTaskOpen.repoId) {
			// 已落定却不在目标项目：导航已不再朝向目标，取消在途态。正常在途不会走到这里——发起时
			// handleSelectProject 与 setPendingCrossProjectTaskOpen 同批 setRequestedProjectId，下一次渲染起
			// isProjectSwitching 为真、board 不算落定，直到 currentProjectId 真正换成目标项目。
			setPendingCrossProjectTaskOpen(null);
			return;
		}
		const selection = findCardSelection(board, pendingCrossProjectTaskOpen.taskId);
		setPendingCrossProjectTaskOpen(null);
		if (selection?.column.id === "backlog") {
			openBacklogTaskEditorRef.current(selection.card);
			return;
		}
		if (selection) {
			setSelectedTaskId(pendingCrossProjectTaskOpen.taskId);
			return;
		}
		showAppToast({ intent: "warning", message: "That task is no longer on its project's board." });
	}, [board, currentProjectId, isCurrentProjectBoardSettled, pendingCrossProjectTaskOpen, setSelectedTaskId]);

	const cancelPendingCrossProjectTaskOpen = useCallback(() => setPendingCrossProjectTaskOpen(null), []);

	return { pendingCrossProjectTaskOpen, handleOpenTaskInProject, cancelPendingCrossProjectTaskOpen };
}
