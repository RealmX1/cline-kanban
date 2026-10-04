import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import { InterWorkUnitRelationLedgerDatabaseWorkerClient } from "../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-ledger-database-worker-client";
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

// cf427：Web UI 新建的卡在启动 agent 前经 `workspace.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart`
// 落盘。走真实 tRPC 路由、真实 workspace api、真实关系账本捕获（含 Y-EVENT-12 的 id 分配校验）。

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

function createBoard(backlogCards: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: backlogCards },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "validation", title: "Validation", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

function listBacklogTaskCardIds(board: RuntimeBoardData): string[] {
	return board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id) ?? [];
}

describe("web ui new backlog task cards persisted before agent session start", () => {
	afterEach(() => {
		registerWorkspaceBoardPersistenceFunnelTaskMutationEventCapture(null);
	});

	it("inserts new cards into the latest persisted board without revision CAS, idempotently, attributed to the user gesture", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const previousHome = process.env.HOME;
		process.env.HOME = gitFixture.isolatedHomeDirectoryPath;
		const ledgerClient = new InterWorkUnitRelationLedgerDatabaseWorkerClient(
			join(gitFixture.isolatedHomeDirectoryPath, "inter-work-unit-relation-ledger-test-root"),
		);
		try {
			const repositoryPath = join(gitFixture.ownedIntegrationProjectsDirectoryPath, "project-new-card");
			mkdirSync(repositoryPath, { recursive: true });
			gitFixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
			const workspaceContext = await loadWorkspaceContext(repositoryPath);
			const workspaceScope = { workspaceId: workspaceContext.workspaceId, workspacePath: workspaceContext.repoPath };
			await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
				board: createBoard([createCard("old01", "already on the board", 1_000)]),
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
			const callerFromWebUiPage = runtimeAppRouter.createCaller({
				requestedWorkspaceId: workspaceScope.workspaceId,
				workspaceScope,
				kanbanRequestOriginActorEvidence: {
					decodedCliActorClaimsRequestHeader:
						decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
					webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
				},
				workspaceApi,
			} as unknown as RuntimeTrpcContext);
			const allocateTaskId = async (): Promise<string> => {
				const allocation = await callerFromWebUiPage.workspace.allocateTaskIdForNewWebUiTaskCard();
				if (!allocation.allocatedTaskIdUniqueAgainstGlobalTaskIdentityRegistry) {
					throw new Error("expected the relation ledger to allocate a task id");
				}
				return allocation.allocatedTaskIdUniqueAgainstGlobalTaskIdentityRegistry;
			};

			// 浏览器此刻持有的快照：之后它的整板保存会带着这个 revision。
			const snapshotHeldByBrowser = await loadWorkspaceState(repositoryPath);
			const firstNewTaskId = await allocateTaskId();
			const firstNewCard = createCard(firstNewTaskId, "install the skill for codex", 5_000);

			// 1) 落盘：插到 backlog 顶部，revision 前进一格，并广播。
			const persisted =
				await callerFromWebUiPage.workspace.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
					newBacklogTaskCardsCreatedFromWebUi: [firstNewCard],
					boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
				});
			expect(listBacklogTaskCardIds(persisted.board)).toEqual([firstNewTaskId, "old01"]);
			expect(persisted.revision).toBe(snapshotHeldByBrowser.revision + 1);
			expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledOnce();

			// 2) 重试（或整板保存先到）：卡已在盘上，幂等返回，不写盘、不广播，也不拿浏览器那份覆盖盘上版本。
			const retried =
				await callerFromWebUiPage.workspace.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
					newBacklogTaskCardsCreatedFromWebUi: [{ ...firstNewCard, title: "stale browser copy" }],
					boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
				});
			expect(retried.revision).toBe(persisted.revision);
			expect(retried.board.columns[0]?.cards[0]?.title).toBe("install the skill for codex");
			expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledOnce();

			// 3) 与其他客户端的整板保存并发：两者都在 board 锁内，新卡不会被整板保存抹掉。
			const secondNewTaskId = await allocateTaskId();
			const boardFromOtherClient = createBoard([
				createCard(firstNewTaskId, "install the skill for codex", 5_000),
				createCard("old01", "edited on another device", 1_000),
			]);
			const [otherClientSaveOutcome] = await Promise.allSettled([
				callerFromWebUiPage.workspace.saveState({
					board: boardFromOtherClient,
					sessions: {},
					expectedRevision: persisted.revision,
				}),
				callerFromWebUiPage.workspace.persistNewBacklogTaskCardsCreatedFromWebUiBeforeAgentSessionStart({
					newBacklogTaskCardsCreatedFromWebUi: [createCard(secondNewTaskId, "second new card", 6_000)],
					boardMutationInitiatorOfNewBacklogTaskCards: "web_ui_user_gesture",
				}),
			]);
			const boardAfterConcurrentWrites = (await loadWorkspaceState(repositoryPath)).board;
			expect(listBacklogTaskCardIds(boardAfterConcurrentWrites)).toContain(secondNewTaskId);
			expect(listBacklogTaskCardIds(boardAfterConcurrentWrites)).toContain(firstNewTaskId);
			if (otherClientSaveOutcome.status === "rejected") {
				// 新卡先落盘：其他客户端拿旧 revision 的整板保存按 CAS 冲突，而不是悄悄覆盖掉新卡。
				expect(String(otherClientSaveOutcome.reason)).toContain("revision mismatch");
			}

			// 4) 账本：建卡事件记在用户手势名下，意图种类标明是启动前落盘这条路径。
			const createdEvents = (await ledgerClient.listCommittedEvents({})).filter(
				(event) =>
					event.eventKind === "task_card_created_on_board" &&
					event.eventPayload.taskMutationOccurrenceCaptureMode === "captured_within_runtime_persistence_funnel",
			);
			expect(
				createdEvents.map((event) => [
					event.subjectTaskId,
					event.eventPayload.taskMutationIntentKind,
					event.actor.kanbanActorKind,
				]),
			).toEqual(
				expect.arrayContaining([
					[
						firstNewTaskId,
						"web_ui_new_backlog_task_cards_persisted_before_agent_session_start",
						"kanban_web_ui_user_gesture_with_verified_page_load_nonce",
					],
					[
						secondNewTaskId,
						"web_ui_new_backlog_task_cards_persisted_before_agent_session_start",
						"kanban_web_ui_user_gesture_with_verified_page_load_nonce",
					],
				]),
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
