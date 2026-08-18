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
//
// 2026-08 复盘补课：只记「创建」判不出**并发**。同一个 task 先后两次刷新与重叠两次刷新，在只有创建记录的
// 通道里产生逐字相同的两行——而这恰恰是「前端重复触发」与「服务端换代竞态」这两个成因的唯一分辨点。
// 因此本模块同时记录退出，并给每条记录带上三样东西：
//   - ptySessionSpawnSequenceNumber：进程内单调序号，创建时分配、退出时回填，两条记录据此配对；
//   - livePtySessionCountAfterSpawn / ...AfterExit：一行自证并发，不必跨行推理；
//   - taskSessionStartRequestId + 请求起始时刻：把「请求区间」而不是「创建时刻」画出来。只有点没有区间，
//     就看不见重叠窗口——而竞态窗口恰在「置空 active → 两次 await → 装载新代」这段区间里。
// 退出记录顺带带上 exitCode 与本代存活时长，这是追「什么燃料让新生 pty 持续秒死」的直接抓手。

import {
	appendDiagnosticEventToRotatingJsonlJournal,
	type DiagnosticEventJournalChannel,
} from "./rotating-jsonl-diagnostic-event-journal";

export type PtySessionSpawnReason = "task_agent_session" | "shell_session" | "unattributed";

// 前四个是服务端自己判定的；后三个必须由**客户端声明**，因为服务端收到的请求形状完全相同——
// 「用户手点 Restart」与「前端发现会话已陈旧、自动续跑」打到的是同一个 refreshTaskTerminal，
// 实测占创建量 68% 的 refresh_task_terminal 里究竟有多少是人点的，不加声明就永远分不出来。
export type TaskSessionStartOrigin =
	| "external_entry_point"
	| "refresh_task_terminal"
	| "resume_reclaimed_task_session_for_pending_user_decision_answer_delivery"
	| "auto_restart_after_pty_exit"
	// 前端 persistent-terminal-manager 的 maybeAutoResumeStaleSession：聚焦到一张 pid 为空且快照为空的
	// 卡片时自动续跑。它是前端唯一由「会话已退出」驱动的自动创建路径，也是成环嫌疑最大的一条。
	| "stale_session_client_auto_resume"
	// 前端 Home 侧栏会话的启动 effect。
	| "home_agent_panel_auto_start"
	// 服务端从 durable board + runtime config 重建续跑请求（Kanban 整进程重启后内存态 restartRequest 已丢失）。
	// 刻意不复用 resume_reclaimed_task_session_for_pending_user_decision_answer_delivery：那会抹掉
	// 「内存 restartRequest 续跑」与「durable 重建续跑」的区别，而这两者的成因与修法完全不同。
	| "durable_record_rebuilt_resume";

