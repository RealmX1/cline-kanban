import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanBoard, type RequestProgrammaticCardMove } from "@/components/kanban-board";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { BoardColumnId, BoardData } from "@/types";

const dndMock = vi.hoisted(() => ({
	sensorApi: null as {
		tryGetLock: ReturnType<typeof vi.fn>;
	} | null,
}));

// 记录每个 BoardColumn 实际收到的 onSaveTitle，用于断言父级 wiring 是否对每一列（含 done/trash）传入保存回调。
const boardColumnMock = vi.hoisted(() => ({
	onSaveTitleByColumnId: new Map<string, ((taskId: string, title: string) => void) | undefined>(),
	onRequestStartAllReadyBacklogTasksByColumnId: new Map<string, (() => void) | undefined>(),
	onCollapseColumnByColumnId: new Map<string, ((columnId: BoardColumnId) => void) | undefined>(),
	columnFlexStyleByColumnId: new Map<string, { flex: string } | undefined>(),
}));

vi.mock("@hello-pangea/dnd", async () => {
	const React = await vi.importActual<typeof import("react")>("react");

	return {
		DragDropContext: ({
			children,
			sensors,
		}: {
			children: ReactNode;
			sensors?: Array<(api: NonNullable<typeof dndMock.sensorApi>) => void>;
		}): React.ReactElement => {
			React.useEffect(() => {
				if (!dndMock.sensorApi) {
					return;
				}
				for (const sensor of sensors ?? []) {
					sensor(dndMock.sensorApi);
				}
			}, [sensors]);

			return <>{children}</>;
		},
	};
});

vi.mock("@/components/board-column", () => ({
	BoardColumn: ({
		column,
		onSaveTitle,
		onRequestStartAllReadyBacklogTasks,
		onCollapseColumn,
		columnFlexStyle,
	}: {
		column: BoardData["columns"][number];
		onSaveTitle?: (taskId: string, title: string) => void;
		onRequestStartAllReadyBacklogTasks?: () => void;
		onCollapseColumn?: (columnId: BoardColumnId) => void;
		columnFlexStyle?: { flex: string };
	}): React.ReactElement => {
		boardColumnMock.onSaveTitleByColumnId.set(column.id, onSaveTitle);
		boardColumnMock.onRequestStartAllReadyBacklogTasksByColumnId.set(column.id, onRequestStartAllReadyBacklogTasks);
		boardColumnMock.onCollapseColumnByColumnId.set(column.id, onCollapseColumn);
		boardColumnMock.columnFlexStyleByColumnId.set(column.id, columnFlexStyle);
		return (
			<section data-column-id={column.id}>
				<div className="kb-column-cards">
					{column.cards.map((card) => (
						<div key={card.id} data-task-id={card.id} />
					))}
				</div>
			</section>
		);
	},
}));

// 折叠竖条的真实实现依赖 Droppable（本文件的 dnd mock 只提供 DragDropContext），这里只保留可点击展开的骨架。
vi.mock("@/components/board-column-collapsed-vertical-strip", () => ({
	BoardColumnCollapsedVerticalStrip: ({
		column,
		onExpandColumn,
	}: {
		column: BoardData["columns"][number];
		onExpandColumn: (columnId: BoardColumnId) => void;
	}): React.ReactElement => (
		<section data-column-id={column.id} data-kanban-board-column-collapsed="true">
			<button type="button" aria-label={`Expand ${column.title} column`} onClick={() => onExpandColumn(column.id)} />
		</section>
	),
}));

