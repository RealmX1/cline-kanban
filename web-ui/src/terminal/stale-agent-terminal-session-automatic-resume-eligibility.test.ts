import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { decideStaleAgentTerminalSessionAutomaticResumeEligibility } from "@/terminal/stale-agent-terminal-session-automatic-resume-eligibility";

type AgentSessionRuntimeReclamationOutcome = NonNullable<
	RuntimeTaskSessionSummary["agentSessionRuntimeReclamationOutcome"]
>;

function buildReclamationOutcome(
	overrides: Partial<AgentSessionRuntimeReclamationOutcome> = {},
): AgentSessionRuntimeReclamationOutcome {
	return {
		runtimeSessionIncarnationId: "incarnation-reclaimed",
		sessionTransport: "pty_terminal",
		reclamationTrigger: "response_generation_grace_period_expired",
		attemptedAt: 1,
		completedAt: 2,
		rootProcessExitConfirmed: true,
		descendantProcessesExitConfirmed: true,
		survivingDescendantPids: [],
		usedForcefulEscalation: true,
		releasedResources: ["pty", "terminal_state_mirror"],
		failureReason: null,
		nextRetryAt: null,
		...overrides,
	};
}

// 回收 / 退出后的形状：awaiting_review + user 回合 + exited + pid null（session-state-machine 的 process.exit）。
function buildExitedUserTurnSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-a",
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "exited",
		userTurnKind: "error",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: "error",
		exitCode: 129,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation-reclaimed",
		...overrides,
	} as RuntimeTaskSessionSummary;
}

describe("decideStaleAgentTerminalSessionAutomaticResumeEligibility", () => {
	it("被 Kanban 空闲回收结束、mirror 还在（快照非空）→ 续：这正是用户反复手动重启的那一类", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({ agentSessionRuntimeReclamationOutcome: buildReclamationOutcome() }),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: false,
			}),
		).toEqual({ kind: "eligible", reason: "agent_session_ended_by_kanban_inactivity_reclamation" });
	});

	it("连上控制通道后被 recoverStaleSession 归零成 idle 的回收会话（incarnation 与回收记录不变）→ 续", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({
					state: "idle",
					turnOwner: null,
					liveness: "none",
					userTurnKind: null,
					reviewReason: null,
					exitCode: null,
					agentSessionRuntimeReclamationOutcome: buildReclamationOutcome(),
				}),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: false,
			}),
		).toEqual({ kind: "eligible", reason: "agent_session_ended_by_kanban_inactivity_reclamation" });
	});

	it("在用户眼前自然退出（mirror 还在、没有回收记录）→ 不续：避免确定性崩溃每次打开都被拉起", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({ userTurnKind: "review", reviewReason: "exit", exitCode: 0 }),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: false,
			}),
		).toEqual({
			kind: "ineligible",
			reason: "agent_session_exited_with_terminal_mirror_retained_without_kanban_reclamation",
		});
	});

	it("回收记录属于更早的活体（续跑后又自然退出）→ 不续", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({
					runtimeSessionIncarnationId: "incarnation-resumed-later",
					agentSessionRuntimeReclamationOutcome: buildReclamationOutcome(),
				}),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: false,
			}).kind,
		).toBe("ineligible");
	});

	it("回收没有干净完成（根进程仍存活 / 有失败原因）→ 不按回收续", () => {
		for (const reclamationOutcome of [
			buildReclamationOutcome({ rootProcessExitConfirmed: false }),
			buildReclamationOutcome({ failureReason: "根进程 pid=1 在 SIGKILL 后仍存活" }),
		]) {
			expect(
				decideStaleAgentTerminalSessionAutomaticResumeEligibility({
					summary: buildExitedUserTurnSummary({ agentSessionRuntimeReclamationOutcome: reclamationOutcome }),
					latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: false,
				}).kind,
			).toBe("ineligible");
		}
	});

	it.each([
		{
			label: "idle（hydrate 归零）",
			overrides: { state: "idle", turnOwner: null, liveness: "none", userTurnKind: null },
		},
		{ label: "review", overrides: { userTurnKind: "review", reviewReason: "exit", exitCode: 0 } },
		{ label: "error", overrides: {} },
		{
			label: "interrupted（优雅关停）",
			overrides: { state: "interrupted", liveness: "interrupted", userTurnKind: "interrupted" },
		},
		{ label: "question", overrides: { userTurnKind: "question", reviewReason: "hook" } },
	] as const)(
		"mirror 随旧 runtime 丢失（快照为空）+ $label → 续：用户回合不再让位，续跑不带 prompt",
		({ overrides }) => {
			expect(
				decideStaleAgentTerminalSessionAutomaticResumeEligibility({
					summary: buildExitedUserTurnSummary(overrides as Partial<RuntimeTaskSessionSummary>),
					latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
				}),
			).toEqual({ kind: "eligible", reason: "terminal_mirror_lost_with_previous_runtime" });
		},
	);

	it("启动即失败（liveness=failed）→ 不续，交给人", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({ state: "failed", liveness: "failed", userTurnKind: "error" }),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
			}),
		).toEqual({ kind: "ineligible", reason: "agent_session_failed_to_start" });
	});

	it("进程还活着（pid 非空）或正在启动 → 不续", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({ pid: 4321, liveness: "live" }),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
			}),
		).toEqual({ kind: "ineligible", reason: "agent_session_process_still_live_or_starting" });
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({
					state: "running",
					turnOwner: "agent",
					liveness: "starting",
					userTurnKind: null,
					reviewReason: null,
				}),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
			}),
		).toEqual({ kind: "ineligible", reason: "agent_session_process_still_live_or_starting" });
	});

	it("服务端已核对对话从未建立 → 不续（续跑注定被拒）", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({
					agentId: "cursor",
					agentNativeConversationPersistenceObservation: {
						persistenceStatus: "conversation_never_established_in_agent_native_store",
						nativeSessionId: null,
						workingDirectoryPath: "/tmp/worktree",
						suspectedBlockingCause: null,
						observedAt: 1,
					},
				}),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
			}),
		).toEqual({ kind: "ineligible", reason: "agent_conversation_never_established_in_native_store" });
	});

	it("agentId 未知 / 会话面板型 agent / 没有 summary → 不续", () => {
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({ agentId: null }),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
			}).reason,
		).toBe("agent_identity_unknown");
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: buildExitedUserTurnSummary({ agentId: "cline" }),
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
			}).reason,
		).toBe("session_rendered_as_conversation_panel");
		expect(
			decideStaleAgentTerminalSessionAutomaticResumeEligibility({
				summary: null,
				latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: true,
			}).reason,
		).toBe("no_session_summary");
	});
});
