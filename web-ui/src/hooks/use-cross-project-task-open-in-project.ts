import { useCallback, useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { findCardSelection } from "@/state/board-state";
import { writeWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab } from "@/stores/workspace-metadata-probe-scope-declaration-inputs-of-browser-tab-store";
import type { BoardCard, BoardData } from "@/types";

export interface PendingCrossProjectTaskOpen {
	repoId: string;
	taskId: string;
	// 发起时 Focus View 正开着：在途期间渲染 FocusViewCrossProjectTaskOpenInTransitShell，左栏不闪退成看板。
	originatedFromFocusView: boolean;
	// 发起那一刻 Focus View 里打开着的任务。过渡外壳上的 Cancel 回到这里；连点多次跨项目打开时保留最早那个。
	originFocusedTaskInProject: { repoId: string; taskId: string } | null;
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
	selectedTaskId,
	isDetailViewOpen,
	isCurrentProjectBoardSettled,
	setSelectedTaskId,
	handleSelectProject,
	openBacklogTaskEditor,
}: {
	board: BoardData;
	currentProjectId: string | null;
	selectedTaskId: string | null;
	isDetailViewOpen: boolean;
	// 当前项目的 board 已是该项目的完整快照（不在切项目 / 等快照 / 等元数据中）。
	isCurrentProjectBoardSettled: boolean;
	setSelectedTaskId: (taskId: string | null) => void;
	handleSelectProject: (projectId: string) => void;
	openBacklogTaskEditor: (card: BoardCard) => void;
}): {
	pendingCrossProjectTaskOpen: PendingCrossProjectTaskOpen | null;
	handleOpenTaskInProject: (repoId: string, taskId: string) => void;
	// 外壳上的 Cancel：回到发起时打开着的任务（必要时反向再切一次项目）。
	cancelPendingCrossProjectTaskOpenReturningToOriginTask: () => void;
	// 只丢掉在途态、不改导航（顶栏「返回看板」用：导航照常落到目标项目，落地后显示它的看板）。
	dismissPendingCrossProjectTaskOpen: () => void;
} {
	const [pendingCrossProjectTaskOpen, setPendingCrossProjectTaskOpen] = useState<PendingCrossProjectTaskOpen | null>(
		null,
	);
	const isDetailViewOpenRef = useRef(isDetailViewOpen);
	isDetailViewOpenRef.current = isDetailViewOpen;
	const selectedTaskIdRef = useRef(selectedTaskId);
	selectedTaskIdRef.current = selectedTaskId;
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
				// 在途期间点回当前项目的任务：先撤销在途切换（handleSelectProject 选回当前项目即撤销；
				// 不在途时是 no-op），否则导航仍会落到在途目标项目、刚选中的详情随即被切项目关掉。
				handleSelectProject(repoId);
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
				originFocusedTaskInProject:
					previous?.originFocusedTaskInProject ??
					(isDetailViewOpenRef.current && currentProjectId && selectedTaskIdRef.current
						? { repoId: currentProjectId, taskId: selectedTaskIdRef.current }
						: null),
			}));
			// 切项目（WS 重连）之前同步登记目标任务：新连接的 URL 就带上它，All projects 下首轮 git 探测只探它，
			// 不等目标项目每张卡的 git 跑完。
			writeWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab({
				focusedTaskInProject: { workspaceId: repoId, taskId },
			});
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

	const dismissPendingCrossProjectTaskOpen = useCallback(() => setPendingCrossProjectTaskOpen(null), []);
	const cancelPendingCrossProjectTaskOpenReturningToOriginTask = useCallback(() => {
		const origin = pendingCrossProjectTaskOpen?.originFocusedTaskInProject ?? null;
		if (!origin) {
			setPendingCrossProjectTaskOpen(null);
			return;
		}
		// 走同一个入口：原项目仍是当前项目（快照未到）时它撤销在途切换并选中原任务；已切过去时反向打开。
		handleOpenTaskInProject(origin.repoId, origin.taskId);
	}, [handleOpenTaskInProject, pendingCrossProjectTaskOpen]);

	return {
		pendingCrossProjectTaskOpen,
		handleOpenTaskInProject,
		cancelPendingCrossProjectTaskOpenReturningToOriginTask,
		dismissPendingCrossProjectTaskOpen,
	};
}
