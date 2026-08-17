// pty 会话创建的归因计数——「谁在创建 pty、创建了多少」的常设记录。
//
// 由来：2026-08 的一次真实故障里，node-pty 每个 pty 生命周期泄漏 1 个 kqueue fd（上游 PR #931 已修，
// 见 package.json 对该依赖的版本下限），13 小时累积上万个把进程 fd 表撑破 Darwin 的 OPEN_MAX，导致
// posix_spawn 建管道 EBADF、所有 git 调用全挂。泄漏本身好定位，**谁在高速创建 pty** 却完全无从直证：
// pty 创建这条路径上原本一行日志都没有，现场冻结后 pty 对象早已 GC，终端回滚缓冲盖不住一整晚。
//
// 修掉泄漏并不能让这个盲区消失，恰恰相反——**它把症状抹掉了，成因还在**。同样的失控创建今后不再表现
// 为 fd 增长，只剩安静的空转（按当年速率约每小时 2000 次进程创建），届时本模块就是仅存的抓手。
// 因此它不随调查结束而摘除，而是转为常设绊线：
//   - 计数点放在 PtySession.spawn **内部**而非调用点，这样即便存在尚未发现的创建路径也一样被记到
//     （reason=unattributed）——不能靠假设调用点已穷举，新增调用路径时也不必记得来这里补一笔；
//   - 任务会话再按启动来源细分：外部入口 / 终端刷新 / 回收会话恢复 / PTY 退出后自动重启。
//     最后一种最值得盯：它不是熔断器，只是「5 秒内最多 3 次」的滑动窗口限速器，无总量上限、无退避，
//     其 0.6 次/秒的理论上限恰好覆盖当年的实测速率，且门控 listeners.size>0 也解释了泄漏为何会随
//     WS 订阅断开而自行停止。要给它加熔断，先靠本通道的记录看清真实成环参数，别凭空设阈值；
//   - stderr 只在累计数跨越水位档时打一次，绝不逐条打印——逐条打印会重演「探针自己刷爆日志」。

import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
} from "./rotating-jsonl-diagnostic-event-journal";

export type PtySessionSpawnReason = "task_agent_session" | "shell_session" | "unattributed";

export type TaskSessionStartOrigin =
	| "external_entry_point"
	| "refresh_task_terminal"
	| "resume_reclaimed_task_session_for_pending_user_decision_answer_delivery"
	| "auto_restart_after_pty_exit";

export interface PtySessionSpawnAttribution {
	reason: PtySessionSpawnReason;
	taskId: string;
	taskSessionStartOrigin?: TaskSessionStartOrigin;
}

// 累计计数跨越这些档位时各打一次 stderr。前段密是为了让「刚开始不正常」尽早可见，
// 后段稀是为了在真的失控时不喧宾夺主。10240 是 Darwin 的 OPEN_MAX——泄漏 1:1 时它就是死线。
const PTY_SESSION_SPAWN_COUNT_STDERR_WATERMARK_TIERS = [
	1, 25, 100, 250, 500, 1_000, 2_500, 5_000, 7_500, 10_000, 10_240, 15_000, 20_000,
];
const TASK_SESSION_AUTO_RESTART_COUNT_STDERR_WATERMARK_TIERS = [
	1, 5, 25, 100, 250, 500, 1_000, 2_500, 5_000, 7_500, 10_000,
];

// 成功与失败必须分开计数。unix 侧 node-pty 分配 kqueue 的 SetupExitCallback 排在所有 throw 点之后——
// **抛错的 spawn 根本走不到 kqueue 分配，不产生要对账的泄漏**。若把失败尝试混进同一个累计数，fd 增量
// 就会去和一个并不存在的会话对账，「fd 增量 ≈ 创建数」这条对账随即失真。
// 失败事件本身仍要记（那是 fd 耗尽最直接的证据），只是不进「已创建的 pty」这个基数。
//
// Windows 例外：node-pty 自 1.2.0-beta.14 起，conPTY 路径上 CreateProcessW 失败改为发 `'exit'` 事件而非
// 抛出，PtySession.spawn 的 catch 收不到，本模块会把它记成一次成功创建。macOS/Linux 不受影响，而对账
// 本身也只在 unix 上有意义（kqueue 是 BSD 设施），故不为此在计数侧做补偿——仅在此标明读数边界。
const ptySessionSpawnSucceededCountsByReason = new Map<PtySessionSpawnReason, number>();
let ptySessionSpawnSucceededTotalCount = 0;
let ptySessionSpawnFailedTotalCount = 0;
let taskSessionAutoRestartScheduledTotalCount = 0;

// 返回本次跨过的最高档位；没跨过任何档位则返回 null。
export function findCrossedStderrWatermarkTier(
	previousCount: number,
	currentCount: number,
	watermarkTiers: number[],
): number | null {
	let highestCrossedTier: number | null = null;
	for (const tier of watermarkTiers) {
		if (previousCount < tier && currentCount >= tier) {
			highestCrossedTier = tier;
		}
	}
	return highestCrossedTier;
}

function emitProbeStderrLine(line: string): void {
	try {
		process.stderr.write(`${line}\n`);
	} catch {
		// Best-effort diagnostic logging only.
	}
}

function appendProbeEvent(channel: DiagnosticEventJournalChannel, payload: Record<string, unknown>): void {
	appendDiagnosticEventToRotatingJsonlJournal(channel, payload);
}

