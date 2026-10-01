import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import {
	InterWorkUnitRelationLedgerUnavailableError,
	type TaskIdReservationSeedEntryFromExistingLocalTrace,
} from "../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable,
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
} from "../../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import type { PersistedWorkspaceStateById, RuntimeWorkspaceIndexEntry } from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

// 不变量：Y-EVENT-12 的 id 分配在 live capture 停用后必须 fail-closed（以账本不可用拒绝），绝不退回
// 「未注册捕获 → 返回 null → 纯函数按本 board 生成 id」；播种在途时停用，等播种的分配同样拒绝，worker 在播种落定后才关。
// 与停用 fail-closed 单测互补：这里的 workspace-state 替身补齐了播种路径要用的全部导出，播种真实地走完收集函数
// （workspace 索引 → 持久化 board → worktree 目录名 → `~/.claude/projects` 目录名），而不是一进入就因替身缺导出而失败。
// 账本 worker 与账本支撑的捕获仍用内存替身，不打开 sqlite。

const ledgerFakes = vi.hoisted(() => ({
	eventsInOrder: [] as string[],
	seededTaskIdsPerSeedingLedgerCall: [] as string[][],
	ledgerBackedTaskIdAllocations: [] as Array<{ requestingWorkspaceId: string | null }>,
}));

vi.mock(
	"../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client",
	async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>();
		class FakeInterWorkUnitRelationLedgerDatabaseWorkerClient {
			async appendCommittedEvents(): Promise<void> {}
			async seedTaskIdReservationsFromExistingLocalTraces(input: {
				seededTaskIdEntries: TaskIdReservationSeedEntryFromExistingLocalTrace[];
			}): Promise<number> {
				ledgerFakes.seededTaskIdsPerSeedingLedgerCall.push(input.seededTaskIdEntries.map((entry) => entry.taskId));
				ledgerFakes.eventsInOrder.push("task_id_reservations_seeded_into_ledger");
				return input.seededTaskIdEntries.length;
			}
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
		createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger: () => ({
			reconcileLedgerWithPersistedBoardWithinBoardLock: vi.fn(async () => {}),
			recordPendingTaskMutationEventsBeforeBoardFileWrite: vi.fn(async () => null),
			commitPendingTaskMutationEventsAfterBoardFileWrite: vi.fn(async () => {}),
			allocateTaskIdUniqueAgainstGlobalTaskIdentityRegistry: vi.fn(
				async (input: { requestingWorkspaceId: string | null }) => {
					ledgerFakes.ledgerBackedTaskIdAllocations.push(input);
					ledgerFakes.eventsInOrder.push("ledger_backed_task_id_allocation_reached");
					return "a110c";
				},
			),
			recordAgentConversationSessionNativeIdentityPersistedWithoutBlocking: vi.fn(),
		}),
	}),
);

vi.mock("../../../src/terminal/kanban-task-agent-session-work-unit-identity-environment", () => ({
	scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess: () => [],
}));

// 播种与急切基线经 workspace-state 读本机痕迹、走漏斗。播种用到的导出必须齐全，否则播种一进入就抛错、分配永远 fail-closed，
// 「播种成功后放行」那条用例会直接失败——替身漂移在这里会被行为断言抓到，而不是被强转掩盖。
const workspaceStateFakes = vi.hoisted(() => ({
	taskWorktreesHomePath: "",
	indexedWorkspaceEntries: [] as RuntimeWorkspaceIndexEntry[],
	persistedBoardCardTaskIdsByWorkspaceId: new Map<string, string[]>(),
	loadPersistedWorkspaceStateByIdHeldUntilReleased: null as Promise<void> | null,
	signalLoadPersistedWorkspaceStateByIdEnteredWhileHeld: (): void => {},
}));

function buildPersistedBoardCardForSeeding(taskId: string): RuntimeBoardCard {
	return {
		id: taskId,
		title: taskId,
		prompt: taskId,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

vi.mock("../../../src/state/workspace-state", () => ({
	getTaskWorktreesHomePath: () => workspaceStateFakes.taskWorktreesHomePath,
	listWorkspaceIndexEntries: async () => workspaceStateFakes.indexedWorkspaceEntries,
	loadPersistedWorkspaceStateById: async (workspaceId: string): Promise<PersistedWorkspaceStateById> => {
		const heldUntilReleased = workspaceStateFakes.loadPersistedWorkspaceStateByIdHeldUntilReleased;
		if (heldUntilReleased) {
			workspaceStateFakes.signalLoadPersistedWorkspaceStateByIdEnteredWhileHeld();
			await heldUntilReleased;
		}
		const persistedBoardCardTaskIds =
			workspaceStateFakes.persistedBoardCardTaskIdsByWorkspaceId.get(workspaceId) ?? [];
		return {
			workspaceId,
			statePath: `/nonexistent-workspace-state/${workspaceId}`,
			board: {
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: persistedBoardCardTaskIds.map(buildPersistedBoardCardForSeeding),
					},
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [] },
					{ id: "trash", title: "Done", cards: [] },
				],
			},
			sessions: {},
			revision: 1,
		};
	},
	resolveWorkspacePath: async (repositoryPath: string) => repositoryPath,
	mutateWorkspaceState: async () => {},
}));

const INDEXED_WORKSPACE_WITH_PERSISTED_CARDS: RuntimeWorkspaceIndexEntry = {
	workspaceId: "workspace-with-persisted-cards",
	repoPath: "/repositories/workspace-with-persisted-cards",
};

