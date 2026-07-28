import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	EMPTY_RECENTLY_USED_PROJECT_SWITCH_HISTORY,
	normalizeRecentlyUsedProjectSwitchHistory,
	prunePermanentlyRemovedProjectsFromRecentlyUsedProjectSwitchHistory,
	RECENTLY_USED_PROJECT_SWITCH_HISTORY_RUNAWAY_GROWTH_SAFETY_VALVE_MAX_ENTRIES,
	type RecentlyUsedProjectSwitchHistory,
	recordProjectUsageInRecentlyUsedProjectSwitchHistory,
	selectRecentlyUsedProjectIdsMostRecentFirst,
	type UseRecentlyUsedProjectSwitchHistoryResult,
	useRecentlyUsedProjectSwitchHistory,
} from "@/hooks/use-recently-used-project-switch-history";
import { LocalStorageKey } from "@/storage/local-storage-store";

describe("normalizeRecentlyUsedProjectSwitchHistory", () => {
	it("rejects shapes that are valid JSON but not a projectId → timestamp record", () => {
		expect(normalizeRecentlyUsedProjectSwitchHistory([1, 2, 3])).toEqual({});
		expect(normalizeRecentlyUsedProjectSwitchHistory("project-a")).toEqual({});
		expect(normalizeRecentlyUsedProjectSwitchHistory(null)).toEqual({});
		expect(normalizeRecentlyUsedProjectSwitchHistory(42)).toEqual({});
	});

	it("drops entries whose timestamp is not a finite positive number", () => {
		expect(
			normalizeRecentlyUsedProjectSwitchHistory({
				"project-a": 1_000,
				"project-b": "yesterday",
				"project-c": -1,
				"project-d": 0,
				"project-e": Number.NaN,
				"project-f": Number.POSITIVE_INFINITY,
			}),
		).toEqual({ "project-a": 1_000 });
	});
});

/**
 * 目标实机 `~/.cline/kanban/workspaces/index.json` 实测已注册的项目数。
 *
 * 它是「上限必须容得下真实项目规模」这条回归的锚点：旧的 20 条上限会把这 23 个项目里最早访问的 3 个
 * 裁出历史，使它们在切换器的 Last visited 列显示成 "Never" 并沉到「从未访问」段末尾。
 */
const REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE = 23;

