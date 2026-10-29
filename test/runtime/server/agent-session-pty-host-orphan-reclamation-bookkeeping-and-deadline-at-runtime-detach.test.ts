// 孤儿回收的两头：detach 时给 host 定期限（取回收账本里当前那条 live 记录，与在线回收同一套防护），
// 以及新 runtime 接管被 host 回收的会话后补记账（账本 reclaimed、待答决策标回收、summary 写回收结果）。
import { describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent } from "../../../src/server/agent-session-pty-host-orphan-reclamation-bookkeeping-after-runtime-restart";
import { resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords } from "../../../src/server/hosted-agent-session-orphan-reclamation-deadline-at-runtime-detach";
import type { PersistedAgentSessionReclamationDeadlineRecord } from "../../../src/state/agent-session-reclamation-deadline-store";

function buildDeadlineRecord(
	overrides: Partial<PersistedAgentSessionReclamationDeadlineRecord> = {},
): PersistedAgentSessionReclamationDeadlineRecord {
	return {
		recordId: "task-1:incarnation-1:3",
		taskId: "task-1",
		agentId: "claude",
		sessionTransport: "pty_terminal",
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 3,
		retentionAnchorKind: "agent_response_generation_stopped",
		retentionAnchorAt: 1_700_000_000_000,
		responseGenerationStopSignalConfidence: null,
		reclamationEligibleAt: 1_700_018_000_000,
		reclamationState: "grace_running",
		reclamationAttemptCount: 0,
		nextReclaimRetryAt: null,
		lastReclaimFailureReason: null,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		schemaVersion: 1,
		...overrides,
	};
}

// 停止生成后、活着等用户的 claude 会话（计时态）。
function buildStoppedClaudeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/tmp/workspace",
		pid: 4242,
		startedAt: 1_699_999_000_000,
		updatedAt: 1_700_000_000_000,
		lastOutputAt: 1_700_000_000_000,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: 1_700_000_000_000,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 3,
		...overrides,
	} as RuntimeTaskSessionSummary;
}

describe("resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords", () => {
	it("hands the host the live deadline of a session that is waiting on the user", () => {
		expect(
			resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords(
				[buildDeadlineRecord()],
				buildStoppedClaudeSummary(),
			),
		).toBe(1_700_018_000_000);
	});

	it("gives no deadline when the record belongs to an earlier turn or the agent is generating", () => {
		expect(
			resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords(
				[buildDeadlineRecord({ agentResponseGenerationTurnSequence: 2 })],
				buildStoppedClaudeSummary(),
			),
		).toBeNull();
		expect(
			resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords(
				[buildDeadlineRecord()],
				buildStoppedClaudeSummary({ state: "running", turnOwner: "agent", userTurnKind: null }),
			),
		).toBeNull();
		expect(
			resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords(
				[buildDeadlineRecord({ reclamationState: "superseded" })],
				buildStoppedClaudeSummary(),
			),
		).toBeNull();
	});
});

describe("recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent", () => {
	it("marks the live deadline reclaimed, flags pending decisions and writes the reclamation outcome onto the summary", async () => {
		const updateReclamationProgress = vi.fn(async () => null);
		const markPendingUserDecisionsReclaimed = vi.fn(async () => 1);
		const applyAgentSessionReclamationOutcomeToTerminalSessionSummary = vi.fn(() => null);

		const recordedReclamationCount = await recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent({
			reclaimedHostedSessions: [
				{ workspaceId: "workspace-1", taskId: "task-1", pid: 4242, exitedAtEpochMs: 1_700_018_000_500 },
			],
			applyAgentSessionReclamationOutcomeToTerminalSessionSummary,
			warn: vi.fn(),
			readNowEpochMs: () => 1_700_020_000_000,
			readReclamationDeadlineRecords: async () => [buildDeadlineRecord()],
			updateReclamationProgress,
			markPendingUserDecisionsReclaimed,
		});

		expect(recordedReclamationCount).toBe(1);
		expect(markPendingUserDecisionsReclaimed).toHaveBeenCalledWith("workspace-1", "task-1", 1_700_018_000_500);
		expect(updateReclamationProgress).toHaveBeenCalledWith(
			"workspace-1",
			"task-1:incarnation-1:3",
			expect.objectContaining({ reclamationState: "reclaimed" }),
		);
		expect(applyAgentSessionReclamationOutcomeToTerminalSessionSummary).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			expect.objectContaining({
				runtimeSessionIncarnationId: "incarnation-1",
				reclamationTrigger: "response_generation_grace_period_expired",
				completedAt: 1_700_018_000_500,
				failureReason: null,
			}),
		);
	});

	it("warns and records nothing when no live deadline record exists", async () => {
		const warn = vi.fn();
		const updateReclamationProgress = vi.fn(async () => null);

		const recordedReclamationCount = await recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent({
			reclaimedHostedSessions: [
				{ workspaceId: "workspace-1", taskId: "task-1", pid: 4242, exitedAtEpochMs: 1_700_018_000_500 },
			],
			applyAgentSessionReclamationOutcomeToTerminalSessionSummary: vi.fn(() => null),
			warn,
			readReclamationDeadlineRecords: async () => [buildDeadlineRecord({ reclamationState: "superseded" })],
			updateReclamationProgress,
			markPendingUserDecisionsReclaimed: vi.fn(async () => 0),
		});

		expect(recordedReclamationCount).toBe(0);
		expect(updateReclamationProgress).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
