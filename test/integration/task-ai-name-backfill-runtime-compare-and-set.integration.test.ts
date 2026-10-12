import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import type { KanbanRequestOriginActorEvidence } from "../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { loadWorkspaceBoardById, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../../src/trpc/app-router";
import { createTaskCardActionApi } from "../../src/trpc/task-card-action-api";
import { createTaskCardActionPerTaskCommandSerializer } from "../../src/trpc/task-card-action-per-task-command-serializer";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";
import { withIsolatedWorkspaceHome } from "./isolated-workspace-home-fixture";

const browserActorEvidence: KanbanRequestOriginActorEvidence = {
	decodedCliActorClaimsRequestHeader: { cliActorClaimsRequestHeaderStatus: "absent" },
	webUiPageLoadRequestOriginNonceVerificationStatus: "verified",
};

function createTaskCardForBackfill(): RuntimeBoardCard {
	return {
		id: "name1",
		title: "初始名称",
		prompt: "完整初始需求",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createStartedSessionSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "name1",
		agentId: "codex",
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
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

function createBackfillApi(startTaskSession: () => Promise<{ ok: true; summary: RuntimeTaskSessionSummary }>) {
	const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
	const api = createTaskCardActionApi({
		runtimeApi: {
			startTaskSession,
			stopTaskSession: async () => ({ ok: true, summary: null }),
			transitionTaskToReview: async () => ({ ok: false, summary: null }),
		},
		workspaceApi: {
			ensureWorktree: async (scope) => ({
				ok: true,
				path: scope.workspacePath,
				baseRef: "main",
				baseCommit: "0".repeat(40),
			}),
			deleteWorktree: async () => ({ ok: true, removed: false }),
		},
		broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated: vi.fn(),
		findTaskSessionSummaryLiveInRuntimeProcessMemory: () => null,
		taskCardActionPerTaskCommandSerializer: createTaskCardActionPerTaskCommandSerializer(),
	});
	return { api, broadcastRuntimeWorkspaceStateUpdated };
}

async function seedCard(scope: RuntimeTrpcWorkspaceScope, card: RuntimeBoardCard | null): Promise<void> {
	const state = await loadWorkspaceState(scope.workspacePath);
	await saveWorkspaceState(scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: {
			...state.board,
			columns: state.board.columns.map((column) => ({
				...column,
				cards: column.id === "backlog" && card ? [card] : [],
			})),
		},
		sessions: card ? { [card.id]: createStartedSessionSummary() } : {},
	});
}

const backfillRequest = {
	taskId: "name1",
	taskCardFieldUpdate: {
		taskCardFieldUpdateInputKind: "three_state_task_card_field_value_patch" as const,
		taskCardFieldValuePatch: { title: "[FIX]建议名称" },
	},
	expectedTaskTitleAndPromptForAiNameBackfill: { title: "初始名称", prompt: "完整初始需求" },
};

describe("Task AI 名称回填的真实落盘与条件更新", () => {
	it.each([
		{ label: "用户或 agent 已改名", changedFields: { title: "新的明确名称" } },
		{ label: "用户或 agent 已改描述", changedFields: { prompt: "修改后的需求" } },
	])("$label：迟到的回填不写盘或广播", async ({ changedFields }) => {
		await withIsolatedWorkspaceHome(async (registerWorkspace) => {
			const workspace = await registerWorkspace("changed-task-fields");
			const scope = { workspaceId: workspace.workspaceId, workspacePath: workspace.path };
			const card = { ...createTaskCardForBackfill(), ...changedFields };
			await seedCard(scope, card);
			const { api, broadcastRuntimeWorkspaceStateUpdated } = createBackfillApi(async () => ({
				ok: true,
				summary: createStartedSessionSummary(),
			}));
			const revisionBefore = (await loadWorkspaceState(scope.workspacePath)).revision;
			const response = await api.updateTaskCardFieldValues(scope, backfillRequest, browserActorEvidence);
			expect(response.taskCardSnapshotAfterAction.taskCard).toMatchObject({
				title: card.title,
				prompt: card.prompt,
			});
			expect((await loadWorkspaceState(scope.workspacePath)).revision).toBe(revisionBefore);
			expect(broadcastRuntimeWorkspaceStateUpdated).not.toHaveBeenCalled();
		});
	});

	it("卡片已删除时拒绝回填，不重新创建卡片", async () => {
		await withIsolatedWorkspaceHome(async (registerWorkspace) => {
			const workspace = await registerWorkspace("deleted-task");
			const scope = { workspaceId: workspace.workspaceId, workspacePath: workspace.path };
			const { api, broadcastRuntimeWorkspaceStateUpdated } = createBackfillApi(async () => ({
				ok: true,
				summary: createStartedSessionSummary(),
			}));
			await expect(
				api.updateTaskCardFieldValues(scope, backfillRequest, browserActorEvidence),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect((await loadWorkspaceBoardById(scope.workspaceId)).columns.flatMap((column) => column.cards)).toEqual(
				[],
			);
			expect(broadcastRuntimeWorkspaceStateUpdated).not.toHaveBeenCalled();
		});
	});

	it("慢启动在途仍可回填，启动完成后保留最新名称、列和会话，跨项目不串写", async () => {
		await withIsolatedWorkspaceHome(async (registerWorkspace) => {
			const currentWorkspace = await registerWorkspace("currently-open-project");
			const targetWorkspace = await registerWorkspace("backfill-target-project");
			const currentScope = { workspaceId: currentWorkspace.workspaceId, workspacePath: currentWorkspace.path };
			const targetScope = { workspaceId: targetWorkspace.workspaceId, workspacePath: targetWorkspace.path };
			await seedCard(currentScope, { ...createTaskCardForBackfill(), id: "other", title: "其他项目名称" });
			await seedCard(targetScope, createTaskCardForBackfill());
			const currentBoardBefore = await loadWorkspaceBoardById(currentScope.workspaceId);
			let releaseStart!: (response: { ok: true; summary: RuntimeTaskSessionSummary }) => void;
			let observeStartEntered!: () => void;
			const startEntered = new Promise<void>((resolve) => {
				observeStartEntered = resolve;
			});
			const pendingStart = new Promise<{ ok: true; summary: RuntimeTaskSessionSummary }>((resolve) => {
				releaseStart = resolve;
			});
			const { api } = createBackfillApi(async () => {
				observeStartEntered();
				return await pendingStart;
			});
			const starting = api.startTaskCardAgentSessionMovingItIntoInProgress(
				targetScope,
				{ taskId: "name1" },
				browserActorEvidence,
			);
			try {
				await startEntered;
				const updated = await api.updateTaskCardFieldValues(targetScope, backfillRequest, browserActorEvidence);
				expect(updated.taskCardSnapshotAfterAction.taskCard.title).toBe("[FIX]建议名称");
				expect(updated.taskCardSnapshotAfterAction.boardColumnIdContainingTaskCard).toBe("in_progress");
				expect(
					updated.taskCardSnapshotAfterAction.taskSessionSummaryPersistedInWorkspaceSessionsFile,
				).toMatchObject({ taskId: "name1", agentId: "codex" });
			} finally {
				releaseStart({ ok: true, summary: createStartedSessionSummary() });
			}
			const started = await starting;
			expect(started.agentSessionStartOutcome).toBe("agent_session_started");
			expect(started.taskCardSnapshotAfterAction.taskCard.title).toBe("[FIX]建议名称");
			expect(
				(await loadWorkspaceBoardById(targetScope.workspaceId)).columns.find(
					(column) => column.id === "in_progress",
				)?.cards[0].title,
			).toBe("[FIX]建议名称");
			expect(await loadWorkspaceBoardById(currentScope.workspaceId)).toEqual(currentBoardBefore);
		});
	});
});