describe("kanban runtime inter-work-unit relation ledger live capture deactivation keeps task id allocation fail-closed with the seeding path executed", () => {
	let isolatedHomeDirectory: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;

	beforeEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		ledgerFakes.eventsInOrder.length = 0;
		ledgerFakes.seededTaskIdsPerSeedingLedgerCall.length = 0;
		ledgerFakes.ledgerBackedTaskIdAllocations.length = 0;
		// 播种扫 `homedir()/.claude/projects`：隔离 HOME，绝不扫开发者真实的 Claude Code 会话目录。
		isolatedHomeDirectory = createTempDir("kanban-live-capture-deactivation-task-id-seeding-home-");
		previousHome = process.env.HOME;
		process.env.HOME = isolatedHomeDirectory.path;
		workspaceStateFakes.taskWorktreesHomePath = join(isolatedHomeDirectory.path, "task-worktrees-home");
		workspaceStateFakes.indexedWorkspaceEntries = [INDEXED_WORKSPACE_WITH_PERSISTED_CARDS];
		workspaceStateFakes.persistedBoardCardTaskIdsByWorkspaceId = new Map([
			[INDEXED_WORKSPACE_WITH_PERSISTED_CARDS.workspaceId, ["c0ffe", "dead1"]],
		]);
		workspaceStateFakes.loadPersistedWorkspaceStateByIdHeldUntilReleased = null;
		workspaceStateFakes.signalLoadPersistedWorkspaceStateByIdEnteredWhileHeld = () => {};
	});

	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		isolatedHomeDirectory.cleanup();
	});

	it("播种真实走完收集函数（board 卡、worktree 目录名、Claude Code 会话目录名）并写进账本之后，分配才放行到账本", async () => {
		mkdirSync(join(workspaceStateFakes.taskWorktreesHomePath, "b0b0a"), { recursive: true });
		mkdirSync(join(isolatedHomeDirectory.path, ".claude", "projects", "-Users-someone-cline-worktrees-f00d2-repo"), {
			recursive: true,
		});
		const activated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		try {
			await activated.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			expect(ledgerFakes.seededTaskIdsPerSeedingLedgerCall).toEqual([["b0b0a", "c0ffe", "dead1", "f00d2"]]);

			await expect(
				allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
					requestingWorkspaceId: INDEXED_WORKSPACE_WITH_PERSISTED_CARDS.workspaceId,
				}),
			).resolves.toBe("a110c");
			expect(ledgerFakes.eventsInOrder).toEqual([
				"task_id_reservations_seeded_into_ledger",
				"ledger_backed_task_id_allocation_reached",
			]);
		} finally {
			await activated.deactivate();
		}
	});

	it("停用后分配以账本不可用拒绝：不返回 null（那会退回纯函数生成 id），也不触达账本支撑的分配", async () => {
		const activated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		await activated.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
		expect(ledgerFakes.seededTaskIdsPerSeedingLedgerCall).toHaveLength(1);
		await activated.deactivate();

		await expect(
			allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
				requestingWorkspaceId: INDEXED_WORKSPACE_WITH_PERSISTED_CARDS.workspaceId,
			}),
		).rejects.toBeInstanceOf(InterWorkUnitRelationLedgerUnavailableError);
		expect(ledgerFakes.ledgerBackedTaskIdAllocations).toEqual([]);
		expect(ledgerFakes.eventsInOrder).toEqual(["task_id_reservations_seeded_into_ledger", "ledger_client_closed"]);
	});

	it("播种收集在途时停用：等播种的分配以账本不可用拒绝，播种放弃写账本，worker 在播种落定之后才关", async () => {
		let releaseHeldPersistedWorkspaceStateRead: () => void = () => {};
		workspaceStateFakes.loadPersistedWorkspaceStateByIdHeldUntilReleased = new Promise((resolve) => {
			releaseHeldPersistedWorkspaceStateRead = resolve;
		});
		const heldPersistedWorkspaceStateReadEntered = new Promise<void>((resolve) => {
			workspaceStateFakes.signalLoadPersistedWorkspaceStateByIdEnteredWhileHeld = resolve;
		});
		const activated = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
		await heldPersistedWorkspaceStateReadEntered;

		// 停用之前发起：分配在就绪屏障上等这次在途播种。
		const allocationWaitingForInFlightSeeding = allocateTaskIdForNewTaskCardThroughRegisteredCaptureWhenAvailable({
			requestingWorkspaceId: INDEXED_WORKSPACE_WITH_PERSISTED_CARDS.workspaceId,
		});
		const allocationWaitingForInFlightSeedingSettled = allocationWaitingForInFlightSeeding.then(
			() => null,
			(error: unknown) => error,
		);
		const deactivation = activated.deactivate();
		// 让出一个完整的宏任务：停用若不等在途播种，此时 worker 已经关闭。
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(ledgerFakes.eventsInOrder).toEqual([]);

		releaseHeldPersistedWorkspaceStateRead();
		await deactivation;

		expect(await allocationWaitingForInFlightSeedingSettled).toBeInstanceOf(
			InterWorkUnitRelationLedgerUnavailableError,
		);
		expect(ledgerFakes.seededTaskIdsPerSeedingLedgerCall).toEqual([]);
		expect(ledgerFakes.ledgerBackedTaskIdAllocations).toEqual([]);
		expect(ledgerFakes.eventsInOrder).toEqual(["ledger_client_closed"]);
	});
});
