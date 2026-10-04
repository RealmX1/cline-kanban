import { beforeEach, describe, expect, it, vi } from "vitest";

import { InterWorkUnitRelationLedgerUnavailableError } from "../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	type WorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
} from "../../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../../utilities/task-mutation-intent-for-test-fixture";

// 不变量：runtime 进程内每一次 board 写入都先过账本，否则 fail-closed——live capture 停用后
// 绝不能退回「未注册捕获 → 直接写盘」。账本 worker 与账本支撑的捕获用内存桩替身，不打开 sqlite。

const ledgerFakes = vi.hoisted(() => {
	const eventsInOrder: string[] = [];
	const ledgerBackedCapturesInActivationOrder: Array<{
		reconcileLedgerWithPersistedBoardWithinBoardLock: ReturnType<typeof vi.fn>;
		recordPendingTaskMutationEventsBeforeBoardFileWrite: ReturnType<typeof vi.fn>;
		commitPendingTaskMutationEventsAfterBoardFileWrite: ReturnType<typeof vi.fn>;
		recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking: ReturnType<typeof vi.fn>;
	}> = [];
	return { eventsInOrder, ledgerBackedCapturesInActivationOrder };
});

vi.mock(
	"../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client",
	async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>();
		class FakeInterWorkUnitRelationLedgerDatabaseWorkerClient {
			async appendCommittedEvents(): Promise<void> {}
			async close(): Promise<void> {
				ledgerFakes.eventsInOrder.push("ledger_client_closed");
			}
		}
		return {
			...original,
			InterWorkUnitRelationLedgerDatabaseWorkerClient: FakeInterWorkUnitRelationLedgerDatabaseWorkerClient,
			resolveInterWorkUnitRelationLedgerStorageRootDirectory: () => "/nonexistent-ledger-storage-root-for-unit-test",
		};
	},
);

vi.mock(
	"../../../src/inter-work-unit-relation-ledger/workspace-board-persistence-funnel-task-mutation-event-capture-backed-by-relation-ledger",
	() => ({
		createCapturingKanbanRuntimeInstanceIdentity: () => ({
			kanbanRuntimeInstanceId: "fake-runtime-instance",
			kanbanRuntimeProcessId: 1,
		}),
		createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger: () => {
			const ledgerBackedCapture = {
				reconcileLedgerWithPersistedBoardWithinBoardLock: vi.fn(async () => {}),
				recordPendingTaskMutationEventsBeforeBoardFileWrite: vi.fn(async () => ({ pendingBatchId: "batch" })),
				commitPendingTaskMutationEventsAfterBoardFileWrite: vi.fn(async () => {}),
				recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking: vi.fn(),
			};
			ledgerFakes.ledgerBackedCapturesInActivationOrder.push(ledgerBackedCapture);
			return ledgerBackedCapture;
		},
	}),
);

vi.mock("../../../src/terminal/kanban-task-agent-session-work-unit-identity-environment", () => ({
	scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess: () => [],
}));

// 播种路径另有专门的单测（…-task-id-allocation-fails-closed-with-seeding-path-executed）。这里让收集直接返回空，
// 播种成功落定而不触账本，也绝不扫开发者真实 HOME 下的 `.claude/projects`。
vi.mock(
	"../../../src/inter-work-unit-relation-ledger/global-task-identity-registry-task-id-reservation-seeding-from-existing-local-traces",
	() => ({
		collectTaskIdReservationSeedingResultFromExistingLocalTraces: async () => ({
			seededTaskIdEntries: [],
			workspacesSkippedBecauseBoardSessionsOrMetaFileUnreadableAtSeeding: [],
		}),
	}),
);

// 激活后的急切基线任务经 workspace-state 遍历索引并走漏斗；默认索引为空，个别用例自行注入。
const workspaceStateFakes = vi.hoisted(() => ({
	indexedWorkspaceEntries: [] as Array<{ workspaceId: string; repoPath: string }>,
	mutateWorkspaceStateImplementation: async (): Promise<void> => {},
}));

