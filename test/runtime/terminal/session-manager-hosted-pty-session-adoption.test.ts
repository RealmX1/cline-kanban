import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/terminal/agent-session-adapters.js")>()),
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { resolveAgentOutputTransitionDetectionForAgentId } from "../../../src/terminal/agent-session-adapters";
import {
	chooseTaskSessionSummaryForHostedSessionAdoption,
	TerminalSessionManager,
} from "../../../src/terminal/session-manager";
import type {
	HostedTerminalPtyProcessSpawner,
	HostedTerminalPtyProcessSpawnRequest,
	HostedTerminalPtySessionAdoptionCandidate,
	TerminalPtyProcessExitEvent,
	TerminalPtyProcessHandle,
} from "../../../src/terminal/terminal-pty-process-handle";
import { parseTerminalSessionAdoptionRecord } from "../../../src/terminal/terminal-session-adoption-record-for-runtime-restart";

interface FakeHostedTerminalPtyProcessHandle extends TerminalPtyProcessHandle {
	write: ReturnType<typeof vi.fn<(data: string | Buffer) => void>>;
	resize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>;
	stop: ReturnType<typeof vi.fn<(options?: { interrupted?: boolean; force?: boolean }) => void>>;
	publishedAdoptionRecords: unknown[];
}

function createFakeHostedTerminalPtyProcessHandle(pid: number): FakeHostedTerminalPtyProcessHandle {
	const publishedAdoptionRecords: unknown[] = [];
	return {
		pid,
		write: vi.fn<(data: string | Buffer) => void>(),
		resize: vi.fn<(cols: number, rows: number) => void>(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn<(options?: { interrupted?: boolean; force?: boolean }) => void>(),
		hasExited: () => false,
		wasInterrupted: () => false,
		publishTerminalSessionAdoptionRecordForRuntimeRestart: (adoptionRecord) => {
			publishedAdoptionRecords.push(adoptionRecord);
		},
		publishedAdoptionRecords,
	};
}

// 上一个 runtime：经 hosted spawner 起一个 Claude 任务会话，拿到它推给 host 的接管记录。
async function startHostedClaudeTaskSessionInPreviousRuntime(input: { taskId: string; pid: number; prompt: string }) {
	const handle = createFakeHostedTerminalPtyProcessHandle(input.pid);
	let spawnRequest: HostedTerminalPtyProcessSpawnRequest | null = null;
	const hostedTerminalPtyProcessSpawner: HostedTerminalPtyProcessSpawner = {
		spawnHostedTerminalPtyProcess: async (request) => {
			spawnRequest = request;
			return handle;
		},
	};
	const previousRuntimeManager = new TerminalSessionManager({ hostedTerminalPtyProcessSpawner });
	await previousRuntimeManager.startTaskSession({
		taskId: input.taskId,
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: `/tmp/${input.taskId}`,
		prompt: input.prompt,
	});
	if (spawnRequest === null) {
		throw new Error("hosted spawner was not used");
	}
	return {
		previousRuntimeManager,
		handle,
		emitOutput: (text: string) =>
			(spawnRequest as HostedTerminalPtyProcessSpawnRequest | null)?.onData(Buffer.from(text, "utf8")),
		readLatestPublishedAdoptionRecord: () => handle.publishedAdoptionRecords.at(-1),
	};
}

interface FakeAdoptionCandidateControls {
	candidate: HostedTerminalPtySessionAdoptionCandidate;
	handle: FakeHostedTerminalPtyProcessHandle;
	terminateAfterRefusedAdoption: ReturnType<typeof vi.fn>;
	emitLiveOutput: (text: string) => void;
}

function createFakeAdoptionCandidate(input: {
	taskId: string;
	pid: number;
	terminalSessionAdoptionRecord: unknown;
	catchUpOutputTexts?: string[];
	exitDuringAttachment?: TerminalPtyProcessExitEvent;
}): FakeAdoptionCandidateControls {
	const handle = createFakeHostedTerminalPtyProcessHandle(input.pid);
	const terminateAfterRefusedAdoption = vi.fn();
	let onDataCallback: ((chunk: Buffer) => void) | null = null;
	const candidate: HostedTerminalPtySessionAdoptionCandidate = {
		taskId: input.taskId,
		hostedSessionKind: "task_agent_session",
		pid: input.pid,
		spawnedAtEpochMs: 1_700_000_000_000,
		cols: 100,
		rows: 30,
		exitedWhileRuntimeWasAbsent: input.exitDuringAttachment !== undefined,
		terminalSessionAdoptionRecord: input.terminalSessionAdoptionRecord,
		adoptHostedTerminalPtyProcess: async (callbacks) => {
			onDataCallback = callbacks.onData;
			for (const catchUpOutputText of input.catchUpOutputTexts ?? []) {
				callbacks.onCatchUpOutput(Buffer.from(catchUpOutputText, "utf8"));
			}
			if (input.exitDuringAttachment) {
				callbacks.onExit(input.exitDuringAttachment);
			}
			return handle;
		},
		terminateHostedTerminalPtyProcessAfterRefusedAdoption: terminateAfterRefusedAdoption,
	};
	return {
		candidate,
		handle,
		terminateAfterRefusedAdoption,
		emitLiveOutput: (text) => onDataCallback?.(Buffer.from(text, "utf8")),
	};
}

const TERMINAL_QUERIES_THAT_MUST_NOT_BE_ANSWERED_DURING_CATCH_UP =
	"\u001b]11;?\u0007\u001b]10;?\u0007\u001b[c\u001b[6n";

function writtenTextOf(handle: FakeHostedTerminalPtyProcessHandle): string {
	return handle.write.mock.calls.map(([data]) => (typeof data === "string" ? data : data.toString("utf8"))).join("");
}

describe("TerminalSessionManager hosted PTY session adoption after runtime restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (launchInput: { prompt: string }) => ({
			args: [],
			env: {},
			deferredStartupPromptText: launchInput.prompt.trim() || undefined,
			...resolveAgentOutputTransitionDetectionForAgentId("claude"),
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("adopts from the adoption record without answering stale terminal queries or advancing lastSubstantiveOutputAt", async () => {
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
			taskId: "task-adopt",
			pid: 4242,
			prompt: "",
		});
		previousRuntime.emitOutput("Claude Code\n⏺ Real response before restart.\n");
		await vi.waitFor(() => {
			expect(
				previousRuntime.previousRuntimeManager.getSummary("task-adopt")?.lastSubstantiveOutputAt,
			).not.toBeNull();
		});
		previousRuntime.previousRuntimeManager.transitionToReview("task-adopt", "hook");
		const lastSubstantiveOutputAtBeforeRestart =
			previousRuntime.previousRuntimeManager.getSummary("task-adopt")?.lastSubstantiveOutputAt;
		await vi.waitFor(() => {
			const latestRecord = parseTerminalSessionAdoptionRecord(previousRuntime.readLatestPublishedAdoptionRecord());
			expect(latestRecord.kind === "usable_adoption_record" && latestRecord.adoptionRecord.summary.turnOwner).toBe(
				"user",
			);
		});

		const restartedRuntimeManager = new TerminalSessionManager();
		restartedRuntimeManager.hydrateFromRecord({}, new Set(["task-adopt"]));
		const { candidate, handle, emitLiveOutput } = createFakeAdoptionCandidate({
			taskId: "task-adopt",
			pid: 4242,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
			catchUpOutputTexts: [
				"Claude Code\r\n⏺ Real response before restart.\r\n",
				TERMINAL_QUERIES_THAT_MUST_NOT_BE_ANSWERED_DURING_CATCH_UP,
			],
		});

		const [adoptionOutcome] = await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			candidate,
		]);

		expect(adoptionOutcome).toEqual({
			taskId: "task-adopt",
			adoptionOutcome: "adopted_running_session",
			summarySource: "adoption_record",
		});
		const adoptedSummary = restartedRuntimeManager.getSummary("task-adopt");
		expect(adoptedSummary).toMatchObject({ pid: 4242, agentId: "claude", turnOwner: "user", liveness: "live" });
		expect(adoptedSummary?.lastSubstantiveOutputAt).toBe(lastSubstantiveOutputAtBeforeRestart);
		// 确定性断言：追赶字节里的查询没有任何应答写回 agent。
		expect(writtenTextOf(handle)).toBe("");
		// resize nudge 的第一步（缩一行）已发出，让 TUI 整屏重绘。
		expect(handle.resize).toHaveBeenCalledWith(100, 29);

		// 接管后的整屏重绘只是旧内容：不推进 lastSubstantiveOutputAt。
		emitLiveOutput("Claude Code\r\n⏺ Real response before restart.\r\n");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(restartedRuntimeManager.getSummary("task-adopt")?.lastSubstantiveOutputAt).toBe(
			lastSubstantiveOutputAtBeforeRestart,
		);
		await vi.waitFor(() => {
			expect(handle.resize).toHaveBeenLastCalledWith(100, 30);
		});
	});

	it("submits a deferred startup prompt once the caught-up screen shows the Claude prompt is ready", async () => {
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
			taskId: "task-deferred",
			pid: 5151,
			prompt: "Implement the adoption feature",
		});
		const adoptionRecordWithPendingPrompt = previousRuntime.readLatestPublishedAdoptionRecord();
		const parsedRecord = parseTerminalSessionAdoptionRecord(adoptionRecordWithPendingPrompt);
		expect(
			parsedRecord.kind === "usable_adoption_record" &&
				parsedRecord.adoptionRecord.carriedActiveProcessStateFields.deferredStartupPromptText,
		).toBe("Implement the adoption feature");

		const restartedRuntimeManager = new TerminalSessionManager();
		const { candidate, handle } = createFakeAdoptionCandidate({
			taskId: "task-deferred",
			pid: 5151,
			terminalSessionAdoptionRecord: adoptionRecordWithPendingPrompt,
			catchUpOutputTexts: ["Claude Code\r\nHow can I help you today?\r\n"],
		});

		await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);

		await vi.waitFor(() => {
			expect(writtenTextOf(handle)).toContain("Implement the adoption feature");
		});
	});

	it("refuses adoption and terminates the hosted process when the record pid differs from the host reported pid", async () => {
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
			taskId: "task-mismatch",
			pid: 6161,
			prompt: "",
		});
		const restartedRuntimeManager = new TerminalSessionManager();
		const { candidate, terminateAfterRefusedAdoption } = createFakeAdoptionCandidate({
			taskId: "task-mismatch",
			pid: 7171,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
		});

		const [adoptionOutcome] = await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			candidate,
		]);

		expect(adoptionOutcome?.adoptionOutcome).toBe("refused_and_terminated");
		expect(terminateAfterRefusedAdoption).toHaveBeenCalledTimes(1);
		expect(restartedRuntimeManager.getSummary("task-mismatch")?.pid ?? null).toBeNull();
	});

	it("installs the adopted session before delivering an exit that happened while the runtime was absent", async () => {
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
			taskId: "task-exited",
			pid: 8181,
			prompt: "",
		});
		const restartedRuntimeManager = new TerminalSessionManager();
		const { candidate } = createFakeAdoptionCandidate({
			taskId: "task-exited",
			pid: 8181,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
			exitDuringAttachment: { exitCode: 0 },
		});

		const [adoptionOutcome] = await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			candidate,
		]);

		expect(adoptionOutcome?.adoptionOutcome).toBe("adopted_session_that_exited_while_runtime_was_absent");
		const summaryAfterExit = restartedRuntimeManager.getSummary("task-exited");
		expect(summaryAfterExit?.pid ?? null).toBeNull();
		expect(summaryAfterExit?.exitCode).toBe(0);
	});
});

