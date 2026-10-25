import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	readDailyWorkProgressStatisticsUpdateSnapshot,
	subscribeToDailyWorkProgressStatisticsUpdates,
} from "@/runtime/daily-work-progress-statistics-invalidation-events";
import {
	claimDailyWorkProgressCelebrations,
	readDailyWorkProgressSummary,
} from "@/runtime/daily-work-progress-statistics-query";
import type {
	RuntimeDailyWorkProgressAchievement,
	RuntimeDailyWorkProgressRequest,
	RuntimeDailyWorkProgressSummary,
} from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem, writeLocalStorageItem } from "@/storage/local-storage-store";

// EXPERIMENT_NODE: 8 秒停留和 60 秒合并窗口是否足够看清成果，同时保持工作流连续。
const MILESTONE_AUTOMATIC_EXPANSION_DURATION_MS = 8_000;
const MILESTONE_CELEBRATION_COALESCING_WINDOW_MS = 60_000;
function readBrowserCalendarContext() {
	const date = new Date();
	return {
		dateKey: [
			date.getFullYear(),
			String(date.getMonth() + 1).padStart(2, "0"),
			String(date.getDate()).padStart(2, "0"),
		].join("-"),
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}
export function useDailyWorkProgressStatistics() {
	const updates = useSyncExternalStore(
		subscribeToDailyWorkProgressStatisticsUpdates,
		readDailyWorkProgressStatisticsUpdateSnapshot,
	);
	const [workspaceId, setWorkspaceId] = useState<string | null>(
		() => readLocalStorageItem(LocalStorageKey.DailyWorkProgressSelectedWorkspace) || null,
	);
	const [calendar, setCalendar] = useState(readBrowserCalendarContext);
	const [summary, setSummary] = useState<RuntimeDailyWorkProgressSummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expansionMode, setExpansionMode] = useState<"collapsed" | "manual" | "celebration">("collapsed");
	const [celebrations, setCelebrations] = useState<RuntimeDailyWorkProgressAchievement[]>([]);
	const [refreshGeneration, setRefreshGeneration] = useState(0);
	const baselineContextRef = useRef<string | null>(null);
	const baselineSuccessfullyReadRef = useRef(false);
	const previousAchievementIdsRef = useRef(new Set<string>());
	const pendingAchievementIdsRef = useRef(new Set<string>());
	const claimingAchievementIdsRef = useRef(new Set<string>());
	const celebrationContextGenerationRef = useRef(0);
	const manualExpansionChangeGenerationRef = useRef(0);
	const lastCelebrationAtRef = useRef(-Infinity);
	const requestGenerationRef = useRef(0);
	const isExpanded = expansionMode !== "collapsed";
	const refresh = useCallback(() => setRefreshGeneration((generation) => generation + 1), []);
	const selectWorkspace = useCallback((value: string | null) => {
		setWorkspaceId(value);
		writeLocalStorageItem(LocalStorageKey.DailyWorkProgressSelectedWorkspace, value ?? "");
		setCelebrations([]);
	}, []);
	useEffect(
		() => () => {
			celebrationContextGenerationRef.current += 1;
			baselineContextRef.current = null;
		},
		[],
	);
	useEffect(() => {
		const synchronizeCalendar = () => {
			const next = readBrowserCalendarContext();
			setCalendar((current) =>
				current.dateKey === next.dateKey && current.timeZone === next.timeZone ? current : next,
			);
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("focus", synchronizeCalendar);
		document.addEventListener("visibilitychange", synchronizeCalendar);
		const nextMidnight = new Date();
		nextMidnight.setHours(24, 0, 0, 100);
		const timer = window.setTimeout(synchronizeCalendar, nextMidnight.getTime() - Date.now());
		return () => {
			window.removeEventListener("focus", synchronizeCalendar);
			document.removeEventListener("visibilitychange", synchronizeCalendar);
			window.clearTimeout(timer);
		};
	}, [refresh, calendar.dateKey, calendar.timeZone]);
	useEffect(() => {
		if (expansionMode !== "celebration") return;
		const timer = window.setTimeout(() => setExpansionMode("collapsed"), MILESTONE_AUTOMATIC_EXPANSION_DURATION_MS);
		return () => window.clearTimeout(timer);
	}, [expansionMode]);
	useEffect(() => {
		const request: RuntimeDailyWorkProgressRequest = { workspaceId, ...calendar };
		const context = JSON.stringify([request, updates.quietGeneration]);
		const establishingBaseline = baselineContextRef.current !== context;
		if (establishingBaseline) {
			celebrationContextGenerationRef.current += 1;
			baselineContextRef.current = context;
			baselineSuccessfullyReadRef.current = false;
			previousAchievementIdsRef.current.clear();
			pendingAchievementIdsRef.current.clear();
			claimingAchievementIdsRef.current.clear();
			setCelebrations([]);
			setSummary(null);
		}
		const celebrationContextGeneration = celebrationContextGenerationRef.current;
		const generation = ++requestGenerationRef.current;
		let cancelled = false;
		void readDailyWorkProgressSummary(request)
			.then(async (next) => {
				if (cancelled || generation !== requestGenerationRef.current) return;
				setSummary(next);
				setError(null);
				if (workspaceId !== null && !next.projects.some((project) => project.workspaceId === workspaceId)) {
					selectWorkspace(null);
					return;
				}
				if (baselineSuccessfullyReadRef.current) {
					for (const id of next.celebrationEligibleAchievementIds)
						if (!previousAchievementIdsRef.current.has(id)) pendingAchievementIdsRef.current.add(id);
				}
				previousAchievementIdsRef.current = new Set(
					next.achievements.map((achievement) => achievement.achievementId),
				);
				baselineSuccessfullyReadRef.current = true;
				if (document.visibilityState !== "visible" || pendingAchievementIdsRef.current.size === 0) return;
				const ids = [...pendingAchievementIdsRef.current].filter(
					(id) => !claimingAchievementIdsRef.current.has(id),
				);
				if (!ids.length) return;
				for (const id of ids) claimingAchievementIdsRef.current.add(id);
				const manualExpansionChangeGeneration = manualExpansionChangeGenerationRef.current;
				try {
					const claimed = await claimDailyWorkProgressCelebrations({ ...request, achievementIds: ids });
					// 已提交的领取属于当前逻辑上下文，普通统计刷新不能撤销其反馈。
					if (celebrationContextGeneration !== celebrationContextGenerationRef.current) return;
					for (const id of ids) pendingAchievementIdsRef.current.delete(id);
					if (!claimed.achievements.length) return;
					const startsNewCelebrationWindow =
						Date.now() - lastCelebrationAtRef.current >= MILESTONE_CELEBRATION_COALESCING_WINDOW_MS;
					setCelebrations((previous) =>
						startsNewCelebrationWindow
							? claimed.achievements
							: [
									...new Map(
										[...previous, ...claimed.achievements].map((achievement) => [
											achievement.achievementId,
											achievement,
										]),
									).values(),
								],
					);
					if (startsNewCelebrationWindow) {
						lastCelebrationAtRef.current = Date.now();
						if (manualExpansionChangeGeneration === manualExpansionChangeGenerationRef.current)
							setExpansionMode((mode) => (mode === "manual" ? "manual" : "celebration"));
					}
				} catch {
					/* 下次实时更新或回到前台时重试领取，统计显示不受影响。 */
				} finally {
					if (celebrationContextGeneration === celebrationContextGenerationRef.current)
						for (const id of ids) claimingAchievementIdsRef.current.delete(id);
				}
			})
			.catch(async () => {
				if (cancelled || generation !== requestGenerationRef.current) return;
				baselineSuccessfullyReadRef.current = false;
				pendingAchievementIdsRef.current.clear();
				if (workspaceId !== null) {
					try {
						const allProjects = await readDailyWorkProgressSummary({ ...request, workspaceId: null });
						if (
							!cancelled &&
							generation === requestGenerationRef.current &&
							!allProjects.projects.some((project) => project.workspaceId === workspaceId)
						) {
							selectWorkspace(null);
							return;
						}
					} catch {
						/* 保留选择与已有记录，等待连接恢复。 */
					}
				}
				setError("今日进展暂时无法读取，已有记录仍保留。");
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, calendar, updates.generation, updates.quietGeneration, refreshGeneration, selectWorkspace]);
	const toggleExpanded = useCallback(() => {
		manualExpansionChangeGenerationRef.current += 1;
		setExpansionMode((mode) => (mode === "collapsed" ? "manual" : "collapsed"));
		refresh();
	}, [refresh]);
	const collapse = useCallback(() => {
		manualExpansionChangeGenerationRef.current += 1;
		setExpansionMode("collapsed");
	}, []);
	return {
		summary,
		error,
		workspaceId,
		selectWorkspace,
		isExpanded,
		isAutomaticallyExpanded: expansionMode === "celebration",
		celebrations,
		toggleExpanded,
		collapse,
		refresh,
	};
}
export type DailyWorkProgressStatisticsController = ReturnType<typeof useDailyWorkProgressStatistics>;
