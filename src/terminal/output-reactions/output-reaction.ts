// 终端 agent「输出反应（output reaction）」框架。
//
// 这是一个跨 harness 的扩展点：每个 reaction 监听解码后的终端输出，匹配某种信号
// （连接错误、配额提示、特定提示符……），在守卫（退避 / 去重 / 空闲门控）通过后
// 执行动作（注入续跑指令、调度兜底定时器、更新「连接重试」UI 状态）。
//
// 首个成员是 connection-drop-auto-continue（连接中断后自动续跑）。现有的
// workspace-trust 自动确认、deferred-startup 注入、prompt-ready 检测在概念上是
// 它的 siblings，本次不重构它们。
//
// 设计要点：
//   - 引擎是模块级单例、无 per-session 状态；每个 session 的状态由
//     `createSessionState()` 产出、由 session-manager 持有在 ActiveProcessState 上。
//   - PTY 机制（写入、定时器、提示符就绪判断、summary 更新）通过 `OutputReactionActions`
//     由 session-manager 注入，reaction 只决定「何时 / 是否」动作。

import type { RuntimeAgentId, RuntimeTaskConnectionRetry } from "../../core/api-contract";

// reaction 触发动作时拿到的上下文。
export interface OutputReactionContext {
	agentId: RuntimeAgentId;
	now: number;
	// 本次新到 chunk 的解码文本（已 stripAnsiAndControl，保留换行）。
	// 定时器 / 手动触发等「无新输出」的调用里为 ""。
	chunkText: string;
	// 滚动归一化缓冲（已 stripAnsiAndControl，保留换行；上限约 16KB）。
	scanText: string;
}

// 连接重试 UI 状态补丁，直接复用 summary 上的形状。
export type ConnectionRetryStatePatch = RuntimeTaskConnectionRetry;

// session-manager 注入给 reaction 的副作用入口。
export interface OutputReactionActions {
	// 注入一条「引用续跑指令文件的简短续跑指令」（bracketed paste + 回车；Codex 追加回车）。
	submitContinuationReference(): void;
	// 安排一个一次性兜底定时器，delayMs 后回调引擎的 onAttempt。
	// 每个 session 同时只保留一个待触发的 attempt 定时器（重复调用会覆盖）。
	schedule(delayMs: number): void;
	// 清除待触发的 attempt 定时器。
	clearScheduledAttempts(): void;
	// 进入 / 刷新「连接重试」状态（驱动看板徽标与顶栏列表）。
	setConnectionRetryState(patch: ConnectionRetryStatePatch): void;
	// 退出「连接重试」状态（agent 已恢复推进或命中 permanent 错误）。
	clearConnectionRetryState(): void;
	// 当前输出是否停在可注入的交互提示符（Claude 输入框 / Codex `›`）。
	isAtInteractivePrompt(): boolean;
	// 此刻是否可以安全自动注入：deferred startup input 已注入完、且用户近期没有手动输入。
	canInjectNow(): boolean;
	// agent 输出是否已「静默」：距最近一次输出已超过静默阈值，说明 agent 确实停在原地、
	// 没有在持续产出。仅用于自动注入路径的二次空闲门控——若输出仍在流动（非静默），
	// 说明 agent 仍在工作 / 已自行恢复，不应注入打断它。手动「立即续跑」豁免此门控。
	isAgentOutputQuiet(): boolean;
	// 结构化日志。
	log(message: string): void;
}

// 单个 reaction。per-session 状态以 `unknown` 在引擎里透明存储，具体 reaction 在
// 方法内部把它 cast 回自己的类型（避免引入 any / 泛型方差噪音）。
export interface OutputReaction {
	readonly id: string;
	appliesTo(agentId: RuntimeAgentId): boolean;
	createState(): unknown;
	// 每个新 chunk 调用：检测信号、维护退避状态、安排首个 attempt。
	onOutput(ctx: OutputReactionContext, state: unknown, actions: OutputReactionActions): void;
	// 兜底定时器 / adapter prompt-ready 触发：到点且就绪则注入（或判定已恢复）。
	onAttempt(ctx: OutputReactionContext, state: unknown, actions: OutputReactionActions): void;
	// 手动「立即续跑」：忽略退避、强制注入一次（仍尊重提示符就绪 / 抑制条件）。
	triggerNow(ctx: OutputReactionContext, state: unknown, actions: OutputReactionActions): void;
}

interface ActiveReaction {
	reaction: OutputReaction;
	state: unknown;
}

export interface OutputReactionSessionState {
	reactions: ActiveReaction[];
}

export interface OutputReactionEngine {
	// 是否有任一 reaction 适用于该 agent（决定 session-manager 要不要建 session 状态、解码输出）。
	isActiveFor(agentId: RuntimeAgentId): boolean;
	createSessionState(agentId: RuntimeAgentId): OutputReactionSessionState;
	onOutput(ctx: OutputReactionContext, session: OutputReactionSessionState, actions: OutputReactionActions): void;
	onAttempt(ctx: OutputReactionContext, session: OutputReactionSessionState, actions: OutputReactionActions): void;
	triggerContinueNow(
		ctx: OutputReactionContext,
		session: OutputReactionSessionState,
		actions: OutputReactionActions,
	): void;
}

export function createOutputReactionEngine(reactions: readonly OutputReaction[]): OutputReactionEngine {
	return {
		isActiveFor(agentId) {
			return reactions.some((reaction) => reaction.appliesTo(agentId));
		},
		createSessionState(agentId) {
			const active: ActiveReaction[] = reactions
				.filter((reaction) => reaction.appliesTo(agentId))
				.map((reaction) => ({ reaction, state: reaction.createState() }));
			return { reactions: active };
		},
		onOutput(ctx, session, actions) {
			for (const active of session.reactions) {
				active.reaction.onOutput(ctx, active.state, actions);
			}
		},
		onAttempt(ctx, session, actions) {
			for (const active of session.reactions) {
				active.reaction.onAttempt(ctx, active.state, actions);
			}
		},
		triggerContinueNow(ctx, session, actions) {
			for (const active of session.reactions) {
				active.reaction.triggerNow(ctx, active.state, actions);
			}
		},
	};
}
