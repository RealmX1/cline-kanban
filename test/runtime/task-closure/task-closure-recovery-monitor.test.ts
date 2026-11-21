import type * as NodeFsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskClosureRecord } from "../../../src/core/task-closure-contract";
import { getTaskClosureAutomaticRecoveryState } from "../../../src/task-closure/task-closure-automatic-recovery-policy";
import type { TaskClosureOperation } from "../../../src/task-closure/task-closure-operation-store";
import { createTaskClosureRecoveryMonitor } from "../../../src/task-closure/task-closure-recovery-monitor";

const recoveryHarness = vi.hoisted(() => ({
	operations: [] as TaskClosureOperation[],
	availableBlocks: 100_000,
	toolDirectoryModifiedAt: 1,
	activeLifecycleLocks: 0,
	cancelledRequests: new Set<string>(),
	reopenedRecords: new Map<string, TaskClosureRecord>(),
	history: [] as TaskClosureRecord[],
	archiveReconciliation: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof NodeFsPromises>()),
	statfs: vi.fn(async () => ({ bavail: recoveryHarness.availableBlocks, bsize: 4096 })),
	lstat: vi.fn(async () => ({ size: 1, mtimeMs: recoveryHarness.toolDirectoryModifiedAt })),
}));
vi.mock("../../../src/workspace/git-utils", () => ({ getGitStdout: vi.fn(async () => "") }));
vi.mock("../../../src/task-closure/task-closure-failure-recovery-evidence", () => ({
	readTaskClosureRecoveryEvidence: vi.fn(async () => ({
		fingerprint: "同一确定性失败的证据",
		prerequisiteSatisfied: true,
		provesRelevantRepair: false,
	})),
}));
vi.mock("../../../src/workspace/task-worktree", () => ({
	getTaskWorkspacePathInfo: vi.fn(async () => ({ path: "/isolated-source", exists: true })),
}));
vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceBoardById: vi.fn(async () => ({
		columns: [
			{
				id: "review",
				cards: recoveryHarness.operations.map((operation) => ({
					id: operation.taskIdentity.taskId,
					createdAt: 1,
					updatedAt: 1,
					taskClosureSummary: recoveryHarness.reopenedRecords.get(operation.taskIdentity.taskId),
				})),
			},
		],
	})),
}));
vi.mock("../../../src/task-closure/task-closure-operation-store", () => ({
	taskClosureIdentityKey: (value: unknown) => JSON.stringify(value),
	withTaskClosureLifecycleCancellationGuards: async (
		_operations: TaskClosureOperation[],
		action: () => Promise<unknown>,
	) => action(),
	isTaskClosureLifecycleCancellationRequested: vi.fn(async (operation: TaskClosureOperation) =>
		recoveryHarness.cancelledRequests.has(
			operation.reopening?.reopeningRequestId ?? operation.progress.closureRequestId,
		),
	),
	writeTaskClosureHistoryRecord: vi.fn(async (record: TaskClosureRecord) => {
		recoveryHarness.history.push(record);
	}),
	listTaskClosureOperations: vi.fn(async () => structuredClone(recoveryHarness.operations)),
	readTaskClosureOperation: vi.fn(async (identity: TaskClosureOperation["taskIdentity"]) =>
		structuredClone(
			recoveryHarness.operations.find((operation) => operation.taskIdentity.taskId === identity.taskId),
		),
	),
	writeTaskClosureOperation: vi.fn(async (operation: TaskClosureOperation) => {
		recoveryHarness.operations[
			recoveryHarness.operations.findIndex((entry) => entry.taskIdentity.taskId === operation.taskIdentity.taskId)
		] = structuredClone(operation);
	}),
	withTaskClosureLifecycleLocks: vi.fn(
		async (_workspace: string, _tasks: string[], action: () => Promise<unknown>) => {
			recoveryHarness.activeLifecycleLocks += 1;
			try {
				return await action();
			} finally {
				recoveryHarness.activeLifecycleLocks -= 1;
			}
		},
	),
	logTaskClosureRecoveryFailure: vi.fn(),
	writeTaskClosureAutomaticAttemptReceipt: vi.fn(async () => undefined),
}));

