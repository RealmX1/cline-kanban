import { isRuntimeAgentSessionSummaryRenderedAsConversationPanel } from "@runtime-agent-catalog";
import { useCallback, useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { getTerminalThemeColors } from "@/hooks/use-theme";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { findCardSelection } from "@/state/board-state";
import { writeWorkspaceMetadataProbeScopeDeclarationInputsOfBrowserTab } from "@/stores/workspace-metadata-probe-scope-declaration-inputs-of-browser-tab-store";
import { ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";
import type { BoardCard, BoardData } from "@/types";

export interface PendingCrossProjectTaskOpen {
	repoId: string;
	taskId: string;
	expectedTaskIncarnationCreatedAtEpochMs?: number;
	// 发起时 Focus View 正开着：在途期间渲染 FocusViewCrossProjectTaskOpenInTransitShell，左栏不闪退成看板。
	originatedFromFocusView: boolean;
	// 发起那一刻 Focus View 里打开着的任务。过渡外壳上的 Cancel 回到这里；连点多次跨项目打开时保留最早那个。
	originFocusedTaskInProject: { repoId: string; taskId: string } | null;
}

/**
 * 「在某个项目里打开某个任务」——All projects 首页、Spotlight、跨项目切换面板共用的唯一入口。
 *
 * 同项目直接选中；跨项目先切 workspace（原地切，WS 重连），待目标 board 落定后再 setSelectedTaskId——
 * 绕开 project-switch 时 use-detail-task-navigation 的 closeDetail 竞态（见该 hook）。
 * 「同项目」以 board 归属为准（repoId 既是 currentProjectId、也是 projectIdOwningHydratedBoard），不只看 currentProjectId：
 * 切项目握手期间 currentProjectId 会先变成目标项目而 board 仍属上一个项目，这时在过渡外壳里再点目标项目的任务若被当成
 * 同项目，会在旧 board 里找卡、误报找不到并丢掉第一次的在途；归属不符就照跨项目处理，挂在途等目标 board 落定。
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
	projectIdOwningHydratedBoard,
	selectedTaskId,
	isDetailViewOpen,
	isCurrentProjectBoardSettled,
	setSelectedTaskId,
	handleSelectProject,
	openBacklogTaskEditor,
}: {
	board: BoardData;
	currentProjectId: string | null;
	// board 此刻装的是哪个项目的数据（use-workspace-sync，与 setBoard 同批更新）。
	projectIdOwningHydratedBoard: string | null;
	selectedTaskId: string | null;
	isDetailViewOpen: boolean;
	// 当前项目的 board 已是该项目的完整快照（不在切项目 / 等快照 / 等元数据中）。
	isCurrentProjectBoardSettled: boolean;
	setSelectedTaskId: (taskId: string | null) => void;
	handleSelectProject: (projectId: string) => void;
	openBacklogTaskEditor: (card: BoardCard) => void;
}): {
	pendingCrossProjectTaskOpen: PendingCrossProjectTaskOpen | null;
	handleOpenTaskInProject: (repoId: string, taskId: string, expectedTaskIncarnationCreatedAtEpochMs?: number) => void;
	handleNavigateToProjectBoard: (repoId: string) => Promise<void>;
	// 外壳上的 Cancel：回到发起时打开着的任务（必要时反向再切一次项目）。
	cancelPendingCrossProjectTaskOpenReturningToOriginTask: () => void;
	// 只丢掉在途态、不改导航（顶栏「返回看板」用：导航照常落到目标项目，落地后显示它的看板）。
	dismissPendingCrossProjectTaskOpen: () => void;
} {
	const [pendingCrossProjectTaskOpen, setPendingCrossProjectTaskOpen] = useState<PendingCrossProjectTaskOpen | null>(
		null,
	);
	const [pendingProjectBoardNavigation, setPendingProjectBoardNavigation] = useState<{
		repoId: string;
		resolve: () => void;
		reject: (error: Error) => void;
	} | null>(null);
	const pendingProjectBoardNavigationRef = useRef(pendingProjectBoardNavigation);
	const handleNavigateToProjectBoard = useCallback(
		(repoId: string): Promise<void> => {
			pendingProjectBoardNavigationRef.current?.reject(new Error("看板导航已被新的导航取代"));
			setPendingCrossProjectTaskOpen(null);
			setSelectedTaskId(null);
			return new Promise<void>((resolve, reject) => {
				const request = { repoId, resolve, reject };
				pendingProjectBoardNavigationRef.current = request;
				setPendingProjectBoardNavigation(request);
				handleSelectProject(repoId);
			});
		},
		[handleSelectProject, setSelectedTaskId],
	);
	useEffect(() => {
		if (!pendingProjectBoardNavigation || !isCurrentProjectBoardSettled) return;
		if (
			currentProjectId !== pendingProjectBoardNavigation.repoId ||
			projectIdOwningHydratedBoard !== pendingProjectBoardNavigation.repoId
		)
			return;
		if (selectedTaskId !== null) {
			setSelectedTaskId(null);
			return;
		}
		pendingProjectBoardNavigation.resolve();
		pendingProjectBoardNavigationRef.current = null;
		setPendingProjectBoardNavigation(null);
	}, [
		currentProjectId,
		projectIdOwningHydratedBoard,
		isCurrentProjectBoardSettled,
		pendingProjectBoardNavigation,
		selectedTaskId,
		setSelectedTaskId,
	]);
	useEffect(() => {
		if (!pendingProjectBoardNavigation) return;
		const navigationTimeout = window.setTimeout(() => {
			if (pendingProjectBoardNavigationRef.current !== pendingProjectBoardNavigation) return;
			pendingProjectBoardNavigation.reject(new Error("所属项目看板尚未加载完成，请重试"));
			pendingProjectBoardNavigationRef.current = null;
			setPendingProjectBoardNavigation(null);
		}, 30_000);
		return () => window.clearTimeout(navigationTimeout);
	}, [pendingProjectBoardNavigation]);
	useEffect(
		() => () => {
			pendingProjectBoardNavigationRef.current?.reject(new Error("看板导航宿主已关闭"));
		},
		[],
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
		(repoId: string, taskId: string, expectedTaskIncarnationCreatedAtEpochMs?: number) => {
			// 刻意不改范围：All projects 首页点进任务时仍留在 Board Scope，从 detail 返回（handleBack 清 selectedTaskId）
			// 即回到首页（Focus View 打开时首页被卸载，列滚动位置由 continuity store 补回）——与 Post-Deploy Verification
			// 面板点 task 后返回回到面板的行为一致（避免「从首页点进去、返回却落到单项目看板」的困惑）。
			if (repoId === currentProjectId && projectIdOwningHydratedBoard === repoId) {
				setPendingCrossProjectTaskOpen(null);
				// 在途期间点回当前项目的任务：先撤销在途切换（handleSelectProject 选回当前项目即撤销；
				// 不在途时是 no-op），否则导航仍会落到在途目标项目、刚选中的详情随即被切项目关掉。
				handleSelectProject(repoId);
				const selection = findCardSelection(latestBoardRef.current, taskId);
				if (
					selection &&
					expectedTaskIncarnationCreatedAtEpochMs !== undefined &&
					selection.card.createdAt !== expectedTaskIncarnationCreatedAtEpochMs
				) {
					showAppToast({ intent: "warning", message: "原任务已被删除并重建，无法用旧关联打开同 ID 新任务。" });
					return;
				}
				if (selection?.column.id === "backlog" && !selection.card.taskShelvingState?.isShelved) {
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
			// 跨项目，或目标已是 currentProjectId 但 board 还没换成它的（握手窗口）：后者 handleSelectProject 是 no-op，
			// 在途态改指向这次点的任务（保留最早的 origin），由下方落定 effect 在目标 board 就绪后打开。
			setPendingCrossProjectTaskOpen((previous) => ({
				repoId,
				taskId,
				...(expectedTaskIncarnationCreatedAtEpochMs !== undefined
					? { expectedTaskIncarnationCreatedAtEpochMs }
					: {}),
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
		[currentProjectId, handleSelectProject, projectIdOwningHydratedBoard, setSelectedTaskId],
	);

	useEffect(() => {
		if (!pendingCrossProjectTaskOpen) return;
		let isTerminalPrewarmReadCancelledByTaskNavigation = false;
		const { repoId, taskId } = pendingCrossProjectTaskOpen;
		const expectedCreatedAt = pendingCrossProjectTaskOpen.expectedTaskIncarnationCreatedAtEpochMs;
		void (
			expectedCreatedAt === undefined
				? readTaskCardWithBoardColumnInWorkspace(repoId, taskId)
				: readTaskCardWithBoardColumnInWorkspace(repoId, taskId, expectedCreatedAt)
		)
			.then((response) => {
				if (
					isTerminalPrewarmReadCancelledByTaskNavigation ||
					response.taskCardLookupOutcome !== "task_card_found_on_workspace_board"
				)
					return;
				const taskCardSnapshotReadForTerminalPrewarm = response.taskCardSnapshot;
				if (
					expectedCreatedAt !== undefined &&
					taskCardSnapshotReadForTerminalPrewarm.taskCard.createdAt !== expectedCreatedAt
				)
					return;
				if (taskCardSnapshotReadForTerminalPrewarm.boardColumnIdContainingTaskCard === "backlog") return;
				const existingTaskSessionSummaryForTerminalPrewarm =
					taskCardSnapshotReadForTerminalPrewarm.taskSessionSummaryLiveInRuntimeProcessMemory ??
					taskCardSnapshotReadForTerminalPrewarm.taskSessionSummaryPersistedInWorkspaceSessionsFile;
				// 只预热已经存在且明确走 PTY 的会话；未知通道交给正式详情页。
				if (
					!existingTaskSessionSummaryForTerminalPrewarm ||
					existingTaskSessionSummaryForTerminalPrewarm.sessionTransport === undefined ||
					isRuntimeAgentSessionSummaryRenderedAsConversationPanel(existingTaskSessionSummaryForTerminalPrewarm)
				)
					return;
				const terminalThemeColorsForTerminalPrewarm = getTerminalThemeColors();
				ensurePersistentTerminal({
					workspaceId: repoId,
					taskId,
					cursorColor: terminalThemeColorsForTerminalPrewarm.textPrimary,
					terminalBackgroundColor: terminalThemeColorsForTerminalPrewarm.surfacePrimary,
					themeColors: terminalThemeColorsForTerminalPrewarm,
					deferAutomaticSessionResumeUntilVisibleMount: true,
				});
			})
			.catch(() => undefined);
		return () => {
			isTerminalPrewarmReadCancelledByTaskNavigation = true;
		};
	}, [pendingCrossProjectTaskOpen]);

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
		if (
			selection &&
			pendingCrossProjectTaskOpen.expectedTaskIncarnationCreatedAtEpochMs !== undefined &&
			selection.card.createdAt !== pendingCrossProjectTaskOpen.expectedTaskIncarnationCreatedAtEpochMs
		) {
			showAppToast({ intent: "warning", message: "原任务已被删除并重建，无法用旧关联打开同 ID 新任务。" });
			return;
		}
		if (selection?.column.id === "backlog" && !selection.card.taskShelvingState?.isShelved) {
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
		handleNavigateToProjectBoard,
		cancelPendingCrossProjectTaskOpenReturningToOriginTask,
		dismissPendingCrossProjectTaskOpen,
	};
}
