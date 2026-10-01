// 量一个 task worktree 的实体磁盘体积（按 task 归因的资源占用采集，S6）。
//
//   - 不跟随符号链接：Kanban 把 node_modules 等 ignored 路径软链进 worktree，跟随会把主 checkout 的依赖
//     重复算到每个 task 头上；
//   - 按实际占用块计（stat.blocks × 512，与 du 同口径），稀疏文件 / APFS 克隆不会被按表观大小高估；
//   - 限并发、设时间预算：超时就停，结果标 measurementWasCutShortByTimeBudget（是下界），绝不长时间占着 IO。
//     预算在目录项循环里逐项检查，而不只在一个目录读完之后：平铺数万文件的目录会在单次 processDirectory
//     里串行 lstat，只在外层查会让一次测量远超预算；超时后在途的目录读取也随即停止排队、停止 lstat。
//   - 按顶层目录分解，一眼看出是 dist / .vite / 真实存在的 node_modules 哪个在膨胀。

import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAXIMUM_CONCURRENT_DIRECTORY_READS = 8;
const LARGEST_TOP_LEVEL_ENTRY_COUNT = 8;

export interface TaskWorktreeDiskUsageMeasurement {
	worktreeTotalBytes: number;
	totalFileCount: number;
	skippedSymbolicLinkCount: number;
	largestTopLevelEntries: Array<{ entryName: string; totalBytes: number }>;
	measurementWasCutShortByTimeBudget: boolean;
	measurementDurationMs: number;
}

export async function measureTaskWorktreeDiskUsageWithinTimeBudget(input: {
	worktreePath: string;
	timeBudgetMs: number;
	maximumConcurrentDirectoryReads?: number;
	now?: () => number;
	// 测试注入点：默认 node:fs/promises 的 lstat（不跟随符号链接）。
	readEntryStatsWithoutFollowingSymbolicLinks?: (entryPath: string) => Promise<Pick<Stats, "blocks">>;
}): Promise<TaskWorktreeDiskUsageMeasurement> {
	const now = input.now ?? Date.now;
	const readEntryStatsWithoutFollowingSymbolicLinks = input.readEntryStatsWithoutFollowingSymbolicLinks ?? lstat;
	const startedAtEpochMs = now();
	const deadlineEpochMs = startedAtEpochMs + input.timeBudgetMs;
	const maximumConcurrentDirectoryReads =
		input.maximumConcurrentDirectoryReads ?? DEFAULT_MAXIMUM_CONCURRENT_DIRECTORY_READS;
	const totalBytesByTopLevelEntryName = new Map<string, number>();
	let totalFileCount = 0;
	let skippedSymbolicLinkCount = 0;
	let measurementWasCutShortByTimeBudget = false;
	// 一旦超时就锁存为 true：外层循环与所有在途的目录读取共用这一个判据，谁先看到超时谁置位。
	const timeBudgetIsExhausted = (): boolean => {
		if (!measurementWasCutShortByTimeBudget && now() > deadlineEpochMs) {
			measurementWasCutShortByTimeBudget = true;
		}
		return measurementWasCutShortByTimeBudget;
	};

	const addBytes = (topLevelEntryName: string, bytes: number) => {
		totalBytesByTopLevelEntryName.set(
			topLevelEntryName,
			(totalBytesByTopLevelEntryName.get(topLevelEntryName) ?? 0) + bytes,
		);
	};

	// 待遍历目录队列：[绝对路径, 所属顶层条目名]。
	const pendingDirectories: Array<[string, string | null]> = [[input.worktreePath, null]];
	const processDirectory = async (directoryPath: string, topLevelEntryName: string | null): Promise<void> => {
		if (timeBudgetIsExhausted()) {
			return;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(directoryPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			// 逐项查预算：超时后不再排队子目录、不再 lstat，在途读取最多再完成手上这一次 lstat 就退出。
			if (timeBudgetIsExhausted()) {
				return;
			}
			const entryPath = join(directoryPath, entry.name);
			const owningTopLevelEntryName = topLevelEntryName ?? entry.name;
			if (entry.isSymbolicLink()) {
				skippedSymbolicLinkCount += 1;
				continue;
			}
			if (entry.isDirectory()) {
				pendingDirectories.push([entryPath, owningTopLevelEntryName]);
				continue;
			}
			try {
				const entryStats = await readEntryStatsWithoutFollowingSymbolicLinks(entryPath);
				addBytes(owningTopLevelEntryName, entryStats.blocks * 512);
				totalFileCount += 1;
			} catch {
				// 遍历途中被删掉的文件：跳过。
			}
		}
	};

	const inFlight = new Set<Promise<void>>();
	while (pendingDirectories.length > 0 || inFlight.size > 0) {
		if (timeBudgetIsExhausted()) {
			break;
		}
		while (pendingDirectories.length > 0 && inFlight.size < maximumConcurrentDirectoryReads) {
			const [directoryPath, topLevelEntryName] = pendingDirectories.shift() as [string, string | null];
			const directoryRead = processDirectory(directoryPath, topLevelEntryName).finally(() => {
				inFlight.delete(directoryRead);
			});
			inFlight.add(directoryRead);
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}
	// 超时退出时不等在途读取：它们在下一个目录项处看到同一个超时判据就自行退出，不再读盘；
	// 此后它们对计数的改动也不会进入已经算好的返回值（结果本来就已标为下界）。

	const largestTopLevelEntries = Array.from(totalBytesByTopLevelEntryName, ([entryName, totalBytes]) => ({
		entryName,
		totalBytes,
	}))
		.sort((left, right) => right.totalBytes - left.totalBytes)
		.slice(0, LARGEST_TOP_LEVEL_ENTRY_COUNT);
	return {
		worktreeTotalBytes: Array.from(totalBytesByTopLevelEntryName.values()).reduce((sum, bytes) => sum + bytes, 0),
		totalFileCount,
		skippedSymbolicLinkCount,
		largestTopLevelEntries,
		measurementWasCutShortByTimeBudget,
		measurementDurationMs: now() - startedAtEpochMs,
	};
}
