// connection-drop-auto-continue：检测到瞬时连接错误后，在 agent 回到空闲提示符时
// 自动注入一条「引用续跑指令文件的简短续跑指令」，按指数退避无限重试，直到 agent
// 恢复推进（移出重试列表）或命中 permanent 错误（放弃）。
//
// 退避用作「再注入」与「恢复探测」二合一：每次注入后记录是否又见到新的连接错误，
// 下一次退避定时器触发时——
//   - 若自上次注入后**没有**再出现连接错误 → 判定 agent 已恢复 → 结束重试；
//   - 若**又**出现了连接错误 → 仍在失败 → 再注入一次（退避继续增长）。
// 这样既不需要脆弱的「进度字符计数」，也天然忽略注入回显（回显不是连接错误）。

import type { RuntimeAgentId } from "../../core/api-contract";
import { normalizeTerminalText } from "../terminal-output-normalization";
import { classifyConnectionError } from "./connection-error-patterns";
import type { OutputReaction, OutputReactionActions, OutputReactionContext } from "./output-reaction";

export const CONNECTION_DROP_AUTO_CONTINUE_REACTION_ID = "connection-drop-auto-continue";

// 指数增长的退避间隔（毫秒），到顶（最后一项）后按顶值无限重试，绝不彻底停止。
// 第 0 次（首个 attempt）用一个较短的「沉降」延时，等 TUI 把提示符框重绘完整。
//
// 首档（4s）特意留足够余量大于 AGENT_OUTPUT_QUIET_THRESHOLD_MS（2s，见 src/core/session-activity.ts）的「输出静默」门控：
// 真实连接中断时 agent 确实停产，到首个 attempt 时一定已静默、不会被误判为「仍在工作」
// 而清掉 episode；而误命中（正常输出含 timeout 等词）若 agent 仍在持续产出，则到首个
// attempt 时输出未静默，触发 endEpisode 清除伪「重连中」状态、绝不注入打断。
const BACKOFF_SCHEDULE_MS: readonly number[] = [4_000, 15_000, 60_000, 240_000, 480_000];

// 「输出静默」阈值（AGENT_OUTPUT_QUIET_THRESHOLD_MS，2s）现由 src/core/session-activity.ts 统一持有：
// session-manager 注入的 isAgentOutputQuiet 动作复用该阈值，仅当距 agent 最近一次输出已超过它、
// 判定 agent 确实停在原地时，本反应才注入续跑。

// attempt 触发时若尚未就绪（agent 仍在忙 / deferred input 未注入完 / 用户刚输入），
// 隔这么久再探一次，而不是消耗一次退避档位。
const NOT_READY_RECHECK_DELAY_MS = 2_000;

// 桥接被 PTY chunk 切断的错误行：保留上一个 chunk 末尾这么多字符作为前缀。
const SPLIT_CARRYOVER_CHARS = 256;

function backoffMs(attemptIndex: number): number {
	const clamped = Math.min(Math.max(attemptIndex, 0), BACKOFF_SCHEDULE_MS.length - 1);
	return BACKOFF_SCHEDULE_MS[clamped];
}

interface ConnectionDropReactionState {
	// 是否正处于一次「连接重试」episode。
	episodeActive: boolean;
	// 已执行的续跑注入次数（也用作退避档位索引）。
	retryCount: number;
	firstErrorAt: number;
	lastAttemptAt: number | null;
	nextAttemptAt: number | null;
	lastErrorSignature: string | null;
	// 自上一次注入以来，是否又观察到连接错误（恢复探测的关键信号）。
	errorSeenSinceLastInjection: boolean;
	// 上一个 chunk 末尾，用于桥接跨 chunk 的错误行。
	splitCarryover: string;
}

function createInitialState(): ConnectionDropReactionState {
	return {
		episodeActive: false,
		retryCount: 0,
		firstErrorAt: 0,
		lastAttemptAt: null,
		nextAttemptAt: null,
		lastErrorSignature: null,
		errorSeenSinceLastInjection: false,
		splitCarryover: "",
	};
}

function startEpisode(state: ConnectionDropReactionState, ctx: OutputReactionContext, signature: string | null): void {
	state.episodeActive = true;
	state.retryCount = 0;
	state.firstErrorAt = ctx.now;
	state.lastAttemptAt = null;
	state.lastErrorSignature = signature;
	state.errorSeenSinceLastInjection = true;
	state.nextAttemptAt = ctx.now + backoffMs(0);
}

function endEpisode(state: ConnectionDropReactionState, actions: OutputReactionActions, reason: string): void {
	state.episodeActive = false;
	state.retryCount = 0;
	state.lastAttemptAt = null;
	state.nextAttemptAt = null;
	state.errorSeenSinceLastInjection = false;
	state.lastErrorSignature = null;
	actions.clearScheduledAttempts();
	actions.clearConnectionRetryState();
	actions.log(`[output-reaction] ${CONNECTION_DROP_AUTO_CONTINUE_REACTION_ID} episode ended: ${reason}`);
}

function publishRetryState(state: ConnectionDropReactionState, actions: OutputReactionActions): void {
	actions.setConnectionRetryState({
		status: "retrying",
		retryCount: state.retryCount,
		firstErrorAt: state.firstErrorAt,
		lastAttemptAt: state.lastAttemptAt,
		nextAttemptAt: state.nextAttemptAt,
	});
}

