import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type TaskSpotlightSearchController,
	type UseTaskSpotlightSearchControllerInput,
	useTaskSpotlightSearchController,
} from "@/hooks/use-task-spotlight-search-controller";
import { buildTaskBoardSearchDocuments, type TaskBoardSearchDocument } from "@/search/task-board-search";
import type { BoardCard, BoardData } from "@/types";

// direct 模式不触碰语义索引，mock 掉以避免加载 TensorFlow vendor。
vi.mock("@/search/task-board-semantic-search", () => ({
	createTaskBoardSemanticSearchIndex: vi.fn(async () => ({ findResults: async () => [] })),
}));

// mock 跨项目按需拉取 hook：enabled（弹层开 && 开关开）时返回预置文档，避免触碰 tRPC 客户端。
const crossProjectIndexMock = vi.hoisted(() => ({ documents: [] as TaskBoardSearchDocument[] }));
vi.mock("@/search/use-all-projects-task-search-index", () => ({
	useAllProjectsTaskSearchIndex: ({ enabled }: { enabled: boolean }) => ({
		documents: enabled ? crossProjectIndexMock.documents : [],
		status: enabled ? "ready" : "idle",
		refetch: () => {},
	}),
}));

function card(id: string, title: string, prompt: string): BoardCard {
	return { id, title, prompt, startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
}

function createBoard(): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [card("task-alpha", "Alpha task", "shared alpha work"), card("task-beta", "Beta shared", "cleanup")],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [card("task-review", "Review task", "inspect shared")] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [card("task-done", "Done task", "shared archive")] },
		],
		dependencies: [],
	};
}

function createOtherProjectBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [card("task-remote", "Remote shared", "other repo")] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("useTaskSpotlightSearchController", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		crossProjectIndexMock.documents = [];
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	function renderController(initialProps: UseTaskSpotlightSearchControllerInput): {
		get: () => TaskSpotlightSearchController;
		rerender: (nextProps: UseTaskSpotlightSearchControllerInput) => void;
	} {
		let controller: TaskSpotlightSearchController | null = null;

		function Harness(props: UseTaskSpotlightSearchControllerInput): null {
			controller = useTaskSpotlightSearchController(props);
			return null;
		}

		act(() => {
			root.render(<Harness {...initialProps} />);
		});

		return {
			get: () => {
				if (!controller) {
					throw new Error("controller not available");
				}
				return controller;
			},
			rerender: (nextProps) => {
				act(() => {
					root.render(<Harness {...nextProps} />);
				});
			},
		};
	}

	function baseProps(
		overrides: Partial<UseTaskSpotlightSearchControllerInput> = {},
	): UseTaskSpotlightSearchControllerInput {
		return {
			board: createBoard(),
			currentProjectId: "proj-a",
			currentProjectName: "Project A",
			canOpen: true,
			crossProjectWorkspaceId: "proj-a",
			crossProjectExcludeProjectIds: new Set<string>(),
			onOpenTaskInProject: vi.fn(),
			...overrides,
		};
	}

	it("defaults to direct mode and starts closed", () => {
		const { get } = renderController(baseProps());
		expect(get().mode).toBe("direct");
		expect(get().isOpen).toBe(false);
	});

	it("does not open when canOpen is false", () => {
		const { get } = renderController(baseProps({ canOpen: false }));
		act(() => get().open());
		expect(get().isOpen).toBe(false);
	});

	it("includes the Done stage by default and excludes it once toggled off", () => {
		const { get } = renderController(baseProps());
		act(() => get().open());
		act(() => get().setQuery("task"));

		// 默认覆盖所有 stage（含 Done/trash），首屏即包含 Done 任务。
		const defaultIds = get().results.map((result) => result.document.taskId);
		expect(defaultIds).toContain("task-alpha");
		expect(defaultIds).toContain("task-review");
		expect(defaultIds).toContain("task-done");

		// 用户主动勾掉 Done stage 后，该 stage 的结果被移除。
		act(() => get().toggleStage("trash"));
		expect(get().results.map((result) => result.document.taskId)).not.toContain("task-done");
	});

	it("opens the selected result via onOpenTaskInProject, then closes and clears the query", () => {
		const onOpenTaskInProject = vi.fn();
		const { get } = renderController(baseProps({ onOpenTaskInProject }));
		act(() => get().open());
		act(() => get().setQuery("alpha"));
		expect(get().results).toHaveLength(1);

		act(() => get().openResultAt(0));

		expect(onOpenTaskInProject).toHaveBeenCalledWith("proj-a", "task-alpha");
		expect(get().isOpen).toBe(false);
		expect(get().query).toBe("");
	});

	it("cycles the active index with wraparound", () => {
		const { get } = renderController(baseProps());
		act(() => get().open());
		// 勾掉 Done/trash，把 "shared" 结果固定为确定的 3 条，独立于默认 stage 选择来验证索引环绕。
		act(() => get().toggleStage("trash"));
		act(() => get().setQuery("shared"));
		expect(get().results.length).toBe(3);
		expect(get().activeIndex).toBe(0);

		act(() => get().moveActive(1));
		expect(get().activeIndex).toBe(1);

		act(() => get().moveActive(-2));
		expect(get().activeIndex).toBe(2);

		act(() => get().moveActive(1));
		expect(get().activeIndex).toBe(0);
	});

	it("only includes other-project results when the switch is on", () => {
		crossProjectIndexMock.documents = buildTaskBoardSearchDocuments(createOtherProjectBoard(), {
			projectId: "proj-b",
			projectName: "Project B",
		});
		const { get } = renderController(baseProps());
		act(() => get().open());
		act(() => get().setQuery("shared"));

		expect(get().results.every((result) => result.document.projectId === "proj-a")).toBe(true);

		act(() => get().setIncludeOtherProjects(true));
		expect(get().results.some((result) => result.document.taskId === "task-remote")).toBe(true);
	});

	function createTaskIdShapedBoard(): BoardData {
		return {
			columns: [
				// title / prompt 都不含 "a3f21"：这条只能靠 task id 通道被捞出来。
				{ id: "backlog", title: "Backlog", cards: [card("a3f21", "Alpha rollout", "prepare deployment")] },
				{ id: "in_progress", title: "In Progress", cards: [card("94c87", "Beta cleanup", "refine rendering")] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
	}

	function createOtherProjectTaskIdShapedBoard(): BoardData {
		return {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [card("a3f21", "Remote same id", "other repo")] },
				{ id: "in_progress", title: "In Progress", cards: [] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "validation", title: "Validation", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
	}

	it("puts the current project first when two projects share the matched task id", () => {
		// 这条契约的真正来源是 controller 的 documents 拼接顺序（当前项目在前），纯函数测试证明不了。
		crossProjectIndexMock.documents = buildTaskBoardSearchDocuments(createOtherProjectTaskIdShapedBoard(), {
			projectId: "proj-b",
			projectName: "Project B",
		});
		const { get } = renderController(baseProps({ board: createTaskIdShapedBoard() }));
		act(() => get().open());
		act(() => get().setIncludeOtherProjects(true));
		act(() => get().setQuery("a3f21"));

		expect(get().results.map((result) => result.document.projectId)).toEqual(["proj-a", "proj-b"]);
	});

	it("still applies the stage filter to a task-id match and reports how many it hid", () => {
		const { get } = renderController(baseProps({ board: createTaskIdShapedBoard() }));
		act(() => get().open());
		act(() => get().setQuery("a3f21"));
		expect(get().results.map((result) => result.document.taskId)).toEqual(["a3f21"]);
		expect(get().taskIdMatchedResultCountHiddenByStageSelection).toBe(0);

		// stage chips 是用户显式设定的 scope，ID 命中不豁免——但要能说出「被挡住了」而非「不存在」。
		act(() => get().toggleStage("backlog"));

		expect(get().results).toHaveLength(0);
		expect(get().taskIdMatchedResultCountHiddenByStageSelection).toBe(1);
	});

	it("selects the task-id match by default and still allows moving off it", () => {
		const onOpenTaskInProject = vi.fn();
		const { get } = renderController(baseProps({ board: createTaskIdShapedBoard(), onOpenTaskInProject }));
		act(() => get().open());
		act(() => get().setQuery("a3f21"));
		expect(get().activeIndex).toBe(0);

		act(() => get().openActiveResult());
		expect(onOpenTaskInProject).toHaveBeenCalledWith("proj-a", "a3f21");
	});

	it("keeps arrow navigation working past a hoisted task-id match", () => {
		// 引用抖动会让 useEffect([results]) 每次 render 都把 activeIndex 钉回 0，这条用来抓住那种回归。
		const board = createTaskIdShapedBoard();
		board.columns[1]?.cards.push(card("c1234", "Alpha follow-up", "mentions a3f21 in the prompt"));
		const { get } = renderController(baseProps({ board }));
		act(() => get().open());
		act(() => get().setQuery("a3f21"));
		expect(get().results.map((result) => result.document.taskId)).toEqual(["a3f21", "c1234"]);

		act(() => get().moveActive(1));
		expect(get().activeIndex).toBe(1);
	});

	it("closes automatically when the current project changes", () => {
		const { get, rerender } = renderController(baseProps());
		act(() => get().open());
		expect(get().isOpen).toBe(true);

		rerender(baseProps({ currentProjectId: "proj-c" }));
		expect(get().isOpen).toBe(false);
	});
});
