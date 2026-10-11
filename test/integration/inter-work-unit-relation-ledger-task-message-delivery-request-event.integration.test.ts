import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { CommittedInterWorkUnitRelationLedgerEvent } from "../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
} from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import {
	InterWorkUnitRelationLedgerDatabaseWorkerClient,
	resolveInterWorkUnitRelationLedgerStorageRootDirectory,
} from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import { activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture } from "../../src/inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking,
	recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking,
	recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking,
} from "../../src/inter-work-unit-relation-ledger/task-message-delivery-request-event-recording";
import { computeSha256HexOfUtf8Text } from "../../src/inter-work-unit-relation-ledger/workspace-board-task-mutation-occurrence-diff";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import type * as WorkspaceStateModule from "../../src/state/workspace-state";
import { loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
	TASK_MUTATION_INTENT_FOR_TEST_FIXTURE,
} from "../utilities/task-mutation-intent-for-test-fixture";

// message 记录在追加前先在后台读 board（卡片 incarnation）。个别用例把这一步卡住，模拟「读 board 期间 runtime 开始停机」；
// 未武装时原样透传。
const boardReadHeldForInFlightTaskMessageDeliveryRecording = vi.hoisted(() => ({
	loadWorkspaceBoardByIdHeldUntilReleased: null as Promise<void> | null,
	signalLoadWorkspaceBoardByIdEnteredWhileHeld: (): void => {},
}));

vi.mock("../../src/state/workspace-state", async (importOriginal) => {
	const original = await importOriginal<typeof WorkspaceStateModule>();
	return {
		...original,
		loadWorkspaceBoardById: async (workspaceId: string) => {
			const heldUntilReleased =
				boardReadHeldForInFlightTaskMessageDeliveryRecording.loadWorkspaceBoardByIdHeldUntilReleased;
			if (heldUntilReleased) {
				boardReadHeldForInFlightTaskMessageDeliveryRecording.signalLoadWorkspaceBoardByIdEnteredWhileHeld();
				await heldUntilReleased;
			}
			return await original.loadWorkspaceBoardById(workspaceId);
		},
	};
});

// 「终会发生」的单档等待：首次提交要等账本 Worker 线程冷启动并加载 better-sqlite3，vi.waitFor 默认 1s
// 在高负载下不够。放宽不损失判别力——断言判的是「最终落了几条、内容对不对」，不是多快。
const LEDGER_EVENT_COMMIT_WAIT_OPTIONS_COVERING_WORKER_COLD_START = { timeout: 15_000 };