describe("recordProjectUsageInRecentlyUsedProjectSwitchHistory", () => {
	it("records a project that has never been visited", () => {
		const history = recordProjectUsageInRecentlyUsedProjectSwitchHistory(
			EMPTY_RECENTLY_USED_PROJECT_SWITCH_HISTORY,
			"project-a",
			1_000,
		);
		expect(history).toEqual({ "project-a": 1_000 });
	});

	// 同一引用 + 时间戳不刷新，两者都是刻意的（见 isAlreadyTheMostRecentlyUsedProject 的说明）：
	// 引用相等是写入 effect 终止循环的唯一判据；不刷新则是因为当前项目恒为最大时间戳、刷新改变不了任何排序，
	// 却会毁掉 `===` 不动点，并让「一仓库一标签页」下各标签页周期性用陈旧快照互相覆盖。
	it("returns the same reference and keeps the timestamp when the project is already the most recently used one", () => {
		const history: RecentlyUsedProjectSwitchHistory = { "project-a": 2_000, "project-b": 1_000 };
		const next = recordProjectUsageInRecentlyUsedProjectSwitchHistory(history, "project-a", 9_000);
		expect(next).toBe(history);
		expect(next["project-a"]).toBe(2_000);
	});

	it("keeps timestamps strictly increasing even when the system clock goes backwards", () => {
		const history: RecentlyUsedProjectSwitchHistory = { "project-a": 5_000 };
		const next = recordProjectUsageInRecentlyUsedProjectSwitchHistory(history, "project-b", 1_000);
		expect(next["project-b"]).toBe(5_001);
		expect(selectRecentlyUsedProjectIdsMostRecentFirst(next)).toEqual(["project-b", "project-a"]);
	});

	it("keeps every visited project addressable at the target instance's real project count", () => {
		let history: RecentlyUsedProjectSwitchHistory = EMPTY_RECENTLY_USED_PROJECT_SWITCH_HISTORY;
		for (let index = 0; index < REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE; index += 1) {
			history = recordProjectUsageInRecentlyUsedProjectSwitchHistory(history, `project-${index}`, 1_000 + index);
		}

		expect(Object.keys(history)).toHaveLength(REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE);
		// 逐个断言而非只看条数：切换器对每个项目单独查表（`lastVisitedEpochMsByProjectId[project.id] ?? null`），
		// 任何一个缺席都会让那一行显示 "Never" 并被排到「从未访问」段。
		for (let index = 0; index < REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE; index += 1) {
			expect(history[`project-${index}`]).toBeDefined();
		}
	});

	it("sizes the runaway-growth safety valve well above any plausible registered project count", () => {
		// 安全阀是「prune 跑不到时的兜底」，不是显示窗口：它必须留出远超真实项目规模的余量，
		// 否则一旦贴近项目数就会重新把访问过的项目裁成 "Never"。
		expect(RECENTLY_USED_PROJECT_SWITCH_HISTORY_RUNAWAY_GROWTH_SAFETY_VALVE_MAX_ENTRIES).toBeGreaterThan(
			REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE * 10,
		);
	});

	it("drops the oldest entries once the runaway-growth safety valve is exceeded", () => {
		let history: RecentlyUsedProjectSwitchHistory = EMPTY_RECENTLY_USED_PROJECT_SWITCH_HISTORY;
		for (
			let index = 0;
			index < RECENTLY_USED_PROJECT_SWITCH_HISTORY_RUNAWAY_GROWTH_SAFETY_VALVE_MAX_ENTRIES + 5;
			index += 1
		) {
			history = recordProjectUsageInRecentlyUsedProjectSwitchHistory(history, `project-${index}`, 1_000 + index);
		}
		expect(Object.keys(history)).toHaveLength(
			RECENTLY_USED_PROJECT_SWITCH_HISTORY_RUNAWAY_GROWTH_SAFETY_VALVE_MAX_ENTRIES,
		);
		expect(history["project-0"]).toBeUndefined();
		expect(history["project-4"]).toBeUndefined();
		expect(history["project-5"]).toBeDefined();
	});
});

describe("prunePermanentlyRemovedProjectsFromRecentlyUsedProjectSwitchHistory", () => {
	it("returns the same reference when every recorded project still exists", () => {
		const history: RecentlyUsedProjectSwitchHistory = { "project-a": 1_000, "project-b": 2_000 };
		expect(
			prunePermanentlyRemovedProjectsFromRecentlyUsedProjectSwitchHistory(
				history,
				new Set(["project-a", "project-b", "project-c"]),
			),
		).toBe(history);
	});

	it("removes projects that no longer exist", () => {
		const history: RecentlyUsedProjectSwitchHistory = { "project-a": 1_000, "project-b": 2_000 };
		expect(
			prunePermanentlyRemovedProjectsFromRecentlyUsedProjectSwitchHistory(history, new Set(["project-b"])),
		).toEqual({ "project-b": 2_000 });
	});
});

describe("selectRecentlyUsedProjectIdsMostRecentFirst", () => {
	it("orders most recent first and breaks ties deterministically by id", () => {
		expect(
			selectRecentlyUsedProjectIdsMostRecentFirst({
				"project-b": 2_000,
				"project-a": 3_000,
				"project-d": 1_000,
				"project-c": 1_000,
			}),
		).toEqual(["project-a", "project-b", "project-c", "project-d"]);
	});
});

