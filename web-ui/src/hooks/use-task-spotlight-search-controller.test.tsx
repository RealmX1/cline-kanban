import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type TaskSpotlightSearchController,
	type UseTaskSpotlightSearchControllerInput,
	useTaskSpotlightSearchController,
} from "@/hooks/use-task-spotlight-search-controller";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { buildTaskBoardSearchDocuments, type TaskBoardSearchDocument } from "@/search/task-board-search";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

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
	};
}

/** 一条「agent 正在跑」的会话摘要；`activityText` 是推流每 tick 都在变的那一段。 */
function runningSessionSummary(taskId: string, activityText: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: {
			activityText,
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: null,
			notificationType: null,
			source: "cline-sdk",
		},
	} as unknown as RuntimeTaskSessionSummary;
}

/** 一条带「对话上次推进」时刻的会话摘要。 */
function sessionSummaryWithAgentConversationProgress(taskId: string, observedAtMs: number): RuntimeTaskSessionSummary {
	return {
		...runningSessionSummary(taskId, "Agent: working"),
		lastConversationProgressObservation: { observedAtMs, evidenceKind: "agent_lifecycle_hook_event" },
	} as unknown as RuntimeTaskSessionSummary;
}

/** 一条已 park 的会话摘要：facet 上就是个普通 running 三元组，只有 sidecar 能把 park 认出来。 */
function parkedSessionSummary(taskId: string, label: string | null): RuntimeTaskSessionSummary {
	return {
		...runningSessionSummary(taskId, "Agent: still working"),
		awaitingDispatchedBackgroundWork: label ? { label } : {},
	} as unknown as RuntimeTaskSessionSummary;
}

