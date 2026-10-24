import {
	assignCrossProjectTaskSwitcherSections,
	buildCrossProjectTaskSwitcherEntryKey,
	CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
	CROSS_PROJECT_TASK_SWITCHER_REMAINING_SECTION_ORDERING_MODES,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherRecentTaskStageFilter,
	type CrossProjectTaskSwitcherRemainingSectionOrderingMode,
	type CrossProjectTaskSwitcherSections,
	isTaskCardWithinCrossProjectTaskSwitcherActivityScope,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon } from "@/runtime/cross-project-recently-active-task-switcher-query";
import type {
	RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse,
	RuntimeNotificationFeedEntry,
	RuntimeProjectSummary,
} from "@/runtime/types";
import type { CrossProjectTaskSwitcherFocusViewSectionVisibility } from "@/state/cross-project-task-switcher-focus-view-visible-task-rows";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import { useBooleanLocalStorageValue, useInterval, useRawLocalStorageValue } from "@/utils/react-use";

// 区归属随时间漂移（Running 的 5 分钟窗、缓存倒计时到期），广播不会为此专门推送，故本地 tick 重算。
// 30 秒与卡片头部的 tick 同口径；倒计时显示到分钟，30 秒足够。
// 「显示更早」开启期间同一 tick 也重新拉取快照：广播取景范围外的旧任务状态变化（阶段变化 / 删除）只能靠它收敛。
const CROSS_PROJECT_TASK_SWITCHER_SECTION_REASSIGNMENT_TICK_MS = 30_000;

export type CrossProjectTaskSwitcherExtendedActivityHorizonLoadState =
	| "not_requested"
	| "loading"
	| "loaded"
	| "failed";

export interface CrossProjectRecentlyActiveTaskSwitcherSectionsModel
	extends CrossProjectTaskSwitcherFocusViewSectionVisibility {
	sections: CrossProjectTaskSwitcherSections;
	nowMs: number;
	unreadHandoffEntryKeys: ReadonlySet<string>;
	remainingSectionOrderingMode: CrossProjectTaskSwitcherRemainingSectionOrderingMode;
	setRemainingSectionOrderingMode: (mode: CrossProjectTaskSwitcherRemainingSectionOrderingMode) => void;
	setIsPinnedSectionCollapsed: (collapsed: boolean) => void;
	setShowsAllPinnedEntries: (showsAll: boolean) => void;
	beginRecentSectionKeyboardNavigationOrderLock: () => void;
	endRecentSectionKeyboardNavigationOrderLock: () => void;
	isRunningSectionExpanded: boolean;
	setIsRunningSectionExpanded: (expanded: boolean) => void;
	isRecentSectionExpanded: boolean;
	setIsRecentSectionExpanded: (expanded: boolean) => void;
	isPromptCacheWarmSectionExpanded: boolean;
	setIsPromptCacheWarmSectionExpanded: (expanded: boolean) => void;
	selectedRecentTaskStageFilters: readonly CrossProjectTaskSwitcherRecentTaskStageFilter[];
	setSelectedRecentTaskStageFilters: (filters: readonly CrossProjectTaskSwitcherRecentTaskStageFilter[]) => void;
	selectedRecentProjectWorkspaceIds: readonly string[];
	setSelectedRecentProjectWorkspaceIds: (workspaceIds: readonly string[]) => void;
	recentProjectFilterOptions: readonly { workspaceId: string; projectName: string; projectPath: string }[];
	extendedActivityHorizonLoadState: CrossProjectTaskSwitcherExtendedActivityHorizonLoadState;
	requestEntriesWithinExtendedActivityHorizon: () => void;
}

interface RecentSectionKeyboardNavigationOrderLock {
	configurationKey: string;
	entryKeysInDisplayOrder: readonly string[];
}

function normalizeRemainingSectionOrderingMode(
	value: string,
): CrossProjectTaskSwitcherRemainingSectionOrderingMode | null {
	return CROSS_PROJECT_TASK_SWITCHER_REMAINING_SECTION_ORDERING_MODES.find((mode) => mode === value) ?? null;
}

