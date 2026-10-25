import * as Popover from "@radix-ui/react-popover";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CardDetailView } from "../src/components/card-detail-view";
import { TaskVisualizationArtifactsPanel } from "../src/components/detail-panels/task-visualization-artifacts-panel";
import { WorkUnitRelationNeighborhoodPanel } from "../src/components/detail-panels/work-unit-relation-neighborhood-panel";
import { ExplorationThreadGraphPanel } from "../src/components/exploration-thread-graph/exploration-thread-graph-panel";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Dialog, DialogHeader, DialogBody } from "../src/components/ui/dialog";
import { useExpandedForegroundViewNavigation } from "../src/expanded-foreground-view/expanded-foreground-view-context";
import { ExpandedForegroundViewProvider } from "../src/expanded-foreground-view/expanded-foreground-view-provider";
import { ExpandedForegroundViewSurface } from "../src/expanded-foreground-view/expanded-foreground-view-surface";
import { useExpandedForegroundViewSurface } from "../src/expanded-foreground-view/use-expanded-foreground-view-surface";
import { useTaskVisualizationArtifacts } from "../src/hooks/use-task-visualization-artifacts";
import { LayoutCustomizationsProvider } from "../src/resize/layout-customizations";
import type { RuntimeExplorationThreadGraphProjectionView, RuntimeTaskSessionSummary } from "../src/runtime/types";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, CardSelection } from "../src/types";
import "../src/styles/globals.css";

export const explorationView: RuntimeExplorationThreadGraphProjectionView = {
	schemaVersion: 1, explorationId: "source-task", threads: [], laneCount: 1, staleReason: null,
	unplacedTurnCountBySession: {}, lastMaintenanceJobCompletedAt: null, lastMaintenanceJobUsage: null,
	anyTurnSourceIsTranscriptReconstructed: false,
	turnRows: Array.from({ length: 30 }, (_, index) => ({
		turnRowId: `turn-${index}`, turnRef: { conversationSessionId: "source-task", turnNumber: 30 - index, turnCheckpointCommit: null },
		userPromptExcerpt: `探索轮次 ${30 - index}`, assistantResponseExcerpt: `这一轮的分析 ${30 - index}`,
		startedAt: "2026-10-25T12:00:00Z", endedAt: "2026-10-25T12:01:00Z", toolCallCount: 1,
		threadId: null, placementConfidence: null, deviationRationale: null, turnSubjectTags: [], eventMarks: [], parentTurnRowIds: [],
		laneLayout: { id: `turn-${index}`, rowLane: 0, laneWaitingForIds: [], mergeFromLanes: [], splitFromLane: null, rowStartsLane: index === 0, isFirstRow: index === 0 },
	})),
};

