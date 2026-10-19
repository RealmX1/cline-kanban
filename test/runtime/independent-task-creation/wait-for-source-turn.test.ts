import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { addTaskToColumn } from "../../../src/core/task-board-mutations";
import { createIndependentTaskCreationService } from "../../../src/independent-task-creation/independent-task-creation-service";
import { loadWorkspaceContext, mutateWorkspaceState } from "../../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../../utilities/task-mutation-intent-for-test-fixture";

afterEach(() => vi.unstubAllEnvs());
it("等待当前轮不打断来源，也不把错过的停止边沿与后续新回合混为同一固定时点", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	const repo = fixture.createNonBareRepository({ repositoryDirectoryName: "source-turn", initialBranchName: "main" });
	writeFileSync(join(repo.repositoryPath, "initial"), "base");
	repo.commitAllRepositoryFilesAtDate({ message: "初始化", authorAndCommitterIsoDate: "2026-01-01T00:00:00Z" });
	const workspace = await loadWorkspaceContext(repo.repositoryPath);
	const scope = { workspaceId: workspace.workspaceId, workspacePath: repo.repositoryPath };
	await mutateWorkspaceState(repo.repositoryPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => {
		const created = addTaskToColumn(
			state.board,
			"backlog",
			{ taskId: "a0001", title: "来源", prompt: "需求", baseRef: "main", startInPlanMode: false },
			randomUUID,
		);
		return { board: created.board, value: created.task };
	});
	let source = runtimeTaskSessionSummarySchema.parse({
		taskId: "peer",
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		agentId: "codex",
		workspacePath: repo.repositoryPath,
		pid: 123,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		agentResponseGenerationTurnSequence: 1,
		taskConversationSessionMetadata: {
			workspaceTaskId: "a0001",
			taskConversationSessionRole: "task_collaborator",
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: "侧线需求",
		},
	});
	const captureContext = vi.fn(async () => ({ before: [], after: [], warnings: [] }));
	const freezeConversation = vi.fn(async () => ({ seed: null, unavailableReason: "无固定原生身份" }));
	const service = createIndependentTaskCreationService({
		findSession: (_workspace, id) => (id === "peer" ? source : null),
		captureContext,
		freezeConversation,
	});
	const request = {
		requestId: "11111111-1111-4111-8111-111111111111",
		sourceTaskId: "a0001",
		sourceTaskConversationSessionId: "peer",
	};
	expect((await service.prepare(scope, request)).status).toBe("waiting_for_source_turn");
	expect(captureContext).not.toHaveBeenCalled();
	source = { ...source, agentResponseGenerationTurnSequence: 2 };
	const missedBoundary = await service.prepare(scope, request);
	expect(missedBoundary.contextCapturedAt).toBeNull();
	expect(missedBoundary.errorMessage).toContain("后续回合");
	expect(captureContext).not.toHaveBeenCalled();
	source = { ...source, state: "awaiting_review", turnOwner: "user", liveness: "live", userTurnKind: "review" };
	const explicitNewRequest = await service.prepare(scope, {
		...request,
		requestId: "22222222-2222-4222-8222-222222222222",
	});
	expect(explicitNewRequest.contextCapturedAt).not.toBeNull();
	expect(captureContext).toHaveBeenCalledTimes(1);
	// 生成材料读取与完整原生分支是两个独立能力；不能把缺少可读转录误当成 fork 失败。
	source = {
		...source,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "original-native",
			transcriptPath: null,
			observedAt: 1,
		},
	};
	const noReadableTranscriptService = createIndependentTaskCreationService({
		findSession: (_workspace, id) => (id === "peer" ? source : null),
		freezeConversation: async () => ({
			seed: {
				sourceAgentId: "codex",
				sourceSessionId: "fixed-native-seed",
				sourceSessionReuseMode: "fork_existing_session",
				sourceSessionWorkingDirectoryPath: repo.repositoryPath,
			},
			unavailableReason: null,
		}),
	});
	const nativeOnly = await noReadableTranscriptService.prepare(scope, {
		...request,
		requestId: "33333333-3333-4333-8333-333333333333",
	});
	expect(nativeOnly.contextWarnings.length).toBeGreaterThan(0);
	expect(nativeOnly.forkUnavailableReason).toBeNull();
	expect(nativeOnly.contextCapturedAt).not.toBeNull();
});
