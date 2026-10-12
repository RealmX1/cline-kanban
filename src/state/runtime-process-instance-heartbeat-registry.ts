// 「此刻这台机器上有哪些 kanban runtime 进程还活着」——一个全机共享的心跳注册表。
//
// ## 为什么需要它
//
// 一台机器上会同时跑多个 runtime：常驻实例、`npm run dev:full`（每次挑一个空闲端口）、`dogfood`、
// 起真服务器的集成测试。它们**共享同一个 `~/.cline/kanban/workspaces/` 根**，于是任何一个「扫一遍
// 磁盘上的历史状态、把不该留的收拾掉」的启动清扫，都必须先能回答一个问题：
//
//   我看到的这条记录，是上一次生命周期留下的残骸，还是**另一个此刻正活着的实例**正在用的东西？
//
// 分不清的代价是实打实的：排队 prompt 的 restart-crossing 盖章按「条目 enqueuedAt 早于本进程启动」
// 判，于是第二个实例一启动就会把常驻实例正常排着的队全部盖章 + 清掉人工确认——那些条目根本没经历过
// 任何重启。注入账本的清扫遇到过同一类问题，它当时能绕开是因为「pending 必然在有界预算内收敛」这条
// 契约给了它一个 staleness 判据可借；排队 prompt 可以合法地等几个小时，借不到。
//
// ## 为什么不探测 pid
//
// `process.kill(pid, 0)` 这条路本仓已经明确拒绝过（见 session-manager.ts 的
// reconcileSummaryWithUnrecoverableRunningAgentProcessClaim 头注）：重启后 pid 会被复用，探测成功只能
// 证明「此刻有某个进程占着这个数字」，不能证明它还是当初那个 runtime；EPERM 判活更是直接把别人的进程
// 认成自己的。心跳是自己写的、带自己身份的，没有这两个问题。
//
// ## 为什么不是「按 workspace 发租约」
//
// 租约看起来更省事（一个 workspace 一份，条目不必记归属），但它有一个 **fail-unsafe** 的洞：
// 实例 A 常驻并持有新鲜租约 → 实例 B 启动，看到租约新鲜而跳过盖章（这一步是对的）→ 但 B 随后也服务
// 了这个 workspace 并续了租约 → 此时 A 真的重启，它看到 B 的租约新鲜，于是**跳过盖章，漏掉一次真实
// 重启**。漏盖意味着队列在重启后不提醒就直接发——正是这套机制要防的那件事。
//
// 所以**托管权**挂在条目上（此刻谁对它负责），活性挂在实例上（谁还活着），两者分开。判据因此是
// 「这条记录的托管者此刻不活着」。
//
// 托管权必须随盖章**转移**，这是配套的另一半：不转移的话，条目会永久指向那个最初排队、后来死掉的
// 实例，于是任何一个后起的并存实例都会再判一次「托管者不活跃」，把误标换个触发条件放回来。
// 转移之后，五种排列都对，没有一种能推出漏盖（枚举见 queued-task-prompt-delivery-store.ts 的盖章函数）。
//
// ## 失败方向
//
// 读不到 / 读坏了一律按「不活着」处理，即倾向于**多盖一次章**（用户多确认一次），绝不倾向于漏盖。

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { getRuntimeHomePath } from "./workspace-state";

const RUNTIME_PROCESS_INSTANCE_HEARTBEATS_DIR = "runtime-process-instance-heartbeats";

// 续期节拍。取值不必精确——判活的宽限期是它的数倍，真正要求的只是「远小于宽限期」。
export const RUNTIME_PROCESS_INSTANCE_HEARTBEAT_INTERVAL_MS = 30_000;

// 多久没续期就算这个实例已经不在了。
//
// 取 4 个节拍（2 分钟）而不是 1–2 个：判「死」的代价是不对称的。判早了（实例其实活着）会把它正在用的
// 队列条目盖上 restart-crossing 章、清掉人工确认，用户莫名其妙被要求重新确认一遍；判晚了只是让一次
// 真实重启的提醒迟到最多两分钟，而用户本来就要先聚焦到那张卡片才看得见提醒。宽限期给足，偏向判活。
export const RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS = 4 * RUNTIME_PROCESS_INSTANCE_HEARTBEAT_INTERVAL_MS;

const runtimeProcessInstanceHeartbeatSchema = z.object({
	runtimeProcessInstanceId: z.string(),
	// 仅供人类排查（「这条心跳是哪个进程写的」），**不**参与判活——理由见文件头「为什么不探测 pid」。
	pid: z.number().int(),
	startedAtEpochMs: z.number(),
	lastHeartbeatAtEpochMs: z.number(),
});
export type RuntimeProcessInstanceHeartbeat = z.infer<typeof runtimeProcessInstanceHeartbeatSchema>;

