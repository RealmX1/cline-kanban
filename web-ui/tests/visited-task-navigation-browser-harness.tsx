import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { NonModalFloatingFormWindowHostProvider } from "../src/components/non-modal-floating-form-window-host-provider";
import { TaskEditorDialog } from "../src/components/task-editor-dialog";
import { TopBar } from "../src/components/top-bar";
import { Button } from "../src/components/ui/button";
import { Dialog, DialogBody, DialogHeader } from "../src/components/ui/dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { VisitedTaskNavigationControls } from "../src/components/visited-task-navigation-controls";
import { useCrossProjectTaskOpenInProject } from "../src/hooks/use-cross-project-task-open-in-project";
import { useVisitedTaskNavigationHistoryController } from "../src/hooks/use-visited-task-navigation-history-controller";
import type { BoardCard, BoardData } from "../src/types";
import "../src/styles/globals.css";
import "@xterm/xterm/css/xterm.css";

const projects = [
	{ id: "project-a", name: "项目甲" },
	{ id: "project-b", name: "项目乙" },
];
const cards: Record<string, BoardCard[]> = {
	"project-a": [
		{
			id: "same1",
			title: "甲项目详情",
			prompt: "详情任务",
			createdAt: 100,
			updatedAt: 100,
			startInPlanMode: true,
			baseRef: "main",
		},
		{
			id: "edit1",
			title: "甲项目草稿",
			prompt: "甲项目原始正文",
			createdAt: 200,
			updatedAt: 200,
			startInPlanMode: true,
			baseRef: "main",
		},
	],
	"project-b": [
		{
			id: "same1",
			title: "乙项目详情",
			prompt: "另一个同号任务",
			createdAt: 100,
			updatedAt: 100,
			startInPlanMode: true,
			baseRef: "main",
		},
		{
			id: "edit2",
			title: "乙项目草稿",
			prompt: "乙项目原始正文",
			createdAt: 300,
			updatedAt: 300,
			startInPlanMode: true,
			baseRef: "main",
		},
	],
};

function AgentTerminalKeyboardProbe() {
	const container = useRef<HTMLDivElement>(null);
	const [sent, setSent] = useState("");
	useEffect(() => {
		const terminal = new Terminal({ cols: 24, rows: 5 });
		if (container.current) terminal.open(container.current);
		terminal.write("终端快捷键验证\r\n");
		const subscription = terminal.onData((text) => setSent((previous) => previous + text));
		return () => {
			subscription.dispose();
			terminal.dispose();
		};
	}, []);
	return (
		<section>
			<div ref={container} />
			<output aria-label="发给 agent 的输入">{JSON.stringify(sent)}</output>
		</section>
	);
}

