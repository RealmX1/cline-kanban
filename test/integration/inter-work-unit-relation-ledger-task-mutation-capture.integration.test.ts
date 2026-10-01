import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import type { CommittedInterWorkUnitRelationLedgerEvent } from "../../src/core/inter-work-unit-relation-ledger-event-contract";
import { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import {
	createCapturingKanbanRuntimeInstanceIdentity,
	createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger,
} from "../../src/inter-work-unit-relation-ledger/workspace-board-persistence-funnel-task-mutation-event-capture-backed-by-relation-ledger";
import {
	registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
	type TaskMutationIntentWithResolvedActor,
	type WorkspaceBoardPersistenceFunnelTaskMutationEventCapture,
} from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceState, mutateWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

const TASK_MUTATION_INTENT_FROM_ACTING_CARD: TaskMutationIntentWithResolvedActor = {
	taskMutationIntentKind: "test_acting_card_updates_other_card",
	resolvedKanbanActor: {
		kanbanActorKind: "kanban_board_card_work_unit",
		actingKanbanBoardCardWorkUnit: {
			workUnitType: "kanban_board_card",
			workspaceId: "acting-workspace",
			taskId: "acting",
			taskIncarnationCreatedAtEpochMs: 1,
		},
	},
	idempotencyKey: "acting-card-request-1",
};

function createCard(taskId: string, prompt: string): RuntimeBoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1_000,
		updatedAt: 1_000,
	};
}

function createBoard(
	cardsByColumn: Partial<Record<"backlog" | "review" | "trash", RuntimeBoardCard[]>>,
): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: cardsByColumn.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: cardsByColumn.review ?? [] },
			{ id: "trash", title: "Done", cards: cardsByColumn.trash ?? [] },
		],
		dependencies: [],
	};
}

function createSessionSummaryWithNativeIdentity(taskId: string, nativeSessionId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "idle",
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "claude",
			nativeSessionId,
			transcriptPath: null,
			observedAt: 1_000,
		},
	} as RuntimeTaskSessionSummary;
}

function withoutCard(board: RuntimeBoardData, taskId: string): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.filter((card) => card.id !== taskId),
		})),
	};
}

async function withIsolatedHomeAndLedger(
	run: (context: {
		workspacePath: string;
		ledgerClient: InterWorkUnitRelationLedgerDatabaseWorkerClient;
		realCapture: WorkspaceBoardPersistenceFunnelTaskMutationEventCapture;
	}) => Promise<void>,
): Promise<void> {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const previousHome = process.env.HOME;
	process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
	const ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
		join(gitFixture.isolatedHomeDirectoryPath, "inter-work-unit-relation-ledger-test-root"),
	);
	try {
		const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-a");
		mkdirSync(repositoryPath, { recursive: true });
		gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
		await loadWorkspaceState(repositoryPath);
		const realCapture = createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger({
			ledgerClient,
			capturingKanbanRuntimeInstance: createCapturingKanbanRuntimeInstanceIdentity(),
		});
		await run({ workspacePath: repositoryPath, ledgerClient, realCapture });
	} finally {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
		await ledgerClient.close();
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		gitFixture.cleanup();
	}
}

function summarize(events: CommittedInterWorkUnitRelationLedgerEvent[]) {
	return events.map((event) => ({
		eventKind: event.eventKind,
		subjectTaskId: event.subjectTaskId,
		kanbanActorKind: event.actor.kanbanActorKind,
		captureMode: event.eventPayload.taskMutationOccurrenceCaptureMode ?? null,
	}));
}

