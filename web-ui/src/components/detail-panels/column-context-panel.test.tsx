import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ColumnContextPanel } from "@/components/detail-panels/column-context-panel";
import type { BoardColumn, CardSelection } from "@/types";

vi.mock("@/components/board-card", () => ({
	BoardCard: ({
		card,
		selected,
	}: {
		card: { id: string; prompt: string };
		selected?: boolean;
	}): React.ReactElement => {
		return (
			<div data-task-id={card.id} data-selected={selected ? "true" : "false"}>
				{card.prompt}
			</div>
		);
	},
}));

vi.mock("@hello-pangea/dnd", () => ({
	DragDropContext: ({ children }: { children: ReactNode }): React.ReactElement => <>{children}</>,
	Droppable: ({
		children,
	}: {
		children: (provided: { innerRef: (element: HTMLDivElement | null) => void; droppableProps: object }) => ReactNode;
	}): React.ReactElement => {
		return <>{children({ innerRef: () => {}, droppableProps: {} })}</>;
	},
}));

function createCard(id: string, prompt: string) {
	return {
		id,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit" as const,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createSelection(columns: BoardColumn[], taskId: string): CardSelection {
	for (const column of columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return {
				card,
				column,
				allColumns: columns,
			};
		}
	}
	throw new Error(`Could not find task ${taskId}.`);
}

describe("ColumnContextPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let scrollIntoViewMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		scrollIntoViewMock = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoViewMock,
		});
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("centers the selected detail card when the selection changes", async () => {
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [createCard("task-1", "Backlog task")] },
			{ id: "in_progress", title: "In Progress", cards: [createCard("task-2", "In progress task")] },
			{ id: "review", title: "Review", cards: [createCard("task-3", "Review task")] },
			{ id: "trash", title: "Done", cards: [] },
		];

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-2")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
				/>,
			);
		});

		expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
		expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
			block: "center",
			inline: "nearest",
		});

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-3")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
				/>,
			);
		});

		expect(scrollIntoViewMock).toHaveBeenCalledTimes(2);
		expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
			block: "center",
			inline: "nearest",
		});
	});

	it("initially renders only the first 10 cards in a column and reveals more on demand", async () => {
		const backlogCards = Array.from({ length: 15 }, (_, index) =>
			createCard(`task-${index + 1}`, `Backlog task ${index + 1}`),
		);
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: backlogCards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		];

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-1")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
				/>,
			);
		});

		expect(container.querySelectorAll("[data-task-id]").length).toBe(10);

		const sentinelButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("滚动或点击加载"),
		);
		expect(sentinelButton?.textContent).toContain("还有 5 个");

		await act(async () => {
			sentinelButton?.click();
		});

		expect(container.querySelectorAll("[data-task-id]").length).toBe(15);
		expect(
			[...container.querySelectorAll("button")].some((button) => button.textContent?.includes("滚动或点击加载")),
		).toBe(false);
	});

	it("renders and centers a selected card that sits beyond the initial render window", async () => {
		const backlogCards = Array.from({ length: 15 }, (_, index) =>
			createCard(`task-${index + 1}`, `Backlog task ${index + 1}`),
		);
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: backlogCards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		];

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-13")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
				/>,
			);
		});

		// 被选中的是第 13 张（index 12），需扩展到至少 13 张才能让它挂载并居中。
		const renderedCount = container.querySelectorAll("[data-task-id]").length;
		expect(renderedCount).toBeGreaterThanOrEqual(13);
		expect(container.querySelector('[data-task-id="task-13"]')).not.toBeNull();
		expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
		expect(scrollIntoViewMock).toHaveBeenLastCalledWith({
			block: "center",
			inline: "nearest",
		});
	});

	it("restores the most recently updated done task from the collapsed done header", async () => {
		const olderDoneTask = {
			...createCard("task-done-older", "Older done task"),
			updatedAt: 3,
		};
		const latestDoneTask = {
			...createCard("task-done-latest", "Latest done task"),
			updatedAt: 10,
		};
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [createCard("task-review", "Review task")] },
			{ id: "trash", title: "Done", cards: [olderDoneTask, latestDoneTask] },
		];
		const onRestoreFromTrashTask = vi.fn();

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-review")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
					onRestoreFromTrashTask={onRestoreFromTrashTask}
				/>,
			);
		});

		const restoreButton = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Restore most recent done task"]',
		);
		expect(restoreButton).toBeInstanceOf(HTMLButtonElement);
		expect(restoreButton?.disabled).toBe(false);

		await act(async () => {
			restoreButton?.click();
		});

		expect(onRestoreFromTrashTask).toHaveBeenCalledTimes(1);
		expect(onRestoreFromTrashTask).toHaveBeenCalledWith("task-done-latest");
	});

	it("disables the collapsed done restore button when done is empty", async () => {
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [createCard("task-review", "Review task")] },
			{ id: "trash", title: "Done", cards: [] },
		];
		const onRestoreFromTrashTask = vi.fn();

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-review")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
					onRestoreFromTrashTask={onRestoreFromTrashTask}
				/>,
			);
		});

		const restoreButton = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Restore most recent done task"]',
		);
		expect(restoreButton).toBeInstanceOf(HTMLButtonElement);
		expect(restoreButton?.disabled).toBe(true);

		await act(async () => {
			restoreButton?.click();
		});

		expect(onRestoreFromTrashTask).not.toHaveBeenCalled();
	});
});