function Harness() {
	const [workspaceId, setWorkspaceId] = useState("project-a");
	const [requestedProjectId, setRequestedProjectId] = useState("project-a");
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [editor, setEditor] = useState<{ workspaceId: string; card: BoardCard; request: symbol } | null>(null);
	const [modalOpen, setModalOpen] = useState(false);
	const [refreshCount, setRefreshCount] = useState(0);
	const [connected, setConnected] = useState(true);
	const cancelHistory = useRef<() => void>(() => {});
	useEffect(() => {
		if (workspaceId === requestedProjectId) return;
		setSelectedTaskId(null);
		const timer = window.setTimeout(() => setWorkspaceId(requestedProjectId), 40);
		return () => window.clearTimeout(timer);
	}, [requestedProjectId, workspaceId]);
	const board: BoardData = {
		columns: [
			{ id: "review", title: "Review", cards: (cards[workspaceId] ?? []).filter((card) => card.id === "same1") },
			{ id: "backlog", title: "Backlog", cards: (cards[workspaceId] ?? []).filter((card) => card.id !== "same1") },
		],
	};
	const opening = useCrossProjectTaskOpenInProject({
		board,
		currentProjectId: workspaceId,
		navigationCurrentProjectId: requestedProjectId,
		projectIdOwningHydratedBoard: workspaceId,
		selectedTaskId,
		isDetailViewOpen: selectedTaskId !== null,
		isCurrentProjectBoardSettled: workspaceId === requestedProjectId,
		setSelectedTaskId,
		handleSelectProject: setRequestedProjectId,
		onOrdinaryTaskOpenRequested: () => cancelHistory.current(),
		openBacklogTaskEditor: (targetWorkspaceId, card) =>
			setEditor({ workspaceId: targetWorkspaceId, card, request: Symbol() }),
	});
	const selected = board.columns.flatMap((column) => column.cards).find((card) => card.id === selectedTaskId);
	const history = useVisitedTaskNavigationHistoryController({
		displayedTask:
			selected && !opening.pendingCrossProjectTaskOpen && requestedProjectId === workspaceId
				? {
						workspaceId,
						taskId: selected.id,
						taskIncarnationCreatedAtEpochMs: selected.createdAt,
						titleSnapshot: selected.title ?? selected.id,
						projectNameSnapshot: projects.find((project) => project.id === workspaceId)?.name ?? workspaceId,
						lastVisitedAtEpochMs: 0,
						unavailable: false,
					}
				: null,
		projects,
		isRuntimeConnected: connected,
		openTaskInProjectWithResult: opening.openTaskInProjectWithResult,
	});
	cancelHistory.current = history.cancelNavigation;
	const dismissEditor = useCallback((open: boolean) => {
		if (!open) setEditor(null);
	}, []);
	return (
		<main className="min-h-screen bg-surface-0 text-text-primary">
			<TopBar
				onToggleSidebar={() => {}}
				onBack={() => {
					history.cancelNavigation();
					opening.dismissPendingCrossProjectTaskOpen();
					setSelectedTaskId(null);
				}}
				onOpenTaskSpotlightSearch={() => {}}
				onToggleTaskLookupWorkbench={() => {}}
				visitedTaskNavigationControl={<VisitedTaskNavigationControls controller={history} />}
				openTargetOptions={[]}
				selectedOpenTargetId="vscode"
				onSelectOpenTarget={() => {}}
				onOpenWorkspace={() => {}}
				canOpenWorkspace={false}
				isOpeningWorkspace={false}
			/>
			<div className="fixed bottom-0 left-0 right-0 z-10 flex flex-wrap gap-1 p-2">
				{projects.flatMap((project) =>
					(cards[project.id] ?? []).map((card) => (
						<Button
							key={`${project.id}:${card.id}`}
							onClick={() => opening.handleOpenTaskInProject(project.id, card.id, card.createdAt)}
						>
							打开{card.title}
						</Button>
					)),
				)}
				<Button onClick={() => setRefreshCount((value) => value + 1)}>刷新元数据 {refreshCount}</Button>
				<Button onClick={() => setModalOpen(true)}>打开模态确认</Button>
				<Button onClick={() => setConnected((value) => !value)}>切换连接</Button>
			</div>
			<p aria-label="当前详情">{selected ? `${workspaceId}:${selected.id}` : "看板"}</p>
			<output aria-label="导航路径">
				{JSON.stringify(history.history.navigationPath.map((entry) => `${entry.workspaceId}:${entry.taskId}`))}
			</output>
			<output aria-label="历史游标">{history.history.cursor}</output>
			<AgentTerminalKeyboardProbe />
			<Dialog open={modalOpen} onOpenChange={setModalOpen}>
				<DialogHeader title="模态确认" />
				<DialogBody>
					<Button onClick={() => setModalOpen(false)}>关闭模态确认</Button>
				</DialogBody>
			</Dialog>
			{editor && (
				<TaskEditorDialog
					open
					openingRequestIdentity={editor.request}
					onOpenChange={dismissEditor}
					taskEditorMode="edit"
					editingTaskId={editor.card.id}
					editingTaskSnapshot={editor.card}
					editingTaskName={editor.card.title}
					workspaceId={editor.workspaceId}
					editorSessionWorkspaceId={editor.workspaceId}
					prompt={editor.card.prompt}
					onPromptChange={() => {}}
					images={[]}
					onImagesChange={() => {}}
					onCreate={() => null}
					onCreateMultiple={() => []}
					startInPlanMode
					onStartInPlanModeChange={() => {}}
					taskAgentPermissionMode="ask_for_every_tool_use"
					onTaskAgentPermissionModeChange={() => {}}
					taskConversationMode="operational"
					onTaskConversationModeChange={() => {}}
					autoReviewEnabled={false}
					onAutoReviewEnabledChange={() => {}}
					autoReviewMode="commit"
					onAutoReviewModeChange={() => {}}
					branchRef="main"
					branchOptions={[{ value: "main", label: "main" }]}
					onBranchRefChange={() => {}}
					worktreeMode="branch"
					onWorktreeModeChange={() => {}}
					agentId="codex"
					defaultAgentId="codex"
					agents={[]}
					onAgentIdChange={() => {}}
				/>
			)}
		</main>
	);
}

createRoot(document.body.appendChild(document.createElement("div"))).render(
	<TooltipProvider>
		<NonModalFloatingFormWindowHostProvider>
			<Harness />
		</NonModalFloatingFormWindowHostProvider>
	</TooltipProvider>,
);