describe("inter-work-unit relation ledger task mutation capture", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it("records an activation baseline, then captures funnel mutations with the declared actor and full field text", async () => {
		await withIsolatedHomeAndLedger(async ({ workspacePath, ledgerClient, realCapture }) => {
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard({ backlog: [createCard("t0001", "original requirement")] }),
				sessions: {},
			});
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);

			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, () => ({
				board: createBoard({
					backlog: [createCard("t0001", "amended requirement"), createCard("t0002", "spawned follow-up")],
				}),
				value: null,
			}));

			const events = await ledgerClient.listCommittedEvents({});
			expect(summarize(events)).toEqual([
				{
					eventKind: "board_state_baseline_observed_at_live_task_mutation_capture_activation",
					subjectTaskId: null,
					kanbanActorKind: "kanban_runtime_system_component",
					captureMode: null,
				},
				{
					eventKind: "task_card_field_value_changed",
					subjectTaskId: "t0001",
					kanbanActorKind: "kanban_board_card_work_unit",
					captureMode: "captured_within_runtime_persistence_funnel",
				},
				{
					eventKind: "task_card_field_value_changed",
					subjectTaskId: "t0001",
					kanbanActorKind: "kanban_board_card_work_unit",
					captureMode: "captured_within_runtime_persistence_funnel",
				},
				{
					eventKind: "task_card_created_on_board",
					subjectTaskId: "t0002",
					kanbanActorKind: "kanban_board_card_work_unit",
					captureMode: "captured_within_runtime_persistence_funnel",
				},
			]);
			expect(events.map((event) => event.globalCommittedEventSequence)).toEqual([1, 2, 3, 4]);

			const promptChange = events.find(
				(event) => event.eventPayload.changedTaskCardFieldName === "prompt" && event.subjectTaskId === "t0001",
			);
			expect(promptChange?.idempotencyKey).toBe("acting-card-request-1#board-derived-occurrence-0");
			expect(promptChange?.eventPayload.subjectKanbanBoardCard).toEqual({
				workUnitType: "kanban_board_card",
				workspaceId: expect.any(String),
				taskId: "t0001",
				taskIncarnationCreatedAtEpochMs: 1_000,
			});
			const retained = await ledgerClient.readRetainedFieldContents([
				promptChange?.eventPayload.fieldValueBeforeSha256 as string,
				promptChange?.eventPayload.fieldValueAfterSha256 as string,
			]);
			expect(retained.map((content) => JSON.parse(content.fieldValueCanonicalJson))).toEqual([
				"original requirement",
				"amended requirement",
			]);
		});
	});

	it("detects board changes written outside the runtime persistence funnel as unresolved-actor occurrences", async () => {
		await withIsolatedHomeAndLedger(async ({ workspacePath, ledgerClient, realCapture }) => {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, {
				board: createBoard({ backlog: [createCard("t0001", "requirement")] }),
				sessions: {},
			});

			// 模拟迁到 runtime procedure 之前的 CLI 进程：没有注册捕获，直接写盘。
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard({ trash: [createCard("t0001", "requirement")] }),
				sessions: {},
			});
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);
			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, (state) => ({
				board: state.board,
				value: null,
				save: false,
			}));

			const detected = (await ledgerClient.listCommittedEvents({})).filter(
				(event) =>
					event.eventPayload.taskMutationOccurrenceCaptureMode ===
					"detected_by_board_diff_outside_runtime_persistence_funnel",
			);
			expect(summarize(detected)).toEqual([
				{
					eventKind: "task_card_moved_to_trash_column",
					subjectTaskId: "t0001",
					kanbanActorKind: "unresolved_actor",
					captureMode: "detected_by_board_diff_outside_runtime_persistence_funnel",
				},
			]);
			expect(detected[0]?.eventPayload.occurredAtIsDetectionTimeNotActualOccurrenceTime).toBe(true);
		});
	});

	it("commits a pending batch whose board file landed, and abandons one whose board file was overwritten", async () => {
		await withIsolatedHomeAndLedger(async ({ workspacePath, ledgerClient, realCapture }) => {
			const captureThatCrashesBeforeCommit: WorkspaceBoardPersistenceFunnelTaskMutationEventCapture = {
				...realCapture,
				commitPendingTaskMutationEventsAfterBoardFileWrite: async () => {},
			};
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, {
				board: createBoard({ backlog: [createCard("t0001", "requirement")] }),
				sessions: {},
			});

			// 1) 写盘成功但提交前崩溃：下一次漏斗通过时，盘上 board 哈希吻合 → 补提交。
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(captureThatCrashesBeforeCommit);
			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, () => ({
				board: createBoard({ review: [createCard("t0001", "requirement")] }),
				value: null,
			}));
			const beforeRecovery = await ledgerClient.listCommittedEvents({});
			expect(
				beforeRecovery.some((event) => event.eventKind === "task_card_moved_between_non_trash_board_columns"),
			).toBe(false);
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);
			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, (state) => ({
				board: state.board,
				value: null,
				save: false,
			}));
			const afterRecovery = await ledgerClient.listCommittedEvents({});
			expect(summarize(afterRecovery).at(-1)).toEqual({
				eventKind: "task_card_moved_between_non_trash_board_columns",
				subjectTaskId: "t0001",
				kanbanActorKind: "kanban_board_card_work_unit",
				captureMode: "captured_within_runtime_persistence_funnel",
			});

			// 2) 提交前崩溃，随后漏斗外写入又改了 board：批次作废，净变化按漏斗外检出记账。
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(captureThatCrashesBeforeCommit);
			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, () => ({
				board: createBoard({
					review: [createCard("t0001", "requirement"), createCard("t0003", "abandoned batch card")],
				}),
				value: null,
			}));
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			const onDisk = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: withoutCard(onDisk.board, "t0001"),
				sessions: {},
			});
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);
			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, (state) => ({
				board: state.board,
				value: null,
				save: false,
			}));
			const finalEvents = await ledgerClient.listCommittedEvents({
				afterGlobalCommittedEventSequence: afterRecovery.at(-1)?.globalCommittedEventSequence,
			});
			expect(summarize(finalEvents)).toEqual([
				{
					eventKind: "task_card_permanently_removed_from_board",
					subjectTaskId: "t0001",
					kanbanActorKind: "unresolved_actor",
					captureMode: "detected_by_board_diff_outside_runtime_persistence_funnel",
				},
				{
					eventKind: "task_card_created_on_board",
					subjectTaskId: "t0003",
					kanbanActorKind: "unresolved_actor",
					captureMode: "detected_by_board_diff_outside_runtime_persistence_funnel",
				},
			]);
		});
	});

	it("seeds persisted native identity sidecars at activation and records later native identity changes", async () => {
		await withIsolatedHomeAndLedger(async ({ workspacePath, ledgerClient, realCapture }) => {
			const forkedCard = {
				...createCard("t0001", "forked from a standalone session"),
				taskAgentSessionInitialization: {
					sourceAgentId: "claude" as const,
					sourceSessionId: "11111111-1111-4111-8111-111111111111",
					sourceSessionReuseMode: "fork_existing_session" as const,
				},
			};
			await saveWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard({ review: [forkedCard] }),
				sessions: { t0001: createSessionSummaryWithNativeIdentity("t0001", "native-before-activation") },
			});
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(realCapture);
			await mutateWorkspaceState(workspacePath, TASK_MUTATION_INTENT_FROM_ACTING_CARD, (state) => ({
				board: state.board,
				sessions: {
					...state.sessions,
					t0001: createSessionSummaryWithNativeIdentity("t0001", "native-after-clear"),
				},
				value: null,
			}));

			const identityEvents = (await ledgerClient.listCommittedEvents({})).filter(
				(event) => event.eventFamily === "agent_conversation_session_identity_event",
			);
			expect(
				identityEvents.map((event) => ({
					eventKind: event.eventKind,
					identity:
						event.eventPayload.conversationSessionIdentityKey ??
						event.eventPayload.sourceConversationSessionIdentityKey,
				})),
			).toEqual([
				{
					eventKind: "persisted_session_native_identity_sidecar_read_at_live_capture_activation",
					identity: {
						conversationSessionHostKanbanAgentId: "claude",
						nativeConversationSessionId: "native-before-activation",
					},
				},
				{
					eventKind: "persisted_card_agent_session_initialization_sidecar_read_at_live_capture_activation",
					identity: {
						conversationSessionHostKanbanAgentId: "claude",
						nativeConversationSessionId: "11111111-1111-4111-8111-111111111111",
					},
				},
				{
					eventKind: "new_native_conversation_session_identity_observed_for_kanban_task_conversation_session",
					identity: {
						conversationSessionHostKanbanAgentId: "claude",
						nativeConversationSessionId: "native-after-clear",
					},
				},
			]);
		});
	});
});
