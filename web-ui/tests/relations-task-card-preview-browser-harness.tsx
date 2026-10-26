import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { ReferenceRelationModelingEditor } from "../src/components/detail-panels/reference-relation-modeling-editor";
import { WorkUnitRelationNeighborhoodPanel } from "../src/components/detail-panels/work-unit-relation-neighborhood-panel";
import { TaskCommentsDialogProvider } from "../src/components/task-comments-dialog-provider";
import { TaskEditorFloatingWindow } from "../src/components/task-editor-floating-window";
import { Dialog, DialogBody, DialogHeader } from "../src/components/ui/dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { ExpandedForegroundViewProvider } from "../src/expanded-foreground-view/expanded-foreground-view-provider";
import { useCrossProjectTaskOpenInProject } from "../src/hooks/use-cross-project-task-open-in-project";
import { useReferenceRelationModelingEditor } from "../src/hooks/use-reference-relation-modeling-editor";
import { useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "../src/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import type { RuntimeProjectSummary } from "../src/runtime/types";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const createdAt = 1_000;
const taskIds = ["root", "review", "backlog", "done", "second-hop", "rebuilt"];
const cards: BoardCard[] = taskIds.map((id) => ({
	id,
	title: `任务 ${id}`,
	prompt: `完整描述 ${id}`,
	agentId: "codex",
	baseRef: "main",
	startInPlanMode: false,
	createdAt,
	updatedAt: createdAt,
}));
const projects: RuntimeProjectSummary[] = ["project-a", "project-b", "unavailable-project"].map((id) => ({
	id,
	name: id === "project-b" ? "另一个项目" : id,
	path: `/isolated/${id}`,
	availability:
		id === "unavailable-project"
			? { status: "unavailable", reason: "project_path_missing" }
			: { status: "available" },
	taskCounts: { backlog: 1, in_progress: 0, review: 3, validation: 0, trash: 1 },
	inProgressTaskDetails: [],
	crossProjectTaskSwitcherEntries: [],
}));
function boardForProject(workspaceId: string) {
	const board = createInitialBoardData();
	for (const card of cards.filter((card) => (card.id === "root") === (workspaceId === "project-a"))) {
		board.columns
			.find((column) => column.id === (card.id === "backlog" ? "backlog" : card.id === "done" ? "trash" : "review"))!
			.cards.push(card);
	}
	return board;
}

function CreationTaskEditorFloatingWindowRelations() {
	const controller = useReferenceRelationModelingEditor({ workspaceId: "project-a", taskId: null });
	const [open, setOpen] = useState(true);
	return (
		<TaskEditorFloatingWindow
			open={open}
			onOpenChange={setOpen}
			title="创建任务"
			onClickCapture={undefined}
			onKeyDownCapture={undefined}
			onKeyDown={undefined}
		>
			<DialogBody>
				<ReferenceRelationModelingEditor controller={controller} workspaceId="project-a" taskId={null} />
			</DialogBody>
		</TaskEditorFloatingWindow>
	);
}

function Harness() {
	const host = new URLSearchParams(location.search).get("host");
	const [projectId, setProjectId] = useState("project-a");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>("root");
	const [lastNavigation, setLastNavigation] = useState("");
	const [edited, setEdited] = useState<BoardCard | null>(null);
	const actions = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
		onRequestEditBacklogTaskCardInOtherProject: (_workspaceId, card) => setEdited(card),
	});
	const selectProject = useCallback((workspaceId: string) => setProjectId(workspaceId), []);
	const navigation = useCrossProjectTaskOpenInProject({
		board: boardForProject(projectId),
		currentProjectId: projectId,
		projectIdOwningHydratedBoard: projectId,
		selectedTaskId,
		isDetailViewOpen: true,
		isCurrentProjectBoardSettled: true,
		setSelectedTaskId,
		handleSelectProject: selectProject,
		openBacklogTaskEditor: setEdited,
	});
	useEffect(() => {
		if (projectId !== "project-a" || selectedTaskId !== "root")
			window.history.replaceState({}, "", `?projectId=${projectId}&taskId=${selectedTaskId ?? ""}`);
	}, [projectId, selectedTaskId]);
	return (
		<TooltipProvider>
			<TaskCommentsDialogProvider currentWorkspaceId={projectId}>
				<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider
					value={{
						projects,
						currentProjectId: projectId,
						defaultAgentId: "codex",
						otherProjectTaskCardActionHandlers: actions,
						notificationLogByWorkspaceId: {},
						isBoardScopeAllProjectsSelected: false,
						focusedTaskInProject: { workspaceId: projectId, taskId: selectedTaskId ?? "root" },
						onOpenTaskInProject: (workspaceId, taskId, incarnation) => {
							setLastNavigation(`${workspaceId}:${taskId}:${incarnation}`);
							navigation.handleOpenTaskInProject(workspaceId, taskId, incarnation);
						},
						onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
						onUnpinCurrentProjectTaskFromTaskPinboard: () => {},
						onEditCurrentProjectTaskPinboardPinReason: () => {},
					}}
				>
					<ExpandedForegroundViewProvider>
						<main className="mx-auto min-h-screen max-w-[1440px] bg-surface-0 p-3 text-text-primary">
							<output aria-label="已导航任务">{lastNavigation}</output>
							<output aria-label="当前聚焦任务">
								{projectId}:{selectedTaskId}
							</output>
							{host === "creation-dialog" || host === "creation-window-with-background" ? (
								<CreationTaskEditorFloatingWindowRelations />
							) : null}
							{host !== "creation-dialog" ? (
								<WorkUnitRelationNeighborhoodPanel
									workspaceId="project-a"
									kanbanBoardCardTaskId="root"
									taskIncarnationCreatedAtEpochMs={createdAt}
									initiallyExpanded
								/>
							) : null}
							{actions.otherProjectTaskCardActionConfirmationDialogs}
							<Dialog
								open={edited !== null}
								onOpenChange={(open) => {
									if (!open) setEdited(null);
								}}
							>
								<DialogHeader title="编辑关联任务" />
								<DialogBody>
									<textarea aria-label="关联任务描述" defaultValue={edited?.prompt} />
								</DialogBody>
							</Dialog>
						</main>
					</ExpandedForegroundViewProvider>
				</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
			</TaskCommentsDialogProvider>
		</TooltipProvider>
	);
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
