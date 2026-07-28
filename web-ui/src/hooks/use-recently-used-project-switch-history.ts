import { useEffect, useMemo } from "react";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { useJsonLocalStorageValue } from "@/utils/react-use";

/**
 * projectId → 该项目最近一次「成为当前项目」的 epoch ms。
 *
 * 这是全仓库唯一的项目 recency 来源：后端 `RuntimeProjectSummary` 不带任何时间戳，
 * `listWorkspaceIndexEntries` 也只按路径字母序返回，所以顺序必须由前端自己记。
 */
export type RecentlyUsedProjectSwitchHistory = Readonly<Record<string, number>>;

export const EMPTY_RECENTLY_USED_PROJECT_SWITCH_HISTORY: RecentlyUsedProjectSwitchHistory = {};

/**
 * 历史条目数的**失控增长安全阀**——它不是「最近使用窗口」，别再按可视区大小去调小它。
 *
 * 这里原先是 20，理由是「超出上限的项目早已滚出切换器可视区」。该前提已不成立：项目切换器表格渲染
 * **全部**已注册项目，并逐行显示 Last visited 列。被裁掉的项目在 `buildProjectSwitcherRows` 里
 * `lastVisitedEpochMs` 取到 null，于是渲染成 "Never" 并被推到「从未访问」段的末尾按名字排——
 * 明明访问过、却被展示成从未访问且沉底，是事实错误。而 20 这个值当场就会造假：本功能的目标实机
 * （`~/.cline/kanban/workspaces/index.json`）已注册 23 个项目，最早访问的 3 个必然被裁掉。
 *
 * 历史体积的真实边界是「当前已注册的项目数」，由
 * `prunePermanentlyRemovedProjectsFromRecentlyUsedProjectSwitchHistory` 按存在性裁剪来保证。
 * 本常量只兜底 prune 永远跑不到的退化情形（项目列表长期不可用因而 `canPruneMissingProjects` 恒为 false、
 * 手改或跨设备同步进来的陈旧存档），所以取一个远高于任何可信项目规模的值即可：每条只是
 * `"<workspaceId>":<epochMs>`，实机 23 条全量序列化仅 761 字节，500 条也不过约 16 KB，
 * 相对 localStorage 的 MB 级配额可以忽略。
 */
export const RECENTLY_USED_PROJECT_SWITCH_HISTORY_RUNAWAY_GROWTH_SAFETY_VALVE_MAX_ENTRIES = 500;

/**
 * localStorage 里可能躺着任意形状的 JSON（手改、旧版本、跨设备同步）。react-use 的 useLocalStorage
 * 只兜 JSON.parse 抛错，**合法 JSON 但形状错**（`[1,2,3]` / `{"a":"x"}` / `{"a":-1}`）会原样交出来，
 * 所以形状校验必须在这里做。
 */
export function normalizeRecentlyUsedProjectSwitchHistory(rawValue: unknown): RecentlyUsedProjectSwitchHistory {
	if (typeof rawValue !== "object" || rawValue === null || Array.isArray(rawValue)) {
		return EMPTY_RECENTLY_USED_PROJECT_SWITCH_HISTORY;
	}
	const normalized: Record<string, number> = {};
	for (const [projectId, timestamp] of Object.entries(rawValue)) {
		if (!projectId) {
			continue;
		}
		if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) {
			continue;
		}
		normalized[projectId] = timestamp;
	}
	return normalized;
}

