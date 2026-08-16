// 【调查专用探针】本进程 fd 占用量的自监控。
//
// 这次故障的病根不是「fd 涨到了 10818」，而是**涨到 10818 却全程无人喊一声**：进程一路无声地
// 越过 Darwin 的 OPEN_MAX(10240)，直到所有 git 调用一起 EBADF 才以「work tree 无法验证」的形式
// 间接显形，排障只能从零重建因果链。
//
// 代价极低：类 Unix 上 /dev/fd 就是本进程 fd 表的目录视图，readdirSync 一次即可拿到总数，
// 不需要 lsof、不需要子进程（fd 快耗尽时恰恰是**开不出**子进程的，靠 lsof 反而拿不到数）。
//
// 同样是双层上报：每次采样进 JSONL（可画出增长曲线、据此估算复发时间），stderr 只在跨越水位档时
// 打一次。

import { readdirSync } from "node:fs";
import { findCrossedStderrWatermarkTier, getPtySessionSpawnCountSnapshot } from "./pty-session-spawn-attribution-probe";
import { appendDiagnosticEventToRotatingJsonlJournal } from "./rotating-jsonl-diagnostic-event-journal";

const PROCESS_FILE_DESCRIPTOR_TABLE_DIRECTORY = "/dev/fd";
const PROCESS_FILE_DESCRIPTOR_SAMPLE_INTERVAL_MS = 60_000;

// 10240 是 Darwin 的 OPEN_MAX 编译期常量（与 RLIMIT_NOFILE 无关）；越过它 posix_spawn 建管道即 EBADF。
// 因此档位在临近它时刻意加密，好在爆炸前而不是爆炸后示警。
const PROCESS_FILE_DESCRIPTOR_COUNT_STDERR_WATERMARK_TIERS = [
	1_000, 2_000, 4_000, 6_000, 8_000, 9_000, 9_500, 10_000, 10_240, 12_000, 16_000,
];

// readdirSync 自身要占一个 fd，故读数天然比「不观测时」多 1；差值恒定，不影响趋势判读。
export function readProcessOpenFileDescriptorCount(): number | null {
	try {
		return readdirSync(PROCESS_FILE_DESCRIPTOR_TABLE_DIRECTORY).length;
	} catch {
		// Windows 及任何没有 /dev/fd 的平台：探针静默失效，不打扰。
		return null;
	}
}

export function startProcessFileDescriptorWatermarkMonitor(): () => void {
	let previousOpenFileDescriptorCount = 0;
	const sampleTimer = setInterval(() => {
		const openFileDescriptorCount = readProcessOpenFileDescriptorCount();
		if (openFileDescriptorCount === null) {
			return;
		}

		// 同一条记录里带上累计 pty 创建数：「fd 增量 ≈ pty 创建增量」即为 1:1 泄漏假说的在线验证，
		// 事后不必再去拼两个通道的时间轴。
		const ptySessionSpawnCounts = getPtySessionSpawnCountSnapshot();
		appendDiagnosticEventToRotatingJsonlJournal("process-file-descriptor-count-sample", {
			openFileDescriptorCount,
			deltaSincePreviousSample: openFileDescriptorCount - previousOpenFileDescriptorCount,
			sampleIntervalMs: PROCESS_FILE_DESCRIPTOR_SAMPLE_INTERVAL_MS,
			darwinOpenMax: 10_240,
			cumulativePtySessionSpawnCount: ptySessionSpawnCounts.totalCount,
			cumulativePtySessionSpawnCountsByReason: ptySessionSpawnCounts.countsByReason,
		});

		const crossedTier = findCrossedStderrWatermarkTier(
			previousOpenFileDescriptorCount,
			openFileDescriptorCount,
			PROCESS_FILE_DESCRIPTOR_COUNT_STDERR_WATERMARK_TIERS,
		);
		previousOpenFileDescriptorCount = openFileDescriptorCount;
		if (crossedTier === null) {
			return;
		}
		try {
			process.stderr.write(
				`[warn] [fd-watermark-probe] 本进程 fd 占用越过水位 tier=${crossedTier} openFileDescriptorCount=${openFileDescriptorCount} darwinOpenMax=10240\n`,
			);
		} catch {
			// Best-effort diagnostic logging only.
		}
	}, PROCESS_FILE_DESCRIPTOR_SAMPLE_INTERVAL_MS);
	// 诊断探针不得阻止进程退出。
	sampleTimer.unref();
	return () => {
		clearInterval(sampleTimer);
	};
}
