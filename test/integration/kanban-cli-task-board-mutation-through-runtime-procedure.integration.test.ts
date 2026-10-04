import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
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
import { createTaskCardActionApi } from "../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { createWorkspaceApi } from "../../src/trpc/workspace-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// dd2db 1a.2b：`kanban task create` 经 `workspace.applyKanbanCliTaskBoardMutation` 落盘；update / start / done /
// delete 经 `taskCardAction.*`（与浏览器共用的唯一实现）。这里走真实的 tRPC 路由（含输入/输出 zod 校验）、真实的
// workspace api、真实的 board 漏斗、真实的行动者解析 lookups（读隔离 HOME 下的 workspace 索引与 board.json）与
// 真实的关系账本捕获，断言账本里每条漏斗内事件都记在「发起调用的那张卡」名下、意图名沿用迁移前的 CLI 旧名，
// 且卡片限定引用带 incarnation 戳。会话起停与 worktree 建删不是本测试的对象，换成桩。

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

function createRunningTaskSessionSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath: null,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
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
			const startedTaskSessionRequests: RuntimeTaskSessionStartRequest[] = [];
			const stoppedTaskSessionIds: string[] = [];
			const taskCardActionApi = createTaskCardActionApi({
				runtimeApi: {
					startTaskSession: async (_scope, request) => {
						startedTaskSessionRequests.push(request);
						return { ok: true, summary: createRunningTaskSessionSummary(request.taskId) };
					},
					stopTaskSession: async (_scope, request) => {
						stoppedTaskSessionIds.push(request.taskId);
						return { ok: true, summary: null };
					},
					transitionTaskToReview: async () => ({ ok: false, summary: null }),
				},
				workspaceApi: {
					ensureWorktree: async (_scope, request) => ({
						ok: true,
						path: join(gitFixture.isolatedHomeDirectoryPath, "worktrees", request.taskId),
						baseRef: request.baseRef,
						baseCommit: "0000000000000000000000000000000000000000",
					}),
					deleteWorktree: async () => ({ ok: true, removed: false }),
				},
				broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated: vi.fn(),
				findTaskSessionSummaryLiveInRuntimeProcessMemory: () => null,
				taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
			});
			const createCallerForCliInvocationEnvironment = (environment: Record<string, string>) =>
				runtimeAppRouter.createCaller({
					requestedWorkspaceId: workspaceId,
					workspaceScope,
					kanbanRequestOriginActorEvidence: createEvidenceFromCliInvocationEnvironment(environment),
					workspaceApi,
					taskCardActionApi,
					// 本测试只触达 workspace / taskCardAction 路由；其余 api 不参与，故不构造。
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
			const updated = await callerFromActingCardSession.taskCardAction.updateTaskCardFieldValues({
				taskId: createdTaskId,
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
					kanbanCliTaskCardFieldUpdateRawInput: { title: "renamed follow-up" },
				},
			});
			expect(updated.taskCardSnapshotAfterAction.taskCard.title).toBe("renamed follow-up");
			expect(updated.taskCardSnapshotAfterAction.taskCard.prompt).toBe("follow-up spawned by the acting card");
			expect(updated.taskCardSnapshotAfterAction.taskCard.clineSettings).toEqual({
				providerId: "anthropic",
				modelId: "claude-sonnet",
			});
			expect(updated.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe("backlog");
			expect(updated.taskCardSnapshotAfterAction.taskSessionSummaryPersistedInWorkspaceSessionsFile).toBeNull();

			// 3) start：第一次移入 in_progress 并起会话；第二次已在 in_progress、不写盘，会话照样会再起
			// （桩不维护活会话摘要，所以 runtime 看不到「已在 agent 回合」）。
			const movedIntoInProgress =
				await callerFromActingCardSession.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
					taskId: createdTaskId,
				});
			const movedIntoInProgressAgain =
				await callerFromActingCardSession.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
					taskId: createdTaskId,
				});
			expect(movedIntoInProgress).toMatchObject({
				taskCardWasMovedIntoInProgressColumnByThisAction: true,
				boardColumnIdOfTaskCardBeforeAction: "backlog",
				agentSessionStartOutcome: "agent_session_started",
			});
			expect(movedIntoInProgressAgain).toMatchObject({ taskCardWasMovedIntoInProgressColumnByThisAction: false });
			expect(startedTaskSessionRequests[0]).toMatchObject({ taskId: createdTaskId, startInPlanMode: true });

			// 4) done：review 卡移入 Done 并停会话（含详情终端）；再移一次是「已在 Done」，不再停。
			const trashed =
				await callerFromActingCardSessionWithOnlyRepositoryPath.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
					{ taskId: "rev01" },
				);
			const trashedAgain =
				await callerFromActingCardSession.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree({
					taskId: "rev01",
				});
			expect(trashed).toMatchObject({
				taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: false,
				boardColumnIdOfTaskCardBeforeAction: "review",
			});
			expect(trashedAgain).toMatchObject({
				taskCardWasAlreadyInTrashColumnSoNoSessionOrWorktreeCleanupRan: true,
				boardColumnIdOfTaskCardBeforeAction: "trash",
			});
			expect(stoppedTaskSessionIds.sort()).toEqual(["__detail_terminal__:rev01", "rev01"]);

			// 5) delete：按 task id 永久删除，回传删除前所在的列（收尾链里的草稿 / 队列 / checkpoint ref 清理真实执行）。
			const deleted =
				await callerFromActingCardSession.taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup({
					permanentlyDeletedTaskCardSelection: {
						permanentlyDeletedTaskCardSelectionKind: "task_cards_selected_by_task_id",
						selectedTaskIds: [createdTaskId],
					},
				});
			expect(deleted).toMatchObject({
				permanentlyDeletedTaskCards: [
					{ deletedTaskCard: { id: createdTaskId }, boardColumnIdOfDeletedTaskCardBeforeDeletion: "in_progress" },
				],
			});

			// 找不到的卡：原文案报错、不写盘。
			await expect(
				callerFromActingCardSession.taskCardAction.updateTaskCardFieldValues({
					taskId: "nope1",
					taskCardFieldUpdate: {
						taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
						kanbanCliTaskCardFieldUpdateRawInput: { title: "x" },
					},
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