// 执行一次 attempt。manual=true 表示用户手动「立即续跑」：跳过「已恢复」判定，强制注入。
function performAttempt(
	state: ConnectionDropReactionState,
	ctx: OutputReactionContext,
	actions: OutputReactionActions,
	options: { manual: boolean },
): void {
	if (!state.episodeActive) {
		return;
	}
	// 还没到下一次注入时刻（自动路径下的早醒）：补齐剩余等待。手动路径忽略时刻限制。
	if (!options.manual && state.nextAttemptAt !== null && ctx.now < state.nextAttemptAt) {
		actions.schedule(state.nextAttemptAt - ctx.now);
		return;
	}
	// 未就绪（agent 仍在忙 / deferred startup 未注入完 / 用户刚手动输入）：稍后再探，
	// 不消耗退避档位。
	if (!actions.isAtInteractivePrompt() || !actions.canInjectNow()) {
		actions.schedule(NOT_READY_RECHECK_DELAY_MS);
		return;
	}
	// 输出静默门控（仅自动路径）：若 agent 输出仍在流动（未静默），说明它仍在工作 /
	// 已自行恢复——常见于正则误命中（正常输出含 timeout/5xx 等词）起的伪 episode。
	// 此时结束 episode（清掉 UI「重连中」），绝不注入打断正在工作的 agent。
	// 首档退避（4s）大于静默阈值（2s），故真实连接中断到首个 attempt 时一定已静默、不被误清。
	// 手动「立即续跑」豁免此门控。
	if (!options.manual && !actions.isAgentOutputQuiet()) {
		endEpisode(state, actions, "agent-output-still-flowing");
		return;
	}
	// 恢复探测：已经注入过、且自上次注入以来没有再出现连接错误 → agent 已恢复。
	if (!options.manual && state.retryCount > 0 && !state.errorSeenSinceLastInjection) {
		endEpisode(state, actions, "recovered");
		return;
	}
	// 注入续跑指令。
	actions.submitContinuationReference();
	state.retryCount += 1;
	state.lastAttemptAt = ctx.now;
	state.errorSeenSinceLastInjection = false;
	const delay = backoffMs(state.retryCount);
	state.nextAttemptAt = ctx.now + delay;
	publishRetryState(state, actions);
	actions.log(
		`[output-reaction] ${CONNECTION_DROP_AUTO_CONTINUE_REACTION_ID} injected continuation #${state.retryCount}` +
			`${options.manual ? " (manual)" : ""}; next check in ${delay}ms`,
	);
	actions.schedule(delay);
}

// appliesTo：第一版覆盖 Claude Code + Codex。
//
// TODO（第一序列 · Cursor Agent）：Cursor 当前不是 Kanban 可选 agent（agent-catalog.ts /
//   runtimeAgentIdSchema 里没有 cursor）。一旦把 Cursor 注册为可选 agent，请在此放行
//   `agentId === "cursor"`，并在 connection-error-patterns.ts 补 Cursor 的连接错误文案
//   与（如需要）独立的提示符就绪正则。
// TODO（第二序列 · droid / kiro 等）：用户主动使用这些终端 agent 时，在此追加对应
//   agentId 即可——接入成本基本就是「appliesTo 放行 + 一组正则」。
function appliesToAgent(agentId: RuntimeAgentId): boolean {
	return agentId === "claude" || agentId === "codex";
}

export function createConnectionDropAutoContinueReaction(): OutputReaction {
	return {
		id: CONNECTION_DROP_AUTO_CONTINUE_REACTION_ID,
		appliesTo: appliesToAgent,
		createState: createInitialState,
		onOutput(ctx, rawState, actions) {
			const state = rawState as ConnectionDropReactionState;
			const detectionText = normalizeTerminalText(`${state.splitCarryover} ${ctx.chunkText}`);
			state.splitCarryover = ctx.chunkText.slice(-SPLIT_CARRYOVER_CHARS);

			const { classification, signature } = classifyConnectionError(detectionText);

			if (classification === "permanent") {
				if (state.episodeActive) {
					endEpisode(state, actions, `permanent-error:${signature ?? "?"}`);
				}
				return;
			}

			if (classification === "transient") {
				if (!state.episodeActive) {
					startEpisode(state, ctx, signature);
					publishRetryState(state, actions);
					actions.log(
						`[output-reaction] ${CONNECTION_DROP_AUTO_CONTINUE_REACTION_ID} detected transient connection error` +
							` (${signature ?? "?"}); first continuation in ${backoffMs(0)}ms`,
					);
					actions.schedule(backoffMs(0));
				} else {
					// 仍在失败：标记「注入后又出错」，让下一次退避触发时继续注入而非判恢复。
					state.errorSeenSinceLastInjection = true;
					state.lastErrorSignature = signature;
				}
				return;
			}
			// classification === null：无错误输出。恢复判定交给退避定时器（onAttempt），
			// 这里无需处理（天然忽略注入回显）。
		},
		onAttempt(ctx, rawState, actions) {
			performAttempt(rawState as ConnectionDropReactionState, ctx, actions, { manual: false });
		},
		triggerNow(ctx, rawState, actions) {
			const state = rawState as ConnectionDropReactionState;
			if (!state.episodeActive) {
				return;
			}
			state.nextAttemptAt = ctx.now;
			performAttempt(state, ctx, actions, { manual: true });
		},
		dismiss(_ctx, rawState, actions) {
			// 手动「移出列表 / 停止重试」：结束当前 episode（清定时器 + 清 UI 重连状态、不注入）。
			// 软移除——之后若再检测到新的瞬时连接错误，onOutput 仍会重新进入一次新 episode。
			const state = rawState as ConnectionDropReactionState;
			if (!state.episodeActive) {
				return;
			}
			endEpisode(state, actions, "manual-dismiss");
		},
	};
}