vi.mock("../../../src/task-closure/task-closure-archive", () => ({
	reconcileTaskClosureVerifiedArchivePublication: async () => {
		recoveryHarness.archiveReconciliation();
		return false;
	},
	reconcileTaskClosureCompletedSourceWorktreeRemoval: vi.fn(async () => false),
	reconcileTaskClosureCompletedArchiveRestoration: vi.fn(async () => false),
	reclaimCancelledTaskClosureRestorationWorktrees: vi.fn(async () => undefined),
}));
vi.mock("../../../src/task-closure/task-closure-unverified-candidate-reclamation", () => ({
	reconcileCancelledTaskClosureCandidateReclamation: vi.fn(async (operation: TaskClosureOperation) => {
		if (operation.progress.unverifiedCandidateReclamation)
			operation.progress.unverifiedCandidateReclamation.phase = "completed";
	}),
}));
vi.mock("../../../src/task-closure/task-closure-operation-progress-projection", () => ({
	persistTaskClosureProgressAndProjectOntoCurrentCard: vi.fn(
		async (_scope: unknown, operation: TaskClosureOperation) => {
			recoveryHarness.operations[
				recoveryHarness.operations.findIndex((entry) => entry.taskIdentity.taskId === operation.taskIdentity.taskId)
			] = structuredClone(operation);
			return true;
		},
	),
}));

function createSixPendingClosureRequests(): TaskClosureOperation[] {
	return ["0030c", "12fbc", "4b154", "60208", "bdbba", "d721e"].map((taskId, index) => ({
		schemaVersion: 1,
		taskIdentity: { workspaceId: "isolated-six-request-incident", taskId, taskIncarnationCreatedAtEpochMs: 1 },
		workspacePath: "/isolated-repository",
		sourceWorktreePath: "/isolated-source",
		sourceBoardColumnId: "review",
		sourceTaskUpdatedAtEpochMs: 1,
		request: { taskId },
		intent: {
			taskMutationIntentKind: "close_task",
			resolvedKanbanActor: {
				kanbanActorKind: "kanban_cli_invocation_without_task_or_session_environment",
				missingEnvironmentVariableNames: [],
			},
		},
		progress: {
			closureRequestId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
			phase: "preserving",
			attemptCount: 0,
			lastError: null,
			recoveryCondition: null,
			nextRetryAtEpochMs: null,
		},
		archiveManifest: null,
		closureRecord: null,
		lastAttemptRuntimeInstanceId: null,
		lastRecoveryProbeFingerprint: null,
	}));
}

beforeEach(() => {
	vi.useFakeTimers();
	recoveryHarness.operations = createSixPendingClosureRequests();
	recoveryHarness.availableBlocks = 100_000;
	recoveryHarness.toolDirectoryModifiedAt = 1;
	recoveryHarness.cancelledRequests.clear();
	recoveryHarness.reopenedRecords.clear();
	recoveryHarness.history.length = 0;
	recoveryHarness.archiveReconciliation.mockClear();
});
afterEach(() => vi.useRealTimers());

const failArchiveVerification = vi.fn(async (operation: TaskClosureOperation) => {
	expect(recoveryHarness.activeLifecycleLocks).toBe(0);
	const stored = recoveryHarness.operations.find(
		(entry) => entry.taskIdentity.taskId === operation.taskIdentity.taskId,
	);
	if (!stored) throw new Error("隔离请求缺失");
	stored.progress.phase = "preservation_waiting_for_recovery";
	stored.progress.attemptCount += 1;
	throw new Error("来源文件发生变化：.claude/commands/release.md");
});

