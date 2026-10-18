import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
import type { CommittedInterWorkUnitRelationLedgerEvent } from "../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	collectKanbanCliInvocationEnvironmentActorClaims,
	decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
	encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue,
} from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import type { KanbanRequestOriginActorEvidence } from "../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	createCapturingKanbanRuntimeInstanceIdentity,
	createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger,
} from "../../src/inter-work-unit-relation-ledger/workspace-board-persistence-funnel-task-mutation-event-capture-backed-by-relation-ledger";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceBoardById, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, type RuntimeTrpcWorkspaceScope, runtimeAppRouter } from "../../src/trpc/app-router";
import { createTaskCardActionApi } from "../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// taskCardAction.* 走真实 tRPC 路由（输入/输出 zod 校验）、真实 board 漏斗与真实关系账本捕获，验证两件事：
//   1) 同一个服务端动作按请求来源记账：带页面 nonce 的请求按浏览器声明的发起方记成「用户手势」/「浏览器端自动流转」，
//      带 CLI 声明头的请求记成 CLI 行动者（带了发起方也不采信），意图名分别是 web_ui_task_card_action_* 与 CLI 旧名；
//   2) 动作作用于连接 scope 指向的那个项目——浏览器当前打开的是项目 A，也能对项目 B 的卡执行动作，A 不受影响。
// 会话起停与 worktree 建删不是本测试的对象，换成桩；现行 taskCardAction 置顶路径也在这里验。

