import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultAcpSummary } from "../../src/acp-client-session/acp-session-state";
import { createAcpTaskSessionService } from "../../src/acp-client-session/acp-task-session-service";
import { runtimeRecordCurrentTaskProgressRequestSchema } from "../../src/core/api-contract";
import { addTaskToColumn } from "../../src/core/task-board-mutations";
import type { KanbanRequestOriginActorEvidence } from "../../src/inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	loadPersistedWorkspaceStateById,
	loadWorkspaceContext,
	saveWorkspaceState,
} from "../../src/state/workspace-state";
import { TerminalSessionManager } from "../../src/terminal/session-manager";
import { createRuntimeApi } from "../../src/trpc/runtime-api";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

afterEach(() => vi.unstubAllEnvs());

it("真实持久化漏斗同时保存任务概况与进展，跨 manager 重建可读，重试幂等且过期身份不能覆盖", async () => {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "codex"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "codex"));
	const projectPath = join(fixture.ownedIntegrationProjectsDirectoryPath, "task-progress-project");
	await mkdir(projectPath, { recursive: true });
	fixture.createNonBareRepositoryAtOwnedPath({ repositoryPath: projectPath, initialBranchName: "main" });
	const created = addTaskToColumn(
		{ columns: [{ id: "in_progress", title: "In Progress", cards: [] }] },
		"in_progress",
		{
			taskId: "abc12",
			title: "原始任务名",
			prompt: "用户原始需求保持原样",
			baseRef: "main",
		},
		randomUUID,
		1,
	);
	const nativeId = randomUUID();
	const initialSummary = {
		...createDefaultAcpSummary("abc12", "codex"),
		workspacePath: projectPath,
		sessionTransport: "pty_terminal" as const,
		runtimeSessionIncarnationId: randomUUID(),
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex" as const,
			nativeSessionId: nativeId,
			transcriptPath: null,
			observedAt: 1,
		},
	};
	await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: created.board,
		sessions: { abc12: initialSummary },
	});
	const workspace = await loadWorkspaceContext(projectPath, { autoCreateIfMissing: false });
	const scope = { workspaceId: workspace.workspaceId, workspacePath: projectPath };
	const evidence = (nativeSessionId = nativeId): KanbanRequestOriginActorEvidence => ({
		decodedCliActorClaimsRequestHeader: {
			cliActorClaimsRequestHeaderStatus: "present",
			claims: {
				claimedEnvironmentVariableValuesByName: {
					KANBAN_TASK_ID: "abc12",
					KANBAN_HOOK_WORKSPACE_ID: scope.workspaceId,
					KANBAN_TASK_CONVERSATION_SESSION_ID: "abc12",
					KANBAN_PROJECT_PATH: projectPath,
					CODEX_THREAD_ID: nativeSessionId,
				},
				invokingKanbanCliCodeVersion: "test",
				invokingProcessWorkingDirectory: projectPath,
			},
		},
	});
	const manager = new TerminalSessionManager();
	manager.hydrateFromRecord({ abc12: initialSummary });
	const api = createRuntimeApi({
		getActiveWorkspaceId: () => scope.workspaceId,
		getScopedTerminalManager: async () => manager,
		getScopedAcpTaskSessionService: async () => createAcpTaskSessionService(),
		loadScopedRuntimeConfig: async () => {
			throw new Error("进展更新不应读取启动配置。");
		},
		setActiveRuntimeConfig: () => {},
		resolveInteractiveShellCommand: () => ({ binary: "unused", args: [] }),
		runCommand: async () => {
			throw new Error("进展更新不应执行命令。");
		},
		getUpdateStatus: () => ({
			currentVersion: "test",
			latestVersion: null,
			updateAvailable: false,
			updateTiming: null,
			installCommand: null,
		}),
		runUpdateNow: async () => ({
			status: "unsupported_installation",
			currentVersion: "test",
			latestVersion: null,
			message: "测试不执行更新。",
		}),
	});
	const first = runtimeRecordCurrentTaskProgressRequestSchema.parse({
		progressEntryId: "implementation-started",
		progressText: "开始实现按范围分批的查卡",
		implementationStarted: true,
		expectedTaskCardUpdatedAt: 1,
		taskTitle: "压缩查卡输入",
		taskDescription: "保留全范围召回，候选按需读取原文。",
	});
	await api.recordCurrentTaskProgress(scope, first, evidence());
	let persisted = await loadPersistedWorkspaceStateById(scope.workspaceId);
	const card = () => persisted.board.columns.flatMap((column) => column.cards).find((entry) => entry.id === "abc12");
	expect(card()).toMatchObject({
		title: "压缩查卡输入",
		taskDescription: first.taskDescription,
		prompt: "用户原始需求保持原样",
	});
	expect(persisted.sessions.abc12.agentWorkProgressEntries).toHaveLength(1);
	const entries = persisted.sessions.abc12.agentWorkProgressEntries;
	await api.recordCurrentTaskProgress(scope, first, evidence());
	expect((await loadPersistedWorkspaceStateById(scope.workspaceId)).sessions.abc12.agentWorkProgressEntries).toEqual(
		entries,
	);
	await expect(
		api.recordCurrentTaskProgress(
			scope,
			{ progressEntryId: "stale", progressText: "过期覆盖", taskDescription: "不应写入" },
			evidence(),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await expect(
		api.recordCurrentTaskProgress(
			scope,
			{ progressEntryId: "spoof", progressText: "错误身份" },
			evidence(randomUUID()),
		),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(
		api.recordCurrentTaskProgress(
			scope,
			{
				progressEntryId: "stale-overview",
				progressText: "不能覆盖后来的概况",
				previousProgressEntryId: first.progressEntryId,
				previousProgressEntryOutcome: "completed",
				taskDescription: "过期方案",
				expectedTaskCardUpdatedAt: 1,
			},
			evidence(),
		),
	).rejects.toMatchObject({ code: "CONFLICT" });
	await api.recordCurrentTaskProgress(
		scope,
		{
			progressEntryId: "verification",
			progressText: "实现完成，正在验证",
			previousProgressEntryId: first.progressEntryId,
			previousProgressEntryOutcome: "completed",
			taskDescription: "方案修正后按字节预算分批核验原文。",
			expectedTaskCardUpdatedAt: card()?.updatedAt,
		},
		evidence(),
	);
	persisted = await loadPersistedWorkspaceStateById(scope.workspaceId);
	await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: {
			...persisted.board,
			columns: persisted.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((task) => ({ ...task, taskDescription: undefined })),
			})),
		},
		sessions: { abc12: initialSummary },
	});
	persisted = await loadPersistedWorkspaceStateById(scope.workspaceId);
	const rebuilt = new TerminalSessionManager();
	rebuilt.hydrateFromRecord(persisted.sessions);
	expect(rebuilt.getSummary("abc12")?.agentWorkProgressEntries?.map((entry) => entry.outcome)).toEqual([
		"completed",
		"in_progress",
	]);
	expect(card()?.taskDescription).toBe("方案修正后按字节预算分批核验原文。");
	const boardBeforeDescriptionWasCleared = persisted.board;
	await api.recordCurrentTaskProgress(
		scope,
		{
			progressEntryId: "finished",
			progressText: "验证完成",
			progressEntryOutcome: "completed",
			previousProgressEntryId: "verification",
			previousProgressEntryOutcome: "completed",
			taskDescription: "",
			expectedTaskCardUpdatedAt: card()?.updatedAt,
		},
		evidence(),
	);
	await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
		board: boardBeforeDescriptionWasCleared,
		sessions: { abc12: initialSummary },
	});
	persisted = await loadPersistedWorkspaceStateById(scope.workspaceId);
	expect(card()?.taskDescription).toBeUndefined();
	expect(persisted.sessions.abc12.agentWorkProgressEntries).toHaveLength(3);
});
