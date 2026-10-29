// runtime 退出的完整流程（计划内 handover、信号停止、显式全停共用；差别只在几处开关）。
//
// 计划内 handover（`kanban runtime handover-restart` / SIGUSR2）要做到「agent 毫无察觉」：
//   1. 新会话一律不起（起在本 runtime 里的进程内 PTY 活不过退出；起在 host 里的赶不上最终接管记录）；
//      写「正在 handover」标记，窗口内的 CLI 写动词据此等待重试；
//   2. 不再起新的后台工作（回收调度、排队 prompt 出队、陈旧清扫），HTTP 停止接受新连接（新到的 hook 走 spool），
//      浏览器连接以 1012 关闭，web-ui 提示「正在热重启」；
//   3. 排空易断的操作（各有上限，到点就不等了，退化为崩溃路径的语义）：
//      - 在途的程序化 PTY 输入投递（paste + 延迟回车等多段序列，腰斩会在输入框里留下半截输入）；
//      - 刚 spawn 的会话的启动期（agent 启动时发出的终端查询在 runtime 缺席的窗口里没人应答）；
//      - 打印在途的 exploration 维护作业数（它们是 runtime 子进程，会被中止，下次 Stop 重新 fork）；
//   4. 冻结 host 链路：不再消费任何会话事件，每条句柄的输出偏移就此固定；等在途的 spool 应用跑完；
//   5. 每条 hosted 会话：停掉定时器 → 存屏幕 checkpoint → 推最终接管记录（带孤儿回收期限）→ detach（绝不发信号）；
//      ACP / Cline 会话照旧安全停止；持久化；
//   6. 把排队的控制消息写进内核再断开 host 连接。
// 信号停止（保活）跳过第 1 步的标记与第 3 步的等待（supervisor 给的时间不多，且停下之后未必马上有人接管），其余相同。
// 显式全停按旧语义终止全部会话，并让每个 generation 的 host 连同未接管的会话一起终止后退出。

import type { RuntimeAgentSessionCountsAffectedByRuntimeExit } from "../core/api-contract";
import {
	type KanbanRuntimeHandoverRestartInProgressMarker,
	removeKanbanRuntimeHandoverRestartInProgressMarker,
	writeKanbanRuntimeHandoverRestartInProgressMarker,
} from "../core/kanban-runtime-handover-restart-in-progress-marker";
import {
	describeRuntimeShutdownTrigger,
	type HostedAgentSessionDispositionForRuntimeShutdown,
	type RuntimeShutdownTrigger,
} from "../core/runtime-shutdown-trigger";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { RuntimeServer } from "./runtime-server";
import { type RuntimeShutdownOutcome, shutdownRuntimeServer } from "./shutdown-coordinator";

// EXPERIMENT_NODE: handover 等在途程序化投递走完的上限。投递的「已提交」确认可能要等很久（最长 ~200s），这里只求
// 多段序列别被腰斩；到点仍未落定的，由下一次启动的清扫判成「可能已发出」交给人。
export const PLANNED_HANDOVER_WAIT_FOR_UNSETTLED_PROGRAMMATIC_INPUT_DELIVERIES_MAXIMUM_MS = 10_000;
// EXPERIMENT_NODE: 刚 spawn 的会话在这么久之内视为仍在启动期（agent 启动时会发 DA / CPR / OSC10/11 查询，crossterm 系
// 2s 内收不到 CPR 应答就报错）。handover 等最年轻的会话过了这个年龄再 detach；上限即这个时长本身。
export const PLANNED_HANDOVER_HOSTED_SESSION_STARTUP_TERMINAL_QUERY_WINDOW_MS = 5_000;
const PLANNED_HANDOVER_UNSETTLED_DELIVERY_POLL_INTERVAL_MS = 100;

export interface KanbanRuntimeExitAgentSessionPtyHostFacade {
	refuseNewSpawnsBecauseRuntimeIsShuttingDown(): void;
	freezeHostedSessionEventRoutingAndStopHookSpoolDrainsForRuntimeHandover(): Promise<void>;
	requestEveryGenerationHostToTerminateAllHostedSessionsAndExit(): number;
	closeControllerConnectionsAfterFlushingPendingFrames(): Promise<void>;
}

