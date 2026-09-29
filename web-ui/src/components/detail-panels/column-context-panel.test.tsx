import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ColumnContextPanel } from "@/components/detail-panels/column-context-panel";
import type { BoardColumn, CardSelection } from "@/types";

// BoardCard = 列表内的可拖卡（包 <Draggable>）。mock 暴露 data-card-variant="draggable" 与它收到的
// Draggable index（data-draggable-index），供断言「展开态焦点卡以真实、连续的 index 拖拽」。
vi.mock("@/components/board-card", () => ({
	BoardCard: ({
		card,
		index,
		selected,
		onMoveToTrash,
		onMoveToValidation,
	}: {
		card: { id: string; prompt: string };
		index: number;
		selected?: boolean;
		onMoveToTrash?: (taskId: string) => void;
		onMoveToValidation?: (taskId: string) => void;
	}): React.ReactElement => {
		return (
			<div
				data-task-id={card.id}
				data-selected={selected ? "true" : "false"}
				data-card-variant="draggable"
				data-draggable-index={String(index)}
			>
				{card.prompt}
				{onMoveToTrash ? (
					<button type="button" aria-label={`move-to-done-${card.id}`} onClick={() => onMoveToTrash(card.id)} />
				) : null}
				{onMoveToValidation ? (
					<button
						type="button"
						aria-label={`move-to-validation-${card.id}`}
						onClick={() => onMoveToValidation(card.id)}
					/>
				) : null}
			</div>
		);
	},
}));

