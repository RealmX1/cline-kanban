import type { RuntimeTaskSessionSummary } from "@/runtime/types";

// 与 src/terminal 的 OUTPUT_QUIET_THRESHOLD_MS（2s，连接中断自动续跑用，
// 见 src/terminal/output-reactions/connection-drop-auto-continue.ts）同源语义：
// 「距最近一次 agent 输出超过此阈值即视为静默」。
//
// web-ui 与 Node 侧 src/ 处于不同模块边界，不直接 import 那个常量，而是在前端
// 定义一个语义等价、可独立调节的常量。validation 停留场景取更保守的 5s：误判
// 「仍活跃」只会稍微推迟停留，代价低；而把刚结束 / 思考间隙的任务误判为活跃从而
// 打回 In Progress，体验更差。
export const VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS = 5_000;

// 「agent 此刻仍在持续产出」= 会话处于 running 且最近一次 PTY 输出在阈值内。
//
// 背景：会话的 `running` 状态只表示「会话还活着且不在显式 review 检查点」，并不跟踪
// agent 是否真在生成回复——它会被空闲的存活会话、甚至进程已退出却未及更新的残留
// 会话占据。空闲的 Claude 不再产出 PTY 输出（spinner 停止刷新 → `lastOutputAt`
// 冻结），活跃思考时 spinner 持续刷新会推进 `lastOutputAt`，因此 `lastOutputAt`
// 能干净地区分「真在干活的 running」与「空闲 / 已死的 running」。
//
// 用途：Validation 列的自动打回判据。空闲（`lastOutputAt` 冻结）或从未输出 / 已死
// 残留（`lastOutputAt` 为 null）的 running 一律判为 false → 允许停留在 Validation；
// 仅当 agent 仍在持续产出时才返回 true → 打回 In Progress。
export function isAgentActivelyProducingOutput(summary: RuntimeTaskSessionSummary | undefined, nowMs: number): boolean {
	return (
		summary?.state === "running" &&
		summary.lastOutputAt !== null &&
		summary.lastOutputAt !== undefined &&
		nowMs - summary.lastOutputAt < VALIDATION_KEEP_WHILE_AGENT_OUTPUT_QUIET_MS
	);
}