export interface KanbanRuntimeExitSequenceDependencies {
	trigger: RuntimeShutdownTrigger;
	hostedAgentSessionDisposition: HostedAgentSessionDispositionForRuntimeShutdown;
	agentSessionPtyHostRuntimeFacade: KanbanRuntimeExitAgentSessionPtyHostFacade | null;
	runtimeServer: Pick<
		RuntimeServer,
		| "stopAcceptingNewWorkBeforeRuntimeExit"
		| "countAgentSessionsAffectedByRuntimeExit"
		| "stopAllActiveRuntimeSessionsForShutdown"
		| "close"
	>;
	listTerminalSessionManagers: () => Array<
		Pick<
			TerminalSessionManager,
			"listTaskIdsWithUnsettledProgrammaticTaskChatInputDelivery" | "listSpawnedAtEpochMsOfActiveHostedPtySessions"
		>
	>;
	handoverRestartInProgressMarker: { markerPath: string; marker: KanbanRuntimeHandoverRestartInProgressMarker };
	log: (message: string) => void;
	warn: (message: string) => void;
	readNowEpochMs?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
	// 测试注入：真实的关停协调器会读真实 HOME 下的 workspace 索引、清各仓库的 worktree 安装锁。
	shutdownRuntimeServer?: typeof shutdownRuntimeServer;
}

export interface KanbanRuntimeExitSequenceOutcome extends RuntimeShutdownOutcome {
	agentSessionCountsAffectedByRuntimeExit: RuntimeAgentSessionCountsAffectedByRuntimeExit;
}

