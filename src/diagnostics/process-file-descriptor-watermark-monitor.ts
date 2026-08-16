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

export interface ProcessFileDescriptorSampleReport {
	// 首个样本没有「上一份样本」可比，其读数是基线而非增量，须与后续样本区分开。
	isBaselineSample: boolean;
	deltaSincePreviousSample: number | null;
	crossedStderrWatermarkTier: number | null;
}

// 抽成纯函数是为了能不依赖计时器地测「首样本不产生虚假增量、也不产生虚假越档」这条不变量。
export function deriveProcessFileDescriptorSampleReport(
	previousOpenFileDescriptorCount: number | null,
	openFileDescriptorCount: number,
): ProcessFileDescriptorSampleReport {
	if (previousOpenFileDescriptorCount === null) {
		return { isBaselineSample: true, deltaSincePreviousSample: null, crossedStderrWatermarkTier: null };
	}
	return {
		isBaselineSample: false,
		deltaSincePreviousSample: openFileDescriptorCount - previousOpenFileDescriptorCount,
		crossedStderrWatermarkTier: findCrossedStderrWatermarkTier(
			previousOpenFileDescriptorCount,
			openFileDescriptorCount,
			PROCESS_FILE_DESCRIPTOR_COUNT_STDERR_WATERMARK_TIERS,
		),
	};
}

export function startProcessFileDescriptorWatermarkMonitor(): () => void {
	// null 而非 0：拿 0 当上一份样本，会把进程启动时既有的全部 fd 误报成这一分钟的增长，
	// 并用同一个虚假基线从 0 起算水位、在启动瞬间误报一次越档，污染首个对账窗口。
	let previousOpenFileDescriptorCount: number | null = null;

	const recordProcessFileDescriptorSample = (): void => {
		const openFileDescriptorCount = readProcessOpenFileDescriptorCount();
		if (openFileDescriptorCount === null) {
			return;
		}
		const sampleReport = deriveProcessFileDescriptorSampleReport(
			previousOpenFileDescriptorCount,
			openFileDescriptorCount,
		);
		previousOpenFileDescriptorCount = openFileDescriptorCount;

		// 同一条记录里带上累计 pty 创建数：「fd 增量 ≈ pty 创建增量」即为 1:1 泄漏假说的在线验证，
		// 事后不必再去拼两个通道的时间轴。
		const ptySessionSpawnCounts = getPtySessionSpawnCountSnapshot();
		appendDiagnosticEventToRotatingJsonlJournal("process-file-descriptor-count-sample", {
			openFileDescriptorCount,
			isBaselineSample: sampleReport.isBaselineSample,
			deltaSincePreviousSample: sampleReport.deltaSincePreviousSample,
			sampleIntervalMs: PROCESS_FILE_DESCRIPTOR_SAMPLE_INTERVAL_MS,
			darwinOpenMax: 10_240,
			// 只有**成功**创建的 pty 才分配 kqueue，故对账基数取 succeeded；失败数单独带出，
			// 用于分辨「fd 不再增长」是泄漏停了还是已经开不出 pty 了。
			cumulativeSucceededPtySessionSpawnCount: ptySessionSpawnCounts.succeededTotalCount,
			cumulativeFailedPtySessionSpawnCount: ptySessionSpawnCounts.failedTotalCount,
			cumulativeSucceededPtySessionSpawnCountsByReason: ptySessionSpawnCounts.succeededCountsByReason,
		});

		if (sampleReport.crossedStderrWatermarkTier === null) {
			return;
		}
		try {
			process.stderr.write(
				`[warn] [fd-watermark-probe] 本进程 fd 占用越过水位 tier=${sampleReport.crossedStderrWatermarkTier} openFileDescriptorCount=${openFileDescriptorCount} darwinOpenMax=10240\n`,
			);
		} catch {
			// Best-effort diagnostic logging only.
		}
	};

	// 启动即取一次真实基线，而不是等满一个采样周期：既让首个周期的增量有意义，也在 journal 里
	// 留下「本进程起步时占了多少 fd」这个事后必然要用到的参照点。
	recordProcessFileDescriptorSample();
	const sampleTimer = setInterval(recordProcessFileDescriptorSample, PROCESS_FILE_DESCRIPTOR_SAMPLE_INTERVAL_MS);
	// 诊断探针不得阻止进程退出。
	sampleTimer.unref();
	return () => {
		clearInterval(sampleTimer);
	};
}
