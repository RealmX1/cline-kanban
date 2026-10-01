import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import type { CommittedInterWorkUnitRelationLedgerEvent } from "../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
} from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import {
	createCapturingKanbanRuntimeInstanceIdentity,
	createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger,
} from "../../src/inter-work-unit-relation-ledger/workspace-board-persistence-funnel-task-mutation-event-capture-backed-by-relation-ledger";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceBoardById, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createWorkspaceApi } from "../../src/trpc/workspace-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// dd2db 1a.2b：`kanban task` 的写动词经 `workspace.applyKanbanCliTaskBoardMutation` 落盘。
// 这里走真实的 tRPC 路由（含输入/输出 zod 校验）、真实的 workspace api、真实的行动者解析 lookups
// （读隔离 HOME 下的 workspace 索引与 board.json）与真实的关系账本捕获，断言账本里每条漏斗内事件
// 都记在「发起调用的那张卡」名下，且卡片限定引用带 incarnation 戳。

const ACTING_TASK_ID = "act01";
const ACTING_TASK_INCARNATION_CREATED_AT_EPOCH_MS = 4_242;

function createCard(taskId: string, prompt: string, createdAt: number): RuntimeBoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createSeedBoard(): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					createCard(
						ACTING_TASK_ID,
						"acting card that runs the kanban CLI",
						ACTING_TASK_INCARNATION_CREATED_AT_EPOCH_MS,
					),
					createCard("wait1", "stays in backlog while rev01 moves to trash", 2_000),
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [createCard("rev01", "in review", 3_000)] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function createEvidenceFromCliInvocationEnvironment(environment: Record<string, string>) {
	return {
		decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
			encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
				collectKanbanCliInvocationEnvironmentActorClaims({
					environment,
					invokingKanbanCliCodeVersion: "integration-test",
					invokingProcessWorkingDirectory: null,
				}),
			),
		),
	};
}

