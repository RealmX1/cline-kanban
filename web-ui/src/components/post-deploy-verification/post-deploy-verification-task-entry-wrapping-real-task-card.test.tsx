import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { createInitialBoardData } from "@/data/board-data";
import type { RuntimePostDeployVerificationTask } from "@/runtime/types";
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
}): void {
	act(() => {
		root.render(
			<PostDeployVerificationTaskEntryWrappingRealTaskCard
				postDeployVerificationTask={input.task}
				board={input.board}
				realTaskCardRenderingInputs={input.realTaskCardRenderingInputs}
				retainedDeploymentGroupsByDeploymentId={new Map()}
				interactive
				checklistInitiallyExpanded
				isCompleting={false}
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
	board: BoardData,
	onMoveToTrashTask: (taskId: string) => void,
): RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries {
	return {
		currentProjectDisplayedBoard: board,
		currentProjectTaskSessions: {},
		currentProjectTaskCardActionHandlers: { onMoveToTrashTask },
		currentProjectWorkspacePath: null,
		onActivateTaskCardOpeningTaskDetail: vi.fn(),
		defaultAgentId: null,
		defaultClineModelId: null,
	};
}

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
			realTaskCardRenderingInputs: renderingInputsFor(board, vi.fn()),
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
			realTaskCardRenderingInputs: renderingInputsFor(board, onMoveToTrashTask),
		});
		const moveToDoneButton = container.querySelector<HTMLButtonElement>(
			'.kb-board-card-shell button[aria-label="Move task to done"]',
		);
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
			realTaskCardRenderingInputs: renderingInputsFor(board, vi.fn()),
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
			realTaskCardRenderingInputs: renderingInputsFor(createInitialBoardData(), vi.fn()),
		});
		expect(
			container.querySelector("[data-post-deploy-verification-task-entry-card-removed-from-board]"),
		).not.toBeNull();
		expect(container.textContent).toContain("已从看板删除");
		expect(container.querySelector(".kb-board-card-shell")).toBeNull();
	});
});