// succeededTotalCount 才是与 fd 增量对账的那个基数；failedTotalCount 单独暴露，供判断「失败是否已开始发生」。
export function getPtySessionSpawnCountSnapshot(): {
	succeededTotalCount: number;
	failedTotalCount: number;
	succeededCountsByReason: Record<string, number>;
} {
	return {
		succeededTotalCount: ptySessionSpawnSucceededTotalCount,
		failedTotalCount: ptySessionSpawnFailedTotalCount,
		succeededCountsByReason: Object.fromEntries(ptySessionSpawnSucceededCountsByReason),
	};
}

export function recordPtySessionSpawnOutcome(input: {
	attribution: PtySessionSpawnAttribution | null;
	spawnedPid: number | null;
	spawnErrorCode: string | null;
	spawnErrorMessage: string | null;
}): void {
	const reason = input.attribution?.reason ?? "unattributed";

	// 失败路径：只记事件与失败计数，绝不进「已创建的 pty」基数——它没有分配 kqueue，不该被对账。
	if (input.spawnErrorCode !== null) {
		ptySessionSpawnFailedTotalCount += 1;
		appendProbeEvent("pty-session-spawn", {
			outcome: "failed",
			reason,
			taskId: input.attribution?.taskId ?? null,
			taskSessionStartOrigin: input.attribution?.taskSessionStartOrigin ?? null,
			spawnedPid: null,
			spawnErrorCode: input.spawnErrorCode,
			spawnErrorMessage: input.spawnErrorMessage,
			cumulativeSucceededTotalCount: ptySessionSpawnSucceededTotalCount,
			cumulativeFailedTotalCount: ptySessionSpawnFailedTotalCount,
		});
		// spawn 失败无条件打 stderr（不走水位节流）：它稀有，且正是 fd 耗尽最直接的证据。
		emitProbeStderrLine(
			`[warn] [pty-spawn-probe] pty.spawn 失败 reason=${reason} taskId=${input.attribution?.taskId ?? "(none)"} errorCode=${input.spawnErrorCode} cumulativeSucceeded=${ptySessionSpawnSucceededTotalCount} cumulativeFailed=${ptySessionSpawnFailedTotalCount}`,
		);
		return;
	}

	const previousSucceededTotalCount = ptySessionSpawnSucceededTotalCount;
	ptySessionSpawnSucceededTotalCount += 1;
	const succeededCountForReason = (ptySessionSpawnSucceededCountsByReason.get(reason) ?? 0) + 1;
	ptySessionSpawnSucceededCountsByReason.set(reason, succeededCountForReason);

	appendProbeEvent("pty-session-spawn", {
		outcome: "succeeded",
		reason,
		taskId: input.attribution?.taskId ?? null,
		taskSessionStartOrigin: input.attribution?.taskSessionStartOrigin ?? null,
		spawnedPid: input.spawnedPid,
		spawnErrorCode: null,
		spawnErrorMessage: null,
		cumulativeSucceededTotalCount: ptySessionSpawnSucceededTotalCount,
		cumulativeFailedTotalCount: ptySessionSpawnFailedTotalCount,
		cumulativeSucceededCountForReason: succeededCountForReason,
	});

	const crossedTier = findCrossedStderrWatermarkTier(
		previousSucceededTotalCount,
		ptySessionSpawnSucceededTotalCount,
		PTY_SESSION_SPAWN_COUNT_STDERR_WATERMARK_TIERS,
	);
	if (crossedTier === null) {
		return;
	}
	const countsByReasonSummary = Array.from(
		ptySessionSpawnSucceededCountsByReason,
		([key, count]) => `${key}=${count}`,
	).join(" ");
	emitProbeStderrLine(
		`[warn] [pty-spawn-probe] 本进程累计 pty 创建数越过水位 tier=${crossedTier} succeededTotal=${ptySessionSpawnSucceededTotalCount} failedTotal=${ptySessionSpawnFailedTotalCount} ${countsByReasonSummary}`,
	);
}

export function recordTaskSessionAutoRestartScheduled(input: {
	taskId: string;
	autoRestartTimestampsInWindowCount: number;
	listenerCount: number;
}): void {
	const previousTotalCount = taskSessionAutoRestartScheduledTotalCount;
	taskSessionAutoRestartScheduledTotalCount += 1;

	appendProbeEvent("task-session-auto-restart-scheduled", {
		taskId: input.taskId,
		// 5 秒滑动窗口内已消耗的重启配额（上限 3）——贴着上限跑即为自动重启循环的直证。
		autoRestartTimestampsInWindowCount: input.autoRestartTimestampsInWindowCount,
		// 决定循环能否持续的门控：降到 0 就停，这解释了泄漏为何会自行终止。
		listenerCount: input.listenerCount,
		cumulativeTotalCount: taskSessionAutoRestartScheduledTotalCount,
	});

	const crossedTier = findCrossedStderrWatermarkTier(
		previousTotalCount,
		taskSessionAutoRestartScheduledTotalCount,
		TASK_SESSION_AUTO_RESTART_COUNT_STDERR_WATERMARK_TIERS,
	);
	if (crossedTier === null) {
		return;
	}
	emitProbeStderrLine(
		`[warn] [pty-spawn-probe] 本进程累计任务会话自动重启数越过水位 tier=${crossedTier} total=${taskSessionAutoRestartScheduledTotalCount} latestTaskId=${input.taskId} windowRestarts=${input.autoRestartTimestampsInWindowCount} listeners=${input.listenerCount}`,
	);
}
