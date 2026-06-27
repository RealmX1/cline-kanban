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
	RuntimeAgentId,
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

// 前端 Validation 列自动打回判据：仅当会话处于 agent 回合（turnOwner==="agent"）且仍在活跃产出
// 窗口内 → true（打回 In Progress）；空闲 / 从未输出 / 已死残留 / 非 agent 回合一律 false（允许停留
// Validation）。
//
// 双轴迁移（Stage 3 ④，行为保持）：门控已从一维 `state==="running"` 翻为 facet 权威
// `resolveSessionFacets(summary).turnOwner==="agent"`——二者全表等价（no-facet summary 即时派生、
// facet-present summary 采信权威，见 resolveSessionFacets）。
//
// 活跃窗口读 **lastSubstantiveOutputAt** 而非 lastOutputAt（本判据是唯一改读实质戳的读点）：
// Claude/Codex TUI 的 spinner 状态行每秒重绘，会让 lastOutputAt 几乎恒新鲜——只要 turnOwner==="agent"，
// 移入 Validation 的卡片就被持续打回。实质戳只在 agent 产出新正文 / 工具内容时推进（装饰性重绘被
// agent-output-substance.ts 分类器滤除），故「spinner 在转但无新正文」≥5s 即可停留 Validation，而真在
// 流式产出时仍按原语义打回。其余 4 个 lastOutputAt 读点（自动续跑静默门控、卡顿探针、卡片 computing
// 展示、终端面板基线）有意继续读 lastOutputAt——spinner=在思考，对它们应计为活动，绝不能迁移。
//   - null/undefined 回退 ⇒ false（不在产出）：isAgentOutputWithinActiveWindow 对 null/undefined 即返
//     false。**不**回退到 lastOutputAt——那会原样重现本 bug（spinner 期正是实质戳未盖、lastOutputAt 恒
//     新鲜的稳态）。代价仅为：流式 agent 在下一段实质 chunk 盖戳前（≈1s）暂判为非产出，可接受、自愈。
// 活跃窗口是「真·时间型」新鲜度，按 freshness 分层规则**不读** computing/quiet 派生叠加，而由唯一调用点
// （use-board-interactions 的 level-triggered effect）在 summary 流到达时重算（详见该处注释）。
export function isAgentActivelyProducingOutput(
	summary: RuntimeTaskSessionSummary | null | undefined,
	nowMs: number,
): boolean {
	if (summary == null) {
		return false;
	}
	return (
		resolveSessionFacets(summary).turnOwner === "agent" &&
		isAgentOutputWithinActiveWindow(
			summary.lastSubstantiveOutputAt,
			nowMs,
			VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS,
		)
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
// 不可为 null」不变量）。三分：error=运行错；interrupted=被中断；exit/completion/hook/manual_review=待审(review)；
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
		case "manual_review":
			// manual_review：用户手动翻入审查回合，与 agent 自然完成同归「待审」人轴。
			return "review";
		default:
			// "attention" 及 null/未知：兜底待输入
			return "needs_input";
	}
}

// old→new：把 legacy 一维 state（+ 同刻上下文）映射为三 facet。dual-write（Stage 1）与读时回填
// （Stage 2 migrateLegacyState）共用此唯一映射。关键增益：awaiting_review 借 agentId+pid 区分
// live↔exited（legacy state 表达不了，故此方向无损；Cline SDK 恒 live，见下），running 借
// connectionRetry 区分 live↔retrying。
export function deriveSessionFacetsFromLegacyState(
	state: RuntimeTaskSessionState,
	context: {
		reviewReason: RuntimeTaskSessionReviewReason;
		pid: number | null;
		connectionRetryActive: boolean;
		agentId: RuntimeAgentId | null;
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
				// harness-aware「进程已退」判定（解阻塞 distinction ②）：Cline SDK 在进程内运行、无 OS pid
				// 概念（pid 恒 null），awaiting 仅表示 SDK 会话仍存活 → 一律 live；终端/PTY agent 才有真实
				// pid，pid===null 才表示其进程已退 → exited。旧实现只看 pid===null，会把所有 Cline awaiting
				// 误标 exited（即此区阻塞根因）。agentId 未知(null) 时保守回退旧 pid 规则（按 pid 判）。
				liveness: context.agentId === "cline" || context.pid !== null ? "live" : "exited",
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
		agentId: summary.agentId,
	});
	return {
		...summary,
		turnOwner: facets.turnOwner,
		liveness: facets.liveness,
		userTurnKind: facets.userTurnKind,
		schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
	};
}