describe("useTaskSpotlightSearchController", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		// 排序档与字段开关都持久化在 localStorage；同文件的用例会互相串味，必须逐例清干净。
		window.localStorage.clear();
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
			currentProjectDefaultAgentId: null,
			taskSessionSummariesByTaskId: {},
			canOpen: true,
			crossProjectWorkspaceId: "proj-a",
			crossProjectExcludeProjectIds: new Set<string>(),
			onOpenTaskInProject: vi.fn(),
			...overrides,
		};
	}

	/** 把 stage 维度设成「只要这几个 stage」。空集 = 不按 stage 收窄（见 task-filter-selection 的统一约定）。 */
	function selectOnlyStages(get: () => TaskSpotlightSearchController, columnIds: readonly BoardColumnId[]): void {
		act(() =>
			get().setFilterSelection({
				...get().filterSelection,
				selectedStageColumnIds: new Set<BoardColumnId>(columnIds),
			}),
		);
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

	it("includes every stage by default and narrows once the stage dimension is used", () => {
		const { get } = renderController(baseProps());
		act(() => get().open());
		act(() => get().setQuery("task"));

		// stage 维度默认是空集 = 不设约束，首屏即包含 Done/trash 里的任务。
		const defaultIds = get().results.map((result) => result.document.taskId);
		expect(defaultIds).toContain("task-alpha");
		expect(defaultIds).toContain("task-review");
		expect(defaultIds).toContain("task-done");

		selectOnlyStages(get, ["backlog", "review"]);
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
		// 排除 Done/trash，把 "shared" 结果固定为确定的 3 条，独立于默认 stage 选择来验证索引环绕。
		selectOnlyStages(get, ["backlog", "in_progress", "review", "validation"]);
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
		expect(get().taskIdMatchedResultCountHiddenByFilters).toBe(0);

		// 过滤是用户显式设定的 scope，ID 命中不豁免——但要能说出「被挡住了」而非「不存在」。
		selectOnlyStages(get, ["in_progress", "review", "validation", "trash"]);

		expect(get().results).toHaveLength(0);
		expect(get().taskIdMatchedResultCountHiddenByFilters).toBe(1);
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

	it("browses every task with an empty query, without preselecting a row", () => {
		// ⌘K 之后直接回车是既有的肌肉记忆；浏览态若预选第 0 行，那个手势会变成「随手打开某个任务」。
		const { get } = renderController(baseProps());
		act(() => get().open());

		expect(get().isBrowsingAllTasksWithoutQuery).toBe(true);
		expect(get().isSearchActive).toBe(false);
		expect(
			get()
				.results.map((result) => result.document.taskId)
				.sort(),
		).toEqual(["task-alpha", "task-beta", "task-done", "task-review"]);
		expect(get().activeIndex).toBe(-1);

		// 无选中态下按 ↓ 必须落到第 0 行；取模环绕会把它算成第 1 行、整个跳过首行。
		act(() => get().moveActive(1));
		expect(get().activeIndex).toBe(0);
	});

	it("falls back off relevance while browsing, and honours an explicit order on both sides", () => {
		const board = createBoard();
		// 只在 updatedAt 上拉开差距，createdAt 保持相同：这样两档排序的差异必然来自档位本身。
		const backlogCards = board.columns[0]?.cards ?? [];
		if (backlogCards[0]) {
			backlogCards[0].updatedAt = 100;
		}
		if (backlogCards[1]) {
			backlogCards[1].updatedAt = 900;
		}
		const { get } = renderController(baseProps({ board }));
		act(() => get().open());

		expect(get().sortOrder).toBe("relevance");
		expect(get().effectiveSortOrder).toBe("task_last_modified_at_desc");
		const browsedIds = get().results.map((result) => result.document.taskId);
		expect(browsedIds.indexOf("task-beta")).toBeLessThan(browsedIds.indexOf("task-alpha"));

		// 有查询串时同一档同样生效——排序层叠在各模式排序之后。
		act(() => get().setSortOrder("task_last_modified_at_desc"));
		act(() => get().setQuery("a"));
		const searchedIds = get().results.map((result) => result.document.taskId);
		expect(searchedIds.indexOf("task-beta")).toBeLessThan(searchedIds.indexOf("task-alpha"));
	});

	it("keeps a task-id match on top no matter which sort order is selected", () => {
		// 「粘贴一个完整 task id → 回车直达」不该因为换了排序档而失效：排序层刻意叠在 ID 置顶层之下。
		const board = createTaskIdShapedBoard();
		board.columns[1]?.cards.push(card("c1234", "Alpha follow-up", "mentions a3f21 in the prompt"));
		const [newerCard] = board.columns[1]?.cards.slice(-1) ?? [];
		if (newerCard) {
			newerCard.updatedAt = 9_000;
		}
		const { get } = renderController(baseProps({ board }));
		act(() => get().open());
		act(() => get().setSortOrder("task_last_modified_at_desc"));
		act(() => get().setQuery("a3f21"));

		expect(get().results[0]?.document.taskId).toBe("a3f21");
	});

	it("exposes the agents actually present as filter values and narrows by them", () => {
		const board = createBoard();
		const backlogCards = board.columns[0]?.cards ?? [];
		if (backlogCards[0]) {
			backlogCards[0].agentId = "claude";
		}
		if (backlogCards[1]) {
			backlogCards[1].agentId = "codex";
		}
		const { get } = renderController(baseProps({ board }));
		act(() => get().open());

		expect(
			get()
				.availableFilterValues.agents.map((agent) => agent.value)
				.sort(),
		).toEqual(["claude", "codex"]);

		act(() => get().setFilterSelection({ ...get().filterSelection, selectedAgentIds: new Set(["claude" as const]) }));
		expect(get().results.map((result) => result.document.taskId)).toEqual(["task-alpha"]);
	});

	it("excludes other-project rows when filtering by session state, and says how many", () => {
		// 会话状态只经当前 workspace 的推流可得，跨项目行结构性判不了——不能谎称「没有匹配」。
		crossProjectIndexMock.documents = buildTaskBoardSearchDocuments(createOtherProjectBoard(), {
			projectId: "proj-b",
			projectName: "Project B",
		});
		const { get } = renderController(baseProps());
		act(() => get().open());
		act(() => get().setIncludeOtherProjects(true));
		act(() =>
			get().setFilterSelection({
				...get().filterSelection,
				selectedSessionActivityCategories: new Set(["no_live_session" as const]),
			}),
		);

		expect(get().results.every((result) => result.document.projectId === "proj-a")).toBe(true);
		expect(get().resultCountExcludedBecauseSessionActivityIsNotObservable).toBe(1);
	});

	it("keeps the user's selected row while session activity text churns", () => {
		// 结果集的成员与顺序分毫未动、只有会话文案在刷新时，绝不能动用户用 ↑↓ 选中的行——
		// 否则当前项目只要有 agent 在产出，搜索态回车打开的就是错误的任务。
		const { get, rerender } = renderController(
			baseProps({
				taskSessionSummariesByTaskId: { "task-alpha": runningSessionSummary("task-alpha", "Reading A") },
			}),
		);
		act(() => get().open());
		act(() => get().setQuery("shared"));
		const orderBefore = get().results.map((result) => result.document.taskId);
		expect(orderBefore.length).toBeGreaterThanOrEqual(2);

		act(() => get().moveActive(1));
		expect(get().activeIndex).toBe(1);

		rerender(
			baseProps({
				taskSessionSummariesByTaskId: { "task-alpha": runningSessionSummary("task-alpha", "Reading B") },
			}),
		);
		expect(get().results.map((result) => result.document.taskId)).toEqual(orderBefore);
		expect(get().activeIndex).toBe(1);
	});

	it("keeps the browsed selection while session activity text churns, and still collapses on a real change", () => {
		const { get, rerender } = renderController(
			baseProps({
				taskSessionSummariesByTaskId: { "task-alpha": runningSessionSummary("task-alpha", "Reading A") },
			}),
		);
		act(() => get().open());
		act(() => get().moveActive(1));
		expect(get().activeIndex).toBe(0);

		rerender(
			baseProps({
				taskSessionSummariesByTaskId: { "task-alpha": runningSessionSummary("task-alpha", "Reading B") },
			}),
		);
		expect(get().activeIndex).toBe(0);

		// 反向护栏：结果集**真的**变了（board 多了一张卡）时，浏览态仍必须收敛回「无选中」。
		const boardWithNewCard = createBoard();
		boardWithNewCard.columns[1]?.cards.push(card("task-new", "New task", "brand new"));
		rerender(
			baseProps({
				board: boardWithNewCard,
				taskSessionSummariesByTaskId: { "task-alpha": runningSessionSummary("task-alpha", "Reading B") },
			}),
		);
		expect(get().activeIndex).toBe(-1);
	});

	it("says Parked on the same row that the Parked filter category selects", () => {
		// 两个值来自同一条 summary：按 Parked 筛出来的行绝不能写着「Thinking...」，反之亦然。
		const { get } = renderController(
			baseProps({
				taskSessionSummariesByTaskId: { "task-alpha": parkedSessionSummary("task-alpha", "reviewer run") },
			}),
		);
		act(() => get().open());

		const parkedDocument = get().results.find((result) => result.document.taskId === "task-alpha")?.document;
		expect(parkedDocument).toBeTruthy();
		if (!parkedDocument) {
			return;
		}
		expect(get().resolveResultRowDisplayContext(parkedDocument).sessionActivity?.text).toContain("Parked");

		act(() =>
			get().setFilterSelection({
				...get().filterSelection,
				selectedSessionActivityCategories: new Set(["parked_awaiting_dispatched_background_work" as const]),
			}),
		);
		expect(get().results.map((result) => result.document.taskId)).toEqual(["task-alpha"]);
	});

	it("ranks other-project rows by their projected agent activity and shows it on the row", () => {
		// 跨项目行的推进时刻来自索引快照（文档字段），当前项目的来自会话推流——两路比较的是同一个量，
		// 跨项目行不再在 Agent activity 档与 direct 的 relevance 档里一律垫底。
		const [remoteDocument] = buildTaskBoardSearchDocuments(createOtherProjectBoard(), {
			projectId: "proj-b",
			projectName: "Project B",
		});
		if (!remoteDocument) {
			throw new Error("missing remote document");
		}
		crossProjectIndexMock.documents = [{ ...remoteDocument, crossProjectAgentConversationProgressAtEpochMs: 900 }];
		const { get } = renderController(
			baseProps({
				taskSessionSummariesByTaskId: {
					"task-alpha": sessionSummaryWithAgentConversationProgress("task-alpha", 100),
				},
			}),
		);
		act(() => get().open());
		act(() => get().setIncludeOtherProjects(true));
		act(() => get().setQuery("shared"));

		expect(
			get()
				.results.slice(0, 2)
				.map((result) => result.document.taskId),
		).toEqual(["task-remote", "task-alpha"]);
		const remoteResult = get().results[0];
		expect(
			remoteResult && get().resolveResultRowDisplayContext(remoteResult.document).agentConversationProgressAtEpochMs,
		).toBe(900);

		act(() => get().setSortOrder("agent_conversation_progress_desc"));
		expect(
			get()
				.results.slice(0, 2)
				.map((result) => result.document.taskId),
		).toEqual(["task-remote", "task-alpha"]);
	});

	it("keeps the selected task selected when live agent activity reorders the same results", () => {
		// direct 的 relevance 档按推进时刻排：某个 agent 一推进，它那行就挪位。成员没变、用户也没改任何排序输入时，
		// 选中行必须跟着同一个任务走——钉回第 0 行会让回车打开别的任务。
		const { get, rerender } = renderController(
			baseProps({
				taskSessionSummariesByTaskId: {
					"task-alpha": sessionSummaryWithAgentConversationProgress("task-alpha", 300),
					"task-beta": sessionSummaryWithAgentConversationProgress("task-beta", 200),
					"task-review": sessionSummaryWithAgentConversationProgress("task-review", 100),
				},
			}),
		);
		act(() => get().open());
		act(() => get().setQuery("shared"));
		expect(
			get()
				.results.slice(0, 3)
				.map((result) => result.document.taskId),
		).toEqual(["task-alpha", "task-beta", "task-review"]);

		act(() => get().moveActive(1));
		expect(get().results[get().activeIndex]?.document.taskId).toBe("task-beta");

		// task-review 推进到最前：beta 被挤到第 2 行。钉回第 0 行会选中 review，这里必须仍是 beta。
		rerender(
			baseProps({
				taskSessionSummariesByTaskId: {
					"task-alpha": sessionSummaryWithAgentConversationProgress("task-alpha", 300),
					"task-beta": sessionSummaryWithAgentConversationProgress("task-beta", 200),
					"task-review": sessionSummaryWithAgentConversationProgress("task-review", 400),
				},
			}),
		);
		expect(
			get()
				.results.slice(0, 3)
				.map((result) => result.document.taskId),
		).toEqual(["task-review", "task-alpha", "task-beta"]);
		expect(get().activeIndex).toBe(2);
		expect(get().results[get().activeIndex]?.document.taskId).toBe("task-beta");

		// 反向护栏：用户自己改了查询串时，仍回到第 0 行（最佳命中）。
		act(() => get().moveActive(1));
		act(() => get().setQuery("shared a"));
		expect(get().activeIndex).toBe(0);
	});

	it("narrows matching to the selected text field scope", () => {
		const { get } = renderController(baseProps());
		act(() => get().open());
		expect(get().matchedTextFieldScope).toBe("title_and_prompt");
		act(() => get().setQuery("shared"));
		expect(
			get()
				.results.map((result) => result.document.taskId)
				.sort(),
		).toEqual(["task-alpha", "task-beta", "task-done", "task-review"].sort());

		act(() => get().setMatchedTextFieldScope("title_only"));
		expect(get().results.map((result) => result.document.taskId)).toEqual(["task-beta"]);

		act(() => get().setMatchedTextFieldScope("prompt_only"));
		expect(
			get()
				.results.map((result) => result.document.taskId)
				.sort(),
		).toEqual(["task-alpha", "task-done", "task-review"].sort());
	});

	it("closes automatically when the current project changes", () => {
		const { get, rerender } = renderController(baseProps());
		act(() => get().open());
		expect(get().isOpen).toBe(true);

		rerender(baseProps({ currentProjectId: "proj-c" }));
		expect(get().isOpen).toBe(false);
	});
});
