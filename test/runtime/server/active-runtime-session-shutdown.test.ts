import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";
import { stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace } from "../../../src/server/active-runtime-session-shutdown";
import { persistSafelyStoppedRuntimeSessionsByWorkspaceId } from "../../../src/server/safely-stopped-runtime-session-persistence";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

function createSummary(
	taskId: string,
	state: "running" | "awaiting_review" | "idle",
	agentId: "codex" | "cline" | "omp",
): RuntimeTaskSessionSummary {
	return applySessionFacets({
		taskId,
		state,
		agentId,
		workspacePath: `/tmp/${taskId}`,
		pid: agentId === "cline" || state === "idle" ? null : 1234,
		startedAt: state === "idle" ? null : 1,
		updatedAt: 10,
		lastOutputAt: state === "idle" ? null : 1,
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	});
}

describe("active runtime session shutdown", () => {
	it("collects a hydrated active-null user turn even though no PTY is stopped", async () => {
		const terminalExitedAwaitingUser = {
			...createSummary("terminal-exited", "awaiting_review", "codex"),
			pid: null,
			liveness: "exited" as const,
		};
		const terminalManager = new TerminalSessionManager();
		terminalManager.hydrateFromRecord({ "terminal-exited": terminalExitedAwaitingUser });

		const result = await stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace({
			terminalManager,
			clineTaskSessionService: null,
			acpTaskSessionService: null,
		});

		expect(result.stoppedRuntimeSessionSummaries).toEqual([]);
		expect(result.runtimeSessionSummariesForSafePersistence).toEqual([
			expect.objectContaining({
				taskId: "terminal-exited",
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: terminalExitedAwaitingUser.userTurnKind,
				updatedAt: terminalExitedAwaitingUser.updatedAt,
			}),
		]);
	});

	it("separates sessions actually stopped from every loaded summary that must be safely persisted", async () => {
		const terminalRunning = createSummary("terminal-running", "running", "codex");
		const clineRunning = createSummary("cline-running", "running", "cline");
		const clineIdle = createSummary("cline-idle", "idle", "cline");
		const safelyStoppedClineRunning = {
			...clineRunning,
			state: "interrupted" as const,
			turnOwner: "user" as const,
			liveness: "interrupted" as const,
			userTurnKind: "interrupted" as const,
		};
		const stopTaskSessionForSafeShutdown = vi.fn(async () => safelyStoppedClineRunning);

		const result = await stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace({
			terminalManager: {
				listSummaries: () => [terminalRunning],
				markInterruptedAndStopAll: () => [terminalRunning],
			},
			clineTaskSessionService: {
				listSummaries: () => [clineRunning, clineIdle],
				stopTaskSessionForSafeShutdown,
			},
			acpTaskSessionService: null,
		});

		expect(stopTaskSessionForSafeShutdown).toHaveBeenCalledWith("cline-running");
		expect(result.stoppedRuntimeSessionSummaries.map((summary) => summary.taskId).sort()).toEqual([
			"cline-running",
			"terminal-running",
		]);
		expect(result.runtimeSessionSummariesForSafePersistence.map((summary) => summary.taskId).sort()).toEqual([
			"cline-idle",
			"cline-running",
			"terminal-running",
		]);
	});

	it("stops live ACP agent subprocesses alongside terminal and Cline sessions", async () => {
		const acpRunning = createSummary("acp-running", "running", "omp");
		const acpIdle = createSummary("acp-idle", "idle", "omp");
		const safelyStoppedAcpRunning = {
			...acpRunning,
			state: "interrupted" as const,
			pid: null,
			turnOwner: "user" as const,
			liveness: "interrupted" as const,
			userTurnKind: "interrupted" as const,
		};
		const stopTaskSession = vi.fn(async () => safelyStoppedAcpRunning);

		const result = await stopActiveTerminalClineAndAcpRuntimeSessionsForWorkspace({
			terminalManager: null,
			clineTaskSessionService: null,
			acpTaskSessionService: {
				listSummaries: () => [acpRunning, acpIdle],
				stopTaskSession,
			},
		});

		expect(stopTaskSession).toHaveBeenCalledTimes(1);
		expect(stopTaskSession).toHaveBeenCalledWith("acp-running");
		expect(result.stoppedRuntimeSessionSummaries.map((summary) => summary.taskId)).toEqual(["acp-running"]);
		expect(result.runtimeSessionSummariesForSafePersistence.map((summary) => summary.taskId).sort()).toEqual([
			"acp-idle",
			"acp-running",
		]);
	});

	it("persists the latest inactive user-owned summary without changing its timestamps or facets", async () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const temporaryHomePath = gitFixture.isolatedHomeDirectoryPath;
		const projectPath = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "safe-runtime-persistence-project",
		}).repositoryPath;
		const previousHome = process.env.HOME;
		process.env.HOME = temporaryHomePath;
		try {
			const initial = await loadWorkspaceState(projectPath);
			const workspaceContext = await loadWorkspaceContext(projectPath);
			const persistedBeforeShutdown = createSummary("waiting-user", "idle", "codex");
			await saveWorkspaceState(projectPath, {
				board: initial.board,
				sessions: { "waiting-user": persistedBeforeShutdown },
				expectedRevision: initial.revision,
			});
			const latestExitedSummary = {
				...createSummary("waiting-user", "awaiting_review", "codex"),
				pid: null,
				liveness: "exited" as const,
				updatedAt: 42,
			};

			const persistence = await persistSafelyStoppedRuntimeSessionsByWorkspaceId(workspaceContext.workspaceId, [
				latestExitedSummary,
			]);
			const after = await loadWorkspaceState(projectPath);

			expect(persistence.persistedSessionCount).toBe(1);
			expect(after.sessions["waiting-user"]).toEqual(latestExitedSummary);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});
});
