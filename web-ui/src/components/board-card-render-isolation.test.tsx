import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as BoardCardModule from "@/components/board-card";
import { ColumnContextPanel } from "@/components/detail-panels/column-context-panel";
import { KanbanBoard } from "@/components/kanban-board";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";

// 保留真实看板/卡片/动作门控，仅替换布局外设；卡体每次执行都会读此 hook。
const cardRenderObservation = vi.hoisted(() => vi.fn());
const cardPropsObservation = vi.hoisted(() => new Map<string, ComponentProps<typeof BoardCardModule.BoardCard>>());
const changedCardPropsObservation = vi.hoisted(() => new Map<string, string[]>());
vi.mock("@/components/board-card", async (importOriginal) => {
	const actual = await importOriginal<typeof BoardCardModule>();
	return {
		BoardCard: (props: ComponentProps<typeof BoardCardModule.BoardCard>) => {
			const previous = cardPropsObservation.get(props.card.id);
			changedCardPropsObservation.set(
				props.card.id,
				previous
					? Object.keys(props).filter((key) => !Object.is(Reflect.get(previous, key), Reflect.get(props, key)))
					: [],
			);
			cardPropsObservation.set(props.card.id, props);
			return <actual.BoardCard {...props} />;
		},
	};
});

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: (taskId: string) => {
		cardRenderObservation(taskId);
		return undefined;
	},
}));
vi.mock("@hello-pangea/dnd", () => ({
	DragDropContext: ({ children }: { children: ReactNode }) => children,
	Droppable: ({ children }: { children: (provided: object) => ReactNode }) =>
		children({ innerRef: () => {}, droppableProps: {}, placeholder: null }),
	Draggable: ({ children }: { children: (provided: object, snapshot: object) => ReactNode }) =>
		children({ innerRef: () => {}, draggableProps: {}, dragHandleProps: {} }, { isDragging: false }),
}));
vi.mock("@/hooks/use-selected-card-pin-state", () => ({ useSelectedCardPinState: () => "pinTop" }));
vi.mock("@/hooks/use-stage-header-pin-layout", () => ({
	useStageHeaderPinLayout: () => ({ topPinnedColumnIds: ["review"], bottomPinnedColumnIds: [] }),
}));

const card = (id: string): BoardCard => ({
	id,
	title: id,
	prompt: id,
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
	pinnedToTaskPinboardAt: 1,
});
const firstCard = card("first");
const secondCard = card("second");
const board: BoardData = {
	columns: [{ id: "review", title: "Review", cards: [firstCard, secondCard] }],
	dependencies: [],
};
const stableHandlers = {
	onCardSelect: vi.fn(),
	onCreateTask: vi.fn(),
	onDragEnd: vi.fn(),
	onTaskDragEnd: vi.fn(),
	onStartTask: vi.fn(),
	onEditTask: vi.fn(),
	onMoveToTrashTask: vi.fn(),
	onMoveToValidationTask: vi.fn(),
	onRequestPinToTaskPinboard: vi.fn(),
	onUnpinFromTaskPinboard: vi.fn(),
	onEditTaskPinboardPinReason: vi.fn(),
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
	window.localStorage.clear();
	cardRenderObservation.mockClear();
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

for (const host of ["board", "focus"] as const) {
	it(`${host}：单条 summary 更新只执行对应卡体（含置顶板及 sticky 副本），输出变化 prop 作为失败诊断`, () => {
		const render = (
			taskSessions: Record<string, RuntimeTaskSessionSummary>,
			overrides: Partial<ComponentProps<typeof KanbanBoard>> = {},
		) =>
			act(() =>
				root.render(
					<TooltipProvider>
						{host === "board" ? (
							<KanbanBoard
								data={board}
								dependencies={board.dependencies}
								taskSessions={taskSessions}
								{...stableHandlers}
								{...overrides}
							/>
						) : (
							<ColumnContextPanel
								selection={{ card: firstCard, column: board.columns[0]!, allColumns: board.columns }}
								taskSessions={taskSessions}
								{...stableHandlers}
								{...overrides}
							/>
						)}
					</TooltipProvider>,
				),
			);
		render({});
		cardRenderObservation.mockClear();
		const summary: RuntimeTaskSessionSummary = {
			taskId: "second",
			state: "idle",
			agentId: null,
			workspacePath: null,
			pid: null,
			startedAt: null,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
		};
		render({ second: summary });
		expect(
			cardRenderObservation.mock.calls.map(([id]) => id),
			`不变的 first 卡及其副本不应重渲染；变化 props: ${changedCardPropsObservation.get("first")?.join(", ")}`,
		).not.toContain("first");
		expect(cardRenderObservation.mock.calls.map(([id]) => id)).toContain("second");
		cardRenderObservation.mockClear();
		render({ second: summary });
		expect(cardRenderObservation).not.toHaveBeenCalled();
		const updatedMoveToValidationHandler = vi.fn();
		render({ second: summary }, { onMoveToValidationTask: updatedMoveToValidationHandler });
		expect(cardRenderObservation.mock.calls.map(([id]) => id)).toContain("first");
	});
}
