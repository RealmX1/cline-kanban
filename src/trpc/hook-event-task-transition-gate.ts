import type { RuntimeHookEvent, RuntimeTaskSessionSummary } from "../core/api-contract";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "../core/session-activity";

// Hook 事件能否触发任务回合转换的判据（Stage 3 余区：legacy `state` 读 → 双轴 facet 真相源）。
// 从 hooks-api.ts 抽出为纯模块，使单测只 import 纯代码、规避 AGENTS.md 的 Node22 SDK-host 启动隐患，
// 并沿用首区/计数区「抽纯函数 + 锁测」纪律。
//
// 两条门控逐项等价旧 legacy 读、零行为漂移：
//   - to_review（running→review）：旧 `state==="running"` ⟺ `turnOwner==="agent"`
//     （running 是 agent 回合的唯一来源，全表等价见 session-facets.test.ts）。
//   - to_in_progress（review→running，本函数的兜底分支）：旧 `state==="awaiting_review"`
//     ⟺ `isAwaitingUserReviewTurn(facets)`（涵盖 user+live 与 user+exited 折叠，对 live↔exited
//     不敏感、不偷渡 distinction ②；全表等价见 session-facets.test.ts）。
//   - activity：永不转换（纯活动元数据 ingestion）。
//
// `reviewReason`(attention/hook/error) 读**故意保留不动**——`deriveUserTurnKind` 是非 1:1 映射
// （attention→needs_input，而 needs_input 亦覆盖 reviewReason===null），把它换成 `userTurnKind`
// 会改变行为，属后续 channel-C 批次，本行为保持块绝不偷渡，只迁 `state` 轴。
export function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return resolveSessionFacets(summary).turnOwner === "agent";
	}
	return (
		isAwaitingUserReviewTurn(resolveSessionFacets(summary)) &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}
