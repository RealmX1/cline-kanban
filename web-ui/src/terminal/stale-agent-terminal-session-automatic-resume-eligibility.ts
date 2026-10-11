import { isRuntimeAgentSessionSummaryRenderedAsConversationPanel } from "@runtime-agent-catalog";
import { resolveSessionFacets } from "@runtime-session-activity";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

// 「用户打开 / 回到一个任务时，要不要静默把它的 PTY agent 会话按原对话接回来」的纯判定。
//
// 自动续跑与人点的「Restart agent session」打的是同一个入口（refreshTaskTerminal：空 prompt +
// resumeFromTrash，续跑后落在 awaiting_review），所以这里回答的只是「这一刻该不该替用户按下那个按钮」。
//
// 两类会话该接回来：
//   - mirror 随旧 runtime 一起丢了（restore 快照为空）：进程死于 runtime 重启 / 硬中断，不是 agent 自己的问题；
//   - mirror 还在、但这个活体是被 Kanban 自己的空闲回收结束的：回收是为了省内存，用户回来就该还原，
//     回收走 forceStopTaskSession，并不释放 mirror，所以「快照非空」挡不住这一类。
// 在用户眼前自然退出的（崩溃熔断、/exit、挪进 Done 时被停）mirror 也还在，但没有回收记录：保持手动，
// 免得一个确定性崩溃被每次打开都拉起一遍。
//
// 刻意**没有** turnOwner 让位守卫：它原本怕「续跑抢跑一个等人审的 Review 会话」，可续跑请求不带 prompt、
// 续跑后的会话恒落在用户回合，不可能抢跑；而它实际拦下的恰恰是回收后恒为 user/exited 的会话。

export type StaleAgentTerminalSessionAutomaticResumeEligibleReason =
	| "terminal_mirror_lost_with_previous_runtime"
	| "agent_session_ended_by_kanban_inactivity_reclamation";

export type StaleAgentTerminalSessionAutomaticResumeIneligibleReason =
	| "no_session_summary"
	| "agent_identity_unknown"
	| "session_rendered_as_conversation_panel"
	| "agent_session_process_still_live_or_starting"
	| "agent_session_failed_to_start"
	| "agent_conversation_never_established_in_native_store"
	| "agent_session_exited_with_terminal_mirror_retained_without_kanban_reclamation";

export type StaleAgentTerminalSessionAutomaticResumeEligibility =
	| { kind: "eligible"; reason: StaleAgentTerminalSessionAutomaticResumeEligibleReason }
	| { kind: "ineligible"; reason: StaleAgentTerminalSessionAutomaticResumeIneligibleReason };

export interface StaleAgentTerminalSessionAutomaticResumeEligibilityInput {
	summary: RuntimeTaskSessionSummary | null;
	// 最近一份落屏的 restore 能否当作「服务端已经没有这条会话的 mirror（runtime 重启过）」的证据：快照为空、
	// 不是「重新同步画面」引起的、且之后没有渲染过任何内容。由调用方按这三条判定（见 persistent-terminal-manager），
	// 少了后两条，证据就会在续跑出新内容之后、或在 resync 拿到不可信的空快照时继续「成立」。
	latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: boolean;
}

// 本活体是不是被 Kanban 的空闲回收干净地结束的。回收记录按活体盖章，续跑出来的新活体换了
// runtimeSessionIncarnationId，旧记录随之失效——否则「续跑后又自然退出」会被误认成回收。
// 导出给终端面板的 stream-closed 横幅复用：横幅承诺「打开即续跑」必须与这里的资格判据同源，
// 回收失败（failureReason 非空）或只是演练（rootProcessExitConfirmed=false）时两边一起回落。
export function wasCurrentRuntimeSessionIncarnationEndedByKanbanInactivityReclamation(
	summary: RuntimeTaskSessionSummary,
): boolean {
	const reclamationOutcome = summary.agentSessionRuntimeReclamationOutcome;
	if (!reclamationOutcome || !summary.runtimeSessionIncarnationId) {
		return false;
	}
	return (
		reclamationOutcome.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
		reclamationOutcome.rootProcessExitConfirmed &&
		reclamationOutcome.failureReason === null
	);
}

export function decideStaleAgentTerminalSessionAutomaticResumeEligibility({
	summary,
	latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss,
}: StaleAgentTerminalSessionAutomaticResumeEligibilityInput): StaleAgentTerminalSessionAutomaticResumeEligibility {
	if (!summary) {
		return { kind: "ineligible", reason: "no_session_summary" };
	}
	// agentId 问不出来时不靠猜去拉起一个 agent：自动续跑是静默动作。面板上的「重启」按钮仍可用，那是显式动作。
	if (summary.agentId === null) {
		return { kind: "ineligible", reason: "agent_identity_unknown" };
	}
	if (isRuntimeAgentSessionSummaryRenderedAsConversationPanel(summary)) {
		return { kind: "ineligible", reason: "session_rendered_as_conversation_panel" };
	}
	const { liveness } = resolveSessionFacets(summary);
	if (summary.pid !== null || liveness === "starting" || liveness === "live" || liveness === "retrying") {
		return { kind: "ineligible", reason: "agent_session_process_still_live_or_starting" };
	}
	if (liveness === "failed") {
		return { kind: "ineligible", reason: "agent_session_failed_to_start" };
	}
	// 服务端已核对过「这段对话从未在 agent 的会话存储里建立」：续跑注定被拒，出路在终端面板上由人选。
	if (
		summary.agentNativeConversationPersistenceObservation?.persistenceStatus ===
		"conversation_never_established_in_agent_native_store"
	) {
		return { kind: "ineligible", reason: "agent_conversation_never_established_in_native_store" };
	}
	if (latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss) {
		return { kind: "eligible", reason: "terminal_mirror_lost_with_previous_runtime" };
	}
	if (wasCurrentRuntimeSessionIncarnationEndedByKanbanInactivityReclamation(summary)) {
		return { kind: "eligible", reason: "agent_session_ended_by_kanban_inactivity_reclamation" };
	}
	return {
		kind: "ineligible",
		reason: "agent_session_exited_with_terminal_mirror_retained_without_kanban_reclamation",
	};
}
