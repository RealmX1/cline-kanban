import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import { KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE } from "../../src/core/kanban-web-ui-page-load-request-origin-nonce";
import { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
import type { KanbanWebUiPageLoadRequestOriginNonceVerificationStatus } from "../../src/inter-work-unit-relation-ledger/kanban-web-ui-page-load-request-origin-nonce-registry";
import {
	createCapturingKanbanRuntimeInstanceIdentity,
	createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger,
} from "../../src/inter-work-unit-relation-ledger/workspace-board-persistence-funnel-task-mutation-event-capture-backed-by-relation-ledger";
import { registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture } from "../../src/state/workspace-board-persistence-funnel-task-mutation-event-capture-port";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createWorkspaceApi } from "../../src/trpc/workspace-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

// dd2db 1a.3：Web UI 页面加载 nonce（Y-EVENT-9）与 saveState 逐卡逐变更发起方标注（Y-EVENT-8），
// 走真实 tRPC 路由、真实 workspace api 与真实关系账本捕获。

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

function createBoard(columns: Partial<Record<"backlog" | "review" | "trash", RuntimeBoardCard[]>>): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: columns.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: columns.review ?? [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: columns.trash ?? [] },
		],
	};
}

describe("kanban web ui page load nonce and board mutation initiator annotations through saveState", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it("rejects unknown nonces as retryable, and attributes each occurrence of one whole-board save to its own initiator", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		const ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
			join(gitFixture.isolatedHomeDirectoryPath, "inter-work-unit-relation-ledger-test-root"),
		);
		try {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-web-ui");
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			const workspaceContext = await loadWorkspaceContext(repositoryPath);
			const workspaceScope = { workspaceId: workspaceContext.workspaceId, workspacePath: workspaceContext.repoPath };
			await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard({
					backlog: [createCard("u0001", "edited by the user", 1_000)],
					review: [createCard("r0002", "completed by auto review in PR mode", 2_000)],
				}),
				sessions: {},
			});
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(
				createWorkspaceBoardPersistenceFunnelTaskMutationEventCaptureBackedByRelationLedger({
					ledgerClient,
					capturingKanbanRuntimeInstance: createCapturingKanbanRuntimeInstanceIdentity(),
				}),
			);
			const workspaceApi = createWorkspaceApi({
				ensureTerminalManagerForWorkspace: vi.fn(),
				getScopedClineTaskSessionService: vi.fn(),
				loadScopedRuntimeConfig: vi.fn(),
				broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
				broadcastRuntimeProjectsUpdated: vi.fn(),
				buildWorkspaceStateSnapshot: vi.fn(),
				listProjectRuntimeSessionSummaries: vi.fn(() => []),
			});
			const createCallerWithWebUiPageLoadNonceStatus = (
				webUiPageLoadRequestOriginNonceVerificationStatus: KanbanWebUiPageLoadRequestOriginNonceVerificationStatus,
			) =>
				runtimeAppRouter.createCaller({
					requestedWorkspaceId: workspaceScope.workspaceId,
					workspaceScope,
					kanbanRequestOriginActorEvidence: {
						decodedCliActorClaimsRequestHeader:
							decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
						webUiPageLoadRequestOriginNonceVerificationStatus,
					},
					workspaceApi,
				} as unknown as RuntimeTrpcContext);

			const persisted = await loadWorkspaceState(repositoryPath);
			const nextBoard = createBoard({
				backlog: [
					createCard("u0001", "edited by the user, amended", 1_000),
					createCard("n0003", "created without an annotation", 3_000),
				],
				trash: [createCard("r0002", "completed by auto review in PR mode", 2_000)],
			});

			// 1) runtime 不认识的 nonce（例如 runtime 重启过）：可重试错误，board 不写。
			await expect(
				createCallerWithWebUiPageLoadNonceStatus("unknown").workspace.saveState({
					board: nextBoard,
					sessions: {},
					expectedRevision: persisted.revision,
				}),
			).rejects.toThrow(KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE);
			// 重取入口本身不过 nonce 闸。
			const reacquired =
				await createCallerWithWebUiPageLoadNonceStatus(
					"unknown",
				).runtime.issueKanbanWebUiPageLoadRequestOriginNonce();
			expect(reacquired.kanbanWebUiPageLoadIssuedRequestOriginNonce).toMatch(/^[0-9a-f-]{36}$/u);

			// 2) 带已签发 nonce 的整板保存：一次保存里三种发起方并存。
			await createCallerWithWebUiPageLoadNonceStatus("verified").workspace.saveState({
				board: nextBoard,
				sessions: {},
				expectedRevision: persisted.revision,
				boardMutationInitiatorAnnotationsForTaskMutationEventCapture: [
					{
						taskId: "u0001",
						annotatedBoardMutationKind: "task_card_field_value_changed",
						changedCardFieldNames: ["prompt", "title"],
						boardMutationInitiator: "web_ui_user_gesture",
					},
					{
						taskId: "r0002",
						annotatedBoardMutationKind: "task_card_moved_to_trash_column",
						fromColumnId: "review",
						toColumnId: "trash",
						boardMutationInitiator: "web_ui_client_automation_auto_review_pull_request_mode_completion",
					},
				],
			});

			const captured = (await ledgerClient.listCommittedEvents({}))
				.filter(
					(event) =>
						event.eventPayload.taskMutationOccurrenceCaptureMode === "captured_within_runtime_persistence_funnel",
				)
				.map((event) => [event.subjectTaskId, event.eventKind, event.actor]);
			expect(captured).toEqual(
				expect.arrayContaining([
					[
						"u0001",
						"task_card_field_value_changed",
						{ kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" },
					],
					[
						"r0002",
						"task_card_moved_to_trash_column",
						{
							kanbanActorKind: "kanban_web_ui_client_side_automation_with_verified_page_load_nonce",
							boardMutationInitiator: "web_ui_client_automation_auto_review_pull_request_mode_completion",
						},
					],
					[
						"n0003",
						"task_card_created_on_board",
						{
							kanbanActorKind:
								"kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation",
						},
					],
				]),
			);
			// 标注只进账本，不随 board 落盘。
			expect(JSON.stringify((await loadWorkspaceState(repositoryPath)).board)).not.toContain(
				"boardMutationInitiator",
			);
		} finally {
			registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
			await ledgerClient.close();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			gitFixture.cleanup();
		}
	});
});
