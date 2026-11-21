import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AcpTaskSessionService } from "../../../src/acp-client-session/acp-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { applySessionFacets } from "../../../src/core/session-activity";
import {
	countAcpTaskSessionsInterruptedByRuntimeExit,
	listConversationSessionsInterruptedByRuntimeExit,
	stopActiveTerminalAndAcpRuntimeSessionsForWorkspace,
} from "../../../src/server/active-runtime-session-shutdown";
import { plannedHandoverInterruptionDecision } from "../../../src/server/authorized-unretainable-session-handover";
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
	it.each(["new", "resume", "replace", "failure", "ready"] as const)("ACP 握手交接 %s", async (scenario) => {
		const taskId = "acp-initialize-handover";
		const workspaceId = "acp-only-workspace";
		const resume = scenario === "resume" || scenario === "replace";
		const directory = await mkdtemp(join(tmpdir(), "kanban-acp-initialize-handover-"));
		const initializeReceivedPath = join(directory, "initialize-received-by-acp-child");
		const allowInitializeResponsePath = join(directory, "allow-acp-initialize-response");
		const service = new AcpTaskSessionService();
		let releaseReplacementSpawn: () => void = () => {};
		const waitForReplacementSpawnPermission = new Promise<void>((resolve) => {
			releaseReplacementSpawn = resolve;
		});
		const spawnedProcessIds: number[] = [];
		const startups: ReturnType<typeof service.startTaskSession>[] = [];
		const waitForInitializeFromNewChild = async () =>
			await vi.waitFor(
				async () => {
					const pid = Number(await readFile(initializeReceivedPath, "utf8"));
					expect(pid).toBeGreaterThan(0);
					expect(spawnedProcessIds).not.toContain(pid);
					expect(process.kill(pid, 0)).toBe(true);
					return pid;
				},
				{ timeout: 5_000 },
			);
		try {
			await writeFile(
				join(directory, "omp"),
				String.raw`#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
const sendResponse = (id, response) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...response }) + "\n");
setTimeout(() => process.exit(1), 8000).unref();
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    writeFileSync(${JSON.stringify(initializeReceivedPath)}, String(process.pid));
    const waitForResponsePermission = setInterval(() => {
      if (!existsSync(${JSON.stringify(allowInitializeResponsePath)})) return;
      clearInterval(waitForResponsePermission);
      sendResponse(request.id, ${JSON.stringify(scenario === "failure")}
        ? { error: { code: -32603, message: "fixture initialize failed" } }
        : { result: { protocolVersion: 1 } });
    }, 10);
  } else if (request.method === "session/new") {
    sendResponse(request.id, { result: { sessionId: "ready-acp-session" } });
  }
});
`,
				{ mode: 0o700 },
			);
			vi.stubEnv("PATH", [directory, process.env.PATH].join(delimiter));
			const startRequest = {
				taskId,
				agentId: "omp",
				cwd: directory,
				permissionMode: "ask_for_every_tool_use" as const,
				prompt: "",
				resumePriorAgentConversationWithoutResendingPrompt: resume,
				observedAgentNativeConversationSessionIdentity: resume
					? {
							sourceAgentId: "omp" as const,
							nativeSessionId: "prior-acp-session",
							transcriptPath: null,
							observedAt: 1,
						}
					: undefined,
			} satisfies Parameters<typeof service.startTaskSession>[0];
			const initialStartup = service.startTaskSession(startRequest);
			startups.push(initialStartup);
			const childProcessId = await waitForInitializeFromNewChild();
			spawnedProcessIds.push(childProcessId);
			const summary = service.getSummary(taskId);
			expect(summary).toMatchObject({ turnOwner: "user", pid: null });
			expect(summary?.runtimeSessionIncarnationId).toBeTruthy();
			expect(service.hasLiveTaskSession(taskId)).toBe(false);
			const countedSessionsThatWouldEnd = countAcpTaskSessionsInterruptedByRuntimeExit([service]);
			expect(countedSessionsThatWouldEnd).toBe(1);
			const currentSessions = listConversationSessionsInterruptedByRuntimeExit(workspaceId, service);
			expect(currentSessions).toEqual([
				{
					workspaceId,
					conversationSessionId: taskId,
					processId: childProcessId,
					nativeConversationSessionId: resume ? "prior-acp-session" : null,
					runtimeSessionIncarnationId: summary?.runtimeSessionIncarnationId,
					sessionKind: "acp_stdio_subprocess",
				},
			]);
			const runtimeProcessStartTimeText = "fixture-runtime-process-start";
			const decisionInput = {
				currentSessions,
				countedSessionsThatWouldEnd,
				currentProcessId: process.pid,
				currentProcessStartTimeText: runtimeProcessStartTimeText,
			};
			expect(
				plannedHandoverInterruptionDecision({ ...decisionInput, allowInterruption: false, binding: undefined }),
			).toEqual({ outcome: "refuse" });
			const binding = { runtimeProcessId: process.pid, runtimeProcessStartTimeText, interruptedSessions: [] };
			expect(plannedHandoverInterruptionDecision({ ...decisionInput, allowInterruption: true, binding })).toEqual({
				outcome: "refuse",
			});
			expect(
				plannedHandoverInterruptionDecision({
					...decisionInput,
					allowInterruption: true,
					binding: { ...binding, interruptedSessions: currentSessions },
				}),
			).toMatchObject({ outcome: "start_bound" });
			if (scenario === "replace") {
				const beforeAgentProcessLaunch = vi.fn(() => waitForReplacementSpawnPermission);
				const replacementNativeSessionId = "replacement-acp-session";
				startups.push(
					service.startTaskSession({
						...startRequest,
						beforeAgentProcessLaunch,
						observedAgentNativeConversationSessionIdentity: {
							sourceAgentId: "omp",
							nativeSessionId: replacementNativeSessionId,
							transcriptPath: null,
							observedAt: 2,
						},
					}),
				);
				await vi.waitFor(() => expect(beforeAgentProcessLaunch).toHaveBeenCalledOnce());
				const replacementIncarnationId = service.getSummary(taskId)?.runtimeSessionIncarnationId;
				expect(replacementIncarnationId).not.toBe(summary?.runtimeSessionIncarnationId);
				expect(listConversationSessionsInterruptedByRuntimeExit(workspaceId, service)).toEqual(currentSessions);
				releaseReplacementSpawn();
				const replacementProcessId = await waitForInitializeFromNewChild();
				spawnedProcessIds.push(replacementProcessId);
				await initialStartup;
				const replacementSessions = listConversationSessionsInterruptedByRuntimeExit(workspaceId, service);
				expect(replacementSessions).toEqual([
					{
						...currentSessions[0],
						processId: replacementProcessId,
						nativeConversationSessionId: replacementNativeSessionId,
						runtimeSessionIncarnationId: replacementIncarnationId,
					},
				]);
				expect(service.hasLiveTaskSession(taskId)).toBe(false);
				expect(
					plannedHandoverInterruptionDecision({
						...decisionInput,
						currentSessions: replacementSessions,
						allowInterruption: true,
						binding: { ...binding, interruptedSessions: currentSessions },
					}),
				).toEqual({ outcome: "refuse" });
			}
			if (scenario === "failure" || scenario === "ready") {
				await writeFile(allowInitializeResponsePath, "");
				const startupSummary = await initialStartup;
				expect(service.getStartingTaskSessionProcessOwnership(taskId)).toBeNull();
				if (scenario === "failure") {
					expect(startupSummary.warningMessage).toContain("fixture initialize failed");
					expect(service.hasLiveTaskSession(taskId)).toBe(false);
					expect(countAcpTaskSessionsInterruptedByRuntimeExit([service])).toBe(0);
					expect(listConversationSessionsInterruptedByRuntimeExit(workspaceId, service)).toEqual([]);
					return;
				}
				expect(service.hasLiveTaskSession(taskId)).toBe(true);
				expect(countAcpTaskSessionsInterruptedByRuntimeExit([service])).toBe(1);
				expect(listConversationSessionsInterruptedByRuntimeExit(workspaceId, service)).toEqual([
					{ ...currentSessions[0], nativeConversationSessionId: "ready-acp-session" },
				]);
			}
			const stopped = await stopActiveTerminalAndAcpRuntimeSessionsForWorkspace({
				terminalManager: null,
				acpTaskSessionService: service,
			});
			expect(stopped.stoppedRuntimeSessionSummaries).toMatchObject([{ taskId, liveness: "interrupted" }]);
			if (scenario !== "ready") {
				expect(await startups.at(-1)).toMatchObject({ taskId, liveness: "interrupted" });
			}
			expect(listConversationSessionsInterruptedByRuntimeExit(workspaceId, service)).toEqual([]);
		} finally {
			try {
				await service.stopTaskSession(taskId);
				service.disposeAllTaskSessions();
				releaseReplacementSpawn();
				await Promise.allSettled(startups);
				for (const ownedProcessId of spawnedProcessIds) {
					await vi.waitFor(() => expect(() => process.kill(ownedProcessId, 0)).toThrow(/ESRCH/));
				}
			} finally {
				vi.unstubAllEnvs();
				await rm(directory, { recursive: true, force: true });
			}
		}
	});

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

	it("已取消回合但进程号仍在的 ACP 会话计入关服中断", () => {
		const summary = {
			...createSummary("acp-aborted", "running", "omp"),
			state: "interrupted" as const,
			turnOwner: "user" as const,
			liveness: "interrupted" as const,
			userTurnKind: "interrupted" as const,
			pid: 40,
			sessionTransport: "acp_stdio_subprocess" as const,
		};
		expect(countAcpTaskSessionsInterruptedByRuntimeExit([{ listSummaries: () => [summary] }])).toBe(1);
		expect(countAcpTaskSessionsInterruptedByRuntimeExit([{ listSummaries: () => [{ ...summary, pid: null }] }])).toBe(
			0,
		);
	});

	it("有连接账本时，已取消但连接仍在计入，连接已释放则不计入", () => {
		const summary = {
			...createSummary("acp-aborted", "running", "omp"),
			state: "interrupted" as const,
			turnOwner: "user" as const,
			liveness: "interrupted" as const,
			userTurnKind: "interrupted" as const,
			pid: 40,
			sessionTransport: "acp_stdio_subprocess" as const,
		};
		expect(
			countAcpTaskSessionsInterruptedByRuntimeExit([
				{
					listSummaries: () => [{ ...summary, pid: null }],
					hasLiveTaskSession: () => true,
				},
			]),
		).toBe(1);
		expect(
			countAcpTaskSessionsInterruptedByRuntimeExit([
				{
					listSummaries: () => [summary],
					hasLiveTaskSession: () => false,
				},
			]),
		).toBe(0);
	});
});