describe("chooseTaskSessionSummaryForHostedSessionAdoption", () => {
	async function captureRunningClaudeSummary(pid: number): Promise<RuntimeTaskSessionSummary> {
		prepareAgentLaunchMock.mockImplementation(async () => ({ args: [], env: {} }));
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
			taskId: "task-choose",
			pid,
			prompt: "",
		});
		const summary = previousRuntime.previousRuntimeManager.getSummary("task-choose");
		if (!summary) {
			throw new Error("no summary");
		}
		return summary;
	}

	it("prefers a newer sessions.json summary of the same incarnation over the adoption record", async () => {
		const runningSummary = await captureRunningClaudeSummary(9191);
		const newerPersistedSummary = { ...runningSummary, updatedAt: runningSummary.updatedAt + 1_000 };

		const choice = chooseTaskSessionSummaryForHostedSessionAdoption({
			parsedAdoptionRecord: {
				kind: "usable_adoption_record",
				adoptionRecord: {
					terminalSessionAdoptionRecordSchemaVersion: 1,
					recordedAtEpochMs: runningSummary.updatedAt,
					summary: runningSummary,
					carriedActiveProcessStateFields: {} as never,
					rederivationInputs: {
						suppressScrollbackErasure: true,
						suppressDeviceAttributeQueries: false,
						outputReactionEngineWasActive: false,
					},
				},
			},
			persistedSummary: newerPersistedSummary,
			summaryOfHydratedEntry: runningSummary,
			hostReportedPid: 9191,
			hostReportedSpawnedAtEpochMs: 1,
		});

		expect(choice).toMatchObject({ kind: "chosen", summarySource: "persisted_sessions_json_of_same_incarnation" });
	});

	it("synthesizes a complete running facet triple from the host reported pid when no record can be read", async () => {
		const runningSummary = await captureRunningClaudeSummary(9292);
		const idleSummaryWithoutPid = { ...runningSummary, pid: null };

		const choice = chooseTaskSessionSummaryForHostedSessionAdoption({
			parsedAdoptionRecord: { kind: "unrecognized_adoption_record_schema_version", schemaVersion: 99 },
			persistedSummary: idleSummaryWithoutPid,
			summaryOfHydratedEntry: idleSummaryWithoutPid,
			hostReportedPid: 9292,
			hostReportedSpawnedAtEpochMs: 1_700_000_000_000,
		});

		expect(choice).toMatchObject({
			kind: "chosen",
			summarySource: "synthesized_from_host_reported_pid",
			summary: { pid: 9292, liveness: "live", turnOwner: "agent", startedAt: 1_700_000_000_000 },
		});
	});
});