vi.mock("../../../src/state/workspace-state", () => ({
	getTaskWorktreesHomePath: () => "/nonexistent-task-worktrees-home-for-unit-test",
	listWorkspaceIndexEntries: async () => workspaceStateFakes.indexedWorkspaceEntries,
	resolveWorkspacePath: async (repositoryPath: string) => repositoryPath,
	mutateWorkspaceState: async () => await workspaceStateFakes.mutateWorkspaceStateImplementation(),
}));

const emptyBoard = { columns: [] };

const reconcileInput: Parameters<
	WorkspaceBoardPersistenceFunnelTaskMutationEventCapture["reconcileLedgerWithPersistedBoardWithinBoardLock"]
>[0] = {
	workspaceId: "workspace",
	workspaceRepositoryPath: "/repositories/workspace",
	persistedBoard: emptyBoard,
	persistedSessions: {},
	persistedBoardFileSha256: null,
	persistedBoardFileRawText: null,
	persistedBoardRevision: 0,
};

const recordPendingInput: Parameters<
	WorkspaceBoardPersistenceFunnelTaskMutationEventCapture["recordPendingTaskMutationEventsBeforeBoardFileWrite"]
>[0] = {
	workspaceId: "workspace",
	workspaceRepositoryPath: "/repositories/workspace",
	previousBoard: emptyBoard,
	nextBoard: emptyBoard,
	previousSessions: {},
	nextSessions: {},
	nextBoardFileSha256: "next-board-file-sha256",
	nextBoardRevision: 1,
	taskMutationIntentWithResolvedActor: TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
};

function requireRegisteredCapture(): WorkspaceBoardPersistenceFunnelTaskMutationEventCapture {
	const capture = getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture();
	if (!capture) {
		throw new Error("expected a registered workspace board persistence funnel task mutation event capture");
	}
	return capture;
}