/**
 * 命中即「本次记录无事可做」，调用方据此原样返回入参引用。
 *
 * **刻意不在这一支刷新时间戳**，别把它当成疏漏改掉。语义上 `lastVisitedEpochMs` 就是
 * 「该项目最近一次**成为**当前项目的时刻」（见类型定义），对正待着的项目显示「3h」回答的是
 * 「我在这个项目里待了多久」，比显示「刚刚」信息量更大；何况该行本就带着 `Current` 徽标，不存在误导。
 * 而刷新的代价是实打实的：
 * 1. 当前项目按构造恒为最大时间戳，刷新**不可能**改变任何一行的排序，收益纯属一个单元格的文案。
 * 2. 无条件刷新根本没有不动点——写入 effect 依赖 `normalizedHistory`，新时间戳 → 新对象 → 写盘 →
 *    依赖变化 → 再写，无限循环（本轮已实测复现过该故障形态）。要造出不动点只能加「陈旧超过 N 才刷新」的
 *    时间窗，等于把一条 `===` 精确不变量降级成「N 毫秒内收敛」的弱保证。
 * 3. `useJsonLocalStorageValue` 底下的 react-use `useLocalStorage` 不监听 `storage` 事件，
 *    每个标签页各持一份内存快照并整对象覆盖写回。现在只有真实切换项目才写，跨标签页丢更新是罕见且自愈的；
 *    一旦变成按时间窗心跳刷新，「一仓库一标签页」的实际用法下每个标签页都会周期性拿陈旧快照
 *    覆盖掉其它标签页刚记下的时间戳——用一个更严重的正确性问题去换一个文案问题。
 */
function isAlreadyTheMostRecentlyUsedProject(history: RecentlyUsedProjectSwitchHistory, projectId: string): boolean {
	const timestamp = history[projectId];
	if (timestamp === undefined) {
		return false;
	}
	return Object.entries(history).every(
		([otherProjectId, otherTimestamp]) => otherProjectId === projectId || otherTimestamp < timestamp,
	);
}

/**
 * 把 `projectId` 记为「最近使用」。
 *
 * 承重不变量：**无需改动时必须返回入参同一引用**。调用方（hook 的写入 effect）靠一次 `===` 比较
 * 终止写入循环；图省事总返回新对象会导致无限写 localStorage + 无限重渲染。
 *
 * 时间戳单调递增（`max(now, 现有最大值 + 1)`），以免系统时钟回拨或同毫秒连续切换把顺序打乱。
 */
export function recordProjectUsageInRecentlyUsedProjectSwitchHistory(
	history: RecentlyUsedProjectSwitchHistory,
	projectId: string,
	nowEpochMs: number,
): RecentlyUsedProjectSwitchHistory {
	if (!projectId) {
		return history;
	}
	if (isAlreadyTheMostRecentlyUsedProject(history, projectId)) {
		return history;
	}
	const timestamps = Object.values(history);
	const highestExistingTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : 0;
	const nextTimestamp = Math.max(nowEpochMs, highestExistingTimestamp + 1);
	const next: Record<string, number> = { ...history, [projectId]: nextTimestamp };

	const projectIdsOldestFirst = Object.keys(next).sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0));
	const overflowCount =
		projectIdsOldestFirst.length - RECENTLY_USED_PROJECT_SWITCH_HISTORY_RUNAWAY_GROWTH_SAFETY_VALVE_MAX_ENTRIES;
	for (let index = 0; index < overflowCount; index += 1) {
		const oldestProjectId = projectIdsOldestFirst[index];
		if (oldestProjectId !== undefined) {
			delete next[oldestProjectId];
		}
	}
	return next;
}

/** 裁掉已被永久删除的项目。同样遵守「无需改动时返回同一引用」。 */
export function prunePermanentlyRemovedProjectsFromRecentlyUsedProjectSwitchHistory(
	history: RecentlyUsedProjectSwitchHistory,
	existingProjectIds: ReadonlySet<string>,
): RecentlyUsedProjectSwitchHistory {
	const removableProjectIds = Object.keys(history).filter((projectId) => !existingProjectIds.has(projectId));
	if (removableProjectIds.length === 0) {
		return history;
	}
	const next: Record<string, number> = { ...history };
	for (const projectId of removableProjectIds) {
		delete next[projectId];
	}
	return next;
}

/** 最近使用在前。同一时间戳（理论上不该出现）按 id 字典序，保证渲染顺序确定。 */
export function selectRecentlyUsedProjectIdsMostRecentFirst(history: RecentlyUsedProjectSwitchHistory): string[] {
	return Object.keys(history).sort((a, b) => {
		const timestampDifference = (history[b] ?? 0) - (history[a] ?? 0);
		if (timestampDifference !== 0) {
			return timestampDifference;
		}
		return a.localeCompare(b);
	});
}

