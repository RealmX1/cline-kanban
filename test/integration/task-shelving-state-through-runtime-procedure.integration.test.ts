import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import { applySessionFacets } from "../../src/core/session-activity";
import { registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard } from "../../src/state/workspace-board-save-state-post-deploy-verification-done-entry-guard-port";
import {
	loadWorkspaceBoardById,
	loadWorkspaceContext,
	loadWorkspaceState,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { type CreateTaskCardActionApiDependencies, createTaskCardActionApi } from "../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

const stages = ["backlog", "in_progress", "review", "validation", "trash"] as const;

afterEach(() => {
	registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard(null);
});

async function withShelvingRuntimeFixture(
	run: (fixture: Awaited<ReturnType<typeof createShelvingRuntimeFixture>>) => Promise<void>,
) {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const previousHome = process.env.HOME;
	process.env.HOME = fixture.isolatedHomeDirectoryPath;
	try {
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "shelving-runtime-project" });
		await run(await createShelvingRuntimeFixture(repository.repositoryPath));
	} finally {
		process.env.HOME = previousHome;
		fixture.cleanup();
	}
}

async function createShelvingRuntimeFixture(repositoryPath: string) {
	const context = await loadWorkspaceContext(repositoryPath);
	const board: RuntimeBoardData = {
		columns: stages.map((id) => ({
			id,
			title: id,
			cards: [
				{
					id,
					title: id,
					prompt: id,
					startInPlanMode: false,
					baseRef: "main",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		})),
	};
	await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, { board, sessions: {} });
	const startTaskSession = vi.fn<CreateTaskCardActionApiDependencies["runtimeApi"]["startTaskSession"]>(async () => ({
		ok: false,
		summary: null,
		error: "隔离启动失败",
	}));
	const stopTaskSession = vi.fn(async () => ({ ok: true, summary: null }));
	const deleteWorktree = vi.fn(async () => ({ ok: true, removed: false }));
	const ensureWorktree = vi.fn<CreateTaskCardActionApiDependencies["workspaceApi"]["ensureWorktree"]>(async () => ({
		ok: true,
		path: repositoryPath,
		baseRef: "main",
		baseCommit: "0".repeat(40),
	}));
	const broadcast = vi.fn();
	const caller = runtimeAppRouter.createCaller({
		requestedWorkspaceId: context.workspaceId,
		workspaceScope: { workspaceId: context.workspaceId, workspacePath: repositoryPath },
		kanbanRequestOriginActorEvidence: {
			decodedCliActorClaimsRequestHeader:
				decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
		},
		taskCardActionApi: createTaskCardActionApi({
			runtimeApi: {
				startTaskSession,
				stopTaskSession,
				transitionTaskToReview: async () => ({ ok: false, summary: null }),
			},
			workspaceApi: { ensureWorktree, deleteWorktree },
			broadcastRuntimeWorkspaceStateUpdated: broadcast,
			broadcastRuntimeProjectsUpdated: broadcast,
			findTaskSessionSummaryLiveInRuntimeProcessMemory: () => null,
			taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
		}),
	} as unknown as RuntimeTrpcContext);
	return { caller, context, board, startTaskSession, stopTaskSession, deleteWorktree, ensureWorktree, broadcast };
}

describe("搁置的服务端持久化与执行边界", () => {
	it.each([
		{ targetBoardColumnId: "trash", integrityRuleDescription: "PDV Done 门禁" },
		{ targetBoardColumnId: "backlog", integrityRuleDescription: "已启动任务禁止回 Backlog" },
	] as const)("整板伪造搁置状态不能绕过 $integrityRuleDescription", async ({ targetBoardColumnId }) => {
		await withShelvingRuntimeFixture(
			async ({ context, board, startTaskSession, stopTaskSession, deleteWorktree, ensureWorktree }) => {
				const startedSession = applySessionFacets({
					taskId: "review",
					state: "awaiting_review",
					agentId: "codex",
					workspacePath: context.repoPath,
					pid: null,
					startedAt: 10,
					updatedAt: 10,
					lastOutputAt: null,
					reviewReason: null,
					exitCode: null,
					lastHookAt: null,
					latestHookActivity: null,
				});
				const persisted = await saveWorkspaceState(context.repoPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board,
					sessions: { review: startedSession },
				});
				const reviewTaskCard = persisted.board.columns.find((column) => column.id === "review")?.cards[0];
				if (!reviewTaskCard) throw new Error("隔离 fixture 缺少 Review 任务");
				const doneEntryGuard = vi.fn(async () => new Set(["review"]));
				registerWorkspaceBoardSaveStatePostDeployVerificationDoneEntryGuard(doneEntryGuard);
				const incomingBoard: RuntimeBoardData = {
					columns: persisted.board.columns.map((column) => ({
						...column,
						cards: [
							...column.cards.filter((card) => card.id !== "review"),
							...(column.id === targetBoardColumnId
								? [{ ...reviewTaskCard, taskShelvingState: { isShelved: true, lastChangedAt: 100 } }]
								: []),
						],
					})),
				};
				const saved = await saveWorkspaceState(context.repoPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: incomingBoard,
					sessions: {},
					expectedRevision: persisted.revision,
				});
				if (targetBoardColumnId === "trash") {
					expect(doneEntryGuard).toHaveBeenCalledWith({
						workspaceId: context.workspaceId,
						taskIdsNewlyEnteringDone: ["review"],
						nowIso: expect.any(String),
					});
				} else expect(doneEntryGuard).not.toHaveBeenCalled();
				for (const state of [saved, await loadWorkspaceState(context.repoPath)]) {
					expect(state.board.columns.map((column) => column.cards.map((card) => card.id))).toEqual(
						stages.map((stage) => [stage]),
					);
					expect(
						state.board.columns.find((column) => column.id === "review")?.cards[0]?.taskShelvingState,
					).toBeUndefined();
					expect(state.sessions.review).toEqual(startedSession);
				}
				expect(startTaskSession).not.toHaveBeenCalled();
				expect(stopTaskSession).not.toHaveBeenCalled();
				expect(deleteWorktree).not.toHaveBeenCalled();
				expect(ensureWorktree).not.toHaveBeenCalled();
			},
		);
	});

	it("五种 Stage 往返、幂等、身份校验与旧快照保护均不产生会话副作用", async () => {
		await withShelvingRuntimeFixture(
			async ({
				caller,
				context,
				board,
				startTaskSession,
				stopTaskSession,
				deleteWorktree,
				ensureWorktree,
				broadcast,
			}) => {
				for (const taskId of stages) {
					const first = await caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({
						taskId,
						isShelved: true,
						expectedTaskIncarnationCreatedAtEpochMs: 1,
					});
					expect(first.boardWasSaved).toBe(true);
					const calls = broadcast.mock.calls.length;
					const second = await caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({
						taskId,
						isShelved: true,
					});
					expect(second.boardWasSaved).toBe(false);
					expect(second.taskCardSnapshotAfterAction).toEqual(first.taskCardSnapshotAfterAction);
					expect(broadcast).toHaveBeenCalledTimes(calls);
				}
				await expect(
					caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({
						taskId: "review",
						isShelved: false,
						expectedTaskIncarnationCreatedAtEpochMs: 99,
					}),
				).rejects.toThrow();
				const staleBoard = { columns: board.columns.map((column) => ({ ...column, cards: [] })) };
				await saveWorkspaceState(context.repoPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
					board: staleBoard,
					sessions: {},
				});
				const afterStaleSnapshot = await loadWorkspaceBoardById(context.workspaceId);
				expect(afterStaleSnapshot.columns.map((column) => column.cards.map((card) => card.id))).toEqual(
					stages.map((stage) => [stage]),
				);
				for (const taskId of stages) {
					const result = await caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({
						taskId,
						isShelved: false,
					});
					expect(result.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe(taskId);
				}
				expect(startTaskSession).not.toHaveBeenCalled();
				expect(stopTaskSession).not.toHaveBeenCalled();
				expect(deleteWorktree).not.toHaveBeenCalled();
				expect(ensureWorktree).not.toHaveBeenCalled();
			},
		);
	});
	it("搁置任务拒绝移列，Done 整列清理排除搁置卡", async () => {
		await withShelvingRuntimeFixture(async ({ caller, context, stopTaskSession }) => {
			for (const taskId of ["review", "trash"])
				await caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({ taskId, isShelved: true });
			await expect(
				caller.taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects({
					taskId: "review",
					targetBoardColumnId: "validation",
				}),
			).rejects.toThrow("取消搁置");
			await expect(
				caller.taskCardAction.moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktree({ taskId: "review" }),
			).rejects.toThrow("取消搁置");
			await caller.taskCardAction.permanentlyDeleteTaskCardsWithFullResourceCleanup({
				permanentlyDeletedTaskCardSelection: {
					permanentlyDeletedTaskCardSelectionKind: "every_task_card_in_board_column",
					selectedBoardColumnId: "trash",
				},
			});
			expect(
				(await loadWorkspaceBoardById(context.workspaceId)).columns.find((column) => column.id === "trash")?.cards,
			).toHaveLength(1);
			expect(stopTaskSession).not.toHaveBeenCalled();
		});
	});
	it.each([true, false])("单独启动取消搁置并原子移列，启动成功=%s", async (succeeds) => {
		await withShelvingRuntimeFixture(async ({ caller, context, startTaskSession }) => {
			await caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({
				taskId: "backlog",
				isShelved: true,
			});
			if (succeeds)
				startTaskSession.mockImplementation(async () => ({
					ok: true,
					summary: {
						taskId: "backlog",
						state: "running",
						agentId: "codex",
						workspacePath: null,
						pid: null,
						startedAt: 10,
						updatedAt: 10,
						lastOutputAt: null,
						reviewReason: null,
						exitCode: null,
					} as RuntimeTaskSessionSummary,
				}));
			const result = await caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({
				taskId: "backlog",
			});
			expect(result.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe("in_progress");
			expect(result.taskCardSnapshotAfterAction.taskCard.taskShelvingState?.isShelved).toBe(false);
			const reloaded = await loadWorkspaceState(context.repoPath);
			expect(
				reloaded.board.columns
					.find((column) => column.id === "in_progress")
					?.cards.find((card) => card.id === "backlog")?.taskShelvingState?.isShelved,
			).toBe(false);
		});
	});
	it("并发启动与搁置按同一任务串行，保留最终搁置意图", async () => {
		await withShelvingRuntimeFixture(async ({ caller, context }) => {
			await Promise.all([
				caller.taskCardAction.startTaskCardAgentSessionMovingItIntoInProgress({ taskId: "backlog" }),
				caller.taskCardAction.setTaskCardShelvingStateWithoutSessionSideEffects({
					taskId: "backlog",
					isShelved: true,
				}),
			]);
			const board = await loadWorkspaceBoardById(context.workspaceId);
			expect(
				board.columns.find((column) => column.id === "in_progress")?.cards.find((card) => card.id === "backlog")
					?.taskShelvingState?.isShelved,
			).toBe(true);
		});
	});
});