describe("kanban runtime inter-work-unit relation ledger live capture deactivation fails closed", () => {
	beforeEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		ledgerFakes.eventsInOrder.length = 0;
		ledgerFakes.ledgerBackedCapturesInActivationOrder.length = 0;
		workspaceStateFakes.indexedWorkspaceEntries = [];
		workspaceStateFakes.mutateWorkspaceStateImplementation = async () => {};
	});

	it("停用后不注销捕获：后续 board 写入以账本不可用拒绝，提交不抛也不再落到已关闭的账本", async () => {
		const activated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		await activated.deactivate();

		const captureAfterDeactivation = requireRegisteredCapture();
		await expect(
			captureAfterDeactivation.reconcileLedgerWithPersistedBoardWithinBoardLock(reconcileInput),
		).rejects.toBeInstanceOf(InterWorkUnitRelationLedgerUnavailableError);
		await expect(
			captureAfterDeactivation.recordPendingTaskMutationEventsBeforeBoardFileWrite(recordPendingInput),
		).rejects.toBeInstanceOf(InterWorkUnitRelationLedgerUnavailableError);
		await expect(
			captureAfterDeactivation.commitPendingTaskMutationEventsAfterBoardFileWrite({
				pendingBatchId: "batch",
				boardFileSha256: "sha",
				boardRevision: 1,
			}),
		).resolves.toBeUndefined();
		const [ledgerBackedCapture] = ledgerFakes.ledgerBackedCapturesInActivationOrder;
		expect(ledgerBackedCapture?.reconcileLedgerWithPersistedBoardWithinBoardLock).not.toHaveBeenCalled();
		expect(ledgerBackedCapture?.recordPendingTaskMutationEventsBeforeBoardFileWrite).not.toHaveBeenCalled();
		expect(ledgerBackedCapture?.commitPendingTaskMutationEventsAfterBoardFileWrite).not.toHaveBeenCalled();
	});

	it("旧实例停用不清掉之后激活的实例的捕获；新实例停用后注册还给旧实例（已停用则拒写）", async () => {
		const olderActivated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		const newerActivated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		const newerCapture = requireRegisteredCapture();

		await olderActivated.deactivate();
		expect(getRegisteredWorkspaceBoardPersistenceFunnelTaskMutationEventCapture()).toBe(newerCapture);
		await newerCapture.reconcileLedgerWithPersistedBoardWithinBoardLock(reconcileInput);
		const [, newerLedgerBackedCapture] = ledgerFakes.ledgerBackedCapturesInActivationOrder;
		expect(newerLedgerBackedCapture?.reconcileLedgerWithPersistedBoardWithinBoardLock).toHaveBeenCalledTimes(1);

		await newerActivated.deactivate();
		const captureAfterBothDeactivated = requireRegisteredCapture();
		expect(captureAfterBothDeactivated).not.toBe(newerCapture);
		await expect(
			captureAfterBothDeactivated.recordPendingTaskMutationEventsBeforeBoardFileWrite(recordPendingInput),
		).rejects.toBeInstanceOf(InterWorkUnitRelationLedgerUnavailableError);
	});

	it("停用前已在途的账本调用先落定，再关闭账本 worker", async () => {
		const activated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		const [ledgerBackedCapture] = ledgerFakes.ledgerBackedCapturesInActivationOrder;
		let releaseInFlightRecordPending: () => void = () => {};
		ledgerBackedCapture?.recordPendingTaskMutationEventsBeforeBoardFileWrite.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseInFlightRecordPending = () => {
						ledgerFakes.eventsInOrder.push("in_flight_record_pending_settled");
						resolve({ pendingBatchId: "in-flight-batch" });
					};
				}),
		);
		const inFlightRecordPending =
			requireRegisteredCapture().recordPendingTaskMutationEventsBeforeBoardFileWrite(recordPendingInput);

		const deactivation = activated.deactivate();
		// 让出一个完整的宏任务：停用若不等在途调用，此时 worker 已经关闭。
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(ledgerFakes.eventsInOrder).toEqual([]);
		releaseInFlightRecordPending();
		await deactivation;

		await expect(inFlightRecordPending).resolves.toEqual({ pendingBatchId: "in-flight-batch" });
		expect(ledgerFakes.eventsInOrder).toEqual(["in_flight_record_pending_settled", "ledger_client_closed"]);
	});

	it("停用时急切基线正卡在漏斗前半段：随后撞上 fail-closed 只记告警，无未处理 rejection，worker 在基线收尾后才关", async () => {
		workspaceStateFakes.indexedWorkspaceEntries = [{ workspaceId: "workspace", repoPath: "/repositories/workspace" }];
		let signalBaselineFunnelPassEntered: () => void = () => {};
		const baselineFunnelPassEntered = new Promise<void>((resolve) => {
			signalBaselineFunnelPassEntered = resolve;
		});
		let releaseBaselineFunnelPassBeforeLedgerReconcile: () => void = () => {};
		const baselineFunnelPassReleased = new Promise<void>((resolve) => {
			releaseBaselineFunnelPassBeforeLedgerReconcile = resolve;
		});
		// 模拟漏斗：先做 git 探测等非账本工作，再在 board 锁内调注册捕获的对账。
		workspaceStateFakes.mutateWorkspaceStateImplementation = async () => {
			signalBaselineFunnelPassEntered();
			await baselineFunnelPassReleased;
			try {
				await requireRegisteredCapture().reconcileLedgerWithPersistedBoardWithinBoardLock(reconcileInput);
			} catch (error) {
				ledgerFakes.eventsInOrder.push(
					error instanceof InterWorkUnitRelationLedgerUnavailableError
						? "baseline_funnel_pass_rejected_by_fail_closed_capture"
						: "baseline_funnel_pass_rejected_by_unexpected_error",
				);
				throw error;
			}
		};

		const activated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		await baselineFunnelPassEntered;
		const deactivation = activated.deactivate();
		releaseBaselineFunnelPassBeforeLedgerReconcile();

		await expect(deactivation).resolves.toBeUndefined();
		await expect(
			activated.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion,
		).resolves.toBeUndefined();
		expect(ledgerFakes.eventsInOrder).toEqual([
			"baseline_funnel_pass_rejected_by_fail_closed_capture",
			"ledger_client_closed",
		]);
		const [ledgerBackedCapture] = ledgerFakes.ledgerBackedCapturesInActivationOrder;
		expect(ledgerBackedCapture?.reconcileLedgerWithPersistedBoardWithinBoardLock).not.toHaveBeenCalled();
	});
});