export interface UseRecentlyUsedProjectSwitchHistoryInput {
	/**
	 * 运行时**已激活**的项目（而非用户请求切换到的项目）。切换失败 / 项目不可用的「意图」不该污染顺序。
	 * 用它作为唯一触发源，天然覆盖全部切换入口：侧栏、跨仓概览、spotlight、通知路由、新增项目、
	 * `popstate` 回退、深链首帧的 pathname 解析、永久删除后回落。
	 */
	currentProjectId: string | null;
	knownProjectIds: readonly string[];
	/**
	 * 首帧与断连期 `projects` 为空，此时裁剪会把全部历史清空。只有确认拿到过项目列表才允许裁剪。
	 */
	canPruneMissingProjects: boolean;
}

export interface UseRecentlyUsedProjectSwitchHistoryResult {
	recentlyUsedProjectIdsMostRecentFirst: string[];
	lastVisitedEpochMsByProjectId: RecentlyUsedProjectSwitchHistory;
}

export function useRecentlyUsedProjectSwitchHistory({
	currentProjectId,
	knownProjectIds,
	canPruneMissingProjects,
}: UseRecentlyUsedProjectSwitchHistoryInput): UseRecentlyUsedProjectSwitchHistoryResult {
	const [storedHistory, setStoredHistory] = useJsonLocalStorageValue<RecentlyUsedProjectSwitchHistory>(
		LocalStorageKey.RecentlyUsedProjectSwitchHistory,
		EMPTY_RECENTLY_USED_PROJECT_SWITCH_HISTORY,
	);
	const normalizedHistory = useMemo(() => normalizeRecentlyUsedProjectSwitchHistory(storedHistory), [storedHistory]);
	const knownProjectIdSet = useMemo(() => new Set(knownProjectIds), [knownProjectIds]);

	// 裁剪的保留集 = 已知项目 ∪ 当前项目。当前项目必须无条件保留：紧随其后的 record 一定会把它写回去，
	// 若 prune 先把它删掉，两步就会互相拉锯——每轮都产出一个新引用 → 写盘 → normalizedHistory 变化 →
	// effect 依赖变化 → 再裁再记，永远收敛不到不动点，表现为无限写 localStorage + 无限重渲染。
	// 这条不变量不依赖「当前项目是否已出现在 projects 推送里」的上游时序论证，直接把整类风险关死。
	// 仅在当前项目确实缺席时才新建 Set，否则原样返回 knownProjectIdSet——保住引用稳定，避免 effect 空跑。
	const projectIdsRetainedByRecentlyUsedProjectSwitchHistoryPruning = useMemo<ReadonlySet<string>>(() => {
		if (!currentProjectId || knownProjectIdSet.has(currentProjectId)) {
			return knownProjectIdSet;
		}
		return new Set([...knownProjectIdSet, currentProjectId]);
	}, [currentProjectId, knownProjectIdSet]);

	// 裁剪与记录合并进单一 effect、单一写入点：`useJsonLocalStorageValue` 的函数式 setter 在同一渲染
	// 周期内连续调用会丢更新（见 utils/react-use.ts 顶部注释）。顺序必须「先裁后记」——刚新增的项目
	// 可能还没进 `projects` 推送，倒过来会把它当残留删掉。
	useEffect(() => {
		const prunedHistory = canPruneMissingProjects
			? prunePermanentlyRemovedProjectsFromRecentlyUsedProjectSwitchHistory(
					normalizedHistory,
					projectIdsRetainedByRecentlyUsedProjectSwitchHistoryPruning,
				)
			: normalizedHistory;
		const nextHistory = currentProjectId
			? recordProjectUsageInRecentlyUsedProjectSwitchHistory(prunedHistory, currentProjectId, Date.now())
			: prunedHistory;
		if (nextHistory === normalizedHistory) {
			return;
		}
		setStoredHistory(nextHistory);
	}, [
		canPruneMissingProjects,
		currentProjectId,
		normalizedHistory,
		projectIdsRetainedByRecentlyUsedProjectSwitchHistoryPruning,
		setStoredHistory,
	]);

	const recentlyUsedProjectIdsMostRecentFirst = useMemo(
		() => selectRecentlyUsedProjectIdsMostRecentFirst(normalizedHistory),
		[normalizedHistory],
	);

	return {
		recentlyUsedProjectIdsMostRecentFirst,
		lastVisitedEpochMsByProjectId: normalizedHistory,
	};
}
