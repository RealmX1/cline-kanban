import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AcpClientConnectionRuntime,
	type AcpTaskConnection,
} from "../../../src/acp-client-session/acp-client-connection-runtime";
import { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import * as agentSessionResponseGenerationStopObserver from "../../../src/server/agent-session-response-generation-stop-observer";
import { createRuntimeStateHub, type RuntimeStateHub } from "../../../src/server/runtime-state-hub";
import { createWorkspaceRegistry } from "../../../src/server/workspace-registry";
import * as workspaceState from "../../../src/state/workspace-state";
import { loadWorkspaceContext, loadWorkspaceState } from "../../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("workspace registry runtime project availability cache", () => {
	it("冷恢复的 ACP 主会话与空侧会话在首帧覆盖已中断的终端水合快照", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const projectPath = fixture.createNonBareRepository({
			repositoryDirectoryName: "acp-resume-first-snapshot",
		}).repositoryPath;
		const previousHome = process.env.HOME;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		let disposeRegistry: (() => void) | undefined;
		try {
			const initial = await loadWorkspaceState(projectPath);
			const context = await loadWorkspaceContext(projectPath);
			const interrupted: RuntimeTaskSessionSummary = {
				taskId: "main-session",
				state: "interrupted",
				turnOwner: "user",
				liveness: "interrupted",
				userTurnKind: "interrupted",
				agentId: "omp",
				sessionTransport: "acp_stdio_subprocess",
				workspacePath: projectPath,
				pid: null,
				startedAt: 1,
				updatedAt: 2,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
			};
			const interruptedSideSession: RuntimeTaskSessionSummary = {
				...interrupted,
				taskId: "task-conversation-session-empty",
				taskConversationSessionMetadata: {
					workspaceTaskId: interrupted.taskId,
					taskConversationSessionRole: "task_collaborator",
					taskConversationSessionContextSource: "forked_from_main_current_turn",
					parentTaskConversationSessionId: interrupted.taskId,
					sideSessionCreatedAt: 1,
					mainSessionOriginTurnNumber: 1,
					mainSessionOriginUserMessagePreview: "原始任务",
					latestUserMessagePreview: null,
				},
			};
			await workspaceState.savePersistedWorkspaceSessionsById(
				context.workspaceId,
				{
					[interrupted.taskId]: interrupted,
					[interruptedSideSession.taskId]: interruptedSideSession,
				},
				initial.revision,
			);
			const resumedSessions = [interrupted, interruptedSideSession].map(
				(summary): RuntimeTaskSessionSummary => ({
					...summary,
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "live",
					userTurnKind: "review",
					pid: 12345,
					updatedAt: 3,
				}),
			);
			const registry = await createWorkspaceRegistry({
				cwd: fixture.isolatedHomeDirectoryPath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
				listConversationTaskSessionSummariesForWorkspace: (workspaceId) =>
					workspaceId === context.workspaceId ? resumedSessions : [],
			});
			disposeRegistry = () => {
				registry.disposeWorkspace(context.workspaceId);
			};
			const snapshot = await registry.buildWorkspaceStateSnapshot(context.workspaceId, projectPath);
			for (const summary of resumedSessions) expect(snapshot.sessions[summary.taskId]).toEqual(summary);
		} finally {
			disposeRegistry?.();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("ACP 停止并弃置后，真实 hub 不再把旧摘要叠加到当前 PTY 首帧", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const projectPath = fixture.createNonBareRepository({
			repositoryDirectoryName: "acp-discard-pty-current-owner-snapshot",
		}).repositoryPath;
		const previousHome = process.env.HOME;
		const previousCodexHome = process.env.CODEX_HOME;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		process.env.CODEX_HOME = join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration-home");
		vi.spyOn(
			agentSessionResponseGenerationStopObserver,
			"createAgentSessionResponseGenerationStopObserver",
		).mockReturnValue({
			observeTaskSessionSummary: () => {},
			forgetWorkspace: () => {},
			whenSettled: async () => {},
		});
		const activeAcpConnectionsByTaskId = new Map<string, AcpTaskConnection>();
		vi.spyOn(AcpClientConnectionRuntime.prototype, "getConnection").mockImplementation(
			(taskId) => activeAcpConnectionsByTaskId.get(taskId) ?? null,
		);
		vi.spyOn(AcpClientConnectionRuntime.prototype, "startTaskConnection").mockImplementation(async (request) => {
			const connection: AcpTaskConnection = {
				taskId: request.taskId,
				agentId: request.agentId,
				sessionId: `native-${request.taskId}`,
				pid: 12345,
				initializeResponse: { protocolVersion: 1, agentCapabilities: {} },
				prompt: vi.fn<AcpTaskConnection["prompt"]>(async () => ({ stopReason: "end_turn" })),
				cancel: vi.fn(async () => {}),
				setSessionMode: vi.fn(async () => {}),
				close: vi.fn(),
			};
			activeAcpConnectionsByTaskId.set(request.taskId, connection);
			return connection;
		});
		vi.spyOn(AcpClientConnectionRuntime.prototype, "disposeTaskConnection").mockImplementation((taskId) => {
			activeAcpConnectionsByTaskId.delete(taskId);
		});
		let runtimeStateHub: RuntimeStateHub | null = null;
		let disposeRegistry: (() => void) | undefined;
		const acpService = new AcpTaskSessionService();
		try {
			await loadWorkspaceState(projectPath);
			const context = await loadWorkspaceContext(projectPath);
			const registry = await createWorkspaceRegistry({
				cwd: fixture.isolatedHomeDirectoryPath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
				listConversationTaskSessionSummariesForWorkspace: (workspaceId) =>
					runtimeStateHub?.listTrackedConversationTaskSessionSummaries(workspaceId) ?? [],
			});
			disposeRegistry = () => registry.disposeWorkspace(context.workspaceId);
			runtimeStateHub = createRuntimeStateHub({
				workspaceRegistry: registry,
				runtimeStateBroadcastCostRecorder: null,
			});
			runtimeStateHub.trackAcpTaskSessionService(context.workspaceId, projectPath, acpService);
			const acpSummary = await acpService.startTaskSession({
				taskId: "switched-omp-session",
				agentId: "omp",
				cwd: projectPath,
				prompt: "",
				permissionMode: "ask_for_every_tool_use",
			});
			const terminalManager = await registry.ensureTerminalManagerForWorkspace(context.workspaceId, projectPath);
			terminalManager.hydrateFromRecord({
				[acpSummary.taskId]: {
					...acpSummary,
					state: "interrupted",
					turnOwner: "user",
					liveness: "interrupted",
					userTurnKind: "interrupted",
					pid: null,
					runtimeSessionIncarnationId: null,
					currentAgentProcessUserTurnIdleRetentionStarted: null,
				},
			});
			expect(terminalManager.getSummary(acpSummary.taskId)?.liveness).toBe("interrupted");
			const restoredAcpSnapshot = await registry.buildWorkspaceStateSnapshot(context.workspaceId, projectPath);
			expect(restoredAcpSnapshot.sessions[acpSummary.taskId]).toEqual(acpSummary);
			const stoppedAcpSummary = await acpService.stopTaskSession(acpSummary.taskId);
			expect(runtimeStateHub.listTrackedConversationTaskSessionSummaries(context.workspaceId)).toEqual([
				stoppedAcpSummary,
			]);
			acpService.discardTaskSessionLedgerEntry(acpSummary.taskId);
			expect(acpService.getSummary(acpSummary.taskId)).toBeNull();
			const activePtySummary: RuntimeTaskSessionSummary = {
				...acpSummary,
				sessionTransport: "pty_terminal",
				state: "running",
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				pid: 23456,
				runtimeSessionIncarnationId: "current-pty-process",
				// 故意比 ACP 历史时间早，验证持有者资格而非按时间戳选胜者。
				updatedAt: 1,
			};
			vi.spyOn(terminalManager, "listSummaries").mockReturnValue([activePtySummary]);
			const switchedSnapshot = await registry.buildWorkspaceStateSnapshot(context.workspaceId, projectPath);
			expect(switchedSnapshot.sessions[acpSummary.taskId]).toEqual(activePtySummary);
			expect(runtimeStateHub.listTrackedConversationTaskSessionSummaries(context.workspaceId)).toEqual([]);
			const remainingAcpSummary = await acpService.startTaskSession({
				taskId: "remaining-acp-session",
				agentId: "omp",
				cwd: projectPath,
				prompt: "",
				permissionMode: "ask_for_every_tool_use",
			});
			expect(runtimeStateHub.listTrackedConversationTaskSessionSummaries(context.workspaceId)).toEqual([
				remainingAcpSummary,
			]);
			runtimeStateHub.disposeWorkspace(context.workspaceId);
			expect(acpService.getSummary(remainingAcpSummary.taskId)).toEqual(remainingAcpSummary);
			expect(runtimeStateHub.listTrackedConversationTaskSessionSummaries(context.workspaceId)).toEqual([]);
		} finally {
			await runtimeStateHub?.close();
			acpService.disposeAllTaskSessions();
			disposeRegistry?.();
			vi.restoreAllMocks();
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = previousCodexHome;
		}
	});

	it("项目摘要重复构建复用看板，文件变化后只重新加载对应看板", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const projectPath = fixture.createNonBareRepository({
			repositoryDirectoryName: "project-summary-board-cache",
		}).repositoryPath;
		const previousHome = process.env.HOME;
		process.env.HOME = fixture.isolatedHomeDirectoryPath;
		try {
			const initial = await loadWorkspaceState(projectPath);
			const workspaceContext = await loadWorkspaceContext(projectPath);
			await mkdir(workspaceState.getWorkspaceDirectoryPath(workspaceContext.workspaceId), { recursive: true });
			await writeFile(
				workspaceState.getPersistedWorkspaceBoardFilePathById(workspaceContext.workspaceId),
				JSON.stringify(initial.board),
			);
			const registry = await createWorkspaceRegistry({
				cwd: fixture.isolatedHomeDirectoryPath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
				inspectRuntimeProjectAvailability: async () => ({ status: "available" }),
			});
			const readBoard = vi.spyOn(workspaceState, "loadWorkspaceBoardById");
			try {
				await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
				await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
				expect(readBoard).toHaveBeenCalledTimes(1);
				const backlog = initial.board.columns.find((column) => column.id === "backlog");
				if (!backlog) throw new Error("隔离看板缺少 Backlog");
				backlog.cards.push({
					id: "new-task",
					title: "新任务",
					prompt: "新任务",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 1,
					updatedAt: 1,
				});
				await writeFile(
					workspaceState.getPersistedWorkspaceBoardFilePathById(workspaceContext.workspaceId),
					JSON.stringify(initial.board),
				);
				const updated = await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
				expect(updated.projects[0]?.taskCounts.backlog).toBe(1);
				expect(readBoard).toHaveBeenCalledTimes(2);
			} finally {
				readBoard.mockRestore();
			}
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	it("reuses availability for summary broadcasts and refreshes it only when explicitly requested", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const temporaryHomePath = gitFixture.isolatedHomeDirectoryPath;
		const projectPath = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "workspace-registry-availability-project",
		}).repositoryPath;
		const previousHome = process.env.HOME;
		process.env.HOME = temporaryHomePath;
		try {
			await loadWorkspaceState(projectPath);
			const workspaceContext = await loadWorkspaceContext(projectPath);
			const inspectRuntimeProjectAvailability = vi.fn(async () => ({ status: "available" as const }));
			const registry = await createWorkspaceRegistry({
				cwd: temporaryHomePath,
				loadGlobalRuntimeConfig: async () => ({}) as never,
				loadRuntimeConfig: async () => ({}) as never,
				hasGitRepository: () => false,
				inspectRuntimeProjectAvailability,
			});

			await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
			await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(null);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(1);

			await registry.buildProjectsPayload(null);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(2);

			await registry.resolveWorkspaceForStream(workspaceContext.workspaceId);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(3);
			await registry.buildProjectsPayloadUsingCachedRuntimeProjectAvailability(workspaceContext.workspaceId);
			expect(inspectRuntimeProjectAvailability).toHaveBeenCalledTimes(3);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});
});