function sleepWithTimer(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

async function waitForUnsettledProgrammaticInputDeliveriesToSettle(
	deps: KanbanRuntimeExitSequenceDependencies,
	queuedPromptDispatchQuiescence: ReturnType<RuntimeServer["stopAcceptingNewWorkBeforeRuntimeExit"]>,
	readNowEpochMs: () => number,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
	const deadlineEpochMs =
		readNowEpochMs() + PLANNED_HANDOVER_WAIT_FOR_UNSETTLED_PROGRAMMATIC_INPUT_DELIVERIES_MAXIMUM_MS;
	let queuedDispatchAttemptsSettled = false;
	void queuedPromptDispatchQuiescence.waitForAlreadyStartedQueuedPromptDispatchAttemptsToSettle().then(
		() => {
			queuedDispatchAttemptsSettled = true;
		},
		(error: unknown) => {
			deps.warn(`handover queue dispatch drain failed: ${error instanceof Error ? error.message : String(error)}`);
			queuedDispatchAttemptsSettled = true;
		},
	);
	// 已经空闲的 dispatcher 不额外占用一轮轮询时间。
	await Promise.resolve();
	let announcedWaiting = false;
	while (true) {
		const unsettledTaskIds = deps
			.listTerminalSessionManagers()
			.flatMap((manager) => manager.listTaskIdsWithUnsettledProgrammaticTaskChatInputDelivery());
		if (queuedDispatchAttemptsSettled && unsettledTaskIds.length === 0) {
			return;
		}
		if (readNowEpochMs() >= deadlineEpochMs) {
			deps.warn(
				`handover restart proceeds while queue dispatch settled=${queuedDispatchAttemptsSettled} and ${unsettledTaskIds.length} programmatic input delivery(ies) are still unsettled (${unsettledTaskIds.join(", ")}); the next runtime start flags them for review`,
			);
			return;
		}
		if (!announcedWaiting) {
			announcedWaiting = true;
			deps.log(`Waiting for ${unsettledTaskIds.length} programmatic input delivery(ies) to settle before handover.`);
		}
		await sleep(PLANNED_HANDOVER_UNSETTLED_DELIVERY_POLL_INTERVAL_MS);
	}
}

async function waitForYoungestHostedSessionToLeaveStartupTerminalQueryWindow(
	deps: KanbanRuntimeExitSequenceDependencies,
	readNowEpochMs: () => number,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
	const spawnedAtEpochMsList = deps
		.listTerminalSessionManagers()
		.flatMap((manager) => manager.listSpawnedAtEpochMsOfActiveHostedPtySessions());
	if (spawnedAtEpochMsList.length === 0) {
		return;
	}
	const youngestSpawnedAtEpochMs = Math.max(...spawnedAtEpochMsList);
	const remainingStartupWindowMs = Math.min(
		PLANNED_HANDOVER_HOSTED_SESSION_STARTUP_TERMINAL_QUERY_WINDOW_MS,
		youngestSpawnedAtEpochMs + PLANNED_HANDOVER_HOSTED_SESSION_STARTUP_TERMINAL_QUERY_WINDOW_MS - readNowEpochMs(),
	);
	if (remainingStartupWindowMs <= 0) {
		return;
	}
	deps.log(
		`Waiting ${remainingStartupWindowMs}ms for a just-started agent session to finish starting before handover.`,
	);
	await sleep(remainingStartupWindowMs);
}

export async function runKanbanRuntimeExitSequence(
	deps: KanbanRuntimeExitSequenceDependencies,
): Promise<KanbanRuntimeExitSequenceOutcome> {
	const readNowEpochMs = deps.readNowEpochMs ?? Date.now;
	const sleep = deps.sleep ?? sleepWithTimer;
	const isPlannedHandoverRestart = deps.trigger.kind === "planned_handover_restart_preserving_hosted_agent_sessions";
	const detachesHostedAgentSessions =
		deps.hostedAgentSessionDisposition === "detach_hosted_agent_sessions_for_successor_runtime";

	deps.agentSessionPtyHostRuntimeFacade?.refuseNewSpawnsBecauseRuntimeIsShuttingDown();
	if (isPlannedHandoverRestart) {
		try {
			writeKanbanRuntimeHandoverRestartInProgressMarker(
				deps.handoverRestartInProgressMarker.markerPath,
				deps.handoverRestartInProgressMarker.marker,
			);
		} catch (error) {
			// 没有标记只是让窗口内的 CLI 少一条重启证据（hosted 会话里还有 host 那条），不阻断 handover。
			deps.warn(
				`could not write the runtime handover restart marker: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const queuedPromptDispatchQuiescence = deps.runtimeServer.stopAcceptingNewWorkBeforeRuntimeExit({
		closeBrowserConnectionsBecauseRuntimeIsRestarting: isPlannedHandoverRestart,
	});
	const agentSessionCountsAffectedByRuntimeExit = deps.runtimeServer.countAgentSessionsAffectedByRuntimeExit();
	deps.log(
		`Kanban runtime exiting (${describeRuntimeShutdownTrigger(deps.trigger)}): ${agentSessionCountsAffectedByRuntimeExit.agentSessionsHostedByAgentSessionPtyHost} agent session(s) in the agent session pty host will be ${detachesHostedAgentSessions ? "kept running for the next runtime" : "terminated"}; ${agentSessionCountsAffectedByRuntimeExit.agentSessionsWithPtyOwnedByRuntimeProcess + agentSessionCountsAffectedByRuntimeExit.conversationAgentSessionsRunningInsideRuntimeProcess} session(s) owned by this runtime process end with it; ${agentSessionCountsAffectedByRuntimeExit.inFlightExplorationThreadGraphMaintenanceJobs} in-flight exploration maintenance job(s) will be aborted.`,
	);

	if (detachesHostedAgentSessions) {
		// 后台交接/收尾可能在 await 后最后一次改动会话或发送输入；完成后再盘点 receipt。
		// 未能关闭时不 detach，由外层关停期限结束 runtime，保留 host 的崩溃接管语义。
		await queuedPromptDispatchQuiescence.waitForRuntimeOwnedBackgroundServicesToStopBeforeSessionDetach();
	}

	if (isPlannedHandoverRestart && detachesHostedAgentSessions) {
		await waitForUnsettledProgrammaticInputDeliveriesToSettle(
			deps,
			queuedPromptDispatchQuiescence,
			readNowEpochMs,
			sleep,
		);
		await waitForYoungestHostedSessionToLeaveStartupTerminalQueryWindow(deps, readNowEpochMs, sleep);
	}
	// 排空到点也必须封住迟到的 validator，之后才能冻结输出偏移并断开旧 controller。
	queuedPromptDispatchQuiescence.stopRemainingQueuedPromptDispatchAttemptsBeforeSessionDetach();
	if (detachesHostedAgentSessions) {
		await deps.agentSessionPtyHostRuntimeFacade?.freezeHostedSessionEventRoutingAndStopHookSpoolDrainsForRuntimeHandover();
	}

	const runtimeShutdownOutcome = await (deps.shutdownRuntimeServer ?? shutdownRuntimeServer)({
		stopAllActiveRuntimeSessionsForShutdown: deps.runtimeServer.stopAllActiveRuntimeSessionsForShutdown,
		hostedAgentSessionDisposition: deps.hostedAgentSessionDisposition,
		warn: deps.warn,
		closeRuntimeServer: deps.runtimeServer.close,
	});

	if (deps.trigger.kind === "explicit_stop_terminating_hosted_agent_sessions") {
		// 本 runtime 自己的会话已按正常停止流程停掉并记账；这里再让每个 host 连同未接管的会话一起收尾。
		deps.agentSessionPtyHostRuntimeFacade?.requestEveryGenerationHostToTerminateAllHostedSessionsAndExit();
	}
	// 关停里对 hosted 会话发出的 stop / 最终接管记录必须写进内核再断开，否则会留在用户态缓冲里随进程一起丢掉。
	await deps.agentSessionPtyHostRuntimeFacade?.closeControllerConnectionsAfterFlushingPendingFrames();
	return { ...runtimeShutdownOutcome, agentSessionCountsAffectedByRuntimeExit };
}

// 下一个 runtime 开始监听之后调用：窗口结束，CLI 写动词不再需要等待。
export function removeKanbanRuntimeHandoverRestartInProgressMarkerAfterRuntimeListens(
	markerPath: string,
	warn: (message: string) => void,
): void {
	try {
		removeKanbanRuntimeHandoverRestartInProgressMarker(markerPath);
	} catch (error) {
		warn(
			`could not remove the runtime handover restart marker ${markerPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
