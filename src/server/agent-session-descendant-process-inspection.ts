// 会话回收的「进程还在不在」探针：枚举一棵进程树、以及回收后复核哪些 pid 仍然存活。
//
// 刻意的边界：本模块只做**存活性**判定，**绝不**读取或求和任何内存指标。现场观测到过一个属于
// agent 会话的临时 `ugrep` 子进程 RSS 高达 6.7 GiB——按「子树 RSS 求和」的口径它会被算成「这个
// 会话占了 6.7 GiB」，那是错的。容量口径一律用 phys_footprint 另行测量，不走这里。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// `ps` 输出上限保护：极端情况下（容器里几万个进程）避免把整张表读进内存。
const MAX_PROCESS_TABLE_BYTES = 4 * 1024 * 1024;

export interface DescendantProcessInspectionOptions {
	platform?: NodeJS.Platform;
	readProcessTable?: () => Promise<string>;
	isProcessAlive?: (pid: number) => boolean;
}

async function readPosixProcessTable(): Promise<string> {
	const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid="], {
		maxBuffer: MAX_PROCESS_TABLE_BYTES,
	});
	return stdout;
}

// 解析 `ps -Ao pid=,ppid=` 的输出为 ppid → pid[] 邻接表。容忍多余空白与畸形行。
export function parsePosixProcessParentTable(processTableText: string): Map<number, number[]> {
	const childPidsByParentPid = new Map<number, number[]>();
	for (const line of processTableText.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}
		const [pidText, parentPidText] = trimmed.split(/\s+/);
		const pid = Number.parseInt(pidText ?? "", 10);
		const parentPid = Number.parseInt(parentPidText ?? "", 10);
		if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) {
			continue;
		}
		const siblings = childPidsByParentPid.get(parentPid);
		if (siblings) {
			siblings.push(pid);
		} else {
			childPidsByParentPid.set(parentPid, [pid]);
		}
	}
	return childPidsByParentPid;
}

// 从邻接表按 BFS 展开一棵进程树（不含根自身）。带 visited 集合，防止 ppid 环导致死循环
// （正常系统上不会出现，但 ps 快照本身不是原子的，理论上可以读到自洽性被破坏的中间态）。
export function collectDescendantPidsFromParentTable(
	childPidsByParentPid: Map<number, number[]>,
	rootPid: number,
): number[] {
	const descendantPids: number[] = [];
	const visited = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0) {
		const currentPid = queue.shift() as number;
		for (const childPid of childPidsByParentPid.get(currentPid) ?? []) {
			if (visited.has(childPid)) {
				continue;
			}
			visited.add(childPid);
			descendantPids.push(childPid);
			queue.push(childPid);
		}
	}
	return descendantPids;
}

// 枚举 rootPid 的全部后代 pid。
// Windows：不做枚举（没有 `ps`，而 win32 的回收路径靠 tree-kill 处理整棵树），返回空数组。
// 这一点在审计结果里是可见的——descendantProcessesExitConfirmed 只由「复核仍存活的 pid 集合为空」
// 决定，Windows 上因为没有枚举到后代而恒为 true，不会伪造一个「已确认」的强断言。
export async function snapshotDescendantPids(
	rootPid: number,
	options: DescendantProcessInspectionOptions = {},
): Promise<number[]> {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		return [];
	}
	if (!Number.isInteger(rootPid) || rootPid <= 0) {
		return [];
	}
	try {
		const processTableText = await (options.readProcessTable ?? readPosixProcessTable)();
		return collectDescendantPidsFromParentTable(parsePosixProcessParentTable(processTableText), rootPid);
	} catch {
		// 探针失败不应阻断回收：拿不到后代清单就按「没枚举到」处理，根进程照杀。
		return [];
	}
}

// `kill(pid, 0)` 只做存在性探测、不发信号。跨平台可用（Node 在 Windows 上也支持这一用法）。
// EPERM = 进程存在但本进程无权发信号 ⇒ 仍算存活。
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EPERM";
	}
}

export function listSurvivingPids(pids: readonly number[], options: DescendantProcessInspectionOptions = {}): number[] {
	const probe = options.isProcessAlive ?? isProcessAlive;
	return pids.filter((pid) => probe(pid));
}
