// 会话「执行活性」派生的单一真相源（纯函数、零运行时依赖，可被 Node 后端 / 浏览器前端 /
// 部署探针共享 import；唯一的类型 import 在编译期被擦除，故打进浏览器 bundle 不会带入任何
// Node 依赖）。
//
// 背景：在双轴会话状态重构（turnOwner + liveness + userTurnKind）落地前，「agent 此刻是否
// 仍在持续产出 PTY 输出」这份时间派生判定曾散落三处、阈值各异：
//   - 前端 Validation 停留判据 isAgentActivelyProducingOutput（5s）
//   - 后端自动续跑静默注入门控 isAgentOutputQuiet（2s）
//   - （纯状态、无时间的 isActiveTaskSessionState 不属此类，归后续阶段改读 liveness 基值）
// 本模块把前两者收敛为「单一新鲜度原语 + 参数化阈值」，保留 5s/2s 双阈值（语义相反、有意
// 不跨边界，见下），消除「同一判定多份实现、阈值漂移」的隐患。

import type {
	RuntimeTaskSessionLiveness,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionTurnOwner,
	RuntimeTaskSessionUserTurnKind,
} from "./api-contract.js";

// 「agent 仍在持续产出」的活跃窗口阈值（毫秒）。前后端有意取不同值、语义相反，故分别命名、
// 不强行统一为一个常量：
//  - 前端 Validation 停留判据取更保守的 5s：把「仍活跃」误判为真只会稍微推迟卡片停留（代价低），
//    而把刚结束 / 思考间隙误判为活跃从而打回 In Progress，体验更差。
//  - 后端自动续跑（connection-drop-auto-continue）取更激进的 2s：越早确认「已静默」越早可安全
//    注入续跑指令。
// 详见各自调用点注释。切勿误以为二者重复而合并。
export const VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS = 5_000;
export const AGENT_OUTPUT_QUIET_THRESHOLD_MS = 2_000;

// 距 agent 最近一次 PTY 输出是否仍落在 activeWindowMs 活跃窗口内（true = 仍在产出 / computing）。
//
// 语义细节（迁移前后必须逐字保持，两侧旧实现都依赖它）：
//  - lastOutputAt 为 null/undefined（从未产出 / 进程已退残留）→ 一律 false（非新鲜）。
//  - 严格小于：恰好等于窗口边界视为「已不新鲜」。
//
// 为什么用 lastOutputAt：会话的 `running` 只表示「会话还活着且不在显式 review 检查点」，并不
// 跟踪 agent 是否真在生成回复——空闲存活会话、甚至进程已退却未更新的残留会话都可能占据
// running。活跃思考时 spinner 持续刷新会推进 lastOutputAt，空闲时冻结，因此 lastOutputAt 叠加
// 时间窗能干净区分「真在干活的 running」与「空闲 / 已死的 running」。
export function isAgentOutputWithinActiveWindow(
	lastOutputAt: number | null | undefined,
	nowMs: number,
	activeWindowMs: number,
): boolean {
	return lastOutputAt !== null && lastOutputAt !== undefined && nowMs - lastOutputAt < activeWindowMs;
}

// 取反语义：距最近输出已 >= quietThresholdMs（或从未产出）→ 视为「已静默」。
// 后端自动续跑注入门控用；从未产出（null）视为静默，避免「无 lastOutputAt」永久卡住注入。
export function isAgentOutputQuiet(
	lastOutputAt: number | null | undefined,
	nowMs: number,
	quietThresholdMs: number = AGENT_OUTPUT_QUIET_THRESHOLD_MS,
): boolean {
	return !isAgentOutputWithinActiveWindow(lastOutputAt, nowMs, quietThresholdMs);
}

// 前端 Validation 列自动打回判据：仅当会话处于 running 且仍在活跃产出窗口内 → true（打回
// In Progress）；空闲 / 从未输出 / 已死残留 / 非 running 一律 false（允许停留 Validation）。
//
// 注：此处对 running 的门控是「当前一维 state」的过渡实现；双轴重构落地后将改为
// `turnOwner==="agent" && liveness ∈ {live, retrying}` 的派生叠加（见 session-state 重构计划
// Stage 1/3）——届时只需改这一处门控，新鲜度原语不动。
export function isAgentActivelyProducingOutput(
	summary: RuntimeTaskSessionSummary | null | undefined,
	nowMs: number,
): boolean {
	return (
		summary?.state === "running" &&
		isAgentOutputWithinActiveWindow(summary.lastOutputAt, nowMs, VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS)
	);
}

// ── 双轴会话状态 facet 的派生真相源 ─────────────────────────────────────────────
// 枚举/类型定义在 src/core/api-contract.ts（含 superRefine 组合护栏）；此处是其求值逻辑：
//   - deriveUserTurnKind / deriveSessionFacetsFromLegacyState：old→new（dual-write 与读时回填共用）
//   - projectLegacyState：new→old 的唯一 reducer（live/exited 在此被有损压扁）
//   - applySessionFacets：单一构造，所有写点经 updateSummary 漏斗统一 stamp facet
// 三者满足 projectLegacyState(deriveSessionFacetsFromLegacyState(state, …)) === state（投影可逆），
// 这正是 Stage 1「零行为漂移」承诺的命门，由黄金转移单测逐路径断言。

