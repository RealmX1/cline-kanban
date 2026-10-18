import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { TaskSpotlightSearchDialog } from "../src/components/task-spotlight-search-dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { useCrossProjectRecentlyActiveTaskSwitcherHost } from "../src/hooks/use-cross-project-recently-active-task-switcher-host";
import { useCrossProjectTaskOpenInProject } from "../src/hooks/use-cross-project-task-open-in-project";
import { useTaskSpotlightSearchController } from "../src/hooks/use-task-spotlight-search-controller";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary } from "../src/runtime/types";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, BoardColumnId, BoardData } from "../src/types";
import "../src/styles/globals.css";

const now = Date.now();
const old = now - 60 * 86_400_000;
function taskCard(id: string, title: string): BoardCard {
	return { id, title, prompt: `原始任务需求：${title}`, baseRef: "main", agentId: "codex", startInPlanMode: false, createdAt: old, updatedAt: old };
}
const outsideTask = taskCard("outside", "分组外目标任务");
const otherProjectTask = taskCard("outside", "跨项目同号目标任务");
const recentCards = Array.from({ length: 40 }, (_, index) =>
	taskCard(
		`recent-${index}`,
		index === 20
			? "列表任务 20：底沿 hover 完整卡片自然换行的长标题，用足够长的任务说明模拟生产中跨越多行的实现目标，确认展开之后会触及滚动视口底沿"
			: `列表任务 ${index}`,
	),
);
const runningTask = taskCard("running", "默认收起的运行任务");
function buildBoard(): BoardData {
	const board = createInitialBoardData();
	board.columns.find((column) => column.id === "review")!.cards = [outsideTask, ...recentCards];
	board.columns.find((column) => column.id === "in_progress")!.cards = [runningTask];
	return board;
}
const projectABoard = buildBoard();
const projectBBoard = createInitialBoardData();
projectBBoard.columns.find((column) => column.id === "trash")!.cards = [otherProjectTask];
setTaskWorkspaceSnapshot({ taskId: "outside", path: "/isolated/project-a/outside", changedFiles: 3, additions: 4, deletions: 1 });

function entry(card: BoardCard, columnId: BoardColumnId): RuntimeCrossProjectTaskSwitcherEntry {
	return {
		taskId: card.id, title: card.title, agentId: "codex", columnId, createdAt: old,
		lastOutputAt: null, lastSubstantiveOutputAt: null, agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null, turnOwner: null, liveness: "none", userTurnKind: null,
		isParkedAwaitingDispatchedBackgroundWork: false, taskDescriptionLastUpdatedAt: now,
		lastOpenedByUserAt: null, pinnedToTaskPinboardAt: null, taskPinboardPinReason: null,
	};
}
function project(id: string, entries: RuntimeCrossProjectTaskSwitcherEntry[]): RuntimeProjectSummary {
	return { id, name: id, path: `/isolated/${id}`, availability: { status: "available" },
		taskCounts: { backlog: 0, in_progress: 0, review: 40, validation: 0, trash: 0 }, inProgressTaskDetails: [], crossProjectTaskSwitcherEntries: entries };
}