function DialogLifecycleSurface() {
	const surface = useExpandedForegroundViewSurface({ viewKind: "task_relations", workspaceId: "isolated-project", taskId: "dialog-test", taskIncarnationCreatedAtEpochMs: 1 });
	const [dialogOpen, setDialogOpen] = useState(false);
	return <ExpandedForegroundViewSurface controller={surface} title="交互验证面板">
		<button type="button" onClick={surface.open}>展开交互验证面板</button>
		{surface.isExpanded ? <button type="button" onClick={() => setDialogOpen(true)}>打开内层对话框</button> : null}
		<Dialog open={dialogOpen} onOpenChange={setDialogOpen}><DialogHeader title="内层验证对话框" /><DialogBody><button type="button">内层焦点</button></DialogBody></Dialog>
	</ExpandedForegroundViewSurface>;
}
function Harness() {
	const visualization = useTaskVisualizationArtifacts({ workspaceId: "isolated-project", taskId: "source-task", observeBrowser: false });
	const selectedInitialArtifact = useRef(false);
	const navigation = useExpandedForegroundViewNavigation();
	const [previewOpen, setPreviewOpen] = useState(false);
	useEffect(() => {
		if (selectedInitialArtifact.current || !visualization.artifacts[0]) return;
		selectedInitialArtifact.current = true; visualization.selectArtifact(visualization.artifacts[0]);
	}, [visualization.artifacts, visualization.selectArtifact]);
	return <main className="flex h-dvh flex-col overflow-hidden bg-surface-0 text-text-primary">
		<header className="flex shrink-0 gap-4 p-3"><span>来源任务工作台</span>
			<Popover.Root open={previewOpen} onOpenChange={setPreviewOpen}>
				<Popover.Trigger asChild><button type="button">预览关联任务</button></Popover.Trigger>
				<Popover.Portal><Popover.Content aria-label="隔离关联预览" className="z-50 bg-surface-2 p-4" onCloseAutoFocus={(event) => event.preventDefault()}>
					<button type="button" onClick={() => navigation?.open({ viewKind: "task_relations", workspaceId: "other-project", taskId: "same-id", taskIncarnationCreatedAtEpochMs: 20 })}>预览任务的关系图</button>
				</Popover.Content></Popover.Portal>
			</Popover.Root>
		</header>
		<DialogLifecycleSurface />
		<div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 md:grid-cols-2">
			<div className="flex min-h-[300px] flex-col"><TaskVisualizationArtifactsPanel workspaceId="isolated-project" taskId="source-task" taskIncarnationCreatedAtEpochMs={10} controller={visualization} /></div>
			<div className="flex min-h-0 flex-col"><WorkUnitRelationNeighborhoodPanel workspaceId="isolated-project" kanbanBoardCardTaskId="source-task" taskIncarnationCreatedAtEpochMs={10} initiallyExpanded />
				<ExplorationThreadGraphPanel workspaceId="isolated-project" explorationId="source-task" taskIncarnationCreatedAtEpochMs={10} initiallyExpanded data={{ queryPhase: "ready", view: explorationView, turnSourceUnavailableSessionIds: [] }} /></div>
		</div>
	</main>;
}
function ResponsiveCardDetailHarness() {
	const card: BoardCard = { id: "source-task", title: "响应式内容连续性验证", prompt: "隔离浏览器验证", agentId: "codex", startInPlanMode: false, baseRef: "main", createdAt: 10, updatedAt: 10 };
	const column = { id: "in_progress" as const, title: "In Progress", cards: [card] };
	const selection: CardSelection = { card, column, allColumns: [column] };
	const summary: RuntimeTaskSessionSummary = { taskId: card.id, agentId: "codex", state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null, workspacePath: "/isolated/foreground", pid: 1, startedAt: 10, updatedAt: 10, lastOutputAt: 10, reviewReason: null, exitCode: null, lastHookAt: null, latestHookActivity: null, latestTurnCheckpoint: null, previousTurnCheckpoint: null };
	return <main className="flex h-dvh min-w-0 flex-col overflow-hidden bg-surface-0 text-text-primary"><CardDetailView selection={selection} currentProjectId="isolated-project" workspacePath="/isolated/foreground" selectedAgentId="codex" sessionSummary={summary} taskSessions={{ [card.id]: summary }} onSessionSummary={() => {}} onCardSelect={() => {}} onTaskDragEnd={() => {}} onMoveToTrash={() => {}} bottomTerminalOpen={false} bottomTerminalTaskId={null} bottomTerminalSummary={null} onBottomTerminalClose={() => {}} explorationThreadGraph={{ queryPhase: "ready", view: explorationView, turnSourceUnavailableSessionIds: [] }} /></main>;
}

const useResponsiveCardDetailHarness = new URLSearchParams(window.location.search).has("realCardDetail");
if (useResponsiveCardDetailHarness) {
	setTaskWorkspaceSnapshot({ taskId: "source-task", path: "/isolated/foreground", changedFiles: 0, additions: 0, deletions: 0, commitsAheadOfBaseRef: 0, commitsBehindBaseRef: 0 });
	let terminalMountCount = 0;
	const openTerminal = Terminal.prototype.open;
	Terminal.prototype.open = function (parent) { openTerminal.call(this, parent); terminalMountCount++; };
	Object.assign(window, { readResponsiveForegroundTerminalMountCount: () => terminalMountCount });
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<TooltipProvider><LayoutCustomizationsProvider onResetBottomTerminalLayoutCustomizations={() => {}}><TaskCommentsDialogProvider currentWorkspaceId="isolated-project"><ExpandedForegroundViewProvider>{useResponsiveCardDetailHarness ? <ResponsiveCardDetailHarness /> : <Harness />}</ExpandedForegroundViewProvider></TaskCommentsDialogProvider></LayoutCustomizationsProvider></TooltipProvider>);
