// task worktree 磁盘体积的低频测量：每小时检查一次，每个 worktree 最多 24 小时量一次，
// 且只量最近 7 天内有会话活动的——session summary 里有数百条历史会话，逐个天天扫没有意义。
// 一个 worktree 一个 worktree 顺序量，每个有 20 秒时间预算，不与 agent 抢 IO。

import { existsSync } from "node:fs";
import type { TaskWorkingDirectoryAttribution } from "../server/task-resource-usage-attribution-root-enumeration";
import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
	type DiagnosticEventJournalPayload,
} from "./rotating-jsonl-diagnostic-event-journal";
import {
	measureTaskWorktreeDiskUsageWithinTimeBudget,
	type TaskWorktreeDiskUsageMeasurement,
} from "./task-worktree-disk-usage-bounded-walker";

const TASK_WORKTREE_DISK_USAGE_CHECK_INTERVAL_MS = 60 * 60_000;
// EXPERIMENT_NODE: 每个 worktree 最多 24 小时量一次、只量 7 天内活跃的、单次 20 秒预算——频率 / 覆盖面 / IO 占用三者的折中。
const MINIMUM_INTERVAL_BETWEEN_MEASUREMENTS_OF_ONE_WORKTREE_MS = 24 * 60 * 60_000;
const MAXIMUM_SESSION_INACTIVITY_FOR_MEASUREMENT_MS = 7 * 24 * 60 * 60_000;
const PER_WORKTREE_MEASUREMENT_TIME_BUDGET_MS = 20_000;

export interface TaskWorktreeDiskUsageMeasurementMonitorDependencies {
	listTaskWorkingDirectoryAttributions: () => TaskWorkingDirectoryAttribution[];
	// 只量 Kanban 管理的 task worktree（inplace 任务的工作目录就是仓库本身，量它没有归因意义）。
	isKanbanManagedTaskWorktreePath: (workingDirectoryPath: string) => boolean;
	measure?: (worktreePath: string) => Promise<TaskWorktreeDiskUsageMeasurement>;
	now?: () => number;
	appendJournalEvent?: (channel: DiagnosticEventJournalChannel, payload: DiagnosticEventJournalPayload) => void;
}

export function createTaskWorktreeDiskUsageMeasurementMonitor(
	deps: TaskWorktreeDiskUsageMeasurementMonitorDependencies,
) {
	const now = deps.now ?? Date.now;
	const measure =
		deps.measure ??
		((worktreePath: string) =>
			measureTaskWorktreeDiskUsageWithinTimeBudget({
				worktreePath,
				timeBudgetMs: PER_WORKTREE_MEASUREMENT_TIME_BUDGET_MS,
			}));
	const appendJournalEvent = deps.appendJournalEvent ?? appendDiagnosticEventToRotatingJsonlJournal;
	const lastMeasuredAtEpochMsByWorktreePath = new Map<string, number>();
	// 每张卡最近一次测得的体积（供看板详情面板；journal 才是完整记录）。
	const latestWorktreeDiskUsageBytesByTaskCardKey = new Map<string, number>();
	const taskCardKey = (workspaceId: string, attributedTaskCardId: string) =>
		`${workspaceId}\u0000${attributedTaskCardId}`;
	let checkTimer: NodeJS.Timeout | null = null;
	let checkInFlight = false;
	let stopped = false;

	const runCheck = async (): Promise<void> => {
		if (checkInFlight || stopped) {
			return;
		}
		checkInFlight = true;
		try {
			for (const attribution of deps.listTaskWorkingDirectoryAttributions()) {
				if (stopped) {
					return;
				}
				const { workingDirectoryPath } = attribution;
				const lastMeasuredAtEpochMs = lastMeasuredAtEpochMsByWorktreePath.get(workingDirectoryPath);
				if (
					attribution.attributedTaskCardId === null ||
					!deps.isKanbanManagedTaskWorktreePath(workingDirectoryPath) ||
					now() - attribution.latestSessionUpdatedAtEpochMs > MAXIMUM_SESSION_INACTIVITY_FOR_MEASUREMENT_MS ||
					(lastMeasuredAtEpochMs !== undefined &&
						now() - lastMeasuredAtEpochMs < MINIMUM_INTERVAL_BETWEEN_MEASUREMENTS_OF_ONE_WORKTREE_MS) ||
					!existsSync(workingDirectoryPath)
				) {
					continue;
				}
				lastMeasuredAtEpochMsByWorktreePath.set(workingDirectoryPath, now());
				try {
					const measurement = await measure(workingDirectoryPath);
					latestWorktreeDiskUsageBytesByTaskCardKey.set(
						taskCardKey(attribution.workspaceId, attribution.attributedTaskCardId),
						measurement.worktreeTotalBytes,
					);
					appendJournalEvent("task-worktree-disk-usage-measurement", {
						workspaceId: attribution.workspaceId,
						attributedTaskCardId: attribution.attributedTaskCardId,
						worktreePath: workingDirectoryPath,
						...measurement,
					});
				} catch {
					// 单个 worktree 量失败不影响其余。
				}
			}
		} finally {
			checkInFlight = false;
		}
	};

	return {
		start: () => {
			if (checkTimer !== null || stopped) {
				return;
			}
			void runCheck();
			checkTimer = setInterval(() => {
				void runCheck();
			}, TASK_WORKTREE_DISK_USAGE_CHECK_INTERVAL_MS);
			checkTimer.unref();
		},
		stop: () => {
			stopped = true;
			if (checkTimer !== null) {
				clearInterval(checkTimer);
				checkTimer = null;
			}
		},
		runCheck,
		getLatestWorktreeDiskUsageBytesForTaskCard: (workspaceId: string, attributedTaskCardId: string): number | null =>
			latestWorktreeDiskUsageBytesByTaskCardKey.get(taskCardKey(workspaceId, attributedTaskCardId)) ?? null,
	};
}