// ── 写侧主真相源派发器（Stage 4 全写侧反转）────────────────────────────────────
// 单一 per-patch 派发器：按 patch 形状决定 facet 与 legacy state 谁是权威，产出「三 facet 与 state
// 自洽」的 summary。两个 updateSummary 漏斗（cline-session-state.ts / session-manager.ts）统一经此写。
//
// 反转后 facet 是**写时主真相源**：
//   - patch 带 facet 且无 state → **facet 权威**：state = projectLegacyState(facets)（写侧主路径；
//     facet 写恒经 statePatch/facetPatch 发完整三元组，故 merged 必带完整三 facet）。
//   - patch 带 state（含同时带 facet 的 constructor seed）→ **legacy 向**：applySessionFacets 从
//     state 反推 facet（旧路兼容 / shutdown 持久化 / seed 数据，state 权威）。
//   - patch 两者皆无（metadata-only：lastOutputAt / latestHookActivity / connectionRetry-only）→
//     从 state+ctx 重派生 turnOwner/liveness（保 connectionRetry→retrying、exited 等元数据驱动的
//     活性变化），但 **preserve 已采集的 userTurnKind**——它可能是采集增强写入的 question /
//     plan_review / permission，无法从 reviewReason 反推，绝不能被 applySessionFacets 冲回
//     review / needs_input（两腿评审同判最致命缺陷）。facet 全缺的旧盘数据走 applySessionFacets。
//
// A1 零行为漂移保证：迁移前全库仍只发 state-only / metadata-only patch。state-only → applySessionFacets
// （同今日）；metadata-only 分支「重派 turnOwner/liveness + preserve userTurnKind」在「facet 恒由 state
// 反推」的迁移前世界里与 applySessionFacets 逐字等价（preserved userTurnKind === 重派 userTurnKind）。
export function mergeSummaryWithFacets(
	prev: RuntimeTaskSessionSummary,
	patch: Partial<RuntimeTaskSessionSummary>,
): RuntimeTaskSessionSummary {
	const merged = { ...prev, ...patch };
	const patchHasFacet =
		patch.turnOwner !== undefined || patch.liveness !== undefined || patch.userTurnKind !== undefined;
	const patchHasState = patch.state !== undefined;

	if (patchHasFacet && !patchHasState) {
		// facet 权威：state 由唯一 reducer 投影；三 facet 直接采信（merged 必完整）。
		const facets = resolveSessionFacets(merged);
		return {
			...merged,
			turnOwner: facets.turnOwner,
			liveness: facets.liveness,
			userTurnKind: facets.userTurnKind,
			state: projectLegacyState(facets),
			schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
		};
	}

	if (patchHasState) {
		// legacy 向（state 权威）：旧路兼容 / shutdown 持久化 / constructor seed（state+facet 同在）。
		return applySessionFacets(merged);
	}

	// metadata-only：重派 agent 轴（turnOwner/liveness），preserve 已采集的 userTurnKind。
	const refreshed = applySessionFacets(merged);
	if (merged.userTurnKind !== undefined) {
		return { ...refreshed, userTurnKind: merged.userTurnKind };
	}
	return refreshed;
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
		agentId: summary.agentId,
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

// 决策型「该回合是否触发 ready-for-review 系统通知」判据（facet 权威，单一真相源）。
// 用户拍板「广·阻塞即提醒」（2026-06-22）：凡进入「等人审查回合」（isAwaitingUserReviewTurn）且
// userTurnKind 非 interrupted（被中断/终止不打扰）即触发——涵盖 review（含完成/exit/hook）、error
// （运行错）、needs_input（含 attention/兜底），以及未来采集增强后才会产出的 question/plan_review/
// permission（均属「agent 阻塞等你」，broad 策略一律提醒）。故判据写成「awaiting 回合 ∧ 非
// interrupted」而非枚举白名单，既精确编码决策、又对后续采集增强前向兼容。
//   - 相对旧 reviewReason∈{hook,attention,error} 白名单的有意差异（属修正、非回归）：reviewReason
//     "exit"/"completion"/null 的等人回合（→review/needs_input）此前不通知，现纳入广播。
//   - 决策型判据：只读事件置位 facet，不读 computing/quiet 派生叠加（见 freshness 分层）。
export function isNotifiableUserTurn(facets: SessionFacets): boolean {
	return isAwaitingUserReviewTurn(facets) && facets.userTurnKind !== "interrupted";
}

// ── park：「已 park、正在等待已派发后台工作」的唯一被认可判据 ────────────────────────────────
// 主 agent 以非 native 方式 dispatch 一个后台任务（例：把 reviewer 计划作为独立 Kanban 任务发出）后，结束自己
// 这一轮去等它完成。Claude 此刻只发一个裸 Stop（它不知道刚才那是子 agent，不发 SubagentStop），裸 Stop 经
// to_review 会被当成「等人审查」误发 ready-for-review 通知。parked 的主 agent 真相就是普通 running 三元组
// {turnOwner:"agent", liveness:"live", userTurnKind:null}——它**不是** user 回合，故无法用 facet 表达「在等后台、
// 别提醒」；改用一个 connectionRetry 式 sidecar `awaitingDispatchedBackgroundWork`（present = parked）表达。
//
// 本谓词是 gate（hook-event-task-transition-gate.ts 的 to_review 前置抑制）/ UI（task-card-body 抑制 computing 脉冲、
// 渲染 parked 徽标）/ RVF（is-parked 查询）/ session-manager（isAgentTurnActive、scanForStalls、shouldAutoRestart
// 四处空闲守卫）共用的**唯一** park 判据——读 sidecar 而非 facet（facet 仍是普通 agent 回合），故不绕开任何 facet
// 真相源。纯函数、读单字段，Node-dep-free（可被 web-ui 经 @runtime-session-activity 直接 import）。
export function isParkedAwaitingDispatchedBackgroundWork(
	summary: RuntimeTaskSessionSummary | null | undefined,
): boolean {
	return summary != null && summary.awaitingDispatchedBackgroundWork != null;
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
