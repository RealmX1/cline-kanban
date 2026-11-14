import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ColumnContextPanel } from "../src/components/detail-panels/column-context-panel";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { createInitialBoardData } from "../src/data/board-data";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "../src/hooks/use-cross-project-recently-active-task-switcher-sections";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary } from "../src/runtime/types";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const observedAt = Date.now();
const board = createInitialBoardData();
for (const column of board.columns) {
	column.cards = Array.from(
		{ length: 20 },
		(_, index): BoardCard => ({
			id: `${column.id}-${index}`,
			title: `验证任务 ${column.title} ${index}`,
			prompt: "验证紧凑分组标题和首张任务卡的滚动可见性。",
			baseRef: "main",
			agentId: "codex",
			startInPlanMode: false,
			createdAt: observedAt,
			updatedAt: observedAt,
		}),
	);
}
const shelvedCard: BoardCard = {
	...board.columns[0]!.cards[0]!,
	id: "shelved-task",
	title: "已搁置验证任务",
	taskShelvingState: { isShelved: true, lastChangedAt: observedAt },
};
board.columns[0]!.cards.push(shelvedCard);
const waitingCard: BoardCard = { ...board.columns[1]!.cards[0]!, id: "waiting-task", title: "等待自动恢复验证任务" };
board.columns[1]!.cards.push(waitingCard);
const entries: RuntimeCrossProjectTaskSwitcherEntry[] = board.columns.flatMap((column) =>
	column.cards.map((card) => ({
		taskId: card.id,
		title: card.title,
		agentId: "codex",
		columnId: column.id,
		createdAt: observedAt,
		lastOutputAt: column.id === "in_progress" ? observedAt : null,
		lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
		turnOwner: column.id === "in_progress" ? ("agent" as const) : null,
		liveness:
			card.id === "waiting-task"
				? ("retrying" as const)
				: column.id === "in_progress"
					? ("live" as const)
					: ("none" as const),
		userTurnKind: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
		taskDescriptionLastUpdatedAt: observedAt,
		lastOpenedByUserAt: null,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		taskShelvingState: card.taskShelvingState,
	})),
);
const project: RuntimeProjectSummary = {
	id: "isolated-focus",
	name: "隔离项目",
	path: "/isolated/focus-view-headers",
	availability: { status: "available" },
	taskCounts: { backlog: 21, in_progress: 21, review: 20, validation: 20, trash: 20 },
	inProgressTaskDetails: [],
	crossProjectTaskSwitcherEntries: entries,
};

function Harness() {
	const [panelWidth, setPanelWidth] = useState(320);
	const [actionResult, setActionResult] = useState("");
	const [countIncrement, setCountIncrement] = useState(0);
	const projects = useMemo(
		() => [
			{
				...project,
				crossProjectTaskSwitcherEntries: [
					...entries,
					...entries
						.filter((entry) => entry.columnId === "review")
						.slice(0, countIncrement)
						.map((entry, index) => ({ ...entry, taskId: `additional-${index}` })),
				],
			},
		],
		[countIncrement],
	);
	const sectionsModel = useCrossProjectRecentlyActiveTaskSwitcherSections({
		projects,
		notificationLogByWorkspaceId: {},
		currentProjectId: project.id,
	});
	const scope = new URLSearchParams(location.search).get("scope") ?? "current";
	const selectedColumn = board.columns.find((column) => column.id === "in_progress")!;
	const selectedCard = selectedColumn.cards[0]!;
	const currentProjectTaskCards = {
		currentProjectDisplayedBoard: board,
		currentProjectTaskSessions: {},
		currentProjectWorkspacePath: project.path,
		currentProjectTaskCardActionHandlers: {},
	};
	return (
		<TooltipProvider>
			<div className="flex h-screen flex-col gap-2 overflow-hidden bg-surface-0 p-3 text-text-primary">
				<div className="flex shrink-0 items-center gap-4 text-xs">
					<label>
						左栏宽度{" "}
						<input
							aria-label="左栏宽度"
							type="number"
							value={panelWidth}
							onChange={(event) => setPanelWidth(Number(event.target.value))}
							className="w-20 bg-surface-2 px-1"
						/>
					</label>
					<button type="button" onClick={() => setCountIncrement(5)}>
						增加分组数量
					</button>
					<output aria-label="动作结果">{actionResult}</output>
				</div>
				<div className="flex min-h-0 flex-1 gap-4">
					<div
						className="flex min-h-0 shrink-0 flex-col [&>div]:flex-1"
						style={{ width: panelWidth }}
						data-isolated-compact-header-panel=""
					>
						{scope === "all" ? (
							<CrossProjectRecentlyActiveTaskSwitcherPanel
								host={{
									crossProjectTaskSwitcherSectionsModel: sectionsModel,
									projects,
									notificationLogByWorkspaceId: {},
									currentProjectId: project.id,
									isBoardScopeAllProjectsSelected: true,
									focusedTaskInProject: { workspaceId: project.id, taskId: selectedCard.id },
									onOpenTaskInProject: (_workspaceId, taskId) => setActionResult(`打开:${taskId}`),
									onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
									onUnpinCurrentProjectTaskFromTaskPinboard: () => {},
									onEditCurrentProjectTaskPinboardPinReason: () => {},
								}}
								currentProjectTaskCards={currentProjectTaskCards}
							/>
						) : (
							<ColumnContextPanel
								selection={{ card: selectedCard, column: selectedColumn, allColumns: board.columns }}
								taskSessions={{}}
								onCardSelect={(taskId) => setActionResult(`打开:${taskId}`)}
								onTaskDragEnd={() => {}}
								onRequestStartAllReadyBacklogTasks={() => setActionResult("启动就绪任务")}
								onClearTrash={() => setActionResult("清空已结案")}
								onRestoreFromTrashTask={(taskId) => setActionResult(`重新打开:${taskId}`)}
								panelWidth="100%"
							/>
						)}
					</div>
					<div className="min-w-0 flex-1 rounded-md border border-border p-4 text-sm text-text-secondary">
						任务工作台 · {scope === "all" ? "All projects" : "当前项目"}
					</div>
				</div>
			</div>
		</TooltipProvider>
	);
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
