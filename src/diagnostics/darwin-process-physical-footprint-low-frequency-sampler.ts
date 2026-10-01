// macOS phys_footprint 的低频读取——「这个进程对整机的真实内存代价」，即 Activity Monitor 的「内存」列。
//
// 为什么要它、又为什么只能低频：
//   - ps 的 RSS 不含被压缩 / 换出的页。长寿的 Node / Bun 进程（harness 根进程正是这种）RSS 会严重偏低：
//     现场对照样本 RSS 250 MiB，footprint 2.8 GiB；
//   - 但读 footprint 很贵：`top -l 1 -pid …` 实测 30 个 pid 要 3.5 秒。所以只对 harness 根进程和 RSS 最大的
//     前几名、每 10 分钟读一次。
// `man top`：mem 列即 "Physical memory footprint of the process"。
//
// EXPERIMENT_NODE: 用 proc_pid_rusage（ri_phys_footprint / ri_lifetime_max_phys_footprint / ri_diskio_bytes*）的 native addon 替代 top——更便宜且能拿到峰值与磁盘 IO，代价是引入原生依赖。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TOP_FOOTPRINT_READ_TIMEOUT_MS = 30_000;

const FOOTPRINT_UNIT_MULTIPLIERS: Readonly<Record<string, number>> = {
	B: 1,
	K: 1024,
	M: 1024 ** 2,
	G: 1024 ** 3,
	T: 1024 ** 4,
};

// top 的 mem 列形如 "312M"、"1091M"、"2G"、"512K"，变化时可能带 "+" / "-" 后缀。
export function parseTopMemoryColumnTextToBytes(memoryColumnText: string): number | null {
	const match = /^(\d+(?:\.\d+)?)([BKMGT])?[+-]?$/.exec(memoryColumnText.trim());
	if (!match) {
		return null;
	}
	const multiplier = FOOTPRINT_UNIT_MULTIPLIERS[match[2] ?? "B"] ?? 1;
	return Math.round(Number.parseFloat(match[1] ?? "0") * multiplier);
}

export function parseTopProcessIdAndPhysicalFootprintOutput(topOutput: string): Map<number, number> {
	const physicalFootprintBytesByProcessId = new Map<number, number>();
	let processRowsStarted = false;
	for (const line of topOutput.split("\n")) {
		const tokens = line.trim().split(/\s+/);
		if (!processRowsStarted) {
			processRowsStarted = tokens[0] === "PID";
			continue;
		}
		if (tokens.length < 2) {
			continue;
		}
		const processId = Number.parseInt(tokens[0] ?? "", 10);
		const physicalFootprintBytes = parseTopMemoryColumnTextToBytes(tokens[1] ?? "");
		if (Number.isInteger(processId) && physicalFootprintBytes !== null) {
			physicalFootprintBytesByProcessId.set(processId, physicalFootprintBytes);
		}
	}
	return physicalFootprintBytesByProcessId;
}

// 非 darwin 或读取失败时返回空表：footprint 是补充口径，拿不到不影响 RSS 主采样。
export async function readDarwinPhysicalFootprintBytesForProcessIds(
	processIds: readonly number[],
): Promise<Map<number, number>> {
	if (process.platform !== "darwin" || processIds.length === 0) {
		return new Map();
	}
	try {
		const { stdout } = await execFileAsync(
			"top",
			["-l", "1", "-stats", "pid,mem", ...processIds.flatMap((processId) => ["-pid", String(processId)])],
			{ timeout: TOP_FOOTPRINT_READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
		);
		return parseTopProcessIdAndPhysicalFootprintOutput(stdout);
	} catch {
		return new Map();
	}
}
