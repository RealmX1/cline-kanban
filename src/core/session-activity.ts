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

import type { RuntimeTaskSessionSummary } from "./api-contract.js";

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