// per-session facet schema 版本（随 dual-write 落盘的可选字段；Stage 2 据此判定是否需读时回填）。
// 故意定义在本纯函数模块而非 api-contract：若从 api-contract 取值 import，会把整套 Zod schema 拖进
// 浏览器 bundle（api-contract 当前仅被 web-ui 以 type-only 引用、不在运行时 bundle）。
export const SESSION_SUMMARY_SCHEMA_VERSION = 1;

// 三 facet 组合（合法组合由 api-contract 的 superRefine 护栏在校验边界硬化）。
export interface SessionFacets {
	turnOwner: RuntimeTaskSessionTurnOwner;
	liveness: RuntimeTaskSessionLiveness;
	userTurnKind: RuntimeTaskSessionUserTurnKind | null;
}

// reviewReason → 人轴种类。仅 turnOwner==="user" 时取用，恒返回非 null（满足「user 回合 userTurnKind
// 不可为 null」不变量）。三分：error=运行错；interrupted=被中断；exit/completion/hook=完成待审(review)；
// attention/兜底=needs_input。注：question / plan_review / permission 需 harness 级采集，归后续 Stage。
export function deriveUserTurnKind(reviewReason: RuntimeTaskSessionReviewReason): RuntimeTaskSessionUserTurnKind {
	switch (reviewReason) {
		case "error":
			return "error";
		case "interrupted":
			return "interrupted";
		case "exit":
		case "completion":
		case "hook":
			return "review";
		default:
			// "attention" 及 null/未知：兜底待输入
			return "needs_input";
	}
}

// old→new：把 legacy 一维 state（+ 同刻上下文）映射为三 facet。dual-write（Stage 1）与读时回填
// （Stage 2 migrateLegacyState）共用此唯一映射。关键增益：awaiting_review 借 pid 区分 live↔exited
// （legacy state 表达不了，故此方向无损），running 借 connectionRetry 区分 live↔retrying。
export function deriveSessionFacetsFromLegacyState(
	state: RuntimeTaskSessionState,
	context: {
		reviewReason: RuntimeTaskSessionReviewReason;
		pid: number | null;
		connectionRetryActive: boolean;
	},
): SessionFacets {
	switch (state) {
		case "idle":
			return { turnOwner: null, liveness: "none", userTurnKind: null };
		case "running":
			return {
				turnOwner: "agent",
				liveness: context.connectionRetryActive ? "retrying" : "live",
				userTurnKind: null,
			};
		case "failed":
			// spawn 失败（终端启动失败）：等人处理、进程未起。
			return { turnOwner: "user", liveness: "failed", userTurnKind: "error" };
		case "interrupted":
			return { turnOwner: "user", liveness: "interrupted", userTurnKind: "interrupted" };
		case "awaiting_review":
			return {
				turnOwner: "user",
				liveness: context.pid === null ? "exited" : "live",
				userTurnKind: deriveUserTurnKind(context.reviewReason),
			};
	}
}

// new→old 的唯一 legacy reducer（禁止消费者各自手写投影）。live/exited 在此被压扁回
// awaiting_review——这是有损方向，故依赖「进程已退」的决策型消费者自 Stage 2 起须直接读 liveness。
export function projectLegacyState(facets: SessionFacets): RuntimeTaskSessionState {
	if (facets.turnOwner === null) {
		return "idle";
	}
	if (facets.turnOwner === "agent") {
		return "running";
	}
	// turnOwner === "user"
	if (facets.liveness === "failed") {
		return "failed";
	}
	if (facets.liveness === "interrupted") {
		return "interrupted";
	}
	return "awaiting_review";
}

// 单一构造：给「已合并好的 summary」打上与其 legacy state 自洽的三 facet + schemaVersion。
// 所有 dual-write 经两处 updateSummary 漏斗（src/cline-sdk/cline-session-state.ts、
// src/terminal/session-manager.ts）统一走此函数，故 facet 恒由当刻 state/reviewReason/pid/
// connectionRetry 派生、与 state 投影可逆——无需在每个写点手填 facet，也杜绝漂移。
export function applySessionFacets(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	const facets = deriveSessionFacetsFromLegacyState(summary.state, {
		reviewReason: summary.reviewReason,
		pid: summary.pid,
		connectionRetryActive: summary.connectionRetry != null,
	});
	return {
		...summary,
		turnOwner: facets.turnOwner,
		liveness: facets.liveness,
		userTurnKind: facets.userTurnKind,
		schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
	};
}

