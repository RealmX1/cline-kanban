import { DragDropContext } from "@hello-pangea/dnd";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardColumn } from "../src/components/board-column";
import { ColumnContextPanel } from "../src/components/detail-panels/column-context-panel";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { StageHeaderRails } from "../src/components/detail-panels/stage-header-rails";
import { TaskCardBody } from "../src/components/task-card-body";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { Dialog, DialogBody, DialogHeader } from "../src/components/ui/dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "../src/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import type { RuntimeProjectSummary } from "../src/runtime/types";
import { findCardSelection } from "../src/state/board-state";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const subject: BoardCard = { id: "subject", title: "关联预览来源任务", prompt: "隔离浏览器验证", agentId: "codex", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
const board = createInitialBoardData();
board.columns.find((column) => column.id === "review")!.cards = [subject];
const selection = findCardSelection(board, subject.id)!;
const projects: RuntimeProjectSummary[] = ["project-a", "project-b", "unavailable-project"].map((id) => ({ id, name: id === "project-b" ? "另一个项目" : "当前项目", path: `/isolated/${id}`, availability: id === "unavailable-project" ? { status: "unavailable", reason: "project_path_missing" } : { status: "available" }, taskCounts: { backlog: 0, in_progress: 0, review: 1, validation: 0, trash: 1 }, inProgressTaskDetails: [], crossProjectTaskSwitcherEntries: [] }));

function Harness() {
	const mode = new URLSearchParams(location.search).get("host") ?? "board";
	const [opened, setOpened] = useState("");
	const [edited, setEdited] = useState<BoardCard | null>(null);
	const scrollRootRef = useRef<HTMLDivElement>(null);
	const actions = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({ onRequestEditBacklogTaskCardInOtherProject: (_workspaceId, card) => setEdited(card) });
	return <TooltipProvider><TaskCommentsDialogProvider currentWorkspaceId="project-a"><CrossProjectRecentlyActiveTaskSwitcherHostContextProvider value={{ projects, currentProjectId: "project-a", defaultAgentId: "codex", otherProjectTaskCardActionHandlers: actions, notificationLogByWorkspaceId: {}, isBoardScopeAllProjectsSelected: false, focusedTaskInProject: null, onOpenTaskInProject: (workspaceId, taskId, createdAt) => setOpened(`${workspaceId}:${taskId}:${createdAt}`), onRequestPinCurrentProjectTaskToTaskPinboard: () => {}, onUnpinCurrentProjectTaskFromTaskPinboard: () => {}, onEditCurrentProjectTaskPinboardPinReason: () => {} }}>
		<main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-3 bg-surface-0 p-3 text-text-primary">
			<p className="text-sm">隔离关联任务预览 · {mode}</p>
			<output aria-label="已打开任务" className="text-xs">{opened}</output>
			{mode === "board" ? <DragDropContext onDragEnd={() => {}}><div className="flex max-w-full" style={{ height: 600, width: 320 }}><BoardColumn column={selection.column} taskSessions={{}} onCardClick={() => setOpened("误触来源卡片")} /></div></DragDropContext> : mode === "focus" ? <div className="flex min-h-0" style={{ height: 600 }}><ColumnContextPanel selection={selection} panelWidth="320px" taskSessions={{}} onCardSelect={() => setOpened("误触来源卡片")} onTaskDragEnd={() => {}} /></div> : mode === "sticky" ? <div ref={scrollRootRef} className="relative h-[500px] w-80 max-w-full overflow-auto"><TaskCardBody card={subject} columnId="review" /><StageHeaderRails selection={selection} topPinnedColumnIds={["review"]} bottomPinnedColumnIds={[]} focusedCardPinState="pinTop" isStageSectionExpanded={() => true} onToggleStageSectionExpandedFromStageHeaderRail={() => {}} onJumpToStageSectionBelowTopRail={() => {}} scrollRootRef={scrollRootRef} taskSessions={{}} taskCardActionHandlers={{}} /></div> : <div className="w-80 max-w-full"><TaskCardBody card={subject} columnId="review" renderRole="focused_task_card_copy_in_mobile_detail_header" /></div>}
			{actions.otherProjectTaskCardActionConfirmationDialogs}
			<Dialog open={edited !== null} onOpenChange={(open) => { if (!open) setEdited(null); }}><DialogHeader title="编辑关联任务" /><DialogBody><textarea aria-label="关联任务描述" defaultValue={edited?.prompt} /></DialogBody></Dialog>
		</main>
	</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider></TaskCommentsDialogProvider></TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