// 本进程的身份。模块加载时铸一次，进程内恒定——与 runtimeSessionIncarnationId 同一个模式：
// 一次真实的生命周期事件对应一个 randomUUID，不是元数据噪声。
const THIS_RUNTIME_PROCESS_INSTANCE_ID = randomUUID();

export function getThisRuntimeProcessInstanceId(): string {
	return THIS_RUNTIME_PROCESS_INSTANCE_ID;
}

export function getRuntimeProcessInstanceHeartbeatsDirectoryPath(): string {
	return join(getRuntimeHomePath(), RUNTIME_PROCESS_INSTANCE_HEARTBEATS_DIR);
}

function getRuntimeProcessInstanceHeartbeatPath(runtimeProcessInstanceId: string): string {
	return join(getRuntimeProcessInstanceHeartbeatsDirectoryPath(), `${runtimeProcessInstanceId}.json`);
}

// 心跳文件刻意**不走 lockedFileSystem**：每份文件只有一个写者（写它的那个进程自己），没有读-改-写，
// 也没有跨文件不变量。上锁只会给一件每 30s 发生一次的事加上一次锁争用。
async function writeRuntimeProcessInstanceHeartbeat(heartbeat: RuntimeProcessInstanceHeartbeat): Promise<void> {
	const directoryPath = getRuntimeProcessInstanceHeartbeatsDirectoryPath();
	await mkdir(directoryPath, { recursive: true });
	await writeFile(
		getRuntimeProcessInstanceHeartbeatPath(heartbeat.runtimeProcessInstanceId),
		`${JSON.stringify(heartbeat, null, 2)}\n`,
		"utf8",
	);
}

export async function readLiveRuntimeProcessInstanceIds(input?: {
	nowEpochMs?: number;
	consideredDeadAfterMs?: number;
}): Promise<Set<string>> {
	const nowEpochMs = input?.nowEpochMs ?? Date.now();
	const consideredDeadAfterMs = input?.consideredDeadAfterMs ?? RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS;
	let fileNames: string[];
	try {
		fileNames = await readdir(getRuntimeProcessInstanceHeartbeatsDirectoryPath());
	} catch {
		// 目录不存在 = 还没有任何实例写过心跳。读不出来也一样按空集：失败方向偏向「都不活着」⇒ 多盖章。
		return new Set();
	}
	const liveRuntimeProcessInstanceIds = new Set<string>();
	for (const fileName of fileNames) {
		if (!fileName.endsWith(".json")) {
			continue;
		}
		let parsed: RuntimeProcessInstanceHeartbeat;
		try {
			const raw = await readFile(join(getRuntimeProcessInstanceHeartbeatsDirectoryPath(), fileName), "utf8");
			const candidate = runtimeProcessInstanceHeartbeatSchema.safeParse(JSON.parse(raw) as unknown);
			if (!candidate.success) {
				continue;
			}
			parsed = candidate.data;
		} catch {
			// 单份心跳读坏了不该让其余实例集体判死——跳过它即可（跳过 = 按不活着，仍是保守方向）。
			continue;
		}
		if (nowEpochMs - parsed.lastHeartbeatAtEpochMs < consideredDeadAfterMs) {
			liveRuntimeProcessInstanceIds.add(parsed.runtimeProcessInstanceId);
		}
	}
	return liveRuntimeProcessInstanceIds;
}

// 清掉早已过期的心跳文件，免得这个目录随着几个月的重启无限长下去。
//
// 判据比「不活着」宽得多（10 倍宽限期）：判死只影响盖章、可自愈，而**删文件不可逆**。一个刚过宽限期
// 就被删掉的实例，若其实只是被 SIGSTOP 挂起了一会儿，删掉它的心跳等于永久抹掉它的身份。
const RUNTIME_PROCESS_INSTANCE_HEARTBEAT_FILE_RETENTION_MS = 10 * RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS;

async function pruneLongDeadRuntimeProcessInstanceHeartbeats(nowEpochMs: number): Promise<void> {
	let fileNames: string[];
	try {
		fileNames = await readdir(getRuntimeProcessInstanceHeartbeatsDirectoryPath());
	} catch {
		return;
	}
	for (const fileName of fileNames) {
		if (!fileName.endsWith(".json")) {
			continue;
		}
		const filePath = join(getRuntimeProcessInstanceHeartbeatsDirectoryPath(), fileName);
		try {
			const raw = await readFile(filePath, "utf8");
			const candidate = runtimeProcessInstanceHeartbeatSchema.safeParse(JSON.parse(raw) as unknown);
			// 读坏的心跳文件也按年龄裁（它对判活已经没有贡献，只剩占位）。
			const lastHeartbeatAtEpochMs = candidate.success ? candidate.data.lastHeartbeatAtEpochMs : 0;
			if (nowEpochMs - lastHeartbeatAtEpochMs > RUNTIME_PROCESS_INSTANCE_HEARTBEAT_FILE_RETENTION_MS) {
				await rm(filePath, { force: true });
			}
		} catch {
			// 清理失败无害：下一个实例启动时再试一次。
		}
	}
}