describe("六请求结案事故的有界恢复", () => {
	it.each(["closure_publication", "reopening_restoration"] as const)(
		"持久撤销先于 %s 补记恢复为终态并登记回收",
		async (scenario) => {
			for (const operation of recoveryHarness.operations) {
				operation.schemaVersion = 2;
				if (scenario === "reopening_restoration")
					operation.reopening = {
						reopeningRequestId: operation.progress.closureRequestId,
						request: { taskId: operation.taskIdentity.taskId },
						intent: operation.intent,
						phase: "restoring_archive",
						startedAtEpochMs: 1,
						sourceTaskUpdatedAtEpochMs: 1,
						lastError: null,
					};
				recoveryHarness.cancelledRequests.add(operation.progress.closureRequestId);
			}
			const execute = vi.fn();
			const monitor = createTaskClosureRecoveryMonitor(execute);
			monitor.start();
			await vi.advanceTimersByTimeAsync(30_000);
			await monitor.close();
			expect(execute).not.toHaveBeenCalled();
			expect(recoveryHarness.archiveReconciliation).not.toHaveBeenCalled();
			for (const operation of recoveryHarness.operations) {
				expect(operation.progress.phase).toBe("cancelled");
				expect(operation.progress.unverifiedCandidateReclamation?.phase).toBe("completed");
				if (scenario === "reopening_restoration") expect(operation.reopening?.phase).toBe("cancelled");
			}
		},
	);
	it("第三次启动后成功看板记录已提交，冷重启无活会话也只补记完成与历史", async () => {
		for (const operation of recoveryHarness.operations) {
			operation.progress.phase = "cancelled";
			operation.reopening = {
				reopeningRequestId: operation.progress.closureRequestId,
				request: { taskId: operation.taskIdentity.taskId },
				intent: operation.intent,
				phase: "resuming_session",
				startedAtEpochMs: 1,
				sourceTaskUpdatedAtEpochMs: 1,
				lastError: null,
			};
			Object.assign(getTaskClosureAutomaticRecoveryState(operation), {
				automaticAttemptCount: 3,
				pendingSideEffect: "resume_session",
			});
			recoveryHarness.reopenedRecords.set(operation.taskIdentity.taskId, {
				closureRequestId: operation.progress.closureRequestId,
				taskIdentity: operation.taskIdentity,
				details: { outcome: "closure_outcome_unspecified", evidence: [], acceptedDeliverables: [] },
				eventKind: "reopened",
				isCurrentlyClosed: false,
				previousClosureRequestId: null,
				recordedAtEpochMs: 2,
				actor: operation.intent.resolvedKanbanActor,
				archiveManifest: {
					archiveDirectory: "",
					headCommit: null,
					persistentHeadReference: null,
					verifiedAtEpochMs: null,
					availability: "historical_artifacts_unavailable",
					preservedFileCount: 0,
					selectedArtifactRelativePaths: [],
				},
			});
		}
		const execute = vi.fn();
		const monitor = createTaskClosureRecoveryMonitor(execute, undefined, () => false);
		monitor.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await monitor.close();
		expect(execute).not.toHaveBeenCalled();
		expect(recoveryHarness.history).toHaveLength(6);
		for (const operation of recoveryHarness.operations) {
			expect(operation.reopening?.phase).toBe("completed");
			expect(operation.reopening?.automaticRecovery).toMatchObject({
				automaticAttemptCount: 3,
				pendingSideEffect: null,
			});
		}
	});
	it("第三次启动已成功但回执丢失时，仅凭所属活会话补记；没有活体不再启动", async () => {
		for (const operation of recoveryHarness.operations) {
			operation.progress.phase = "cancelled";
			operation.reopening = {
				request: { taskId: operation.taskIdentity.taskId },
				intent: operation.intent,
				phase: "resuming_session",
				startedAtEpochMs: 1,
				sourceTaskUpdatedAtEpochMs: 1,
				lastError: null,
			};
			Object.assign(getTaskClosureAutomaticRecoveryState(operation), {
				automaticAttemptCount: 3,
				pendingSideEffect: "resume_session",
			});
		}
		const reconcileCompleted = vi.fn(async (operation: TaskClosureOperation) => {
			const stored = recoveryHarness.operations.find(
				(entry) => entry.taskIdentity.taskId === operation.taskIdentity.taskId,
			);
			if (stored?.reopening) stored.reopening.phase = "completed";
		});
		const noLiveSession = createTaskClosureRecoveryMonitor(reconcileCompleted, undefined, () => false);
		noLiveSession.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await noLiveSession.close();
		expect(reconcileCompleted).not.toHaveBeenCalled();
		const withLiveSession = createTaskClosureRecoveryMonitor(reconcileCompleted, undefined, () => true);
		withLiveSession.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await withLiveSession.close();
		expect(reconcileCompleted).toHaveBeenCalledTimes(6);
	});
	it("相同失败跨五代运行时仍只执行首次尝试", async () => {
		failArchiveVerification.mockClear();
		for (let runtimeGeneration = 0; runtimeGeneration < 5; runtimeGeneration += 1) {
			const monitor = createTaskClosureRecoveryMonitor(failArchiveVerification);
			monitor.start();
			await vi.advanceTimersByTimeAsync(0);
			await monitor.close();
		}
		expect(failArchiveVerification).toHaveBeenCalledTimes(6);
	});
	it("失败副本引起的 64 MiB 空间波动及无关工具目录变化不触发复制", async () => {
		failArchiveVerification.mockClear();
		const monitor = createTaskClosureRecoveryMonitor(failArchiveVerification);
		monitor.start();
		await vi.advanceTimersByTimeAsync(0);
		for (let fluctuation = 0; fluctuation < 6; fluctuation += 1) {
			recoveryHarness.availableBlocks += fluctuation % 2 ? -16_384 : 16_384;
			recoveryHarness.toolDirectoryModifiedAt += 1;
			await vi.advanceTimersByTimeAsync(15_000);
		}
		await monitor.close();
		expect(failArchiveVerification).toHaveBeenCalledTimes(6);
	});
	it("已取消的原请求跨重启不恢复", async () => {
		failArchiveVerification.mockClear();
		for (const operation of recoveryHarness.operations) operation.progress.phase = "cancelled";
		const monitor = createTaskClosureRecoveryMonitor(failArchiveVerification);
		monitor.start();
		await vi.advanceTimersByTimeAsync(30_000);
		await monitor.close();
		expect(failArchiveVerification).not.toHaveBeenCalled();
	});
});
