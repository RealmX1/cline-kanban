import type { RuntimeGuidedVerificationPendingConfirmation, RuntimeGuidedVerificationTask } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

// M4 恢复判定：「移列成功但 confirm 失败」的滞留态——任务已被移入 Done（trash 列）却未标记 verified，但盘上
// 仍有一枚未过期的一次性 confirm token（pendingConfirmation）。命中时返回该 pending，供 controller 直接用其
// token 重试 confirmVerificationComplete（后端已放行 trash + 有效 token 的直接标记），绕过对 trash 列拒发
// 新 token 的 requestVerificationComplete——那正是原本让该滞留态在产品内无法恢复的死角。
//
// 安全边界（仅自动恢复 requiredAcknowledgements 为空的 token）：token 是 requestVerificationComplete 按来源列
// 发放的——validation 发空 acks（免确认框、由 finalizeCompletion 直连处理），review/in_progress 发非空 acks
// （skip_validation / in_progress_active，须弹安全二次确认框逐项收集）。若照单把冻结的非空 requiredAcknowledgements
// 原样当作「用户已确认」回传，就会伪造用户从未给出的 acknowledgement：用户在确认框点「取消」时 token 不被消费、
// 会保留到 15min TTL；此期间任务仍在原列（reconcile 因 pendingConfirmation!==null 不标 dropped），若用户随后手动
// 把任务拖入 Done 就凑成「trash + verifiedAt=null + droppedReason=null + 有效非空-acks pending」，正好命中本恢复，
// 再点「完成核对」会直接标记 verified、绕过本应弹出的 skip_validation / in_progress_active 确认。此「取消对话框 +
// 手动移列」的伪滞留态与「真滞留态（acks 已在对话框被确认过、移列成功但 confirm 失败）」在盘上完全不可区分，故对
// 非空 acks 一律不自动恢复。仅空 acks（validation-origin）可自动恢复：它本就无对话框、无可绕过的 acknowledgement，
// 其残留只可能来自 finalizeCompletion 的真滞留态。
//
// 不覆盖的子态（返回 null）：token 已过期被回收（pendingConfirmation===null）、任务已被 reconcile 标记 dropped、
// 或 pending 带非空 requiredAcknowledgements（review/in_progress-origin）。这些需后端 --force 恢复（见 follow-up），
// 不在本前端最小恢复范围内。
export function resolveGuidedVerificationStuckDoneRecovery(
	task: RuntimeGuidedVerificationTask | null,
	currentColumnId: BoardColumnId | null,
	nowMs: number,
): RuntimeGuidedVerificationPendingConfirmation | null {
	if (currentColumnId !== "trash" || task === null || task.verifiedAt !== null || task.droppedReason !== null) {
		return null;
	}
	const pending = task.pendingConfirmation;
	if (pending === null) {
		return null;
	}
	const expiresAtMs = Date.parse(pending.expiresAtIso);
	if (Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs) {
		return null;
	}
	// 仅自动恢复「无需用户确认」的 validation-origin token（空 acks）——非空 acks 会伪造安全二次确认（详见上方注释）。
	if (pending.requiredAcknowledgements.length > 0) {
		return null;
	}
	return pending;
}