// TaskCardBody = 裸卡体（无 <Draggable>、不收 index）。折叠 peek 的焦点卡、StageHeaderRails 的 sticky 卡头副本、
// 置顶板分身都走这里。mock 忠实还原真实契约：只有 canonical 角色输出 data-task-id（保全局唯一），
// 且 data-card-variant="static"（不可拖），供断言「peek 卡不带假 Draggable index、不可拖」。
vi.mock("@/components/task-card-body", () => ({
	TaskCardBody: ({
		card,
		selected,
		renderRole = "canonical_card_in_its_stage_list",
		onMoveToTrash,
		onMoveToValidation,
	}: {
		card: { id: string; prompt: string };
		selected?: boolean;
		renderRole?: string;
		onMoveToTrash?: (taskId: string) => void;
		onMoveToValidation?: (taskId: string) => void;
	}): React.ReactElement => {
		const emitsCanonicalDomIdentity = renderRole === "canonical_card_in_its_stage_list";
		return (
			<div
				data-task-id={emitsCanonicalDomIdentity ? card.id : undefined}
				data-selected={selected ? "true" : "false"}
				data-card-variant={emitsCanonicalDomIdentity ? "static" : renderRole}
			>
				{card.prompt}
				{onMoveToTrash ? (
					<button type="button" aria-label={`move-to-done-${card.id}`} onClick={() => onMoveToTrash(card.id)} />
				) : null}
				{onMoveToValidation ? (
					<button
						type="button"
						aria-label={`move-to-validation-${card.id}`}
						onClick={() => onMoveToValidation(card.id)}
					/>
				) : null}
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

	it("renders the create-task button at the top of the scroll list, above every stage section", async () => {
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [createCard("task-1", "Backlog task")] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		];
		const onCreateTask = vi.fn();

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-1")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
					onCreateTask={onCreateTask}
				/>,
			);
		});

		const createButton = container.querySelector<HTMLButtonElement>('button[aria-label="Create task"]');
		expect(createButton).toBeInstanceOf(HTMLButtonElement);
		// 直接挂在 scrollport 上（不再嵌在 backlog 的 stage section / Droppable 里）。
		const scrollport = container.querySelector(".kb-detail-task-list-scroll");
		expect(createButton?.parentElement).toBe(scrollport);
		// 文档顺序上位于所有任务卡之前 = 列表最顶端。
		const firstCard = container.querySelector("[data-task-id]");
		expect(firstCard).not.toBeNull();
		if (createButton && firstCard) {
			expect(createButton.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		}

		await act(async () => {
			createButton?.click();
		});
		expect(onCreateTask).toHaveBeenCalledTimes(1);
	});

	it("requests centralized confirmation from the Focus View backlog header action", async () => {
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [createCard("task-1", "Backlog task")] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		];
		const onRequestStartAllReadyBacklogTasks = vi.fn();

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-1")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
					onRequestStartAllReadyBacklogTasks={onRequestStartAllReadyBacklogTasks}
				/>,
			);
		});

		const startAllButton = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Start all ready backlog tasks"]',
		);
		expect(startAllButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			startAllButton?.click();
		});

		expect(onRequestStartAllReadyBacklogTasks).toHaveBeenCalledTimes(1);
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

	// Pinned 分段要常驻列表顶端、不随 stage 列表滚走：它必须在 scrollport 之外；且 stage 卡头 rail 以
	// 绝对定位锚在「stage 列表区」（scrollport 的父节点）上，Pinned 若也落在那个定位父级里就会被顶沿 rail 盖住。
	it("keeps the Focus View pinned section outside the scrollport and outside the stage-header rail anchor", async () => {
		const pinnedReviewCard = { ...createCard("task-review", "Review task"), pinnedToTaskPinboardAt: 5_000 };
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [createCard("task-1", "Backlog task")] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [pinnedReviewCard] },
			{ id: "trash", title: "Done", cards: [] },
		];

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-1")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
					onCreateTask={() => {}}
				/>,
			);
		});

		const pinnedSection = container.querySelector('[data-task-pinboard-container="focus-view-section"]');
		const scrollport = container.querySelector(".kb-detail-task-list-scroll");
		expect(pinnedSection).not.toBeNull();
		expect(scrollport).not.toBeNull();
		if (!pinnedSection || !scrollport?.parentElement) {
			return;
		}
		expect(scrollport.contains(pinnedSection)).toBe(false);
		expect(scrollport.parentElement.contains(pinnedSection)).toBe(false);
		expect(
			scrollport.parentElement.style.position === "relative" ||
				scrollport.parentElement.classList.contains("relative"),
		).toBe(true);
		// rail 定位锚同时须是裁剪边界：底沿 rail 向上堆叠超出本区高度时，不得溢出本区上沿去盖住 Pinned 分段。
		expect(
			scrollport.parentElement.style.overflow === "clip" ||
				scrollport.parentElement.classList.contains("overflow-clip"),
		).toBe(true);
		// 文档序在 scrollport 之前 = 视觉上位于任务列表最顶端。
		expect(pinnedSection.compareDocumentPosition(scrollport) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	// 置顶板分身与本体卡同处一个页面，唯一性一旦破掉，居中滚动 / 钉住几何 / 依赖锚点
	// 都会随机接到分身上（dependency-overlay 的锚点表是「后出现者覆盖先出现者」）。
	it("keeps data-task-id unique after a card gets pinned to the task pinboard", async () => {
		const pinnedReviewCard = { ...createCard("task-review", "Review task"), pinnedToTaskPinboardAt: 5_000 };
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [pinnedReviewCard] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		];

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-review")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
				/>,
			);
		});

		// 置顶板分段渲染了这张卡的分身，但只有 review 列表里的本体带 data-task-id。
		expect(container.querySelector('[data-task-pinboard-container="focus-view-section"]')).not.toBeNull();
		expect(container.querySelectorAll('[data-task-id="task-review"]').length).toBe(1);
		expect(container.querySelectorAll('[data-card-variant="pinned_card_copy_in_task_pinboard"]').length).toBe(1);
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

	it("keeps only the focused card visible when its stage is collapsed (peek), as a non-draggable card with a unique data-task-id", async () => {
		// 焦点卡故意放在 review 列的第 2 位（真实 index 1，非 0）——这是原缺陷的触发条件：折叠 peek 若把它
		// 当成 Draggable index=0 渲染，跨列拖放会按 source.index=0 splice 掉第 1 张（task-review-sibling）而非焦点卡。
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [createCard("task-review-sibling", "Other review task"), createCard("task-review", "Review task")],
			},
			{ id: "trash", title: "Done", cards: [] },
		];

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-review")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
				/>,
			);
		});

		// Review starts expanded: both cards render as draggable BoardCards, each carrying its REAL, contiguous
		// column index (sibling=0, focused=1). This is what makes cross-column drop splice the correct card.
		const expandedSibling = container.querySelector('[data-task-id="task-review-sibling"]');
		const expandedFocused = container.querySelector('[data-task-id="task-review"]');
		expect(expandedSibling).not.toBeNull();
		expect(expandedFocused).not.toBeNull();
		expect(expandedSibling?.getAttribute("data-card-variant")).toBe("draggable");
		expect(expandedSibling?.getAttribute("data-draggable-index")).toBe("0");
		expect(expandedFocused?.getAttribute("data-card-variant")).toBe("draggable");
		expect(expandedFocused?.getAttribute("data-draggable-index")).toBe("1");

		// Collapse the focused stage via its header toggle (the button carrying the "Review" label).
		const reviewToggle = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Review"),
		);
		expect(reviewToggle).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			reviewToggle?.click();
		});

		// Peek: the focused card remains (exactly once — the rail clone carries no data-task-id), the sibling is gone.
		expect(container.querySelectorAll('[data-task-id="task-review"]').length).toBe(1);
		expect(container.querySelector('[data-task-id="task-review-sibling"]')).toBeNull();

		// And it is rendered NON-draggable (static TaskCardBody, no Draggable index) — so it can no longer be
		// dragged with a fake index-0 that would splice the wrong card. No draggable index is emitted for it.
		const peekCard = container.querySelector('[data-task-id="task-review"]');
		expect(peekCard?.getAttribute("data-card-variant")).toBe("static");
		expect(peekCard?.getAttribute("data-draggable-index")).toBeNull();
	});

	it("wires the compact move actions per column (review gets both, in_progress none, validation done only)", async () => {
		const columns: BoardColumn[] = [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [createCard("task-ip", "In progress task")] },
			{ id: "review", title: "Review", cards: [createCard("task-review", "Review task")] },
			{ id: "validation", title: "Validation", cards: [createCard("task-val", "Validation task")] },
			{ id: "trash", title: "Done", cards: [] },
		];
		const onMoveToValidationTask = vi.fn();
		const onMoveToTrashTask = vi.fn();

		await act(async () => {
			root.render(
				<ColumnContextPanel
					selection={createSelection(columns, "task-review")}
					onCardSelect={() => {}}
					taskSessions={{}}
					onTaskDragEnd={() => {}}
					onMoveToValidationTask={onMoveToValidationTask}
					onMoveToTrashTask={onMoveToTrashTask}
				/>,
			);
		});

		// Review card: both actions wired.
		const reviewValidation = container.querySelector<HTMLButtonElement>(
			'button[aria-label="move-to-validation-task-review"]',
		);
		expect(reviewValidation).toBeInstanceOf(HTMLButtonElement);
		expect(container.querySelector('button[aria-label="move-to-done-task-review"]')).toBeInstanceOf(
			HTMLButtonElement,
		);
		await act(async () => {
			reviewValidation?.click();
		});
		expect(onMoveToValidationTask).toHaveBeenCalledWith("task-review");

		// In Progress card: neither action wired.
		expect(container.querySelector('button[aria-label="move-to-validation-task-ip"]')).toBeNull();
		expect(container.querySelector('button[aria-label="move-to-done-task-ip"]')).toBeNull();

		// Validation card: move-to-done wired, move-to-validation not.
		const validationDone = container.querySelector<HTMLButtonElement>('button[aria-label="move-to-done-task-val"]');
		expect(validationDone).toBeInstanceOf(HTMLButtonElement);
		expect(container.querySelector('button[aria-label="move-to-validation-task-val"]')).toBeNull();
		await act(async () => {
			validationDone?.click();
		});
		expect(onMoveToTrashTask).toHaveBeenCalledWith("task-val");
	});
});
