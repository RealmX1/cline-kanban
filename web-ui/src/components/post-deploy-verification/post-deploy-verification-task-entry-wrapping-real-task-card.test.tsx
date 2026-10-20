import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { createInitialBoardData } from "@/data/board-data";
import type { RuntimePostDeployVerificationTask, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import {
	PostDeployVerificationTaskEntryWrappingRealTaskCard,
	type RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries,
} from "./post-deploy-verification-task-entry-wrapping-real-task-card";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
	useTaskWorkspaceInfoValue: () => null,
}));
vi.mock("@/runtime/task-retained-committed-line-change-history-query", () => ({
	fetchTaskRetainedCommittedLineChangeHistory: vi.fn(async () => ({
		summary: {
			status: "unavailable",
			commitCount: null,
			additions: null,
			deletions: null,
			historyVersion: "unavailable",
			unavailableReason: "task_commit_history_unavailable",
		},
		commits: [],
	})),
}));

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

function createCard(taskId: string, title: string): BoardCard {
	return {
		id: taskId,
		title,
		prompt: title,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now() - 60_000,
		updatedAt: Date.now(),
	};
}

function boardWithCardInColumn(card: BoardCard, columnId: BoardColumnId): BoardData {
	const board = createInitialBoardData();
	return {
		columns: board.columns.map((column) => (column.id === columnId ? { ...column, cards: [card] } : column)),
	};
}

function renderEntry(input: {
	task: RuntimePostDeployVerificationTask;
	board: BoardData;
	realTaskCardRenderingInputs: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	onRequestComplete?: () => void;
	interactive?: boolean;
	isCompleting?: boolean;
}): void {
	act(() => {
		root.render(
			<PostDeployVerificationTaskEntryWrappingRealTaskCard
				postDeployVerificationTask={input.task}
				board={input.board}
				realTaskCardRenderingInputs={input.realTaskCardRenderingInputs}
				retainedDeploymentGroupsByDeploymentId={new Map()}
				interactive={input.interactive ?? true}
				checklistInitiallyExpanded
				isCompleting={input.isCompleting ?? false}
				onToggleChecklistItem={vi.fn()}
				onAddCustomChecklistItem={vi.fn()}
				onRemoveCustomChecklistItem={vi.fn()}
				onRunVerificationItem={vi.fn()}
				onRequestComplete={input.onRequestComplete ?? vi.fn()}
				onSelectTask={vi.fn()}
				onNavigateToBoard={vi.fn()}
			/>,
		);
	});
}

function renderingInputsFor(
	onMoveToTrashTask: (taskId: string) => void,
): RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries {
	return {
		realTaskCardRenderingInputsBoardSourceKind: "current_project_board_hydrated_in_browser",
		currentProjectTaskSessions: {},
		currentProjectTaskCardActionHandlers: { onMoveToTrashTask },
		currentProjectWorkspacePath: null,
		onActivateTaskCardOpeningTaskDetail: vi.fn(),
		defaultAgentId: null,
		defaultClineModelId: null,
	};
}

function runtimeBoardSnapshotRenderingInputsFor(
	onActivateTaskCardOpeningTaskInItsProject: (card: BoardCard) => void,
	taskSessionsFromRuntimeBoardSnapshot: Record<string, RuntimeTaskSessionSummary> = {},
): RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries {
	return {
		realTaskCardRenderingInputsBoardSourceKind: "runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
		workspaceIdOwningRuntimeBoardSnapshot: "cline-kanban",
		taskSessionsFromRuntimeBoardSnapshot,
		workspacePathOwningRuntimeBoardSnapshot: "/fixture/cline-kanban",
		onActivateTaskCardOpeningTaskInItsProject,
		defaultAgentId: null,
		defaultClineModelId: null,
	};
}

function findMoveToDoneButtonOnCardCopy(): HTMLButtonElement | null {
	return container.querySelector<HTMLButtonElement>('.kb-board-card-shell button[aria-label="Move task to done"]');
}

function findButtonOnCardCopyByAriaLabel(ariaLabel: string): HTMLButtonElement | null {
	return container.querySelector<HTMLButtonElement>(`.kb-board-card-shell button[aria-label="${ariaLabel}"]`);
}

// 终端 agent（claude）在跑的会话：In Progress 卡体据此画出「Move task to review」。
function createRunningTerminalAgentSessionSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath: "/fixture/cline-kanban/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
	};
}