// 未读交接 = 通知中心里该 (workspaceId, taskId) 还有 visitedAt 为空的条目（与铃铛同源）。
export function collectUnreadHandoffEntryKeysFromNotificationLog(
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>,
): Set<string> {
	const unreadHandoffEntryKeys = new Set<string>();
	for (const entries of Object.values(notificationLogByWorkspaceId)) {
		for (const entry of entries) {
			if (entry.visitedAt === null) {
				unreadHandoffEntryKeys.add(buildCrossProjectTaskSwitcherEntryKey(entry.workspaceId, entry.taskId));
			}
		}
	}
	return unreadHandoffEntryKeys;
}

// 广播条目（新鲜）优先；「显示更早」拉回的快照只补**广播取景范围之外**的旧任务。快照是拉取那一刻的状态，
// 它里面落在广播取景范围内、却不在广播里的条目说明已失效（取消置顶 / 已删除），不得按旧状态补回。
// 取景判据与服务端投影共用 core 的单一判据；broadcastActivityScopeEvaluatedAtMs 应不早于广播的计算时刻，
// 否则刚滑出 7 天窗、已不在广播里的任务会被误判为「范围内失效」而暂时消失。
// 不可用的项目（路径没了 / 不是 git 仓库）不进面板：点进去也打不开。
export function collectCrossProjectTaskSwitcherEntriesInProjects(
	projects: readonly RuntimeProjectSummary[],
	entriesWithinExtendedActivityHorizon: RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse | null,
	broadcastActivityScopeEvaluatedAtMs: number,
): CrossProjectTaskSwitcherEntryInProject[] {
	const broadcastActivityHorizonStartAt =
		broadcastActivityScopeEvaluatedAtMs - CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS;
	const entriesInProjects: CrossProjectTaskSwitcherEntryInProject[] = [];
	const seenEntryKeys = new Set<string>();
	const availableProjectNameByWorkspaceId = new Map<string, string>();
	for (const project of projects) {
		if (project.availability.status === "unavailable") {
			continue;
		}
		availableProjectNameByWorkspaceId.set(project.id, project.name);
		for (const entry of project.crossProjectTaskSwitcherEntries) {
			seenEntryKeys.add(buildCrossProjectTaskSwitcherEntryKey(project.id, entry.taskId));
			entriesInProjects.push({ workspaceId: project.id, projectName: project.name, entry });
		}
	}
	for (const projectEntries of entriesWithinExtendedActivityHorizon?.projects ?? []) {
		const projectName = availableProjectNameByWorkspaceId.get(projectEntries.workspaceId);
		if (projectName === undefined) {
			continue;
		}
		for (const entry of projectEntries.crossProjectTaskSwitcherEntries) {
			const entryKey = buildCrossProjectTaskSwitcherEntryKey(projectEntries.workspaceId, entry.taskId);
			if (seenEntryKeys.has(entryKey)) {
				continue;
			}
			if (isTaskCardWithinCrossProjectTaskSwitcherActivityScope(entry, broadcastActivityHorizonStartAt)) {
				continue;
			}
			seenEntryKeys.add(entryKey);
			entriesInProjects.push({ workspaceId: projectEntries.workspaceId, projectName, entry });
		}
	}
	return entriesInProjects;
}

