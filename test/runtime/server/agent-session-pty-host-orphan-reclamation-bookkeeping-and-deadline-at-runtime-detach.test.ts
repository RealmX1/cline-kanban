// 孤儿回收的两头：detach 时给 host 定期限（取回收账本里当前那条 live 记录，与在线回收同一套防护），
// 以及新 runtime 接管被 host 回收的会话后补记账（账本 reclaimed、待答决策标回收、summary 写回收结果）。
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../../src/config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { recordHostedSessionsReclaimedByAgentSessionPtyHostWhileRuntimeWasAbsent } from "../../../src/server/agent-session-pty-host-orphan-reclamation-bookkeeping-after-runtime-restart";
import {
	loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace,
	resolveHostedSessionOrphanReclamationEligibleAtFromReclamationDeadlineRecords,
} from "../../../src/server/hosted-agent-session-orphan-reclamation-deadline-at-runtime-detach";
import type { PersistedAgentSessionReclamationDeadlineRecord } from "../../../src/state/agent-session-reclamation-deadline-store";
import * as reclamationDeadlineStore from "../../../src/state/agent-session-reclamation-deadline-store";

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

describe("loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace", () => {
	afterEach(() => vi.restoreAllMocks());

	const parkedDeadlineRecord = buildDeadlineRecord({
		recordId: "parked-task:incarnation-1:3",
		taskId: "parked-task",
		retentionAnchorKind: "session_parked_awaiting_dispatched_background_work",
		reclamationEligibleAt: 1_700_086_400_000,
	});
	const parkedSummary = buildStoppedClaudeSummary({
		taskId: "parked-task",
		state: "running",
		turnOwner: "agent",
		userTurnKind: null,
		awaitingDispatchedBackgroundWork: { sinceMs: 1_700_000_000_000 },
	});

	it("普通配置读取失败只暂停普通待命回收，park 仍保留期限与身份门禁", async () => {
		vi.spyOn(reclamationDeadlineStore, "readAgentSessionReclamationDeadlineRecords").mockResolvedValue([
			buildDeadlineRecord(),
			parkedDeadlineRecord,
		]);
		vi.spyOn(runtimeConfig, "readAgentSessionUserTurnIdleProcessRetentionDurationMinutes").mockRejectedValue(
			new Error("普通待命配置不可读"),
		);
		const refreshDeadline = vi.spyOn(
			reclamationDeadlineStore,
			"refreshAgentSessionUserTurnIdleProcessRetentionDeadline",
		);
		const warn = vi.fn();

		const readDeadline = await loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace("workspace-1", warn);

		expect(readDeadline(parkedSummary)).toBe(parkedDeadlineRecord.reclamationEligibleAt);
		expect(readDeadline(buildStoppedClaudeSummary())).toBeNull();
		expect(readDeadline({ ...parkedSummary, runtimeSessionIncarnationId: "new-incarnation" })).toBeNull();
		expect(readDeadline({ ...parkedSummary, agentResponseGenerationTurnSequence: 4 })).toBeNull();
		expect(readDeadline({ ...parkedSummary, awaitingDispatchedBackgroundWork: null })).toBeNull();
		expect(refreshDeadline).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("普通待命配置不可读"));
	});

	it("一条普通期限写失败只暂停该记录，保留其他已核实期限并允许重试恢复", async () => {
		const failedDeadlineRecord = buildDeadlineRecord();
		const successfulDeadlineRecord = buildDeadlineRecord({
			recordId: "successful-task:incarnation-1:3",
			taskId: "successful-task",
		});
		const records = [failedDeadlineRecord, parkedDeadlineRecord, successfulDeadlineRecord];
		vi.spyOn(reclamationDeadlineStore, "readAgentSessionReclamationDeadlineRecords").mockResolvedValue(records);
		vi.spyOn(runtimeConfig, "readAgentSessionUserTurnIdleProcessRetentionDurationMinutes").mockResolvedValue(120);
		const refreshDeadline = vi.spyOn(
			reclamationDeadlineStore,
			"refreshAgentSessionUserTurnIdleProcessRetentionDeadline",
		);
		refreshDeadline.mockImplementation(async (_workspaceId, recordId, durationMinutes, updatedAt) => {
			const record = records.find((candidate) => candidate.recordId === recordId);
			return record
				? { ...record, reclamationEligibleAt: record.retentionAnchorAt + durationMinutes * 60_000, updatedAt }
				: null;
		});
		refreshDeadline.mockRejectedValueOnce(new Error("普通期限持久写失败"));
		const warn = vi.fn();

		const readDeadline = await loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace("workspace-1", warn);

		expect(readDeadline(parkedSummary)).toBe(parkedDeadlineRecord.reclamationEligibleAt);
		expect(readDeadline(buildStoppedClaudeSummary({ taskId: "successful-task" }))).toBe(
			successfulDeadlineRecord.retentionAnchorAt + 120 * 60_000,
		);
		expect(readDeadline(buildStoppedClaudeSummary())).toBeNull();
		expect(refreshDeadline).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("taskId=task-1"));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("普通期限持久写失败"));

		const readRetriedDeadline = await loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace(
			"workspace-1",
			warn,
		);
		expect(readRetriedDeadline(buildStoppedClaudeSummary())).toBe(
			failedDeadlineRecord.retentionAnchorAt + 120 * 60_000,
		);
		expect(readRetriedDeadline(parkedSummary)).toBe(parkedDeadlineRecord.reclamationEligibleAt);
	});

	it("只有 park 记录时不依赖普通配置，显式无期限保持不回收", async () => {
		const noExpiryParkedDeadlineRecord = { ...parkedDeadlineRecord, reclamationEligibleAt: null };
		vi.spyOn(reclamationDeadlineStore, "readAgentSessionReclamationDeadlineRecords")
			.mockResolvedValueOnce([parkedDeadlineRecord])
			.mockResolvedValueOnce([noExpiryParkedDeadlineRecord]);
		const readOrdinaryRetentionDuration = vi
			.spyOn(runtimeConfig, "readAgentSessionUserTurnIdleProcessRetentionDurationMinutes")
			.mockRejectedValue(new Error("普通待命配置不可读"));
		const warn = vi.fn();

		const readDeadline = await loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace("workspace-1", warn);
		const readNoExpiryDeadline = await loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace(
			"workspace-1",
			warn,
		);

		expect(readDeadline(parkedSummary)).toBe(parkedDeadlineRecord.reclamationEligibleAt);
		expect(readNoExpiryDeadline(parkedSummary)).toBeNull();
		expect(readOrdinaryRetentionDuration).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("整个期限账本不可读时仍暂停所有宿主孤儿回收", async () => {
		vi.spyOn(reclamationDeadlineStore, "readAgentSessionReclamationDeadlineRecords").mockRejectedValue(
			new Error("期限账本不可读"),
		);
		const warn = vi.fn();

		const readDeadline = await loadHostedSessionOrphanReclamationEligibleAtReaderForWorkspace("workspace-1", warn);

		expect(readDeadline(parkedSummary)).toBeNull();
		expect(readDeadline(buildStoppedClaudeSummary())).toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("期限账本不可读"));
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