function Harness() {
	const [currentProjectId, setCurrentProjectId] = useState("project-a");
	const [hydratedProjectId, setHydratedProjectId] = useState("project-a");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>("recent-20");
	const [outsideTaskNowInRecent, setOutsideTaskNowInRecent] = useState(false);
	const [panelMountSequence, setPanelMountSequence] = useState(0);
	const [actionResult, setActionResult] = useState("");
	const board = hydratedProjectId === "project-a" ? projectABoard : projectBBoard;
	const handleSelectProject = useCallback((id: string) => setCurrentProjectId(id), []);
	const taskOpening = useCrossProjectTaskOpenInProject({
		board, currentProjectId, projectIdOwningHydratedBoard: hydratedProjectId, selectedTaskId,
		isDetailViewOpen: selectedTaskId !== null,
		isCurrentProjectBoardSettled: currentProjectId === hydratedProjectId,
		setSelectedTaskId, handleSelectProject, openBacklogTaskEditor: () => {},
	});
	const projects = useMemo(() => [project("project-a", [
		...recentCards.map((card) => entry(card, "review")),
		{ ...entry(runningTask, "in_progress"), turnOwner: "agent" as const, liveness: "live" as const, lastOutputAt: now },
		...(outsideTaskNowInRecent ? [entry(outsideTask, "review")] : []),
	]), project("project-b", [])], [outsideTaskNowInRecent]);
	const { crossProjectRecentlyActiveTaskSwitcherHost: host } = useCrossProjectRecentlyActiveTaskSwitcherHost({
		projects, notificationLogByWorkspaceId: {}, currentProjectId, isBoardScopeAllProjectsSelected: true,
		selectedCardTaskId: selectedTaskId, pendingCrossProjectTaskOpen: taskOpening.pendingCrossProjectTaskOpen,
		onOpenTaskInProject: taskOpening.handleOpenTaskInProject, onOpenBacklogTaskEditorInProject: () => {},
		onRequestCreateTaskInBoardScope: () => {}, onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
		onUnpinCurrentProjectTaskFromTaskPinboard: () => {}, onEditCurrentProjectTaskPinboardPinReason: () => {},
	});
	const crossProjectExcludeProjectIds = useMemo(() => new Set([hydratedProjectId]), [hydratedProjectId]);
	const search = useTaskSpotlightSearchController({
		board, currentProjectId: hydratedProjectId, currentProjectName: hydratedProjectId, currentProjectDefaultAgentId: "codex",
		taskSessionSummariesByTaskId: {}, canOpen: true, crossProjectWorkspaceId: hydratedProjectId,
		crossProjectExcludeProjectIds, onOpenTaskInProject: taskOpening.handleOpenTaskInProject,
	});
	return <TooltipProvider>
		<div className="flex h-screen flex-col gap-2 bg-surface-0 p-3 text-text-primary">
			<div className="flex flex-wrap gap-3">
				<button type="button" onClick={search.open}>Search tasks</button>
				<button type="button" onClick={() => taskOpening.handleOpenTaskInProject("project-a", "recent-20")}>打开组内任务</button>
				<button type="button" onClick={() => taskOpening.handleOpenTaskInProject("project-a", "running")}>打开收起任务</button>
				<button type="button" onClick={() => setOutsideTaskNowInRecent(true)}>移入 Recent</button>
				<button type="button" onClick={() => setPanelMountSequence((value) => value + 1)}>重新挂载左栏</button>
				<button type="button" onClick={() => setHydratedProjectId(currentProjectId)}>完成跨项目加载</button>
				<button type="button" onClick={taskOpening.cancelPendingCrossProjectTaskOpenReturningToOriginTask}>取消跨项目跳转</button>
				<button type="button" onClick={() => setSelectedTaskId(null)}>移除焦点</button>
			</div>
			<div className="flex min-h-0 flex-1 gap-3">
				<div className="flex h-[540px] w-[360px] min-h-0 shrink-0 flex-col" data-isolated-focus-view-left-panel="">
					<CrossProjectRecentlyActiveTaskSwitcherPanel key={`${panelMountSequence}:${hydratedProjectId}`}
						host={host} defaultAgentId="codex"
						currentProjectTaskCards={taskOpening.pendingCrossProjectTaskOpen || currentProjectId !== hydratedProjectId ? null : {
							currentProjectDisplayedBoard: board, currentProjectTaskSessions: {}, currentProjectWorkspacePath: `/isolated/${hydratedProjectId}`,
							currentProjectTaskCardActionHandlers: {
								onMoveToValidationTask: (id) => setActionResult(`validation:${hydratedProjectId}:${id}`),
								onRestoreFromTrashTask: (id) => setActionResult(`restore:${hydratedProjectId}:${id}`),
							},
						}} />
				</div>
				<div className="flex-1" aria-label="当前打开任务">{hydratedProjectId}:{selectedTaskId ?? "none"}
					<output aria-label="动作结果">{actionResult}</output>
				</div>
			</div>
			<TaskSpotlightSearchDialog controller={search} />
		</div>
	</TooltipProvider>;
}

const mountElement = document.createElement("div");
document.body.appendChild(mountElement);
createRoot(mountElement).render(<Harness />);
