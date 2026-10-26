import type {
	RuntimeClaimDailyWorkProgressCelebrationsRequest,
	RuntimeClaimDailyWorkProgressCelebrationsResponse,
	RuntimeDailyWorkProgressRequest,
	RuntimeDailyWorkProgressSummary,
} from "../core/api-contract";
import {
	createDailyWorkProgressCollectionCostRecorder,
	measureDailyWorkProgressSynchronousStage,
} from "../diagnostics/daily-work-progress-collection-cost-recorder";
import type { DailyWorkProgressCollector } from "./daily-work-progress-statistics-collector";
import {
	buildDailyWorkProgressSummary,
	type DailyWorkProgressWorkspaceCoverage,
} from "./daily-work-progress-statistics-projection";
import {
	createEmptyDailyWorkProgressStatisticsStore,
	type DailyWorkProgressStatisticsStore,
	mutateDailyWorkProgressStatisticsStore,
} from "./daily-work-progress-statistics-store";

export interface DailyWorkProgressStatisticsService {
	getSummary(request: RuntimeDailyWorkProgressRequest): Promise<RuntimeDailyWorkProgressSummary>;
	claimCelebrations(
		request: RuntimeClaimDailyWorkProgressCelebrationsRequest,
	): Promise<RuntimeClaimDailyWorkProgressCelebrationsResponse>;
	refresh(): Promise<void>;
	start(): void;
	close(): Promise<void>;
}
interface WatchedDailyWorkProgressView {
	request: RuntimeDailyWorkProgressRequest;
	achievementIds: Set<string>;
}
function buildCoverage(
	state: DailyWorkProgressStatisticsStore,
	projects: RuntimeDailyWorkProgressSummary["projects"],
): DailyWorkProgressWorkspaceCoverage[] {
	return projects.map(({ workspaceId }) => {
		const sources = Object.entries(state.nativeSourcesByIdentityKey).filter(
			([, source]) => source.workspaceId === workspaceId,
		);
		const sourceInventoryDiscovered = state.workspacePromptSourceInventoryDiscoveryCompleted[workspaceId] === true;
		const incomplete =
			sources.length === 0 ||
			sources.some(([key]) => {
				const cursor = state.transcriptCursorsByIdentityKey[key];
				return !cursor?.rejectedDescendantSession && !cursor?.complete;
			});
		const captureStartedAt = state.ledgerCaughtUp
			? (state.workspaceCaptureStartedAtEpochMs[workspaceId] ?? null)
			: null;
		const warnings = [
			...(state.workspaceWarnings[workspaceId] ?? []),
			...(!sourceInventoryDiscovered ? ["尚未确认项目人工 prompt 来源清单"] : []),
			...(sources.length === 0 ? ["尚无可确认的人工 prompt 历史来源"] : []),
			...(incomplete ? ["部分人工 prompt 历史仍在读取或暂时不可读"] : []),
			...(!state.ledgerCaughtUp ? ["正在追赶任务流转历史"] : []),
		];
		return {
			workspaceId,
			taskHistoryCompleteSinceEpochMs: captureStartedAt,
			promptHistoryCompleteSinceEpochMs: incomplete || warnings.length ? null : captureStartedAt,
			warnings,
		};
	});
}
function statisticsSignature(state: DailyWorkProgressStatisticsStore): string {
	return JSON.stringify([
		Object.keys(state.factsByEventId).length,
		state.ledgerCaughtUp,
		state.workspaceCaptureStartedAtEpochMs,
		state.workspacePromptSourceInventoryDiscoveryCompleted,
		state.workspaceWarnings,
		Object.entries(state.nativeSourcesByIdentityKey).map(([key, source]) => [
			key,
			source.workspaceId,
			state.transcriptCursorsByIdentityKey[key]?.complete ?? false,
			state.transcriptCursorsByIdentityKey[key]?.rejectedDescendantSession ?? false,
		]),
	]);
}