function createCard(taskId: string, createdAt: number): RuntimeBoardCard {
	return {
		id: taskId,
		title: `card ${taskId}`,
		prompt: `prompt of ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(cardsByColumnId: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: cardsByColumnId.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: cardsByColumnId.in_progress ?? [] },
			{ id: "review", title: "Review", cards: cardsByColumnId.review ?? [] },
			{ id: "validation", title: "Validation", cards: cardsByColumnId.validation ?? [] },
			{ id: "trash", title: "Done", cards: cardsByColumnId.trash ?? [] },
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

const KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE_WITH_VERIFIED_NONCE: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
	webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
};

const KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI_WITHOUT_TASK_ENVIRONMENT: KanbanRequestOriginActorEvidence =
	{
		decodedCliActorClaimsRequestHeader: decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
			encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
				collectKanbanCliInvocationEnvironmentActorClaims({
					environment: {},
					invokingKanbanCliCodeVersion: "integration-test",
					invokingProcessWorkingDirectory: null,
				}),
			),
		),
	};

describe("taskCardAction commands through the runtime procedure", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it("attributes web page requests to the declared initiator and CLI requests to the CLI actor, on any registered project", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		const ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
			join(gitFixture.isolatedHomeDirectoryPath, "inter-work-unit-relation-ledger-test-root"),
		);
		try {
			const createProjectWithSeedBoard = async (
				projectDirectoryName: string,
				seedBoard: RuntimeBoardData,
			): Promise<RuntimeTrpcWorkspaceScope> => {
				const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, projectDirectoryName);
				mkdirSync(repositoryPath, { recursive: true });
				gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
				const workspaceContext = await loadWorkspaceContext(repositoryPath);
				await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: seedBoard,
					sessions: {},
				});
				return { workspaceId: workspaceContext.workspaceId, workspacePath: workspaceContext.repoPath };
			};
			// 项目 A 扮演浏览器「当前打开」的项目；全部动作都打到项目 B。
			const currentlyOpenProjectScope = await createProjectWithSeedBoard(
				"project-currently-open-in-browser",
				createBoard({ review: [createCard("aaa01", 1_000)] }),
			);
			const otherProjectScope = await createProjectWithSeedBoard(
				"project-acted-on-across-projects",
				createBoard({
					backlog: [createCard("web01", 2_000), createCard("cli01", 2_500)],
					review: [createCard("rev01", 3_000)],
				}),
			);
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(
				createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger({
					ledgerClient,
					capturingKanbanRuntimeInstance: createCapturingKanbanRuntimeInstanceIdentity(),
				}),
			);

			const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
			const broadcastRuntimeProjectsUpdated = vi.fn();
			const taskCardActionApi = createTaskCardActionApi({
				runtimeApi: {
					startTaskSession: async (_scope, request) => ({
						ok: true,
						summary: createRunningTaskSessionSummary(request.taskId),
					}),
					stopTaskSession: async () => ({ ok: true, summary: null }),
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
				broadcastRuntimeProjectsUpdated,
				findTaskSessionSummaryLiveInRuntimeProcessMemory: () => null,
				taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
			});
			const createCallerScopedToOtherProject = (
				kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
			) =>
				runtimeAppRouter.createCaller({
					requestedWorkspaceId: otherProjectScope.workspaceId,
					workspaceScope: otherProjectScope,
					kanbanRequestOriginActorEvidence,
					taskCardActionApi,
					// 本测试只触达 taskCardAction；其余 api 不参与，故不构造。
				} as unknown as RuntimeTrpcContext);
			const webUiPageCaller = createCallerScopedToOtherProject(
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_WEB_UI_PAGE_WITH_VERIFIED_NONCE,
			);
			const kanbanCliCaller = createCallerScopedToOtherProject(
				KANBAN_REQUEST_ORIGIN_ACTOR_EVIDENCE_FROM_KANBAN_CLI_WITHOUT_TASK_ENVIRONMENT,
			);

			// 页面：用户手势启动 web01；把 rev01 拖进 validation；auto review（commit 模式）把 web01 送进 Done。
			const webStarted = await webUiPageCaller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
				taskId: "web01",
				boardMutationInitiator: "web_ui_user_gesture",
			});
			expect(webStarted.agentSessionStartOutcome).toBe("agent_session_started");
			await webUiPageCaller.taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects({
				taskId: "rev01",
				targetBoardColumnId: "validation",
				boardMutationInitiator: "web_ui_user_gesture",
			});
			await expect(
				webUiPageCaller.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree({
					taskId: "web01",
					taskCommentToAppendWhenMovingIntoDone: {
						taskCommentEntryId: "empty-completion-comment",
						commentText: "  ",
					},
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			const completionRequest = {
				taskId: "web01",
				boardMutationInitiator: "web_ui_client_automation_auto_review_commit_mode_completion" as const,
				taskCommentToAppendWhenMovingIntoDone: {
					taskCommentEntryId: "durable-completion-comment",
					commentText: "  真实持久化\n确认完成  ",
				},
			};
			await webUiPageCaller.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
				completionRequest,
			);
			// 同一请求经过真实 schema 再次重试，不追加评论或再次清理。
			await webUiPageCaller.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree(
				completionRequest,
			);
			// 页面置顶经唯一 taskCardAction 入口，并保留用户手势行动者证据。
			await webUiPageCaller.taskCardAction.setTaskPinboardPinStateOfTaskCard({
				taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
				taskId: "rev01",
				taskPinboardPinReason: "watch it",
				boardMutationInitiator: "web_ui_user_gesture",
			});
			await expect(
				webUiPageCaller.taskCardAction.setTaskPinboardPinStateOfTaskCard({
					taskPinboardPinAction: "unpin_task_card",
					taskId: "gone1",
					boardMutationInitiator: "web_ui_user_gesture",
				}),
			).rejects.toMatchObject({ code: "NOT_FOUND" });

			// CLI：启动 cli01、改 rev01 的标题；带了发起方也照样记成 CLI 行动者。
			await kanbanCliCaller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: "cli01" });
			await kanbanCliCaller.taskCardAction.updateTaskCardFieldValues({
				taskId: "rev01",
				taskCardFieldUpdate: {
					taskCardFieldUpdateInputKind: "kanban_cli_task_update_command_raw_arguments",
					kanbanCliTaskCardFieldUpdateRawInput: { title: "renamed by the CLI" },
				},
				boardMutationInitiator: "web_ui_user_gesture",
			});

			// 只读查询：非当前项目上的卡也能拿到快照；不存在的卡回传「不存在」而不是错误。
			const readBack = await webUiPageCaller.taskCardAction.readTaskCardWithBoardColumn({ taskId: "rev01" });
			expect(readBack).toMatchObject({
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: {
					taskCard: { title: "renamed by the CLI", taskPinboardPinReason: "watch it" },
					boardColumnIdContainingTaskCard: "validation",
				},
			});
			expect(await webUiPageCaller.taskCardAction.readTaskCardWithBoardColumn({ taskId: "gone1" })).toEqual({
				taskCardLookupOutcome: "task_card_not_found_on_workspace_board",
				lookedUpTaskId: "gone1",
			});

			// 动作只落在 scope 指向的项目 B；浏览器当前打开的项目 A 原样未动。
			const boardOfOtherProject = await loadWorkspaceBoardById(otherProjectScope.workspaceId);
			expect(
				boardOfOtherProject.columns.find((column) => column.id === "trash")?.cards[0].taskCommentEntries,
			).toEqual([
				{
					taskCommentEntryId: "durable-completion-comment",
					commentText: "真实持久化\n确认完成",
					createdAt: expect.any(Number),
					updatedAt: expect.any(Number),
				},
			]);
			expect(
				boardOfOtherProject.columns.flatMap((column) => column.cards.map((card) => `${column.id}:${card.id}`)),
			).toEqual(["in_progress:cli01", "validation:rev01", "trash:web01"]);
			const boardOfCurrentlyOpenProject = await loadWorkspaceBoardById(currentlyOpenProjectScope.workspaceId);
			expect(
				boardOfCurrentlyOpenProject.columns.flatMap((column) =>
					column.cards.map((card) => `${column.id}:${card.id}`),
				),
			).toEqual(["review:aaa01"]);
			expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledWith(
				otherProjectScope.workspaceId,
				otherProjectScope.workspacePath,
			);
			expect(broadcastRuntimeWorkspaceStateUpdated).not.toHaveBeenCalledWith(
				currentlyOpenProjectScope.workspaceId,
				expect.anything(),
			);

			const capturedWithinFunnel = (await ledgerClient.listCommittedEvents({})).filter(
				(event: CommittedInterWorkUnitRelationLedgerEvent) =>
					event.eventPayload.taskMutationOccurrenceCaptureMode === "captured_within_runtime_persistence_funnel",
			);
			const describeCapturedEvent = (event: CommittedInterWorkUnitRelationLedgerEvent) => [
				event.subjectTaskId,
				event.eventKind,
				event.eventPayload.taskMutationIntentKind,
				event.actor,
			];
			const webUserGestureActor = { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" };
			const kanbanCliActor = {
				kanbanActorKind: "kanban_cli_invocation_without_task_or_session_environment",
				missingEnvironmentVariableNames: expect.any(Array),
			};
			expect(capturedWithinFunnel.map(describeCapturedEvent)).toEqual(
				expect.arrayContaining([
					[
						"web01",
						"task_card_moved_between_non_trash_board_columns",
						"web_ui_task_card_action_start_agent_session_moving_into_in_progress",
						webUserGestureActor,
					],
					[
						"rev01",
						"task_card_moved_between_non_trash_board_columns",
						"web_ui_task_card_action_move_between_non_trash_columns",
						webUserGestureActor,
					],
					[
						"web01",
						"task_card_moved_to_trash_column",
						"web_ui_task_card_action_move_into_done",
						{
							kanbanActorKind: "kanban_web_ui_client_side_automation_with_verified_page_load_nonce",
							boardMutationInitiator: "web_ui_client_automation_auto_review_commit_mode_completion",
						},
					],
					[
						"rev01",
						"task_card_field_value_changed",
						"web_ui_task_card_action_pin_to_task_pinboard",
						webUserGestureActor,
					],
					[
						"cli01",
						"task_card_moved_between_non_trash_board_columns",
						"kanban_cli_task_start_move_to_in_progress",
						kanbanCliActor,
					],
					["rev01", "task_card_field_value_changed", "kanban_cli_task_update", kanbanCliActor],
				]),
			);
			// 页面请求里没有一条落成「缺标注」：每个动作都带了发起方。
			expect(
				capturedWithinFunnel.filter(
					(event) =>
						event.actor.kanbanActorKind ===
						"kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation",
				),
			).toEqual([]);
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			await ledgerClient.close();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
	});
});