export function useCrossProjectRecentlyActiveTaskSwitcherSections({
	isTaskSwitcherSectionModelActive = true,
	projects,
	notificationLogByWorkspaceId,
	currentProjectId,
}: {
	isTaskSwitcherSectionModelActive?: boolean;
	allProjectsTaskSwitcherView?: "kanban_board" | "task_focus" | "outside_all_projects";
	projects: readonly RuntimeProjectSummary[];
	notificationLogByWorkspaceId: Record<string, RuntimeNotificationFeedEntry[]>;
	currentProjectId: string | null;
}): CrossProjectRecentlyActiveTaskSwitcherSectionsModel {
	const [nowMs, setNowMs] = useState(() => Date.now());
	// 模型常驻 App，跨视图、任务切换与过渡壳重挂载保留；页面刷新恢复展开与 In progress / Review。
	const [isRecentSectionExpanded, setIsRecentSectionExpanded] = useState(true);
	const [isPromptCacheWarmSectionExpanded, setIsPromptCacheWarmSectionExpanded] = useState(true);
	const [isPinnedSectionCollapsed, setIsPinnedSectionCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed,
		false,
	);
	const [showsAllPinnedEntries, setShowsAllPinnedEntriesState] = useState(
		() => readCrossProjectTaskSwitcherPanelViewContinuity().showsAllPinnedEntries,
	);
	const setShowsAllPinnedEntries = useCallback((showsAll: boolean) => {
		writeCrossProjectTaskSwitcherPanelViewContinuity({ showsAllPinnedEntries: showsAll });
		setShowsAllPinnedEntriesState(showsAll);
	}, []);
	const [recentSectionKeyboardNavigationOrderLock, setRecentSectionKeyboardNavigationOrderLock] =
		useState<RecentSectionKeyboardNavigationOrderLock | null>(null);
	const [selectedRecentTaskStageFilters, setSelectedRecentTaskStageFilters] = useState<
		readonly CrossProjectTaskSwitcherRecentTaskStageFilter[]
	>(["in_progress_and_review"]);
	const [selectedRecentProjectWorkspaceIds, setSelectedRecentProjectWorkspaceIds] = useState<readonly string[]>([]);
	const recentProjectFilterOptions = useMemo(
		() =>
			projects
				.filter((project) => project.availability.status !== "unavailable")
				.map((project) => ({ workspaceId: project.id, projectName: project.name, projectPath: project.path }))
				.sort(
					(left, right) =>
						left.projectName.localeCompare(right.projectName) ||
						left.workspaceId.localeCompare(right.workspaceId),
				),
		[projects],
	);

	const [remainingSectionOrderingMode, setRemainingSectionOrderingMode] =
		useRawLocalStorageValue<CrossProjectTaskSwitcherRemainingSectionOrderingMode>(
			LocalStorageKey.CrossProjectTaskSwitcherRemainingSectionOrderingMode,
			"most_recently_touched_by_conversation_progress_or_user_open_or_description_edit",
			normalizeRemainingSectionOrderingMode,
		);
	const [isRunningSectionExpanded, setIsRunningSectionExpanded] = useBooleanLocalStorageValue(
		LocalStorageKey.CrossProjectTaskSwitcherRunningSectionExpanded,
		false,
	);

	// 「显示更早」不落 localStorage（刷新页面回到默认 7 天窗），但跨重挂载保留：跨项目打开途中面板会在
	// Focus View 左栏与过渡外壳之间重挂载，见 cross-project-task-switcher-panel-view-continuity-store。
	const [entriesWithinExtendedActivityHorizon, setEntriesWithinExtendedActivityHorizonState] =
		useState<RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse | null>(
			() => readCrossProjectTaskSwitcherPanelViewContinuity().entriesWithinExtendedActivityHorizon,
		);
	const entriesWithinExtendedActivityHorizonRef = useRef(entriesWithinExtendedActivityHorizon);
	entriesWithinExtendedActivityHorizonRef.current = entriesWithinExtendedActivityHorizon;
	const setEntriesWithinExtendedActivityHorizon = useCallback(
		(response: RuntimeCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizonResponse) => {
			writeCrossProjectTaskSwitcherPanelViewContinuity({ entriesWithinExtendedActivityHorizon: response });
			setEntriesWithinExtendedActivityHorizonState(response);
		},
		[],
	);
	const [extendedActivityHorizonLoadState, setExtendedActivityHorizonLoadState] =
		useState<CrossProjectTaskSwitcherExtendedActivityHorizonLoadState>(() =>
			readCrossProjectTaskSwitcherPanelViewContinuity().entriesWithinExtendedActivityHorizon === null
				? "not_requested"
				: "loaded",
		);
	// 定期刷新可能与上一次请求重叠：只采纳最后发出的那次的结果，防止慢的旧响应覆盖新快照。
	const latestExtendedActivityHorizonFetchSequenceNumberRef = useRef(0);
	const fetchEntriesWithinExtendedActivityHorizon = useCallback(
		(fetchTrigger: "requested_by_user_show_older" | "periodic_refresh_while_extended") => {
			if (!isTaskSwitcherSectionModelActive) {
				return;
			}
			latestExtendedActivityHorizonFetchSequenceNumberRef.current += 1;
			const fetchSequenceNumber = latestExtendedActivityHorizonFetchSequenceNumberRef.current;
			if (fetchTrigger === "requested_by_user_show_older") {
				setExtendedActivityHorizonLoadState("loading");
			}
			void fetchCrossProjectTaskSwitcherEntriesWithinExtendedActivityHorizon(currentProjectId)
				.then((response) => {
					if (fetchSequenceNumber !== latestExtendedActivityHorizonFetchSequenceNumberRef.current) {
						return;
					}
					setEntriesWithinExtendedActivityHorizon(response);
					setExtendedActivityHorizonLoadState("loaded");
				})
				.catch(() => {
					if (fetchSequenceNumber !== latestExtendedActivityHorizonFetchSequenceNumberRef.current) {
						return;
					}
					// 定期刷新失败保留上一份快照、下个 tick 重试，不把已展开的面板打回「Retry」。
					if (fetchTrigger === "requested_by_user_show_older") {
						setExtendedActivityHorizonLoadState("failed");
					}
				});
		},
		[currentProjectId, isTaskSwitcherSectionModelActive, setEntriesWithinExtendedActivityHorizon],
	);
	const requestEntriesWithinExtendedActivityHorizon = useCallback(() => {
		fetchEntriesWithinExtendedActivityHorizon("requested_by_user_show_older");
	}, [fetchEntriesWithinExtendedActivityHorizon]);

	useEffect(() => {
		if (!isTaskSwitcherSectionModelActive) {
			return;
		}
		// 共享模型常驻 App：恢复活动时立即纠正时间，并刷新停用期间可能失效的旧任务快照。
		setNowMs(Date.now());
		setExtendedActivityHorizonLoadState((loadState) =>
			loadState === "loading"
				? entriesWithinExtendedActivityHorizonRef.current === null
					? "not_requested"
					: "loaded"
				: loadState,
		);
		if (entriesWithinExtendedActivityHorizonRef.current !== null) {
			fetchEntriesWithinExtendedActivityHorizon("periodic_refresh_while_extended");
		}
		return () => {
			// 停用、切项目或卸载都作废在途请求，迟到结果不能改模型或连续性记忆。
			latestExtendedActivityHorizonFetchSequenceNumberRef.current += 1;
		};
	}, [isTaskSwitcherSectionModelActive, fetchEntriesWithinExtendedActivityHorizon]);

	useInterval(
		() => {
			setNowMs(Date.now());
			if (entriesWithinExtendedActivityHorizon !== null) {
				fetchEntriesWithinExtendedActivityHorizon("periodic_refresh_while_extended");
			}
		},
		isTaskSwitcherSectionModelActive ? CROSS_PROJECT_TASK_SWITCHER_SECTION_REASSIGNMENT_TICK_MS : null,
	);

	const unreadHandoffEntryKeys = useMemo(
		() => collectUnreadHandoffEntryKeysFromNotificationLog(notificationLogByWorkspaceId),
		[notificationLogByWorkspaceId],
	);
	// 广播取景范围按合并这一刻判（而非 tick 的 nowMs）：tick 最多落后 30 秒，比它新的广播已把刚滑出 7 天窗的
	// 任务剔掉，按 tick 判会把它们误当「范围内失效」藏起来。广播与快照每次更新都会重算这里。
	const entriesInProjects = useMemo(
		() =>
			collectCrossProjectTaskSwitcherEntriesInProjects(projects, entriesWithinExtendedActivityHorizon, Date.now()),
		[projects, entriesWithinExtendedActivityHorizon],
	);
	const liveSections = useMemo(
		() =>
			assignCrossProjectTaskSwitcherSections({
				entriesInProjects,
				nowMs,
				remainingSectionOrderingMode,
				remainingSectionActivityHorizonMs:
					entriesWithinExtendedActivityHorizon?.activityHorizonMs ??
					CROSS_PROJECT_TASK_SWITCHER_DEFAULT_REMAINING_SECTION_ACTIVITY_HORIZON_MS,
				selectedRecentTaskStageFilters,
				selectedRecentProjectWorkspaceIds,
			}),
		[
			entriesInProjects,
			entriesWithinExtendedActivityHorizon,
			nowMs,
			remainingSectionOrderingMode,
			selectedRecentTaskStageFilters,
			selectedRecentProjectWorkspaceIds,
		],
	);
	const recentSectionOrderingConfigurationKey = JSON.stringify([
		remainingSectionOrderingMode,
		selectedRecentTaskStageFilters,
		selectedRecentProjectWorkspaceIds,
	]);
	const sections = useMemo(() => {
		if (recentSectionKeyboardNavigationOrderLock?.configurationKey !== recentSectionOrderingConfigurationKey) {
			return liveSections;
		}
		const rankByEntryKey = new Map(
			recentSectionKeyboardNavigationOrderLock.entryKeysInDisplayOrder.map((key, index) => [key, index]),
		);
		const rank = ({ workspaceId, entry }: CrossProjectTaskSwitcherEntryInProject) =>
			rankByEntryKey.get(buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId)) ?? rankByEntryKey.size;
		return {
			...liveSections,
			remainingSection: {
				...liveSections.remainingSection,
				entries: [...liveSections.remainingSection.entries].sort((left, right) => rank(left) - rank(right)),
			},
		};
	}, [liveSections, recentSectionKeyboardNavigationOrderLock, recentSectionOrderingConfigurationKey]);
	const latestSectionsRef = useRef(sections);
	latestSectionsRef.current = sections;
	const beginRecentSectionKeyboardNavigationOrderLock = useCallback(() => {
		setRecentSectionKeyboardNavigationOrderLock((previous) =>
			previous?.configurationKey === recentSectionOrderingConfigurationKey
				? previous
				: {
						configurationKey: recentSectionOrderingConfigurationKey,
						entryKeysInDisplayOrder: latestSectionsRef.current.remainingSection.entries.map(
							({ workspaceId, entry }) => buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId),
						),
					},
		);
	}, [recentSectionOrderingConfigurationKey]);
	const endRecentSectionKeyboardNavigationOrderLock = useCallback(() => {
		setRecentSectionKeyboardNavigationOrderLock(null);
	}, []);
	useLayoutEffect(() => {
		if (!recentSectionKeyboardNavigationOrderLock) return;
		if (recentSectionKeyboardNavigationOrderLock.configurationKey !== recentSectionOrderingConfigurationKey) {
			setRecentSectionKeyboardNavigationOrderLock(null);
			return;
		}
		// 新任务追加后也获得固定位置；删除、移组和不可用项目仍立即采用实时投影。
		const knownKeys = new Set(recentSectionKeyboardNavigationOrderLock.entryKeysInDisplayOrder);
		const additionalKeys = sections.remainingSection.entries
			.map(({ workspaceId, entry }) => buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId))
			.filter((key) => !knownKeys.has(key));
		if (additionalKeys.length > 0) {
			setRecentSectionKeyboardNavigationOrderLock({
				...recentSectionKeyboardNavigationOrderLock,
				entryKeysInDisplayOrder: [...knownKeys, ...additionalKeys],
			});
		}
	}, [recentSectionKeyboardNavigationOrderLock, recentSectionOrderingConfigurationKey, sections]);

	return {
		sections,
		nowMs,
		unreadHandoffEntryKeys,
		remainingSectionOrderingMode,
		setRemainingSectionOrderingMode,
		isPinnedSectionCollapsed,
		setIsPinnedSectionCollapsed,
		showsAllPinnedEntries,
		setShowsAllPinnedEntries,
		beginRecentSectionKeyboardNavigationOrderLock,
		endRecentSectionKeyboardNavigationOrderLock,
		isRunningSectionExpanded,
		setIsRunningSectionExpanded,
		isRecentSectionExpanded,
		setIsRecentSectionExpanded,
		isPromptCacheWarmSectionExpanded,
		setIsPromptCacheWarmSectionExpanded,
		selectedRecentTaskStageFilters,
		setSelectedRecentTaskStageFilters,
		selectedRecentProjectWorkspaceIds,
		setSelectedRecentProjectWorkspaceIds,
		recentProjectFilterOptions,
		extendedActivityHorizonLoadState,
		requestEntriesWithinExtendedActivityHorizon,
	};
}
