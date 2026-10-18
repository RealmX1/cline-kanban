import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { useBoardInteractions } from "../src/hooks/use-board-interactions";
import { useCacheWarmTaskFocusNavigationAfterValidationMove } from "../src/hooks/use-cache-warm-task-focus-navigation-after-validation-move";
import { useCrossProjectRecentlyActiveTaskSwitcherHost } from "../src/hooks/use-cross-project-recently-active-task-switcher-host";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "../src/hooks/use-cross-project-recently-active-task-switcher-sections";
import { useCrossProjectTaskOpenInProject } from "../src/hooks/use-cross-project-task-open-in-project";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary } from "../src/runtime/types";
import { moveTaskToColumn } from "../src/state/board-state";
import type { BoardCard, BoardData } from "../src/types";
import "../src/styles/globals.css";

const now = Date.now();
const scenario = new URLSearchParams(location.search).get("scenario") ?? "same-project";
function card(id: string): BoardCard {
	return { id, title: id, prompt: `隔离浏览器回归：${id}`, baseRef: "main", startInPlanMode: false, createdAt: now, updatedAt: now };
}
function buildBoard(isOtherProject = false): BoardData {
	const board = createInitialBoardData();
	board.columns.find((column) => column.id === "review")!.cards = isOtherProject
		? [card("warm-current")]
		: [card("warm-current"), ...Array.from({ length: 25 }, (_, i) => card(`recent-${i}`)),
			...(scenario === "same-project" ? [card("warm-next")] : []),
			...(scenario === "last" ? [card("warm-previous")] : [])];
	if (!isOtherProject && scenario === "next-in-progress") {
		board.columns.find((column) => column.id === "in_progress")!.cards = [card("warm-next")];
	}
	return board;
}
const initialBoardA = buildBoard();
const boardB = buildBoard(true);
function project(id: string, board: BoardData): RuntimeProjectSummary {
	return {
		id, name: id, path: `/isolated/${id}`, availability: { status: "available" },
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 }, inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: board.columns.flatMap((column) => column.cards.map((task): RuntimeCrossProjectTaskSwitcherEntry => {
			const isWarm = task.id.startsWith("warm-");
			return {
				taskId: task.id, title: task.title, agentId: "codex", columnId: column.id, createdAt: now,
				agentProcessStartedAt: now - 600_000,
				lastOutputAt: null, lastSubstantiveOutputAt: null, agentResponseGenerationStopped: null,
				lastConversationProgressObservation: null, turnOwner: isWarm ? "user" : null,
				liveness: isWarm ? "live" : "none", userTurnKind: isWarm ? "review" : null,
				isParkedAwaitingDispatchedBackgroundWork: false, taskDescriptionLastUpdatedAt: now,
				lastOpenedByUserAt: null, pinnedToTaskPinboardAt: null, taskPinboardPinReason: null,
				...(isWarm ? { lastMainAgentConversationModelRequestDispatchObservation: {
					observedAtMs: now - (task.id === "warm-previous" ? 180_000 : task.id === "warm-current" && id === "project-a" ? 120_000 : 60_000),
					evidenceKind: "post_tool_use_hook_event" as const,
				} } : {}),
			};
		})),
	};
}

function Harness() {
	const [boardA, setBoardA] = useState(initialBoardA);
	const [currentProjectId, setCurrentProjectId] = useState("project-a");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>("warm-current");
	const [boardScopeSelected, setBoardScopeSelected] = useState(true);
	const [sessions, setSessions] = useState({});
	const [, setClearTrashOpen] = useState(false);
	const [, setGitHistoryOpen] = useState(false);
	const board = currentProjectId === "project-a" ? boardA : boardB;
	const opening = useCrossProjectTaskOpenInProject({
		board, currentProjectId, projectIdOwningHydratedBoard: currentProjectId, selectedTaskId,
		isDetailViewOpen: selectedTaskId !== null, isCurrentProjectBoardSettled: true,
		setSelectedTaskId, handleSelectProject: setCurrentProjectId, openBacklogTaskEditor: () => {},
	});
	const projects = useMemo(() => [project("project-a", boardA), ...(scenario === "cross-project" ? [project("project-b", boardB)] : [])], [boardA]);
	const sectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({ projects, notificationLogByWorkspaceId: {}, currentProjectId });
	const captureCacheWarmTaskFocusNavigationAfterValidationMove = useCacheWarmTaskFocusNavigationAfterValidationMove({
		isBoardScopeAllProjectsSelected: boardScopeSelected, currentProjectId, selectedTaskId,
		isCrossProjectTaskOpenPending: opening.pendingCrossProjectTaskOpen !== null,
		promptCacheWarmAwaitingUserEntries: sectionsModel.sections.promptCacheWarmAwaitingUserEntries,
		onOpenTaskInProject: opening.handleOpenTaskInProject,
	});
	const interactions = useBoardInteractions({
		board, setBoard: setBoardA, sessions, setSessions, selectedCard: null, selectedTaskId, currentProjectId,
		setSelectedTaskId, setIsClearTrashDialogOpen: setClearTrashOpen, setIsGitHistoryOpen: setGitHistoryOpen,
		fetchTaskWorkspaceInfo: async () => null, sendTaskSessionInput: async () => ({ ok: true }),
		readyForReviewNotificationsEnabled: false, taskGitActionLoadingByTaskId: {}, runAutoReviewGitAction: async () => false,
		captureCacheWarmTaskFocusNavigationAfterValidationMove,
	});
	const { crossProjectRecentlyActiveTaskSwitcherHost: host } = useCrossProjectRecentlyActiveTaskSwitcherHost({
		crossProjectTaskSwitcherSectionsModel: sectionsModel, projects, notificationLogByWorkspaceId: {}, currentProjectId, isBoardScopeAllProjectsSelected: boardScopeSelected,
		selectedCardTaskId: selectedTaskId, pendingCrossProjectTaskOpen: opening.pendingCrossProjectTaskOpen,
		onOpenTaskInProject: opening.handleOpenTaskInProject, onOpenBacklogTaskEditorInProject: () => {},
		onRequestCreateTaskInBoardScope: () => {}, onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
		onUnpinCurrentProjectTaskFromTaskPinboard: () => {}, onEditCurrentProjectTaskPinboardPinReason: () => {},
	});
	useEffect(() => {
		const applyBroadcast = () => setBoardA((previous) => moveTaskToColumn(previous, "warm-current", "validation").board);
		window.addEventListener("isolated-validation-move-broadcast", applyBroadcast);
		return () => window.removeEventListener("isolated-validation-move-broadcast", applyBroadcast);
	}, []);
	return <TooltipProvider>
		<div className="flex h-screen gap-4 bg-surface-0 p-4 text-text-primary">
			<div className="flex h-[460px] w-[360px] min-h-0 flex-col">
				<CrossProjectRecentlyActiveTaskSwitcherPanel host={host} currentProjectTaskCards={{
					currentProjectDisplayedBoard: board, currentProjectTaskSessions: sessions, currentProjectWorkspacePath: "/isolated/project-a",
					currentProjectTaskCardActionHandlers: { onMoveToValidationTask: interactions.handleMoveCardToValidation },
				}} />
			</div>
			<div>
				<output aria-label="当前焦点">{currentProjectId}:{selectedTaskId}</output>
				<button type="button" onClick={() => setSelectedTaskId("recent-0")}>手动切走</button>
				<button type="button" onClick={() => setBoardScopeSelected(false)}>切换单项目范围</button>
			</div>
		</div>
	</TooltipProvider>;
}
const mount = document.createElement("div");
document.body.appendChild(mount);
createRoot(mount).render(<Harness />);