describe("kanban CLI task board mutations through the runtime procedure", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it("records every CLI board write under the acting card with an incarnation-qualified reference", async () => {
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
			const workspaceContext = await loadWorkspaceContext(repositoryPath);
			const workspaceId = workspaceContext.workspaceId;
			const workspaceScope = { workspaceId, workspacePath: workspaceContext.repoPath };
			await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createSeedBoard(),
				sessions: {},
			});
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(
				createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger({
					ledgerClient,
					capturingKanbanRuntimeInstance: createCapturingKanbanRuntimeInstanceIdentity(),
				}),
			);

			const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
			const workspaceApi = createWorkspaceApi({
				ensureTerminalManagerForWorkspace: vi.fn(),
				getScopedClineTaskSessionService: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(),
				broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
				listProjectRuntimeSessionSummaries: vi.fn(() => []),
			});
			const createCallerForCliInvocationEnvironment = (environment: Record<string, string>) =>
				runtimeAppRouter.createCaller({
					requestedWorkspaceId: workspaceId,
					workspaceScope,
					kanbanRequestOriginActorEvidence: createEvidenceFromCliInvocationEnvironment(environment),
					workspaceApi,
					// 本测试只触达 workspace 路由；其余 api 不参与，故不构造。
				} as unknown as RuntimeTrpcContext);
			// 卡片会话注入的全套环境变量（含 workspace id）。
			const callerFromActingCardSession = createCallerForCliInvocationEnvironment({
				KANBAN_TASK_ID: ACTING_TASK_ID,
				KANBAN_HOOK_WORKSPACE_ID: workspaceId,
				KANBAN_TASK_CONVERSATION_SESSION_ID: ACTING_TASK_ID,
				CLAUDE_CODE_SESSION_ID: "claude-native-session-of-acting-card",
			});
			// 只剩仓库路径、且是未经 realpath 的原始路径：走生产 lookups 的按路径反查分支。
			const callerFromActingCardSessionWithOnlyRepositoryPath = createCallerForCliInvocationEnvironment({
				KANBAN_TASK_ID: ACTING_TASK_ID,
				KANBAN_PROJECT_PATH: repositoryPath,
			});

			// 1) create：runtime 分配 task id。
			const created = await callerFromActingCardSession.workspace.applyKanbanCliTaskBoardMutation({
				kanbanCliTaskBoardMutationKind: "create_backlog_task_card",
				backlogTaskCardFieldValuesResolvedByKanbanCli: {
					prompt: "follow-up spawned by the acting card",
					startInPlanMode: true,
					taskAgentPermissionMode: "ask_for_every_tool_use",
					baseRef: "main",
					clineSettings: { providerId: "anthropic", modelId: "claude-sonnet" },
					ompAgentSessionTransportForNewTasks: "pty_terminal",
					workspaceDefaultAgentIdForNewTasks: "claude",
				},
			});
			if (created.kanbanCliTaskBoardMutationKind !== "create_backlog_task_card") {
				throw new Error("expected a create response");
			}
			const createdTaskId = created.createdBacklogTaskCard.id;
			expect(created.createdBacklogTaskCard.startInPlanMode).toBe(true);
			expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith(workspaceId, workspaceContext.repoPath);

			// 2) update：只改标题；合并在 runtime 锁内对最新卡片进行，未传字段保留现值。
			const updated = await callerFromActingCardSession.workspace.applyKanbanCliTaskBoardMutation({
				kanbanCliTaskBoardMutationKind: "update_task_card_fields",
				updatedTaskId: createdTaskId,
				kanbanCliTaskCardFieldUpdateRawInput: { title: "renamed follow-up" },
			});
			if (updated.kanbanCliTaskBoardMutationKind !== "update_task_card_fields") {
				throw new Error("expected an update response");
			}
			expect(updated.updatedTaskCard.title).toBe("renamed follow-up");
			expect(updated.updatedTaskCard.prompt).toBe("follow-up spawned by the acting card");
			expect(updated.updatedTaskCard.clineSettings).toEqual({ providerId: "anthropic", modelId: "claude-sonnet" });
			expect(updated.updatedTaskCardBoardColumnId).toBe("backlog");
			expect(updated.updatedTaskCardSessionSummaryPersistedOnDisk).toBeNull();

			// 3) start 的移列：第一次移入，第二次已在 in_progress、不写盘。
			const movedIntoInProgress = await callerFromActingCardSession.workspace.applyKanbanCliTaskBoardMutation({
				kanbanCliTaskBoardMutationKind: "move_task_card_to_in_progress_column",
				movedTaskId: createdTaskId,
			});
			const movedIntoInProgressAgain = await callerFromActingCardSession.workspace.applyKanbanCliTaskBoardMutation({
				kanbanCliTaskBoardMutationKind: "move_task_card_to_in_progress_column",
				movedTaskId: createdTaskId,
			});
			expect(movedIntoInProgress).toMatchObject({
				taskCardWasMovedIntoInProgressColumn: true,
				movedTaskCardBoardColumnIdBeforeMutation: "backlog",
			});
			expect(movedIntoInProgressAgain).toMatchObject({ taskCardWasMovedIntoInProgressColumn: false });

			// 4) trash：review 卡移入 trash（只移列，不再有「就绪的下游 backlog 卡」）；再移一次是「已在 trash」。
			const trashed =
				await callerFromActingCardSessionWithOnlyRepositoryPath.workspace.applyKanbanCliTaskBoardMutation({
					kanbanCliTaskBoardMutationKind: "move_task_card_to_trash_column",
					movedTaskId: "rev01",
				});
			const trashedAgain = await callerFromActingCardSession.workspace.applyKanbanCliTaskBoardMutation({
				kanbanCliTaskBoardMutationKind: "move_task_card_to_trash_column",
				movedTaskId: "rev01",
			});
			expect(trashed).toMatchObject({
				taskCardWasAlreadyInTrashColumn: false,
				movedTaskCardBoardColumnIdBeforeMutation: "review",
			});
			expect(trashedAgain).toMatchObject({
				taskCardWasAlreadyInTrashColumn: true,
				movedTaskCardBoardColumnIdBeforeMutation: "trash",
			});

			// 5) delete：按 task id 永久删除，回传删除前所在的列。
			const deleted = await callerFromActingCardSession.workspace.applyKanbanCliTaskBoardMutation({
				kanbanCliTaskBoardMutationKind: "permanently_delete_task_cards",
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
					selectedTaskIds: [createdTaskId],
				},
			});
			expect(deleted).toMatchObject({
				permanentlyDeletedTaskCards: [
					{ deletedTaskCard: { id: createdTaskId }, deletedTaskCardBoardColumnIdBeforeDeletion: "in_progress" },
				],
			});

			// 找不到的卡：原文案报错、不写盘。
			await expect(
				callerFromActingCardSession.workspace.applyKanbanCliTaskBoardMutation({
					kanbanCliTaskBoardMutationKind: "update_task_card_fields",
					updatedTaskId: "nope1",
					kanbanCliTaskCardFieldUpdateRawInput: { title: "x" },
				}),
			).rejects.toThrow(`Task "nope1" was not found in workspace ${workspaceContext.repoPath}.`);

			const boardAfterMutations = await loadWorkspaceBoardById(workspaceId);
			expect(
				boardAfterMutations.columns.flatMap((column) => column.cards.map((card) => `${column.id}:${card.id}`)),
			).toEqual([`backlog:${ACTING_TASK_ID}`, "backlog:wait1", "trash:rev01"]);

			const capturedWithinFunnel = (await ledgerClient.listCommittedEvents({})).filter(
				(event: CommittedInterWorkUnitRelationLedgerEvent) =>
					event.eventPayload.taskMutationOccurrenceCaptureMode === "captured_within_runtime_persistence_funnel",
			);
			expect(
				capturedWithinFunnel.map((event) => [event.eventKind, event.eventPayload.taskMutationIntentKind]),
			).toEqual(
				expect.arrayContaining([
					["task_card_created_on_board", "kanban_cli_task_create"],
					["task_card_field_value_changed", "kanban_cli_task_update"],
					["task_card_moved_between_non_trash_board_columns", "kanban_cli_task_start_move_to_in_progress"],
					["task_card_moved_to_trash_column", "kanban_cli_task_trash"],
					["task_card_permanently_removed_from_board", "kanban_cli_task_delete"],
				]),
			);
			for (const event of capturedWithinFunnel) {
				expect(event.actor).toEqual({
					kanbanActorKind: "kanban_board_card_work_unit",
					actingKanbanBoardCardWorkUnit: {
						workUnitType: "kanban_board_card",
						workspaceId,
						taskId: ACTING_TASK_ID,
						taskIncarnationCreatedAtEpochMs: ACTING_TASK_INCARNATION_CREATED_AT_EPOCH_MS,
					},
				});
			}
			const createdEvent = capturedWithinFunnel.find((event) => event.eventKind === "task_card_created_on_board");
			expect(createdEvent?.eventPayload.subjectKanbanBoardCard).toEqual({
				workUnitType: "kanban_board_card",
				workspaceId,
				taskId: createdTaskId,
				taskIncarnationCreatedAtEpochMs: created.createdBacklogTaskCard.createdAt,
			});
			// 行动者上下文也随事件落账：原生会话身份与事件时刻的仓库身份。
			expect(createdEvent).toMatchObject({
				actorNativeConversationSessionIdentity: {
					conversationSessionHostKanbanAgentId: "claude",
					nativeConversationSessionId: "claude-native-session-of-acting-card",
				},
				actorRepositoryIdentityAtEventTime: { workspaceId, repositoryPath: workspaceContext.repoPath },
				invokingKanbanCliCodeVersion: "integration-test",
			});
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			await ledgerClient.close();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
	});
});