// 卡体上只做本地展示、不走任何卡片动作的按钮：看原始 prompt（本地对话框）、复制目录路径（解析后写剪贴板）。
const CARD_COPY_BUTTON_ARIA_LABELS_WITH_LOCAL_BEHAVIOR_NOT_ROUTED_THROUGH_TASK_CARD_ACTIONS = new Set([
	"View original prompt",
	"Copy directory path",
]);

const UNCHECKED_GUIDED_ITEM: RuntimePostDeployVerificationTask["checklist"][number] = {
	id: "authored:guided",
	label: "看板拖拽进 Done 弹出原因对话框",
	checked: false,
	source: "authored",
	kind: "guided_manual",
	guidance: null,
	script: null,
	run: null,
	cleanup: null,
};

describe("PostDeployVerificationTaskEntryWrappingRealTaskCard", () => {
	it("上半部分是真实卡体（PDV 面板条目角色、无 data-task-id），verification 锚点挂在 wrapper 上", () => {
		const card = createCard("task-1", "调整 Direct Match 搜索按最近活跃排序");
		const board = boardWithCardInColumn(card, "review");
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({
				taskId: "task-1",
				checklist: [UNCHECKED_GUIDED_ITEM],
			}),
			board,
			realTaskCardRenderingInputs: renderingInputsFor(vi.fn()),
		});
		const wrapper = container.querySelector<HTMLElement>('[data-post-deploy-verification-task-entry="task-1"]');
		expect(wrapper?.getAttribute("data-verification-anchor")).toBe("verification-panel-task:task-1");
		const cardShell = wrapper?.querySelector<HTMLElement>(".kb-board-card-shell");
		expect(cardShell?.dataset.taskCardRenderRole).toBe("task_card_copy_in_post_deploy_verification_panel_entry");
		expect(cardShell?.getAttribute("data-task-id")).toBeNull();
		expect(cardShell?.getAttribute("data-verification-anchor")).toBeNull();
		expect(cardShell?.style.cursor).toBe("pointer");
		expect(cardShell?.textContent).toContain("调整 Direct Match 搜索按最近活跃排序");
		expect(document.body.querySelectorAll("[data-task-id]").length).toBe(0);
	});

	it("卡体动作按钮与本体一致：Review 卡的「移入 Done」走看板同一个 handler", () => {
		const card = createCard("task-1", "Review 卡");
		const board = boardWithCardInColumn(card, "review");
		const onMoveToTrashTask = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-1" }),
			board,
			realTaskCardRenderingInputs: renderingInputsFor(onMoveToTrashTask),
		});
		const moveToDoneButton = findMoveToDoneButtonOnCardCopy();
		expect(moveToDoneButton).not.toBeNull();
		act(() => moveToDoneButton?.click());
		expect(onMoveToTrashTask).toHaveBeenCalledWith("task-1");
	});

	it("有未勾项时完成区是「带原因移入 Done」，清单标题显示已核对计数", () => {
		const card = createCard("task-1", "有未勾项的任务");
		const board = boardWithCardInColumn(card, "validation");
		const onRequestComplete = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({
				taskId: "task-1",
				checklist: [UNCHECKED_GUIDED_ITEM],
			}),
			board,
			realTaskCardRenderingInputs: renderingInputsFor(vi.fn()),
			onRequestComplete,
		});
		expect(container.textContent).toContain("0/1 已核对");
		const completeButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("带原因移入 Done"),
		);
		expect(completeButton).toBeTruthy();
		act(() => completeButton?.click());
		expect(onRequestComplete).toHaveBeenCalledTimes(1);
	});

	it("卡已不在看板：兜底显示标题与「已从看板删除」，不渲染卡体", () => {
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-gone" }),
			board: createInitialBoardData(),
			realTaskCardRenderingInputs: renderingInputsFor(vi.fn()),
		});
		expect(
			container.querySelector("[data-post-deploy-verification-task-entry-card-removed-from-board]"),
		).not.toBeNull();
		expect(container.textContent).toContain("已从看板删除");
		expect(container.querySelector(".kb-board-card-shell")).toBeNull();
	});

	it("runtime 快照卡体（All projects 下 board 不在浏览器里）：同一 PDV 角色卡体，Done 走条目自己的完成核对", () => {
		const card = createCard("task-1", "快照里的 Validation 卡");
		const board = boardWithCardInColumn(card, "validation");
		const onRequestComplete = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-1" }),
			board,
			realTaskCardRenderingInputs: runtimeBoardSnapshotRenderingInputsFor(vi.fn()),
			onRequestComplete,
		});
		const cardShell = container.querySelector<HTMLElement>(".kb-board-card-shell");
		expect(cardShell?.dataset.taskCardRenderRole).toBe("task_card_copy_in_post_deploy_verification_panel_entry");
		expect(cardShell?.textContent).toContain("快照里的 Validation 卡");
		const moveToDoneButton = findMoveToDoneButtonOnCardCopy();
		expect(moveToDoneButton).not.toBeNull();
		act(() => moveToDoneButton?.click());
		expect(onRequestComplete).toHaveBeenCalledTimes(1);
	});

	it("runtime 快照卡体：条目不可交互（历史组）时 Done 按钮改为在所属项目打开任务，不发起完成核对", () => {
		const card = createCard("task-1", "历史组里的卡");
		const board = boardWithCardInColumn(card, "validation");
		const onRequestComplete = vi.fn();
		const onActivateTaskCardOpeningTaskInItsProject = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-1" }),
			board,
			realTaskCardRenderingInputs: runtimeBoardSnapshotRenderingInputsFor(onActivateTaskCardOpeningTaskInItsProject),
			onRequestComplete,
			interactive: false,
		});
		act(() => findMoveToDoneButtonOnCardCopy()?.click());
		expect(onRequestComplete).not.toHaveBeenCalled();
		expect(onActivateTaskCardOpeningTaskInItsProject).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
	});

	it("runtime 快照卡体：点卡在它所属的项目里打开", () => {
		const card = createCard("task-1", "点开它");
		const board = boardWithCardInColumn(card, "review");
		const onActivateTaskCardOpeningTaskInItsProject = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-1" }),
			board,
			realTaskCardRenderingInputs: runtimeBoardSnapshotRenderingInputsFor(onActivateTaskCardOpeningTaskInItsProject),
		});
		vi.useFakeTimers();
		try {
			act(() => container.querySelector<HTMLElement>(".kb-board-card-shell")?.click());
			// Review 列的单击会延迟一拍（留给双击改标题），推进过去。
			act(() => {
				vi.advanceTimersByTime(300);
			});
		} finally {
			vi.useRealTimers();
		}
		expect(onActivateTaskCardOpeningTaskInItsProject).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
	});

	// TaskCardBody 里这几颗按钮只按列渲染、不看 handler 是否存在；快照分支若不接，就是画出来了、点了没反应。
	it.each<{
		caseDescription: string;
		columnId: BoardColumnId;
		taskSessionsFromRuntimeBoardSnapshot: Record<string, RuntimeTaskSessionSummary>;
		buttonAriaLabel: string;
	}>([
		{
			caseDescription: "Backlog 卡的 Start",
			columnId: "backlog",
			taskSessionsFromRuntimeBoardSnapshot: {},
			buttonAriaLabel: "Start task",
		},
		{
			caseDescription: "Review 卡的 Move to validation",
			columnId: "review",
			taskSessionsFromRuntimeBoardSnapshot: {},
			buttonAriaLabel: "Move task to validation",
		},
		{
			caseDescription: "终端 agent 会话 In Progress 卡的 Move to review",
			columnId: "in_progress",
			taskSessionsFromRuntimeBoardSnapshot: { "task-1": createRunningTerminalAgentSessionSummary("task-1") },
			buttonAriaLabel: "Move task to review",
		},
		{
			caseDescription: "Done 卡的 Restore",
			columnId: "trash",
			taskSessionsFromRuntimeBoardSnapshot: {},
			buttonAriaLabel: "Restore task from done",
		},
	])("runtime 快照卡体：$caseDescription 按钮改为在所属项目打开该任务", (testCase) => {
		const card = createCard("task-1", "快照里按列画出动作按钮的卡");
		const board = boardWithCardInColumn(card, testCase.columnId);
		const onRequestComplete = vi.fn();
		const onActivateTaskCardOpeningTaskInItsProject = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-1" }),
			board,
			realTaskCardRenderingInputs: runtimeBoardSnapshotRenderingInputsFor(
				onActivateTaskCardOpeningTaskInItsProject,
				testCase.taskSessionsFromRuntimeBoardSnapshot,
			),
			onRequestComplete,
		});
		const columnActionButton = findButtonOnCardCopyByAriaLabel(testCase.buttonAriaLabel);
		expect(columnActionButton).not.toBeNull();
		act(() => columnActionButton?.click());
		expect(onActivateTaskCardOpeningTaskInItsProject).toHaveBeenCalledTimes(1);
		expect(onActivateTaskCardOpeningTaskInItsProject).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
		expect(onRequestComplete).not.toHaveBeenCalled();
	});

	it.each<{
		caseDescription: string;
		columnId: BoardColumnId;
		taskSessionsFromRuntimeBoardSnapshot: Record<string, RuntimeTaskSessionSummary>;
	}>([
		{ caseDescription: "Backlog", columnId: "backlog", taskSessionsFromRuntimeBoardSnapshot: {} },
		{ caseDescription: "In Progress（无会话）", columnId: "in_progress", taskSessionsFromRuntimeBoardSnapshot: {} },
		{
			caseDescription: "In Progress（终端 agent 会话）",
			columnId: "in_progress",
			taskSessionsFromRuntimeBoardSnapshot: { "task-1": createRunningTerminalAgentSessionSummary("task-1") },
		},
		{ caseDescription: "Review", columnId: "review", taskSessionsFromRuntimeBoardSnapshot: {} },
		{ caseDescription: "Validation", columnId: "validation", taskSessionsFromRuntimeBoardSnapshot: {} },
		{ caseDescription: "Done", columnId: "trash", taskSessionsFromRuntimeBoardSnapshot: {} },
	])("runtime 快照卡体（$caseDescription 列）：卡体上画出的每颗动作按钮点了都有明确行为", (testCase) => {
		const card = createCard("task-1", "逐颗点按钮的快照卡");
		const board = boardWithCardInColumn(card, testCase.columnId);
		const onRequestComplete = vi.fn();
		const onActivateTaskCardOpeningTaskInItsProject = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-1" }),
			board,
			realTaskCardRenderingInputs: runtimeBoardSnapshotRenderingInputsFor(
				onActivateTaskCardOpeningTaskInItsProject,
				testCase.taskSessionsFromRuntimeBoardSnapshot,
			),
			onRequestComplete,
		});
		const taskCardActionButtonAriaLabels = Array.from(
			container.querySelectorAll<HTMLButtonElement>(".kb-board-card-shell button[aria-label]"),
		)
			// 累计指标打开本地浮层，不路由卡片动作；下面单独验证它确实打开了明细。
			.filter((button) => !button.closest("[data-task-retained-committed-line-change-indicator]"))
			.map((button) => button.getAttribute("aria-label") ?? "")
			.filter(
				(ariaLabel) =>
					!CARD_COPY_BUTTON_ARIA_LABELS_WITH_LOCAL_BEHAVIOR_NOT_ROUTED_THROUGH_TASK_CARD_ACTIONS.has(ariaLabel),
			);
		expect(taskCardActionButtonAriaLabels.length).toBeGreaterThan(0);
		for (const ariaLabel of taskCardActionButtonAriaLabels) {
			onRequestComplete.mockClear();
			onActivateTaskCardOpeningTaskInItsProject.mockClear();
			act(() => findButtonOnCardCopyByAriaLabel(ariaLabel)?.click());
			expect(
				{
					ariaLabel,
					explicitBehaviorTriggerCount:
						onRequestComplete.mock.calls.length + onActivateTaskCardOpeningTaskInItsProject.mock.calls.length,
				},
				`快照卡体上的「${ariaLabel}」点了没反应`,
			).toEqual({ ariaLabel, explicitBehaviorTriggerCount: 1 });
		}
	});

	it("runtime 快照卡体的累计指标打开明细，不导航卡片", async () => {
		const card = createCard("task-1", "查看历史累计");
		const onActivateTask = vi.fn();
		renderEntry({
			task: createPostDeployVerificationTaskReadModelTestFixture({ taskId: "task-1" }),
			board: boardWithCardInColumn(card, "trash"),
			realTaskCardRenderingInputs: runtimeBoardSnapshotRenderingInputsFor(onActivateTask),
		});
		const indicator = container.querySelector<HTMLButtonElement>(
			"[data-task-retained-committed-line-change-indicator] button",
		);
		expect(indicator).not.toBeNull();
		await act(async () => indicator?.click());
		expect(document.querySelector('[role="dialog"][aria-label="任务已提交增删行明细"]')).not.toBeNull();
		expect(onActivateTask).not.toHaveBeenCalled();
	});
});