function HookHarness({
	currentProjectId,
	knownProjectIds,
	canPruneMissingProjects,
	onResult,
}: {
	currentProjectId: string | null;
	// 刻意每次渲染都传新数组字面量：hook 内部把它 memo 成 Set，引用变化会让 effect 重跑，
	// 这正是「写入循环护栏」要挡住的情形。
	knownProjectIds: string[];
	canPruneMissingProjects: boolean;
	onResult: (result: UseRecentlyUsedProjectSwitchHistoryResult) => void;
}): null {
	const result = useRecentlyUsedProjectSwitchHistory({
		currentProjectId,
		knownProjectIds,
		canPruneMissingProjects,
	});
	onResult(result);
	return null;
}

/**
 * 写入次数探针 + 写入循环熔断器。
 *
 * 两处非显然之处：
 * 1. **必须 spy 在 `globalThis.localStorage` 这个实例上，不能 spy `Storage.prototype`**：Node 22+ 会给
 *    globalThis 塞一个缺方法的内建 localStorage，`vitest.setup.ts` 因此把它整个换成一个自建的
 *    对象字面量 mock（并非 `Storage` 实例）。spy 在 `Storage.prototype` 上一次也拦不到，断言会永远为真。
 * 2. **越界后让 setItem 抛错**：写入循环一旦复发就是「effect 永远收敛不到不动点」，纯计数 spy 会让
 *    `act()` 无限刷下去、把测试进程挂死（实测 vitest worker 满核空转，连测试超时都触发不了）。
 *    react-use 的 useLocalStorage 把 setItem 与 setState 放在同一 try 块里并静默吞掉异常
 *    （见 utils/react-use.ts 顶部注释），所以抛错会跳过 setState、就地断开循环，
 *    让断言拿到一个远超上限的写入次数并明确失败。
 */
const RECENTLY_USED_PROJECT_SWITCH_HISTORY_WRITE_LOOP_CIRCUIT_BREAKER_LIMIT = 20;

interface RecentlyUsedProjectSwitchHistoryWriteProbe {
	getWriteCount: () => number;
	resetWriteCount: () => void;
}

function spyOnRecentlyUsedProjectSwitchHistoryWritesWithWriteLoopCircuitBreaker(): RecentlyUsedProjectSwitchHistoryWriteProbe {
	let writeCount = 0;
	const originalSetItem = localStorage.setItem.bind(localStorage);
	vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
		if (key !== LocalStorageKey.RecentlyUsedProjectSwitchHistory) {
			originalSetItem(key, value);
			return;
		}
		writeCount += 1;
		if (writeCount > RECENTLY_USED_PROJECT_SWITCH_HISTORY_WRITE_LOOP_CIRCUIT_BREAKER_LIMIT) {
			throw new Error(
				`recency 历史写入次数超过熔断上限 ${RECENTLY_USED_PROJECT_SWITCH_HISTORY_WRITE_LOOP_CIRCUIT_BREAKER_LIMIT}：写入 effect 未收敛`,
			);
		}
		originalSetItem(key, value);
	});
	return {
		getWriteCount: () => writeCount,
		resetWriteCount: () => {
			writeCount = 0;
		},
	};
}

