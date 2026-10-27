import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard } from "../src/components/board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "../src/hooks/use-cross-project-recently-active-task-switcher-sections";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary } from "../src/runtime/types";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const now = Date.now();
const taskCards: BoardCard[] = Array.from({ length: 35 }, (_, index) => ({
	id: `hover-${index}`,
	title: `悬浮任务 ${index}`,
	prompt: `原始需求：悬浮任务 ${index}`,
	agentId: "codex",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: now - 86_400_000,
	updatedAt: now - index,
}));
for (const card of taskCards) {
	setTaskWorkspaceSnapshot({ taskId: card.id, path: `/isolated/project-a/${card.id}`, changedFiles: 3, additions: 4, deletions: 1 });
}
const entries: RuntimeCrossProjectTaskSwitcherEntry[] = taskCards.map((card, index) => ({
	taskId: card.id, title: card.title, agentId: "codex", columnId: "review", createdAt: card.createdAt,
	lastOutputAt: null, lastSubstantiveOutputAt: null, agentResponseGenerationStopped: null,
	lastConversationProgressObservation: null, turnOwner: null, liveness: "none", userTurnKind: null,
	isParkedAwaitingDispatchedBackgroundWork: false, taskDescriptionLastUpdatedAt: now - index,
	lastOpenedByUserAt: null, pinnedToTaskPinboardAt: null, taskPinboardPinReason: null,
}));
const projects: RuntimeProjectSummary[] = [{
	id: "project-a", name: "project-a", path: "/isolated/project-a", availability: { status: "available" },
	taskCounts: { backlog: 0, in_progress: 0, review: 35, validation: 0, trash: 0 }, inProgressTaskDetails: [], crossProjectTaskSwitcherEntries: entries,
}];

function Harness() {
	const [fullCardTitleSuffix, setFullCardTitleSuffix] = useState("");
	const [actionResult, setActionResult] = useState("");
	const sectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({ projects, notificationLogByWorkspaceId: {}, currentProjectId: "project-a" });
	const board = useMemo(() => {
		const nextBoard = createInitialBoardData();
		nextBoard.columns.find((column) => column.id === "review")!.cards = taskCards.map((card) => ({ ...card, title: card.title + fullCardTitleSuffix }));
		return nextBoard;
	}, [fullCardTitleSuffix]);
	const currentProjectTaskCards = {
		currentProjectDisplayedBoard: board,
		currentProjectTaskSessions: {},
		currentProjectWorkspacePath: "/isolated/project-a",
		currentProjectTaskCardActionHandlers: {
			onMoveToValidationTask: (taskId: string) => setActionResult(`validation:${taskId}`),
			onMoveToTrashTask: (taskId: string) => setActionResult(`done:${taskId}`),
		},
	};
	const host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue = {
		crossProjectTaskSwitcherSectionsModel: sectionsModel,
		projects, notificationLogByWorkspaceId: {}, currentProjectId: "project-a", isBoardScopeAllProjectsSelected: true,
		focusedTaskInProject: null,
		onOpenTaskInProject: (_workspaceId, taskId) => setActionResult(`open:${taskId}`),
		onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
		onUnpinCurrentProjectTaskFromTaskPinboard: () => {},
		onEditCurrentProjectTaskPinboardPinReason: () => {},
	};
	const showsHomeColumns = new URLSearchParams(window.location.search).get("host") === "home";
	return <TooltipProvider>
		<div className="flex h-screen flex-col gap-2 bg-surface-0 p-3 text-text-primary">
			<div className="flex shrink-0 gap-4">
				<button type="button" onClick={() => setFullCardTitleSuffix(" 需要完整展示并可滚动的长任务标题".repeat(200))}>模拟卡片内容增长</button>
				<button type="button" onClick={() => setFullCardTitleSuffix("")}>恢复卡片内容</button>
				<output aria-label="动作结果">{actionResult}</output>
			</div>
			<div data-isolated-hover-host="" className={`flex min-h-0 flex-1 flex-col ${showsHomeColumns ? "w-full" : "w-[360px]"}`}>
				{showsHomeColumns
					? <BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard host={host} currentProjectTaskCards={currentProjectTaskCards} defaultAgentId="codex" />
					: <CrossProjectRecentlyActiveTaskSwitcherPanel host={host} currentProjectTaskCards={currentProjectTaskCards} defaultAgentId="codex" />}
			</div>
		</div>
	</TooltipProvider>;
}
const mountElement = document.createElement("div");
document.body.appendChild(mountElement);
createRoot(mountElement).render(<Harness />);
