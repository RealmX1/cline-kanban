import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";
import {
	countAcpTaskSessionsInterruptedByRuntimeExit,
	stopActiveTerminalAndAcpRuntimeSessionsForWorkspace,
} from "../../../src/server/active-runtime-session-shutdown";
import { persistSafelyStoppedRuntimeSessionsByWorkspaceId } from "../../../src/server/safely-stopped-runtime-session-persistence";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../../utilities/task-mutation-intent-for-test-fixture";

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

		const result = await stopActiveTerminalAndAcpRuntimeSessionsForWorkspace({
			terminalManager,
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

	it("detaches hosted terminal sessions instead of stopping them when the runtime exits for a successor, while still stopping ACP sessions", async () => {
		const terminalHosted = createSummary("terminal-hosted", "running", "codex");
		const terminalInProcess = createSummary("terminal-in-process", "running", "codex");
		const acpRunning = createSummary("acp-running", "running", "omp");
		const markInterruptedAndStopAll = vi.fn(() => [terminalHosted, terminalInProcess]);
		const detachHostedPtySessionsForRuntimeHandover = vi.fn(
			async (input: {
				readHostedSessionOrphanReclamationEligibleAtEpochMs: (summary: typeof terminalHosted) => number | null;
			}) => {
				expect(input.readHostedSessionOrphanReclamationEligibleAtEpochMs(terminalHosted)).toBe(1_900_000_000_000);
				return {
					detachedHostedSessionSummaries: [terminalHosted],
					interruptedInProcessSessionSummaries: [terminalInProcess],
				};
			},
		);
		const stopTaskSession = vi.fn(async () => ({ ...acpRunning, state: "interrupted" as const }));

		const result = await stopActiveTerminalAndAcpRuntimeSessionsForWorkspace({
			terminalManager: {
				listSummaries: () => [terminalHosted, terminalInProcess],
				markInterruptedAndStopAll,
				detachHostedPtySessionsForRuntimeHandover,
			},
			acpTaskSessionService: { listSummaries: () => [acpRunning], stopTaskSession },
			hostedAgentSessionDisposition: "detach_hosted_agent_sessions_for_successor_runtime",
			readHostedSessionOrphanReclamationEligibleAtEpochMs: () => 1_900_000_000_000,
		});

		expect(markInterruptedAndStopAll).not.toHaveBeenCalled();
		expect(detachHostedPtySessionsForRuntimeHandover).toHaveBeenCalledTimes(1);
		expect(stopTaskSession).toHaveBeenCalledWith("acp-running");
		expect(result.detachedHostedAgentSessionSummaries?.map((summary) => summary.taskId)).toEqual(["terminal-hosted"]);
		expect(result.stoppedRuntimeSessionSummaries.map((summary) => summary.taskId).sort()).toEqual([
			"acp-running",
			"terminal-in-process",
		]);
		// 留给下一个 runtime 的会话照样按原样持久化（仍是活着的）。
		expect(result.runtimeSessionSummariesForSafePersistence.map((summary) => summary.taskId)).toContain(
			"terminal-hosted",
		);
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

		const result = await stopActiveTerminalAndAcpRuntimeSessionsForWorkspace({
			terminalManager: null,
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
			await saveWorkspaceState(projectPath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, {
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

it("separates sessions actually stopped from every loaded summary that must be safely persisted", async () => {
	const terminalRunning = createSummary("terminal-running", "running", "codex");
	const acpRunning = createSummary("acp-running", "running", "omp");
	const acpIdle = createSummary("acp-idle", "idle", "omp");
	const safelyStoppedAcpRunning = {
		...acpRunning,
		state: "interrupted" as const,
		turnOwner: "user" as const,
		liveness: "interrupted" as const,
		userTurnKind: "interrupted" as const,
	};
	const stopTaskSession = vi.fn(async () => safelyStoppedAcpRunning);

	const result = await stopActiveTerminalAndAcpRuntimeSessionsForWorkspace({
		terminalManager: {
			listSummaries: () => [terminalRunning],
			markInterruptedAndStopAll: () => [terminalRunning],
			detachHostedPtySessionsForRuntimeHandover: async () => {
				throw new Error("detach must not be used without the detach disposition");
			},
		},
		acpTaskSessionService: {
			listSummaries: () => [acpRunning, acpIdle],
			stopTaskSession,
		},
	});

	expect(stopTaskSession).toHaveBeenCalledWith("acp-running");
	expect(result.stoppedRuntimeSessionSummaries.map((summary) => summary.taskId).sort()).toEqual([
		"acp-running",
		"terminal-running",
	]);
	expect(result.runtimeSessionSummariesForSafePersistence.map((summary) => summary.taskId).sort()).toEqual([
		"acp-idle",
		"acp-running",
		"terminal-running",
	]);
});

describe("运行时退出将中断的 ACP 会话计数", () => {
	it.each(["starting", "live", "retrying", "exited", "interrupted"] as const)(
		"按实际 %s facet 判断，不使用 legacy state 或 PID",
		(liveness) => {
			const summary = {
				...createSummary("acp-session", "idle", "omp"),
				turnOwner: "agent" as const,
				liveness,
				userTurnKind: null,
			};
			expect(countAcpTaskSessionsInterruptedByRuntimeExit([{ listSummaries: () => [summary] }])).toBe(
				["starting", "live", "retrying"].includes(liveness) ? 1 : 0,
			);
		},
	);
	it("统计全部 ACP workspace，包含未登记 PTY workspace 的会话", () => {
		const services = new Map([
			["acp-only-workspace", { listSummaries: () => [createSummary("acp-only", "running", "omp")] }],
			[
				"other-workspace",
				{
					listSummaries: () => [
						createSummary("acp-review", "awaiting_review", "omp"),
						createSummary("acp-stopped", "idle", "omp"),
					],
				},
			],
		]);
		expect(countAcpTaskSessionsInterruptedByRuntimeExit(services.values())).toBe(2);
		expect(countAcpTaskSessionsInterruptedByRuntimeExit([])).toBe(0);
	});
});