describe("useRecentlyUsedProjectSwitchHistory", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.restoreAllMocks();
		localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderHarness(props: {
		currentProjectId: string | null;
		knownProjectIds: string[];
		canPruneMissingProjects: boolean;
		onResult: (result: UseRecentlyUsedProjectSwitchHistoryResult) => void;
	}): Promise<void> {
		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId={props.currentProjectId}
					knownProjectIds={[...props.knownProjectIds]}
					canPruneMissingProjects={props.canPruneMissingProjects}
					onResult={props.onResult}
				/>,
			);
		});
	}

	it("records the activated project and puts the newest switch first", async () => {
		let latestResult: UseRecentlyUsedProjectSwitchHistoryResult | null = null;
		const onResult = (result: UseRecentlyUsedProjectSwitchHistoryResult) => {
			latestResult = result;
		};

		await renderHarness({
			currentProjectId: "project-a",
			knownProjectIds: ["project-a", "project-b"],
			canPruneMissingProjects: true,
			onResult,
		});
		await renderHarness({
			currentProjectId: "project-b",
			knownProjectIds: ["project-a", "project-b"],
			canPruneMissingProjects: true,
			onResult,
		});

		const result = latestResult as UseRecentlyUsedProjectSwitchHistoryResult | null;
		expect(result?.recentlyUsedProjectIdsMostRecentFirst).toEqual(["project-b", "project-a"]);
		expect(localStorage.getItem(LocalStorageKey.RecentlyUsedProjectSwitchHistory)).toContain("project-b");
	});

	it("never reports a visited project as never visited on a real-world-sized project set", async () => {
		let latestResult: UseRecentlyUsedProjectSwitchHistoryResult | null = null;
		const onResult = (result: UseRecentlyUsedProjectSwitchHistoryResult) => {
			latestResult = result;
		};

		const allProjectIds = Array.from(
			{ length: REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE },
			(_unused, index) => `project-${index}`,
		);
		// 走完整 hook（裁剪 + 记录同在一个 effect 里）而非只测纯函数：真实实机上两者共同决定
		// lastVisitedEpochMsByProjectId，回归必须覆盖它们的合成结果。
		for (const projectId of allProjectIds) {
			await renderHarness({
				currentProjectId: projectId,
				knownProjectIds: allProjectIds,
				canPruneMissingProjects: true,
				onResult,
			});
		}

		const result = latestResult as UseRecentlyUsedProjectSwitchHistoryResult | null;
		expect(result?.recentlyUsedProjectIdsMostRecentFirst).toHaveLength(
			REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE,
		);
		// 切换器的 "Never" 文案与「从未访问」段排序都只看这张表里有没有该项目的时间戳。
		for (const projectId of allProjectIds) {
			expect(result?.lastVisitedEpochMsByProjectId[projectId]).toBeDefined();
		}
		// 最近访问的项目仍排在最前，说明抬高上限没有动摇 recency 语义。
		expect(result?.recentlyUsedProjectIdsMostRecentFirst[0]).toBe(
			allProjectIds[REGISTERED_PROJECT_COUNT_ON_THE_TARGET_INSTANCE - 1],
		);
	});

	it("stops writing to localStorage while the current project stays the same", async () => {
		const onResult = () => {};
		await renderHarness({
			currentProjectId: "project-a",
			knownProjectIds: ["project-a"],
			canPruneMissingProjects: true,
			onResult,
		});

		const historyWrites = spyOnRecentlyUsedProjectSwitchHistoryWritesWithWriteLoopCircuitBreaker();
		for (let index = 0; index < 5; index += 1) {
			await renderHarness({
				currentProjectId: "project-a",
				knownProjectIds: ["project-a"],
				canPruneMissingProjects: true,
				onResult,
			});
		}

		expect(historyWrites.getWriteCount()).toBe(0);
	});

	it("stops writing to localStorage while the current project is missing from the known project list", async () => {
		let latestResult: UseRecentlyUsedProjectSwitchHistoryResult | null = null;
		const onResult = (result: UseRecentlyUsedProjectSwitchHistoryResult) => {
			latestResult = result;
		};

		const historyWrites = spyOnRecentlyUsedProjectSwitchHistoryWritesWithWriteLoopCircuitBreaker();
		// 刚新增的项目：currentProjectId 已切过去，但 projects 推送还没带上它。
		// 若 prune 允许删掉当前项目，紧随其后的 record 又会把它写回去并给一个更大的时间戳，
		// 两步互相拉锯——每轮都产出新引用 → 写 localStorage → normalizedHistory 变化 → effect 重跑，
		// 形成无限写盘 + 无限重渲染，永远收敛不到不动点。
		await renderHarness({
			currentProjectId: "project-just-added",
			knownProjectIds: ["project-a"],
			canPruneMissingProjects: true,
			onResult,
		});

		// 首帧写入次数必须有界（挂载期的初始化写 + 记录写各算一次），而不是随 effect 反复重入线性增长。
		expect(historyWrites.getWriteCount()).toBeLessThan(
			RECENTLY_USED_PROJECT_SWITCH_HISTORY_WRITE_LOOP_CIRCUIT_BREAKER_LIMIT,
		);

		historyWrites.resetWriteCount();
		for (let index = 0; index < 5; index += 1) {
			await renderHarness({
				currentProjectId: "project-just-added",
				knownProjectIds: ["project-a"],
				canPruneMissingProjects: true,
				onResult,
			});
		}

		expect(historyWrites.getWriteCount()).toBe(0);

		const result = latestResult as UseRecentlyUsedProjectSwitchHistoryResult | null;
		expect(result?.recentlyUsedProjectIdsMostRecentFirst).toEqual(["project-just-added"]);
	});

	it("keeps pruning the current project's stale peers once the project list catches up", async () => {
		let latestResult: UseRecentlyUsedProjectSwitchHistoryResult | null = null;
		const onResult = (result: UseRecentlyUsedProjectSwitchHistoryResult) => {
			latestResult = result;
		};

		await renderHarness({
			currentProjectId: "project-a",
			knownProjectIds: ["project-a", "project-b"],
			canPruneMissingProjects: true,
			onResult,
		});
		await renderHarness({
			currentProjectId: "project-b",
			knownProjectIds: ["project-a", "project-b"],
			canPruneMissingProjects: true,
			onResult,
		});
		// 当前项目豁免裁剪只针对当前项目本身：其余已删除项目仍必须被裁掉。
		await renderHarness({
			currentProjectId: "project-just-added",
			knownProjectIds: ["project-b"],
			canPruneMissingProjects: true,
			onResult,
		});

		const result = latestResult as UseRecentlyUsedProjectSwitchHistoryResult | null;
		expect(result?.recentlyUsedProjectIdsMostRecentFirst).toEqual(["project-just-added", "project-b"]);
	});

	it("does not prune while the project list is unavailable", async () => {
		let latestResult: UseRecentlyUsedProjectSwitchHistoryResult | null = null;
		const onResult = (result: UseRecentlyUsedProjectSwitchHistoryResult) => {
			latestResult = result;
		};

		await renderHarness({
			currentProjectId: "project-a",
			knownProjectIds: ["project-a"],
			canPruneMissingProjects: true,
			onResult,
		});
		// 断连：projects 推送为空，但历史必须原样保留。
		await renderHarness({
			currentProjectId: null,
			knownProjectIds: [],
			canPruneMissingProjects: false,
			onResult,
		});

		const result = latestResult as UseRecentlyUsedProjectSwitchHistoryResult | null;
		expect(result?.recentlyUsedProjectIdsMostRecentFirst).toEqual(["project-a"]);
	});

	it("prunes permanently deleted projects once the project list is known", async () => {
		let latestResult: UseRecentlyUsedProjectSwitchHistoryResult | null = null;
		const onResult = (result: UseRecentlyUsedProjectSwitchHistoryResult) => {
			latestResult = result;
		};

		await renderHarness({
			currentProjectId: "project-a",
			knownProjectIds: ["project-a", "project-b"],
			canPruneMissingProjects: true,
			onResult,
		});
		await renderHarness({
			currentProjectId: "project-b",
			knownProjectIds: ["project-a", "project-b"],
			canPruneMissingProjects: true,
			onResult,
		});
		await renderHarness({
			currentProjectId: "project-b",
			knownProjectIds: ["project-b"],
			canPruneMissingProjects: true,
			onResult,
		});

		const result = latestResult as UseRecentlyUsedProjectSwitchHistoryResult | null;
		expect(result?.recentlyUsedProjectIdsMostRecentFirst).toEqual(["project-b"]);
	});
});
