import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RuntimeBoardCard, RuntimeBoardData } from "../../src/core/api-contract";
import { decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue } from "../../src/core/kanban-cli-invocation-environment-actor-claims";
import { loadWorkspaceBoardById, loadWorkspaceContext, saveWorkspaceState } from "../../src/state/workspace-state";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../src/trpc/app-router";
import { createTaskCardActionApi } from "../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

it("便签经真实路由、文件锁和持久化跨 API 重建恢复，移列及旧整板不丢失，任务代际隔离", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	const previousHome = process.env.HOME;
	process.env.HOME = fixture.isolatedHomeDirectoryPath;
	try {
		const repositoryPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "task-sticker-persistence");
		mkdirSync(repositoryPath, { recursive: true });
		fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath, initialBranchName: "main" });
		const context = await loadWorkspaceContext(repositoryPath);
		const workspaceScope = { workspaceId: context.workspaceId, workspacePath: context.repoPath };
		const original: RuntimeBoardCard = {
			id: "sticker-task",
			title: "测试便签",
			prompt: "需求",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 2,
			taskDescriptionLastUpdatedAt: 1,
		};
		const originalBoard: RuntimeBoardData = { columns: [{ id: "review", title: "Review", cards: [original] }] };
		await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: originalBoard,
			sessions: {},
		});
		const createFreshRuntimeCaller = () =>
			runtimeAppRouter.createCaller({
				requestedWorkspaceId: context.workspaceId,
				workspaceScope,
				kanbanRequestOriginActorEvidence: {
					decodedCliActorClaimsRequestHeader:
						decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(undefined),
					webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
				},
				taskCardActionApi: createTaskCardActionApi({
					runtimeApi: {
						startTaskSession: async () => {
							throw new Error("便签不应启动会话");
						},
						stopTaskSession: async () => ({ ok: true, summary: null }),
						transitionTaskToReview: async () => ({ ok: false, summary: null }),
					},
					workspaceApi: {
						ensureWorktree: async () => {
							throw new Error("便签不应创建工作树");
						},
						deleteWorktree: async () => ({ ok: true, removed: false }),
					},
					broadcastRuntimeWorkspaceStateUpdated: () => {},
					broadcastRuntimeProjectsUpdated: () => {},
					findTaskSessionSummaryLiveInRuntimeProcessMemory: () => null,
					taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
				}),
			} as unknown as RuntimeTrpcContext);
		const caller = createFreshRuntimeCaller();
		const base = { taskId: original.id, expectedTaskIncarnationCreatedAtEpochMs: original.createdAt };
		await Promise.all(
			["first", "second"].map((taskStickerEntryId) =>
				caller.taskCardAction.applyTaskStickerEntryMutation({
					...base,
					mutation: { operation: "create", taskStickerEntryId, stickerText: `便签 ${taskStickerEntryId}` },
				}),
			),
		);
		await caller.taskCardAction.applyTaskStickerEntryMutation({
			...base,
			mutation: { operation: "set_collapsed", taskStickerEntryId: "first", isCollapsed: true },
		});
		// 重建 API 与串行器，所有后续事实只能从文件恢复。
		const restartedCaller = createFreshRuntimeCaller();
		const restored = await restartedCaller.taskCardAction.readTaskCardWithBoardColumn(base);
		expect(restored.taskCardLookupOutcome).toBe("task_card_found_on_workspace_board");
		if (restored.taskCardLookupOutcome !== "task_card_found_on_workspace_board") throw new Error("缺失任务");
		expect(restored.taskCardSnapshot.taskCard.taskStickerEntries?.[0]?.isCollapsed).toBe(true);
		expect(restored.taskCardSnapshot.taskCard.taskStickerEntries).toHaveLength(2);
		await restartedCaller.taskCardAction.moveTaskCardBetweenNonTrashColumnsWithoutSessionSideEffects({
			...base,
			targetBoardColumnId: "validation",
		});
		await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: originalBoard,
			sessions: {},
		});
		const persisted = (await loadWorkspaceBoardById(context.workspaceId)).columns.flatMap(
			(column) => column.cards,
		)[0];
		expect(persisted?.taskStickerEntries).toEqual(restored.taskCardSnapshot.taskCard.taskStickerEntries);
		expect(persisted?.taskDescriptionLastUpdatedAt).toBe(1);
		await restartedCaller.taskCardAction.applyTaskStickerEntryMutation({
			...base,
			mutation: { operation: "delete", taskStickerEntryId: "first", expectedStickerText: "便签 first" },
		});
		await createFreshRuntimeCaller().taskCardAction.applyTaskStickerEntryMutation({
			...base,
			mutation: { operation: "create", taskStickerEntryId: "first", stickerText: "迟到重试" },
		});
		expect(
			(await loadWorkspaceBoardById(context.workspaceId)).columns.flatMap((column) => column.cards)[0]
				?.taskStickerEntries,
		).toHaveLength(1);
		await saveWorkspaceState(repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
			board: { columns: [{ id: "backlog", title: "Backlog", cards: [{ ...original, createdAt: 100 }] }] },
			sessions: {},
		});
		await expect(
			restartedCaller.taskCardAction.applyTaskStickerEntryMutation({
				...base,
				mutation: { operation: "create", taskStickerEntryId: "late", stickerText: "不能串写" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});