describe("inter-work-unit relation ledger task message delivery request event", () => {
	it("records who sent the message, who authored the body, the idempotency key and the body hash, without the body", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		try {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-message");
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			const card = (taskId: string, createdAt: number) => ({
				id: taskId,
				title: taskId,
				prompt: taskId,
				startInPlanMode: false,
				baseRef: "main",
				createdAt,
				updatedAt: createdAt,
			});
			await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					columns: [
						{ id: "backlog", title: "Backlog", cards: [] },
						{ id: "in_progress", title: "In Progress", cards: [card("s0001", 1_000), card("r0002", 2_000)] },
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Done", cards: [] },
					],
				},
				sessions: {},
			});
			const { workspaceId } = await loadWorkspaceContext(repositoryPath, { autoCreateIfMissing: false });

			const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			try {
				const cliEvidenceFromSendingCard = {
					decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
						encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
							collectKanbanCliInvocationEnvironmentActorClaims({
								environment: { KANBAN_TASK_ID: "s0001", KANBAN_HOOK_WORKSPACE_ID: workspaceId },
								invokingKanbanCliCodeVersion: "0.0.0-test",
								invokingProcessWorkingDirectory: null,
							}),
						),
					),
				};
				const messageBody = "请吸收 s0001 的结论后继续";
				recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking({
					workspaceId,
					taskChatSendRequest: {
						taskId: "r0002",
						text: messageBody,
						source: "test-cross-card-handoff",
						idempotencyKey: "handoff-1",
					},
					taskChatSendResponse: null,
					kanbanRequestOriginActorEvidence: cliEvidenceFromSendingCard,
				});
				recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking({
					workspaceId,
					taskChatSendRequest: { taskId: "r0002", text: "typed or queued in the web ui" },
					taskChatSendResponse: null,
					kanbanRequestOriginActorEvidence:
						KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
				});

				let messageEvents: CommittedInterWorkUnitRelationLedgerEvent[] = [];
				await vi.waitFor(async () => {
					messageEvents = (await activatedLiveCapture.ledgerClient.listCommittedEvents({})).filter(
						(event) => event.eventKind === "task_message_delivery_requested_into_task_conversation_session",
					);
					expect(messageEvents).toHaveLength(2);
				}, LEDGER_EVENT_COMMIT_WAIT_OPTIONS_COVERING_WORKER_COLD_START);
				const fromCard = messageEvents.find(
					(event) => event.actor.kanbanActorKind === "kanban_board_card_work_unit",
				);
				expect(fromCard?.eventFamily).toBe("task_mutation_event");
				expect(fromCard?.subjectTaskId).toBe("r0002");
				expect(fromCard?.idempotencyKey).toBe(`task-message-delivery:${workspaceId}:r0002:handoff-1`);
				expect(fromCard?.eventPayload).toMatchObject({
					subjectKanbanBoardCard: { taskId: "r0002", taskIncarnationCreatedAtEpochMs: 2_000 },
					messageBodyAuthorshipIntentExtractionTreatment: "context_only_never_quote_as_user_statement",
					taskMessageDeliveryIdempotencyKey: "handoff-1",
					messageBodyContentSha256: computeSha256HexOfUtf8Text(messageBody),
					declaredMessageSourceLabel: "test-cross-card-handoff",
					taskMessageDeliveryChannel: "immediate_delivery_into_task_conversation_session",
					targetKanbanTaskConversationSessionId: "r0002",
				});
				expect(JSON.stringify(fromCard)).not.toContain(messageBody);
				const fromWebUi = messageEvents.find((event) => event !== fromCard);
				expect(fromWebUi?.eventPayload.messageBodyAuthorshipIntentExtractionTreatment).toBe(
					"message_body_authorship_not_determinable_from_request_origin",
				);
			} finally {
				await activatedLiveCapture.deactivate();
			}
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
		// 用例超时覆盖：账本提交等待 15s + 激活与停用 Worker。
	}, 45_000);

	it("停用时仍在读 board 的 message 记录先落到发起时的实例再关 worker；停用开始后才发起的记录只告警，不写账本也不重开 worker", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		const verificationLedgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
			resolveInterWorkUnitRelationLedgerStorageRootDirectory(),
		);
		const stderrWriteSpy = vi.spyOn(process.stderr, "write");
		try {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-message-drain");
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					columns: [
						{ id: "backlog", title: "Backlog", cards: [] },
						{
							id: "in_progress",
							title: "In Progress",
							cards: [
								{
									id: "d0003",
									title: "d0003",
									prompt: "d0003",
									startInPlanMode: false,
									baseRef: "main",
									createdAt: 3_000,
									updatedAt: 3_000,
								},
							],
						},
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Done", cards: [] },
					],
				},
				sessions: {},
			});
			const { workspaceId } = await loadWorkspaceContext(repositoryPath, { autoCreateIfMissing: false });

			const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			await activatedLiveCapture.eagerBoardStateBaselineEstablishmentForEveryIndexedWorkspaceCompletion;
			const appendCommittedEventsSpy = vi.spyOn(activatedLiveCapture.ledgerClient, "appendCommittedEvents");
			const closeSpy = vi.spyOn(activatedLiveCapture.ledgerClient, "close");

			let releaseHeldBoardRead: () => void = () => {};
			boardReadHeldForInFlightTaskMessageDeliveryRecording.loadWorkspaceBoardByIdHeldUntilReleased = new Promise(
				(resolve) => {
					releaseHeldBoardRead = resolve;
				},
			);
			const heldBoardReadEntered = new Promise<void>((resolve) => {
				boardReadHeldForInFlightTaskMessageDeliveryRecording.signalLoadWorkspaceBoardByIdEnteredWhileHeld = resolve;
			});
			try {
				recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking({
					workspaceId,
					taskChatSendRequest: { taskId: "d0003", text: "in flight at deactivation", idempotencyKey: "in-flight" },
					taskChatSendResponse: null,
					kanbanRequestOriginActorEvidence:
						KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
				});
				await heldBoardReadEntered;

				const deactivation = activatedLiveCapture.deactivate();
				// 让出一个完整的宏任务：停用若不等在途的后台记录，此时 worker 已经关闭。
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				expect(closeSpy).not.toHaveBeenCalled();

				recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking({
					workspaceId,
					taskChatSendRequest: {
						taskId: "d0003",
						text: "initiated after deactivation started",
						idempotencyKey: "after-deactivation",
					},
					taskChatSendResponse: null,
					kanbanRequestOriginActorEvidence:
						KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
				});
				releaseHeldBoardRead();
				await deactivation;
				// 再让出一个宏任务：被拒的记录若仍在后台跑，此时会撞上已关闭的 client。
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			} finally {
				boardReadHeldForInFlightTaskMessageDeliveryRecording.loadWorkspaceBoardByIdHeldUntilReleased = null;
				releaseHeldBoardRead();
			}

			expect(closeSpy).toHaveBeenCalledTimes(1);
			const [closeInvocationOrder] = closeSpy.mock.invocationCallOrder;
			// close 之后再无任何追加：worker client 关闭后再发请求会悄悄重开一个新 worker。
			expect(
				appendCommittedEventsSpy.mock.invocationCallOrder.every((order) => order < (closeInvocationOrder ?? 0)),
			).toBe(true);
			const appendedMessageEventDrafts = appendCommittedEventsSpy.mock.calls
				.flatMap(([appendInput]) => appendInput.eventDrafts)
				.filter(
					(eventDraft) =>
						eventDraft.eventKind === "task_message_delivery_requested_into_task_conversation_session",
				);
			expect(appendedMessageEventDrafts.map((eventDraft) => eventDraft.idempotencyKey)).toEqual([
				`task-message-delivery:${workspaceId}:d0003:in-flight`,
			]);

			const persistedMessageEvents = (
				await verificationLedgerClient.listCommittedEvents({ subjectWorkspaceId: workspaceId })
			).filter((event) => event.eventKind === "task_message_delivery_requested_into_task_conversation_session");
			expect(persistedMessageEvents.map((event) => event.idempotencyKey)).toEqual([
				`task-message-delivery:${workspaceId}:d0003:in-flight`,
			]);
			expect(persistedMessageEvents[0]?.eventPayload).toMatchObject({
				subjectKanbanBoardCard: { taskId: "d0003", taskIncarnationCreatedAtEpochMs: 3_000 },
			});
			expect(
				stderrWriteSpy.mock.calls.some(
					([chunk]) =>
						typeof chunk === "string" &&
						chunk.includes("task message delivery request for d0003 was not recorded because the live capture"),
				),
			).toBe(true);
		} finally {
			stderrWriteSpy.mockRestore();
			await verificationLedgerClient.close();
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
	});

	// dd2db T2：两条排队入口与立即投递记同一种事件，用 taskMessageDeliveryChannel 区分。
	it("records queued delivery requests: agent-idle-gated CLI enqueue and user Queue-tab entries for a by-the-way session", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		try {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-queued-message");
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			const card = (taskId: string, createdAt: number) => ({
				id: taskId,
				title: taskId,
				prompt: taskId,
				startInPlanMode: false,
				baseRef: "main",
				createdAt,
				updatedAt: createdAt,
			});
			await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: {
					columns: [
						{ id: "backlog", title: "Backlog", cards: [] },
						{ id: "in_progress", title: "In Progress", cards: [card("s0001", 1_000), card("r0002", 2_000)] },
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Done", cards: [] },
					],
				},
				sessions: {},
			});
			const { workspaceId } = await loadWorkspaceContext(repositoryPath, { autoCreateIfMissing: false });

			const activatedLiveCapture = activateKanbanRuntimeInterWorkUnitRelationLedgerLiveCapture();
			try {
				const cliEvidenceFromSendingCard = {
					decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
						encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
							collectKanbanCliInvocationEnvironmentActorClaims({
								environment: { KANBAN_TASK_ID: "s0001", KANBAN_HOOK_WORKSPACE_ID: workspaceId },
								invokingKanbanCliCodeVersion: "0.0.0-test",
								invokingProcessWorkingDirectory: null,
							}),
						),
					),
				};
				const agentIdleGatedMessageBody = "等你空闲后读 s0001 的交接";
				recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking({
					workspaceId,
					taskId: "r0002",
					messageBodyText: agentIdleGatedMessageBody,
					taskMessageDeliveryIdempotencyKey: "handoff-when-idle-1",
					declaredMessageSourceLabel: "test-cross-card-handoff",
					queuedPromptDeliveryQueueEntryId: "programmatic-queue-entry-1",
					maxWaitForAgentIdleMs: 600_000,
					kanbanRequestOriginActorEvidence: cliEvidenceFromSendingCard,
				});
				recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking({
					workspaceId,
					newlyCreatedQueueEntry: {
						queueEntryId: "user-queue-entry-1",
						taskId: "btw-session-of-r0002",
						text: "这轮结束后再跑一遍测试",
						deliverTogetherWithNextQueuedEntry: false,
						sourcePromptLibraryEntryId: null,
						sourcePromptLibraryEntryTextSha256: null,
						workspaceTaskId: "r0002",
						deliveryState: "queued",
						deliveryAttemptCount: 0,
						lastAttemptedAt: null,
						settledAt: null,
						dispatchIdempotencyKey: null,
						claimedForSessionIncarnationId: null,
						claimedAtTurnSequence: null,
						enqueuedAt: 5_000,
						expiresAt: 9_000,
						lastDeliveryFailureNote: null,
						survivedRuntimeRestartAtEpochMs: null,
						humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
					},
					retriedFromSettledFailedQueueEntryId: null,
					kanbanRequestOriginActorEvidence:
						KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_WITHOUT_CLI_ACTOR_CLAIMS_HEADER_FOR_TEST_FIXTURE,
				});

				let messageEvents: CommittedInterWorkUnitRelationLedgerEvent[] = [];
				await vi.waitFor(async () => {
					messageEvents = (
						await activatedLiveCapture.ledgerClient.listCommittedEvents({ subjectWorkspaceId: workspaceId })
					).filter(
						(event) => event.eventKind === "task_message_delivery_requested_into_task_conversation_session",
					);
					expect(messageEvents).toHaveLength(2);
				}, LEDGER_EVENT_COMMIT_WAIT_OPTIONS_COVERING_WORKER_COLD_START);
				const agentIdleGated = messageEvents.find(
					(event) =>
						event.eventPayload.taskMessageDeliveryChannel === "agent_idle_gated_programmatic_delivery_queue",
				);
				expect(agentIdleGated?.actor.kanbanActorKind).toBe("kanban_board_card_work_unit");
				expect(agentIdleGated?.subjectTaskId).toBe("r0002");
				// 与立即投递同一命名空间：同一个 CLI 幂等键只对应一次投递意图。
				expect(agentIdleGated?.idempotencyKey).toBe(
					`task-message-delivery:${workspaceId}:r0002:handoff-when-idle-1`,
				);
				expect(agentIdleGated?.eventPayload).toMatchObject({
					subjectKanbanBoardCard: { taskId: "r0002", taskIncarnationCreatedAtEpochMs: 2_000 },
					targetKanbanTaskConversationSessionId: "r0002",
					messageBodyAuthorshipIntentExtractionTreatment: "context_only_never_quote_as_user_statement",
					messageBodyContentSha256: computeSha256HexOfUtf8Text(agentIdleGatedMessageBody),
					queuedPromptDeliveryQueueEntryId: "programmatic-queue-entry-1",
					maxWaitForAgentIdleMs: 600_000,
				});
				expect(JSON.stringify(agentIdleGated)).not.toContain(agentIdleGatedMessageBody);

				const userQueued = messageEvents.find((event) => event !== agentIdleGated);
				expect(userQueued?.eventPayload.taskMessageDeliveryChannel).toBe(
					"user_queued_prompt_delivery_after_current_turn",
				);
				// by-the-way 会话的条目归到它所属的卡片名下；投递目标会话另记。
				expect(userQueued?.subjectTaskId).toBe("r0002");
				expect(userQueued?.idempotencyKey).toBe(
					`task-message-delivery:${workspaceId}:btw-session-of-r0002:queue-entry:user-queue-entry-1`,
				);
				expect(userQueued?.eventPayload).toMatchObject({
					subjectKanbanBoardCard: { taskId: "r0002", taskIncarnationCreatedAtEpochMs: 2_000 },
					targetKanbanTaskConversationSessionId: "btw-session-of-r0002",
					queuedPromptDeliveryQueueEntryId: "user-queue-entry-1",
					retriedFromSettledFailedQueueEntryId: null,
					queuedPromptDeliveryExpiresAtEpochMs: 9_000,
				});
			} finally {
				await activatedLiveCapture.deactivate();
			}
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
		// 用例超时覆盖：账本提交等待 15s + 激活与停用 Worker。
	}, 45_000);
});