function createRect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("KanbanBoard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		boardColumnMock.onSaveTitleByColumnId.clear();
		boardColumnMock.onRequestStartAllReadyBacklogTasksByColumnId.clear();
		boardColumnMock.onCollapseColumnByColumnId.clear();
		boardColumnMock.columnFlexStyleByColumnId.clear();
		window.localStorage.clear();
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			return window.setTimeout(() => {
				callback(performance.now());
			}, 16);
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle: number) => {
			window.clearTimeout(handle);
		});
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(
			this: HTMLElement,
		) {
			if (this.dataset.taskId === "source-task") {
				return createRect(20, 20, 160, 96);
			}
			if (this.dataset.taskId === "target-task-1") {
				return createRect(300, 20, 160, 96);
			}
			if (this.classList.contains("kb-column-cards")) {
				const columnId = this.closest<HTMLElement>("[data-column-id]")?.dataset.columnId;
				if (columnId === "backlog") {
					return createRect(12, 12, 176, 420);
				}
				if (columnId === "in_progress") {
					return createRect(292, 12, 176, 420);
				}
			}
			return createRect(0, 0, 0, 0);
		});
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		dndMock.sensorApi = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("marks the board while a programmatic move is active", async () => {
		const dragActions = {
			isActive: vi.fn(() => true),
			move: vi.fn(),
			drop: vi.fn(),
			cancel: vi.fn(),
		};
		const preDrag = {
			fluidLift: vi.fn(() => dragActions),
			isActive: vi.fn(() => true),
			abort: vi.fn(),
		};
		dndMock.sensorApi = {
			tryGetLock: vi.fn(() => preDrag),
		};

		const board: BoardData = {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "source-task",
							title: "Source task",
							prompt: "Source task",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "target-task-1",
							title: "Target task 1",
							prompt: "Target task 1",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		};

		let requestMove: RequestProgrammaticCardMove | null = null;

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					onDragEnd={() => {}}
					onRequestProgrammaticCardMoveReady={(nextRequestMove) => {
						requestMove = nextRequestMove;
					}}
				/>,
			);
		});

		const boardElement = container.querySelector<HTMLElement>(".kb-board");
		expect(boardElement?.dataset.programmaticCardMove).toBeUndefined();

		await act(async () => {
			requestMove?.({
				taskId: "source-task",
				fromColumnId: "backlog",
				toColumnId: "in_progress",
				insertAtTop: true,
			});
		});

		expect(boardElement?.dataset.programmaticCardMove).toBe("true");
	});

	it("wires onSaveTitle to every column including done/trash so inline title editing stays reachable", async () => {
		// validation / done 默认折叠（不挂 BoardColumn）；这里先把它们展开，断言展开后的 wiring。
		window.localStorage.setItem(
			LocalStorageKey.KanbanBoardColumnCollapsedOverrides,
			JSON.stringify({ validation: false, trash: false }),
		);
		const onSaveTaskTitle = vi.fn();
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		};

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					onSaveTaskTitle={onSaveTaskTitle}
					onDragEnd={() => {}}
				/>,
			);
		});

		// done/trash 列必须收到非空 onSaveTitle，否则 board-card 的双击/铅笔改标题在生产里恒不可达。
		expect(boardColumnMock.onSaveTitleByColumnId.get("trash")).toBe(onSaveTaskTitle);
		expect(boardColumnMock.onSaveTitleByColumnId.get("in_progress")).toBe(onSaveTaskTitle);
		expect(boardColumnMock.onSaveTitleByColumnId.get("review")).toBe(onSaveTaskTitle);
		expect(boardColumnMock.onSaveTitleByColumnId.get("validation")).toBe(onSaveTaskTitle);
	});

	it("wires the main backlog header action to the centralized start-all confirmation request", async () => {
		const onRequestStartAllReadyBacklogTasks = vi.fn();
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		};

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					onRequestStartAllReadyBacklogTasks={onRequestStartAllReadyBacklogTasks}
					onDragEnd={() => {}}
				/>,
			);
		});

		expect(boardColumnMock.onRequestStartAllReadyBacklogTasksByColumnId.get("backlog")).toBe(
			onRequestStartAllReadyBacklogTasks,
		);
		expect(boardColumnMock.onRequestStartAllReadyBacklogTasksByColumnId.get("in_progress")).toBeUndefined();
	});
	function createFiveEmptyColumnBoard(): BoardData {
		return {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
		};
	}

	async function renderFiveEmptyColumnBoard(
		onRequestProgrammaticCardMoveReady?: (requestMove: RequestProgrammaticCardMove | null) => void,
		board: BoardData = createFiveEmptyColumnBoard(),
	): Promise<void> {
		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					onDragEnd={() => {}}
					onRequestProgrammaticCardMoveReady={onRequestProgrammaticCardMoveReady}
				/>,
			);
		});
	}

	function readCollapsedColumnIds(): string[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>('section[data-kanban-board-column-collapsed="true"]'),
			(element) => element.dataset.columnId ?? "",
		);
	}

	it("collapses validation and done by default and renders a width handle only after expanded columns", async () => {
		await renderFiveEmptyColumnBoard();

		expect(readCollapsedColumnIds()).toEqual(["validation", "trash"]);
		expect(Array.from(boardColumnMock.onCollapseColumnByColumnId.keys())).toEqual([
			"backlog",
			"in_progress",
			"review",
		]);
		const resizeHandleLabels = Array.from(
			container.querySelectorAll<HTMLElement>('.kb-board > [role="separator"]'),
			(element) => element.getAttribute("aria-label"),
		);
		expect(resizeHandleLabels).toEqual([
			"Resize Backlog column",
			"Resize In Progress column",
			"Resize Review column",
		]);
		expect(boardColumnMock.columnFlexStyleByColumnId.get("backlog")).toEqual({ flex: "1 1 0" });
	});

	it("expands a collapsed column from its strip and collapses any expanded column, persisting both", async () => {
		await renderFiveEmptyColumnBoard();

		await act(async () => {
			container.querySelector<HTMLButtonElement>('button[aria-label="Expand Done column"]')?.click();
		});
		expect(readCollapsedColumnIds()).toEqual(["validation"]);

		await act(async () => {
			boardColumnMock.onCollapseColumnByColumnId.get("backlog")?.("backlog");
		});
		expect(readCollapsedColumnIds()).toEqual(["backlog", "validation"]);
		expect(
			JSON.parse(window.localStorage.getItem(LocalStorageKey.KanbanBoardColumnCollapsedOverrides) ?? "{}"),
		).toEqual({ trash: false, backlog: true });
	});

	it("applies persisted custom widths as a fixed flex-basis", async () => {
		window.localStorage.setItem(LocalStorageKey.KanbanBoardColumnCustomWidthsPx, JSON.stringify({ review: 420 }));
		await renderFiveEmptyColumnBoard();

		expect(boardColumnMock.columnFlexStyleByColumnId.get("review")).toEqual({ flex: "0 0 420px" });
		expect(boardColumnMock.columnFlexStyleByColumnId.get("backlog")).toEqual({ flex: "1 1 0" });
	});

	it("declines to animate a programmatic move into a collapsed column so the caller falls back to a direct move", async () => {
		const tryGetLock = vi.fn();
		dndMock.sensorApi = { tryGetLock };
		const board = createFiveEmptyColumnBoard();
		board.columns[2] = {
			id: "review",
			title: "Review",
			cards: [
				{
					id: "source-task",
					title: "Source task",
					prompt: "Source task",
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		};
		let requestMove: RequestProgrammaticCardMove | null = null;
		await renderFiveEmptyColumnBoard((nextRequestMove) => {
			requestMove = nextRequestMove;
		}, board);

		let started: boolean | undefined;
		await act(async () => {
			started = (requestMove as RequestProgrammaticCardMove | null)?.({
				taskId: "source-task",
				fromColumnId: "review",
				toColumnId: "trash",
				insertAtTop: true,
			});
		});

		expect(started).toBe(false);
		expect(tryGetLock).not.toHaveBeenCalled();
	});
	it("resizes columns from the focused width handle with the keyboard, mirroring the mouse semantics", async () => {
		window.localStorage.setItem(LocalStorageKey.KanbanBoardColumnCustomWidthsPx, JSON.stringify({ backlog: 300 }));
		await renderFiveEmptyColumnBoard();
		const pressKeyOnResizeHandle = async (columnTitle: string, key: string, shiftKey = false): Promise<void> => {
			const handle = container.querySelector<HTMLElement>(
				`.kb-board > [role="separator"][aria-label="Resize ${columnTitle} column"]`,
			);
			expect(handle?.tabIndex).toBe(0);
			await act(async () => {
				handle?.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
			});
		};
		const readStoredWidths = (): unknown =>
			JSON.parse(window.localStorage.getItem(LocalStorageKey.KanbanBoardColumnCustomWidthsPx) ?? "{}");

		expect(
			container
				.querySelector('.kb-board > [role="separator"][aria-label="Resize Backlog column"]')
				?.getAttribute("aria-valuenow"),
		).toBe("300");

		await pressKeyOnResizeHandle("Backlog", "ArrowRight");
		expect(boardColumnMock.columnFlexStyleByColumnId.get("backlog")).toEqual({ flex: "0 0 316px" });
		expect(readStoredWidths()).toEqual({ backlog: 316 });

		// 自动填充列（测试里实测宽度为 0）按 End 直接设到最大宽度，与当前实测宽度无关。
		await pressKeyOnResizeHandle("Review", "End");
		expect(readStoredWidths()).toEqual({ backlog: 316, review: 900 });

		await pressKeyOnResizeHandle("Backlog", "ArrowLeft", true);
		expect(readStoredWidths()).toEqual({ backlog: 300, in_progress: 300, review: 300 });

		await pressKeyOnResizeHandle("Review", "Enter");
		expect(readStoredWidths()).toEqual({ backlog: 300, in_progress: 300 });

		await pressKeyOnResizeHandle("Backlog", "Delete", true);
		expect(readStoredWidths()).toEqual({});
		expect(boardColumnMock.columnFlexStyleByColumnId.get("backlog")).toEqual({ flex: "1 1 0" });
	});
});