export interface PtySessionSpawnAttribution {
	reason: PtySessionSpawnReason;
	taskId: string;
	taskSessionStartOrigin?: TaskSessionStartOrigin;
	// 一次会话启动尝试的标识与起始时刻，由 manager 在进入 startTaskSession / startShellSession 的那一刻生成。
	// 记的是**区间的左端**：右端就是本条 spawn 记录自己的 recordedAtIso。两个请求区间重叠即为并发直证——
	// 这正是「服务端 per-task 启动互斥有没有生效、还有没有第三条入口」的判据。
	taskSessionStartRequestId?: string;
	taskSessionStartRequestStartedAtIso?: string;
	// 拿到 per-task 启动互斥闸门的时刻。与上面那个「请求到达时刻」是**两件事**，必须都记：
	//   - [到达, 创建] 区间重叠 ⇒ 两个请求确实并发到达了（互斥随后把它们串行化，这是**预期**行为）；
	//   - [拿到闸门, 创建] 区间重叠 ⇒ 互斥没生效，或存在绕过它的第三条入口（这才是**故障**）。
	// 只记后者会把排队并发记成串行、让复发现场拿到「请求未重叠」的错误证据；只记前者则分不出
	// 「并发到达但被正确串行化」与「互斥失效」。
	taskSessionStartExclusivityAcquiredAtIso?: string;
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
// 进程内单调序号：每次**成功**的 pty 创建分配一个，退出记录回填同一个值，两条记录据此配对。
// 失败的 spawn 不分配——它没有进程、也永远不会有退出事件，占号只会在配对时留下等不到的空洞。
let ptySessionSpawnSequenceNumberCounter = 0;
// 本进程当前存活的 pty 数（成功创建 +1、退出 -1）。孤儿堆积会直接表现为它只涨不跌。
let livePtySessionCount = 0;
// 存活数的历史峰值，只用于让 stderr 水位「每档一生只报一次」：存活数天然上下起伏，
// 拿上一拍读数当基线会在同一档位反复触发。
let peakLivePtySessionCount = 0;

// 存活 pty 数的 stderr 水位。起点取 16 而非 1：一个任务一条 pty 是正常形态，本机可达的并发
// in_progress 上限是 36，低档位只会在正常使用时刷屏。真正的异常形态是它爬到远超任务数。
const LIVE_PTY_SESSION_COUNT_STDERR_WATERMARK_TIERS = [16, 32, 64, 128, 256, 512, 1_024, 2_048];

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
// liveCount / peakLiveCount 回答的是另一个问题——「这些创建是先后还是重叠」，累计数对此完全无能为力。
export function getPtySessionSpawnCountSnapshot(): {
	succeededTotalCount: number;
	failedTotalCount: number;
	succeededCountsByReason: Record<string, number>;
	livePtySessionCount: number;
	peakLivePtySessionCount: number;
} {
	return {
		succeededTotalCount: ptySessionSpawnSucceededTotalCount,
		failedTotalCount: ptySessionSpawnFailedTotalCount,
		succeededCountsByReason: Object.fromEntries(ptySessionSpawnSucceededCountsByReason),
		livePtySessionCount,
		peakLivePtySessionCount,
	};
}

// 返回本次分配的单调序号；spawn 失败时返回 null（失败不占号，理由见计数器声明处）。
// 调用方（PtySession）必须把它连同创建时刻一起留在实例上，退出时回传给 recordPtySessionExitOutcome。
export function recordPtySessionSpawnOutcome(input: {
	attribution: PtySessionSpawnAttribution | null;
	spawnedPid: number | null;
	spawnErrorCode: string | null;
	spawnErrorMessage: string | null;
}): number | null {
	const reason = input.attribution?.reason ?? "unattributed";

	// 失败路径：只记事件与失败计数，绝不进「已创建的 pty」基数——它没有分配 kqueue，不该被对账。
	if (input.spawnErrorCode !== null) {
		ptySessionSpawnFailedTotalCount += 1;
		appendProbeEvent("pty-session-spawn", {
			outcome: "failed",
			reason,
			taskId: input.attribution?.taskId ?? null,
			taskSessionStartOrigin: input.attribution?.taskSessionStartOrigin ?? null,
			taskSessionStartRequestId: input.attribution?.taskSessionStartRequestId ?? null,
			taskSessionStartRequestStartedAtIso: input.attribution?.taskSessionStartRequestStartedAtIso ?? null,
			taskSessionStartExclusivityAcquiredAtIso: input.attribution?.taskSessionStartExclusivityAcquiredAtIso ?? null,
			spawnedPid: null,
			spawnErrorCode: input.spawnErrorCode,
			spawnErrorMessage: input.spawnErrorMessage,
			cumulativeSucceededTotalCount: ptySessionSpawnSucceededTotalCount,
			cumulativeFailedTotalCount: ptySessionSpawnFailedTotalCount,
			livePtySessionCount,
		});
		// spawn 失败无条件打 stderr（不走水位节流）：它稀有，且正是 fd 耗尽最直接的证据。
		emitProbeStderrLine(
			`[warn] [pty-spawn-probe] pty.spawn 失败 reason=${reason} taskId=${input.attribution?.taskId ?? "(none)"} errorCode=${input.spawnErrorCode} cumulativeSucceeded=${ptySessionSpawnSucceededTotalCount} cumulativeFailed=${ptySessionSpawnFailedTotalCount}`,
		);
		return null;
	}

	const previousSucceededTotalCount = ptySessionSpawnSucceededTotalCount;
	ptySessionSpawnSucceededTotalCount += 1;
	const succeededCountForReason = (ptySessionSpawnSucceededCountsByReason.get(reason) ?? 0) + 1;
	ptySessionSpawnSucceededCountsByReason.set(reason, succeededCountForReason);
	ptySessionSpawnSequenceNumberCounter += 1;
	const ptySessionSpawnSequenceNumber = ptySessionSpawnSequenceNumberCounter;
	livePtySessionCount += 1;

	appendProbeEvent("pty-session-spawn", {
		outcome: "succeeded",
		reason,
		taskId: input.attribution?.taskId ?? null,
		taskSessionStartOrigin: input.attribution?.taskSessionStartOrigin ?? null,
		taskSessionStartRequestId: input.attribution?.taskSessionStartRequestId ?? null,
		taskSessionStartRequestStartedAtIso: input.attribution?.taskSessionStartRequestStartedAtIso ?? null,
		taskSessionStartExclusivityAcquiredAtIso: input.attribution?.taskSessionStartExclusivityAcquiredAtIso ?? null,
		ptySessionSpawnSequenceNumber,
		spawnedPid: input.spawnedPid,
		spawnErrorCode: null,
		spawnErrorMessage: null,
		cumulativeSucceededTotalCount: ptySessionSpawnSucceededTotalCount,
		cumulativeFailedTotalCount: ptySessionSpawnFailedTotalCount,
		cumulativeSucceededCountForReason: succeededCountForReason,
		// 本条创建落地之后的存活 pty 数。一行自证并发：> 1 即此刻确有多条 pty 并存。
		livePtySessionCountAfterSpawn: livePtySessionCount,
	});

	emitLivePtySessionCountWatermarkStderrLineIfCrossed(input.attribution?.taskId ?? null);

	const crossedTier = findCrossedStderrWatermarkTier(
		previousSucceededTotalCount,
		ptySessionSpawnSucceededTotalCount,
		PTY_SESSION_SPAWN_COUNT_STDERR_WATERMARK_TIERS,
	);
	if (crossedTier === null) {
		return ptySessionSpawnSequenceNumber;
	}
	const countsByReasonSummary = Array.from(
		ptySessionSpawnSucceededCountsByReason,
		([key, count]) => `${key}=${count}`,
	).join(" ");
	emitProbeStderrLine(
		`[warn] [pty-spawn-probe] 本进程累计 pty 创建数越过水位 tier=${crossedTier} succeededTotal=${ptySessionSpawnSucceededTotalCount} failedTotal=${ptySessionSpawnFailedTotalCount} live=${livePtySessionCount} ${countsByReasonSummary}`,
	);
	return ptySessionSpawnSequenceNumber;
}

// 一次「到了闸门跟前、但因为已有活会话在跑而被折叠掉」的启动请求。
//
// 它不产生 pty，所以此前在归因通道里**完全没有痕迹**——而这正好抹掉了并发的最强证据：两个并发请求里
// 被折叠的那一个不留记录，剩下那一个看起来就像一次孤零零的正常启动。追「谁在高速发起启动」时，
// 被折叠的请求与真的创建了 pty 的请求同等重要。
//
// 走 pty-session-spawn 同一条通道而不是新开一条：读者要的是一条按时间排好的启动时间线，
// 拆成两个文件反而要自己 merge。outcome 是这条记录的第一分叉，不会与创建记录混淆。
export function recordTaskSessionStartRequestFoldedIntoRunningSession(input: {
	taskId: string;
	taskSessionStartOrigin: TaskSessionStartOrigin;
	taskSessionStartRequestId: string;
	taskSessionStartRequestStartedAtIso: string;
	taskSessionStartExclusivityAcquiredAtIso: string;
}): void {
	appendProbeEvent("pty-session-spawn", {
		outcome: "folded_into_running_session",
		reason: "task_agent_session",
		taskId: input.taskId,
		taskSessionStartOrigin: input.taskSessionStartOrigin,
		taskSessionStartRequestId: input.taskSessionStartRequestId,
		taskSessionStartRequestStartedAtIso: input.taskSessionStartRequestStartedAtIso,
		taskSessionStartExclusivityAcquiredAtIso: input.taskSessionStartExclusivityAcquiredAtIso,
		spawnedPid: null,
		livePtySessionCount,
	});
}

function emitLivePtySessionCountWatermarkStderrLineIfCrossed(latestTaskId: string | null): void {
	if (livePtySessionCount <= peakLivePtySessionCount) {
		return;
	}
	const previousPeak = peakLivePtySessionCount;
	peakLivePtySessionCount = livePtySessionCount;
	const crossedTier = findCrossedStderrWatermarkTier(
		previousPeak,
		peakLivePtySessionCount,
		LIVE_PTY_SESSION_COUNT_STDERR_WATERMARK_TIERS,
	);
	if (crossedTier === null) {
		return;
	}
	emitProbeStderrLine(
		`[warn] [pty-spawn-probe] 并存的 pty 数越过水位 tier=${crossedTier} live=${livePtySessionCount} latestTaskId=${latestTaskId ?? "(none)"}`,
	);
}

// 退出记录。与创建记录同源同序号，是「先后」与「重叠」的唯一分辨器：两条 spawn 之间夹着对应的 exit ⇒ 先后；
// 夹不到 ⇒ 重叠。exitCode 与存活时长同时是「什么燃料让新生 pty 持续秒死」的直接抓手。
//
// 存活时长由调用方（PtySession）从自己实例上的创建时刻算出来后传入，而不是本模块按序号建表暂存：
// 建表就要负责清表，而「退出事件永不到达」恰恰是本模块要观测的异常本身——那种情况下表会随之泄漏。
export function recordPtySessionExitOutcome(input: {
	attribution: PtySessionSpawnAttribution | null;
	ptySessionSpawnSequenceNumber: number | null;
	spawnedPid: number;
	exitCode: number;
	exitSignal: number | null;
	ptySessionLifetimeMs: number;
}): void {
	// 只有分配过序号（即成功创建）的会话才计入存活数，否则退出记录会把计数带成负数。
	if (input.ptySessionSpawnSequenceNumber !== null && livePtySessionCount > 0) {
		livePtySessionCount -= 1;
	}

	// 退出时刻即本条记录的 recordedAtIso（由 journal 无条件写入），故不再另起一个同义字段。
	appendProbeEvent("pty-session-exit", {
		reason: input.attribution?.reason ?? "unattributed",
		taskId: input.attribution?.taskId ?? null,
		taskSessionStartOrigin: input.attribution?.taskSessionStartOrigin ?? null,
		taskSessionStartRequestId: input.attribution?.taskSessionStartRequestId ?? null,
		ptySessionSpawnSequenceNumber: input.ptySessionSpawnSequenceNumber,
		spawnedPid: input.spawnedPid,
		exitCode: input.exitCode,
		exitSignal: input.exitSignal,
		ptySessionLifetimeMs: input.ptySessionLifetimeMs,
		livePtySessionCountAfterExit: livePtySessionCount,
	});
}

// 一次自动重启**判定**的记录——不只是「排了一次重启」，也包括「这次判定决定不再重启了」。
//
// 通道名仍叫 task-session-auto-restart-scheduled：既有的 journal 文件与既有的判读口径都挂在这个名字上，
// 为一次字段扩容改名会把历史数据切成两段。decisionKind 才是读这条记录时的第一分叉。
export function recordTaskSessionAutoRestartDecision(input: {
	taskId: string;
	decisionKind: "restart_after_backoff" | "circuit_broken";
	circuitBreakReason: string | null;
	backoffMs: number | null;
	previousIncarnationLifetimeMs: number | null;
	previousIncarnationCountsAsHealthy: boolean;
	consecutiveFailedFastExitAutoRestartCount: number;
	autoRestartCountForThisTaskWithinRollingHour: number;
	fastExitAutoRestartCountAcrossAllTasksWithinRollingHour: number;
	listenerCount: number;
}): void {
	const previousTotalCount = taskSessionAutoRestartScheduledTotalCount;
	// 水位计数只数**真的排了重启**的那些：熔断是停手，把它算进「累计重启数」会让水位读数说谎。
	if (input.decisionKind === "restart_after_backoff") {
		taskSessionAutoRestartScheduledTotalCount += 1;
	}

	appendProbeEvent("task-session-auto-restart-scheduled", {
		taskId: input.taskId,
		decisionKind: input.decisionKind,
		circuitBreakReason: input.circuitBreakReason,
		backoffMs: input.backoffMs,
		// 上一代活了多久 + 够不够健康门。持续的小数值就是「燃料」的直接线索：某种原因让每条新生的
		// pty 都在数秒内死掉，而这正是本轮没能解释的那个量级缺口。
		previousIncarnationLifetimeMs: input.previousIncarnationLifetimeMs,
		previousIncarnationCountsAsHealthy: input.previousIncarnationCountsAsHealthy,
		consecutiveFailedFastExitAutoRestartCount: input.consecutiveFailedFastExitAutoRestartCount,
		// 两个滚动小时窗的当前读数。与存活时长无关，是慢环（每代都活得够久、连续计数永不增长）
		// 唯一看得见的量。
		autoRestartCountForThisTaskWithinRollingHour: input.autoRestartCountForThisTaskWithinRollingHour,
		fastExitAutoRestartCountAcrossAllTasksWithinRollingHour:
			input.fastExitAutoRestartCountAcrossAllTasksWithinRollingHour,
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
		`[warn] [pty-spawn-probe] 本进程累计任务会话自动重启数越过水位 tier=${crossedTier} total=${taskSessionAutoRestartScheduledTotalCount} latestTaskId=${input.taskId} consecutiveFastExits=${input.consecutiveFailedFastExitAutoRestartCount} perTaskThisHour=${input.autoRestartCountForThisTaskWithinRollingHour} allTasksFastExitThisHour=${input.fastExitAutoRestartCountAcrossAllTasksWithinRollingHour} listeners=${input.listenerCount}`,
	);
}