// ── 读侧 facet 权威解析（Stage 2 翻转真相源）─────────────────────────────────────
// 决策型消费者一律经此读 facet、不再读 legacy `state`，从而绕开 projectLegacyState 对
// live↔exited 的有损压扁（投影只在 new→old 方向有损；facet 本身保真）。
//
// 解析优先级：
//   - summary 已带三 facet（经 applySessionFacets 漏斗 / 读时回填 backfillSessionFacets）→ 直接采信；
//   - facet 全缺（未迁移旧盘残留、或 web-ui 无-facet 构造点）→ 即时从 legacy state 派生（与读时
//     回填同一映射 deriveSessionFacetsFromLegacyState，故「在线派生」与「落盘回填」结果恒一致）。
// 三 facet 由 superRefine 护栏保证共生（要么全置、要么全缺），故仅以 turnOwner 是否 undefined 判定
// 「已带 facet」即可；为容错对另两者也作显式 defined 收窄。
export function resolveSessionFacets(summary: RuntimeTaskSessionSummary): SessionFacets {
	if (summary.turnOwner !== undefined && summary.liveness !== undefined && summary.userTurnKind !== undefined) {
		return {
			turnOwner: summary.turnOwner,
			liveness: summary.liveness,
			userTurnKind: summary.userTurnKind,
		};
	}
	return deriveSessionFacetsFromLegacyState(summary.state, {
		reviewReason: summary.reviewReason,
		pid: summary.pid,
		connectionRetryActive: summary.connectionRetry != null,
	});
}

// 决策型「会话是否处于活跃回合」判据（facet 权威，绕开有损 legacy 投影）。
// 严格等价于 legacy `state ∈ {running, awaiting_review}`：有回合主（turnOwner 非 null）且未落入
// 终止态（failed=spawn 失败 / interrupted=被中断）。
//   - 全表等价证明见 session-facets.test.ts（全 state×pid×retry×reviewReason 与旧判据逐项对照）。
//   - 关键：exited（进程已退但仍等人审）仍判活跃——这正是 legacy 投影压扁、而 facet 保真的区分点。
//     未来「进程已退」类 UX（Terminal stream closed / 标记被打断会话）据 liveness="exited" 细分，
//     而本活跃判据对 live/exited 不敏感，故此处迁移为纯重构、零行为漂移。
export function isSessionInActiveTurn(facets: SessionFacets): boolean {
	return facets.turnOwner !== null && facets.liveness !== "failed" && facets.liveness !== "interrupted";
}

// 决策型「会话处于等人审查回合」判据（facet 权威）。严格等价于 legacy `state==="awaiting_review"`：
// user 回合（turnOwner==="user"）且未落终止态（failed/interrupted）——即 user 回合的活跃态。
//   - 等价于 projectLegacyState(facets)==="awaiting_review"；全表证明见 session-facets.test.ts。
//   - 涵盖 user+live 与 user+exited（旧 projectLegacyState 把两者压扁为 awaiting_review），故对
//     live↔exited 不敏感，凡读它的消费者迁移皆为零行为漂移、且不会偷渡 distinction ②。
//   - 单一真相源：项目计数叠加、claude/codex prompt-ready 检测器、hook 事件转换闸（hooks-api）等
//     共用本判据，避免各自手写 `turnOwner==="user" && liveness∉{failed,interrupted}` 子集
//     （计划反对的「每消费者维护子集」反模式）。
export function isAwaitingUserReviewTurn(facets: SessionFacets): boolean {
	return facets.turnOwner === "user" && isSessionInActiveTurn(facets);
}

// ── 展示叠加：把存储基值 liveness 的 "live" 按新鲜度细分为 computing / quiet ──────────────
// 双轴模型里 computing（仍在产出）/ quiet（活着但静默）是「随时间漂移的派生叠加」，故意不进存储/
// 不进 superRefine 枚举（summary 只在事件时广播、无周期 tick，存它一写即 stale）。本函数即计划所称
// 的 deriveLiveness：对 liveness==="live" 用共享新鲜度原语叠加出 computing|quiet，其余基值原样透传。
//
// **只供「有重渲染 tick」的展示型消费者**（board-card / agent-terminal-panel）。决策型消费者
// （通知、Validation 打回、active 判定、shutdown）**绝不读 computing/quiet**——它们只读事件置位的
// liveness 基值（见计划 freshness 分层）。本函数对任意 turnOwner 的 live 都会拆分；「computing 仅对
// agent 回合有意义」由消费者自行收窄（user 回合的 live=终端 agent 在 prompt 待命，不应被当作在算）。
export type SessionDisplayLiveness = Exclude<RuntimeTaskSessionLiveness, "live"> | "computing" | "quiet";

export function deriveDisplayLiveness(
	facets: SessionFacets,
	lastOutputAt: number | null | undefined,
	nowMs: number,
	options: { activeWindowMs?: number } = {},
): SessionDisplayLiveness {
	if (facets.liveness !== "live") {
		return facets.liveness;
	}
	const activeWindowMs = options.activeWindowMs ?? VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS;
	return isAgentOutputWithinActiveWindow(lastOutputAt, nowMs, activeWindowMs) ? "computing" : "quiet";
}