export function createDailyWorkProgressStatisticsService(deps: {
	storageFilePath: string;
	costRecorder?: ReturnType<typeof createDailyWorkProgressCollectionCostRecorder>;
	readCostRecorderRuntimeIdentity?: () => { runtimeProcessInstanceId: string; runtimeOrigin: string };
	collect: DailyWorkProgressCollector;
	onUpdated?: (revision: number) => void;
	now?: () => number;
	warn: (message: string) => void;
}): DailyWorkProgressStatisticsService {
	const now = deps.now ?? Date.now;
	const costRecorder =
		deps.costRecorder ??
		createDailyWorkProgressCollectionCostRecorder({ readRuntimeIdentity: deps.readCostRecorderRuntimeIdentity });
	let state = createEmptyDailyWorkProgressStatisticsStore(now());
	let projects: RuntimeDailyWorkProgressSummary["projects"] = [];
	let initialized = false;
	let lastRefreshFailed = false;
	let closed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let refreshInFlight: Promise<void> | null = null;
	let serializationTail: Promise<unknown> = Promise.resolve();
	let hasPendingHistoricalReads = false;
	const views = new Map<string, WatchedDailyWorkProgressView>();
	const summaryCache = new Map<string, RuntimeDailyWorkProgressSummary>();
	function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = serializationTail.then(operation);
		serializationTail = result.catch(() => {});
		return result;
	}
	function project(request: RuntimeDailyWorkProgressRequest): RuntimeDailyWorkProgressSummary {
		const key = JSON.stringify(request);
		let summary = summaryCache.get(key);
		if (!summary) {
			summary = measureDailyWorkProgressSynchronousStage("statistics_summary_projection", () =>
				buildDailyWorkProgressSummary({
					facts: Object.values(state.factsByEventId),
					coverage: buildCoverage(state, projects),
					projects,
					request,
					revision: state.revision,
				}),
			);
			summaryCache.set(key, summary);
		}
		return {
			...summary,
			celebrationEligibleAchievementIds: summary.achievements
				.filter(
					(achievement) =>
						state.eligibleAchievementIds[achievement.achievementId] !== undefined &&
						state.claimedAchievementIds[achievement.achievementId] === undefined,
				)
				.map((achievement) => achievement.achievementId),
		};
	}
	async function refresh(): Promise<void> {
		if (closed) return;
		if (!refreshInFlight)
			refreshInFlight = serialize(() =>
				costRecorder.run("refresh", async () => {
					const mutation = await mutateDailyWorkProgressStatisticsStore(deps.storageFilePath, async (current) => {
						const before = statisticsSignature(current);
						const precedingFactIds = new Set(Object.keys(current.factsByEventId));
						const collected = await deps.collect(current);
						const liveIds = new Set(collected.liveFactEventIds);
						const historicalFacts = Object.values(current.factsByEventId).filter(
							(fact) => !precedingFactIds.has(fact.eventId) && !liveIds.has(fact.eventId),
						);
						const projectSetChanged = JSON.stringify(projects) !== JSON.stringify(collected.projects);
						projects = collected.projects;
						hasPendingHistoricalReads = collected.hasPendingHistoricalReads;
						const changed = before !== statisticsSignature(current) || projectSetChanged;
						if (changed) current.revision++;
						state = current;
						if (changed) summaryCache.clear();
						for (const view of changed ? views.values() : []) {
							const summary = project(view.request);
							const liveMetrics = new Set(
								collected.liveFactEventIds.flatMap((id) => {
									const fact = current.factsByEventId[id];
									return fact &&
										(view.request.workspaceId === null || view.request.workspaceId === fact.workspaceId)
										? [fact.metric]
										: [];
								}),
							);
							const quietlyBackfilledMetrics = new Set(
								historicalFacts
									.filter(
										(fact) =>
											view.request.workspaceId === null || view.request.workspaceId === fact.workspaceId,
									)
									.map((fact) => fact.metric),
							);
							for (const achievement of summary.achievements) {
								if (
									!projectSetChanged &&
									!view.achievementIds.has(achievement.achievementId) &&
									liveMetrics.has(achievement.metric) &&
									!quietlyBackfilledMetrics.has(achievement.metric)
								)
									current.eligibleAchievementIds[achievement.achievementId] = now();
							}
							view.achievementIds = new Set(
								summary.achievements.map((achievement) => achievement.achievementId),
							);
						}
						// 过期领取仅用于避免重复反馈；历史成果事实保留，供今后的日纪录比较。
						for (const records of [current.eligibleAchievementIds, current.claimedAchievementIds])
							for (const [id, timestamp] of Object.entries(records))
								if (now() - timestamp > 14 * 86_400_000) delete records[id];
						return changed;
					});
					state = mutation.state;
					initialized = true;
					const recovered = lastRefreshFailed;
					lastRefreshFailed = false;
					if (mutation.result || recovered) deps.onUpdated?.(state.revision);
				}),
			)
				.catch((error: unknown) => {
					if (!lastRefreshFailed) {
						lastRefreshFailed = true;
						deps.onUpdated?.(state.revision);
					}
					throw error;
				})
				.finally(() => {
					refreshInFlight = null;
				});
		await refreshInFlight;
	}
	function schedule(): void {
		if (closed || timer !== null) return;
		timer = setTimeout(
			() => {
				timer = null;
				void refresh()
					.catch(() => deps.warn("今日进展统计更新失败；保留已有记录并稍后重试。"))
					.finally(schedule);
			},
			hasPendingHistoricalReads ? 200 : 2_000,
		);
		timer.unref();
	}
	return {
		async getSummary(request) {
			if (!initialized) await refresh();
			if (lastRefreshFailed) throw new Error("统计持久记录暂时不可读，已有记录未覆盖");
			if (request.workspaceId !== null && !projects.some((project) => project.workspaceId === request.workspaceId))
				throw new Error("统计项目不在当前已登记项目中");
			const summary = project(request);
			const key = JSON.stringify(request);
			if (!views.has(key)) {
				if (views.size >= 128) {
					const firstKey = views.keys().next().value;
					if (firstKey) {
						views.delete(firstKey);
						summaryCache.delete(firstKey);
					}
				}
				views.set(key, {
					request,
					achievementIds: new Set(summary.achievements.map((achievement) => achievement.achievementId)),
				});
			}
			return summary;
		},
		async claimCelebrations(request) {
			if (!initialized) await refresh();
			if (lastRefreshFailed) throw new Error("统计持久记录暂时不可读，暂不领取庆祝");
			return serialize(() =>
				costRecorder.run("celebration_claim", async () => {
					const result = await mutateDailyWorkProgressStatisticsStore(deps.storageFilePath, async (current) => {
						state = current;
						summaryCache.clear();
						const summary = project(request);
						const requested = new Set(request.achievementIds);
						const achievements = summary.achievements.filter(
							(achievement) =>
								requested.has(achievement.achievementId) &&
								current.eligibleAchievementIds[achievement.achievementId] !== undefined &&
								current.claimedAchievementIds[achievement.achievementId] === undefined,
						);
						for (const achievement of achievements)
							current.claimedAchievementIds[achievement.achievementId] = now();
						return { achievements };
					});
					state = result.state;
					return result.result;
				}),
			);
		},
		refresh,
		start() {
			schedule();
		},
		async close() {
			closed = true;
			if (timer !== null) clearTimeout(timer);
			timer = null;
			await serializationTail;
			costRecorder.close();
		},
	};
}