export interface RunningRuntimeProcessInstanceHeartbeat {
	runtimeProcessInstanceId: string;
	startedAtEpochMs: number;
	stop: () => Promise<void>;
}

// 启动心跳：立刻写一次（于是同刻启动的另一个实例马上就能看见我），然后按节拍续期。
//
// 定时器 unref：心跳是纠偏设施，不该成为进程退不掉的理由。
export async function startRuntimeProcessInstanceHeartbeat(input?: {
	nowEpochMs?: number;
	intervalMs?: number;
}): Promise<RunningRuntimeProcessInstanceHeartbeat> {
	const startedAtEpochMs = input?.nowEpochMs ?? Date.now();
	const intervalMs = input?.intervalMs ?? RUNTIME_PROCESS_INSTANCE_HEARTBEAT_INTERVAL_MS;
	const runtimeProcessInstanceId = THIS_RUNTIME_PROCESS_INSTANCE_ID;
	const buildHeartbeat = (nowEpochMs: number): RuntimeProcessInstanceHeartbeat => ({
		runtimeProcessInstanceId,
		pid: process.pid,
		startedAtEpochMs,
		lastHeartbeatAtEpochMs: nowEpochMs,
	});
	await writeRuntimeProcessInstanceHeartbeat(buildHeartbeat(startedAtEpochMs));
	void pruneLongDeadRuntimeProcessInstanceHeartbeats(startedAtEpochMs);
	// 关停与「已经开始的那一次续期」之间的竞态，必须两道一起堵，缺一不可。
	//
	// 曾经的写法是 `void write(...)` 放飞 + `stop()` 里 `clearInterval` 后立刻 `rm`。`clearInterval`
	// 只阻止**下一次**触发，拦不住一次已经进到函数体里、正停在 `mkdir` 那个 await 上的续期。于是：
	//   stop() 删掉心跳文件 → 那次续期恢复执行 → writeFile **重新创建一份崭新的心跳**
	// 一个已经退出的进程就此在磁盘上"活着"整整一个宽限期。后果是本设计里最坏的那一种：真正的重启
	// 发生时，清扫读到这份假心跳、判定旧 custodian 仍活着，于是**漏掉 restart-crossing 盖章**——
	// 队列在重启后不提醒就直接发。整个模块的价值主张就是"没有任何排列能推出漏盖"，这条会把它打穿。
	//
	//   ① `stopped` 标志：拦住**还没开始**的续期（含已排队但尚未执行的那次触发）；
	//   ② `await inFlightHeartbeatWrite`：等**已经开始**的那次落地，再删。
	// 只做 ① 拦不住正在 await 中的那次；只做 ② 拦不住"排在 rm 之后才开始"的那次。
	let stopped = false;
	let inFlightHeartbeatWrite: Promise<unknown> = Promise.resolve();
	const timer = setInterval(() => {
		if (stopped) {
			return;
		}
		// 续期失败（磁盘满 / 权限）不抛到定时器外：最坏结果是本实例被别人判死、它的队列条目多盖一次章，
		// 那是保守方向；把异常抛出去反而会打断整个进程。
		// 句柄同步留下来，好让 stop() 等得到它——放飞而不留句柄正是上面那条竞态的成因。
		inFlightHeartbeatWrite = writeRuntimeProcessInstanceHeartbeat(buildHeartbeat(Date.now())).catch(() => undefined);
	}, intervalMs);
	timer.unref();
	return {
		runtimeProcessInstanceId,
		startedAtEpochMs,
		stop: async () => {
			stopped = true;
			clearInterval(timer);
			await inFlightHeartbeatWrite;
			// 优雅退出时**主动删掉自己的心跳**：于是下一个实例不必等满宽限期才敢判我死，重启后的
			// restart-crossing 盖章能立刻生效，而不是迟到两分钟。非优雅退出没有这一步，靠宽限期兜底。
			// 必须排在上面那个 await 之后：删完再被续期重建，等于没删。
			await rm(getRuntimeProcessInstanceHeartbeatPath(runtimeProcessInstanceId), { force: true }).catch(
				() => undefined,
			);
		},
	};
}
