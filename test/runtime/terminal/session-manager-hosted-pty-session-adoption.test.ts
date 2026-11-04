import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HostedSessionTerminalModeReplayState,
	serializeHostedSessionTerminalModes,
} from "../../../src/agent-session-pty-host/wire-protocol/hosted-session-terminal-mode-checkpoint";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../src/terminal/agent-session-adapters.js")>()),
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { resolveAgentOutputTransitionDetectionForAgentId } from "../../../src/terminal/agent-session-adapters";
import type { ClaudeCodeBackgroundSessionDaemonClient } from "../../../src/terminal/claude-code-background-session-ownership-preflight-before-resume";
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
import {
	parseTerminalSessionAdoptionRecord,
	readRecentlyAppliedHookEventDeliveryIdempotencyKeysFromCarriedFields,
} from "../../../src/terminal/terminal-session-adoption-record-for-runtime-restart";
import { TerminalStateMirror } from "../../../src/terminal/terminal-state-mirror";

interface FakeHostedTerminalPtyProcessHandle extends TerminalPtyProcessHandle {
	write: ReturnType<typeof vi.fn<(data: string | Buffer) => void>>;
	resize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>;
	stop: ReturnType<typeof vi.fn<(options?: { interrupted?: boolean; force?: boolean }) => void>>;
	detachFromRuntimeForHandoverRestartWithoutSignallingProcess: ReturnType<typeof vi.fn<() => void>>;
	publishedAdoptionRecords: unknown[];
	publishedHostedSessionOrphanReclamationEligibleAtEpochMsList: Array<number | null | undefined>;
	outputByteOffsetAfterLastDeliveredChunk: number;
}

function createFakeHostedTerminalPtyProcessHandle(pid: number): FakeHostedTerminalPtyProcessHandle {
	const publishedAdoptionRecords: unknown[] = [];
	const publishedHostedSessionOrphanReclamationEligibleAtEpochMsList: Array<number | null | undefined> = [];
	return {
		pid,
		write: vi.fn<(data: string | Buffer) => void>(),
		resize: vi.fn<(cols: number, rows: number) => void>(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn<(options?: { interrupted?: boolean; force?: boolean }) => void>(),
		hasExited: () => false,
		wasInterrupted: () => false,
		publishTerminalSessionAdoptionRecordForRuntimeRestart: (
			adoptionRecord,
			hostedSessionOrphanReclamationEligibleAtEpochMs,
		) => {
			publishedAdoptionRecords.push(adoptionRecord);
			publishedHostedSessionOrphanReclamationEligibleAtEpochMsList.push(
				hostedSessionOrphanReclamationEligibleAtEpochMs,
			);
		},
		detachFromRuntimeForHandoverRestartWithoutSignallingProcess: vi.fn<() => void>(),
		publishedAdoptionRecords,
		publishedHostedSessionOrphanReclamationEligibleAtEpochMsList,
		outputByteOffsetAfterLastDeliveredChunk: 0,
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
		// 与 hosted 句柄同一口径：每交付一段输出，「已交付到哪里」随之前进。
		emitOutput: (text: string) => {
			const bytes = Buffer.from(text, "utf8");
			handle.outputByteOffsetAfterLastDeliveredChunk += bytes.byteLength;
			(spawnRequest as HostedTerminalPtyProcessSpawnRequest | null)?.onData(bytes);
		},
		readLatestPublishedAdoptionRecord: () => handle.publishedAdoptionRecords.at(-1),
	};
}

interface FakeAdoptionCandidateControls {
	candidate: HostedTerminalPtySessionAdoptionCandidate;
	handle: FakeHostedTerminalPtyProcessHandle;
	terminateAfterRefusedAdoption: ReturnType<typeof vi.fn>;
	emitLiveOutput: (text: string) => void;
	readRequestedFromOutputByteOffset: () => number | undefined;
}

function createFakeAdoptionCandidate(input: {
	taskId: string;
	pid: number;
	terminalSessionAdoptionRecord: unknown;
	catchUpOutputTexts?: string[];
	exitDuringAttachment?: TerminalPtyProcessExitEvent;
	retainedOutputStartByteOffset?: number;
	outputEndByteOffset?: number;
	catchUpOutputGap?: boolean;
	terminalModeReplayState?: HostedSessionTerminalModeReplayState;
	liveOutputTextDuringAttachment?: string;
}): FakeAdoptionCandidateControls {
	const handle = createFakeHostedTerminalPtyProcessHandle(input.pid);
	const terminateAfterRefusedAdoption = vi.fn();
	let onDataCallback: ((chunk: Buffer) => void) | null = null;
	let requestedFromOutputByteOffset: number | undefined;
	const candidate: HostedTerminalPtySessionAdoptionCandidate = {
		taskId: input.taskId,
		hostedSessionKind: "task_agent_session",
		pid: input.pid,
		spawnedAtEpochMs: 1_700_000_000_000,
		cols: 100,
		rows: 30,
		exitedWhileRuntimeWasAbsent: input.exitDuringAttachment !== undefined,
		reclaimedByHostWhileRuntimeWasAbsent: false,
		retainedOutputStartByteOffset: input.retainedOutputStartByteOffset ?? 0,
		outputEndByteOffset: input.outputEndByteOffset ?? 1_000_000,
		terminalSessionAdoptionRecord: input.terminalSessionAdoptionRecord,
		adoptHostedTerminalPtyProcess: async (callbacks) => {
			requestedFromOutputByteOffset = callbacks.fromOutputByteOffset;
			onDataCallback = callbacks.onData;
			if (input.catchUpOutputGap) await callbacks.onCatchUpOutputGap?.();
			await callbacks.onCatchUpOutputStart?.({
				startByteOffset: input.retainedOutputStartByteOffset ?? 0,
				terminalModeReplayState: input.terminalModeReplayState,
			});
			for (const catchUpOutputText of input.catchUpOutputTexts ?? []) {
				callbacks.onCatchUpOutput(Buffer.from(catchUpOutputText, "utf8"));
			}
			if (input.liveOutputTextDuringAttachment) {
				callbacks.onData(Buffer.from(input.liveOutputTextDuringAttachment, "utf8"));
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
		readRequestedFromOutputByteOffset: () => requestedFromOutputByteOffset,
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

	it("截断输出先恢复 host 模式再重放，不响应历史查询，也不把滚轮降成文本输入", async () => {
		const taskId = "mode-checkpoint-adoption";
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ taskId, pid: 4545, prompt: "" });
		const { candidate, handle } = createFakeAdoptionCandidate({
			taskId,
			pid: 4545,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
			retainedOutputStartByteOffset: 3 * 1024 * 1024,
			outputEndByteOffset: 4 * 1024 * 1024,
			terminalModeReplayState: {
				terminalModes: {
					alternateScreenActive: true,
					mouseTrackingMode: 1002,
					mouseCoordinateEncoding: 1006,
					bracketedPasteActive: true,
					focusReportingActive: true,
				},
				parserContinuationHex: Buffer.from("\u001b[?10").toString("hex"),
			},
			catchUpOutputTexts: ["03h\u001b[H会话显示", TERMINAL_QUERIES_THAT_MUST_NOT_BE_ANSWERED_DURING_CATCH_UP],
		});
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({}, new Set([taskId]));
		try {
			await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);
			const snapshot = await manager.getRestoreSnapshot(taskId);
			expect(snapshot?.snapshot).toContain("\u001b[?1049h");
			expect(snapshot?.snapshot).toContain("\u001b[?1003h");
			expect(snapshot?.snapshot).toContain("\u001b[?1006h");
			expect(snapshot?.snapshot).toContain("\u001b[?2004h");
			expect(snapshot?.snapshot).toContain("会话显示");
			expect(writtenTextOf(handle)).toBe("");
		} finally {
			manager.dispose();
			previousRuntime.previousRuntimeManager.dispose();
		}
	});

	it.each([
		["\u001b[?100", "6h", false],
		["\u001b[?1006", "h", true],
		["\u001b[?1006;2004;1004", "h", false],
		["\u001b[?1006;2004;1004", "l", true],
		["\u001b]0;追赶标题", "实时标题\u0007", false],
		["\u001b]0;追赶标题\u001b", "\\", true],
	] as const)(
		"追赶到实时输出续接同一个 CSI/OSC 解析状态：%j + %j，安装前到达=%j",
		async (catchUpPrefix, liveSuffix, arrivesBeforeInstallation) => {
			const taskId = "catch-up-live-protocol-continuation";
			const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ taskId, pid: 4546, prompt: "" });
			const terminalModeReplayState: HostedSessionTerminalModeReplayState = {
				terminalModes: {
					alternateScreenActive: true,
					mouseTrackingMode: 1002,
					mouseCoordinateEncoding: 0,
					bracketedPasteActive: true,
					focusReportingActive: true,
				},
				parserContinuationHex: "",
			};
			const liveOutput = `${liveSuffix}边界后的正文`;
			const { candidate, handle, emitLiveOutput } = createFakeAdoptionCandidate({
				taskId,
				pid: 4546,
				terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
				retainedOutputStartByteOffset: 3 * 1024 * 1024,
				outputEndByteOffset: 4 * 1024 * 1024,
				terminalModeReplayState,
				catchUpOutputTexts: [TERMINAL_QUERIES_THAT_MUST_NOT_BE_ANSWERED_DURING_CATCH_UP, catchUpPrefix],
				liveOutputTextDuringAttachment: arrivesBeforeInstallation ? liveOutput : undefined,
			});
			const manager = new TerminalSessionManager();
			const uninterruptedMirror = new TerminalStateMirror(100, 30);
			const observedOutput: Buffer[] = [];
			manager.hydrateFromRecord({}, new Set([taskId]));
			manager.attach(taskId, { onOutput: (chunk) => observedOutput.push(chunk) });
			try {
				await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);
				if (!arrivesBeforeInstallation) emitLiveOutput(liveOutput);
				uninterruptedMirror.applyOutput(serializeHostedSessionTerminalModes(terminalModeReplayState.terminalModes));
				uninterruptedMirror.applyOutput(Buffer.from(catchUpPrefix + liveOutput));
				expect((await manager.getRestoreSnapshot(taskId))?.snapshot).toBe(
					(await uninterruptedMirror.getSnapshot()).snapshot,
				);
				expect(Buffer.concat(observedOutput).toString("utf8")).toBe(catchUpPrefix + liveOutput);
				expect(writtenTextOf(handle)).toBe("");
			} finally {
				manager.dispose();
				uninterruptedMirror.dispose();
				previousRuntime.previousRuntimeManager.dispose();
			}
		},
	);

	it("旧 host 的截断输出保持模式未知，原生初始化后自动恢复并更新持久接管记录", async () => {
		const taskId = "legacy-host-unknown-modes";
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ taskId, pid: 4646, prompt: "" });
		const { candidate, handle, emitLiveOutput } = createFakeAdoptionCandidate({
			taskId,
			pid: 4646,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
			retainedOutputStartByteOffset: 2 * 1024 * 1024,
			outputEndByteOffset: 3 * 1024 * 1024,
			catchUpOutputTexts: ["\u001b[2J\u001b[H只有重绘"],
		});
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({}, new Set([taskId]));
		try {
			await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);
			expect(parseTerminalSessionAdoptionRecord(handle.publishedAdoptionRecords.at(-1))).toMatchObject({
				kind: "usable_adoption_record",
				adoptionRecord: { rederivationInputs: { terminalModesAreKnown: false } },
			});
			emitLiveOutput("\u001b[?1049;1002h");
			emitLiveOutput("\u001b[?1006;2004;1004h");
			await manager.getRestoreSnapshot(taskId);
			expect(parseTerminalSessionAdoptionRecord(handle.publishedAdoptionRecords.at(-1))).toMatchObject({
				kind: "usable_adoption_record",
				adoptionRecord: { rederivationInputs: { terminalModesAreKnown: true } },
			});
			expect(writtenTextOf(handle)).toBe("");
		} finally {
			manager.dispose();
			previousRuntime.previousRuntimeManager.dispose();
		}
	});

	it("模式未知标记跨连续接管保留，未知屏幕检查点不会被当成模式已恢复", async () => {
		const taskId = "unknown-mode-repeated-adoption";
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ taskId, pid: 4747, prompt: "" });
		let adoptionRecord = previousRuntime.readLatestPublishedAdoptionRecord();
		try {
			for (let generation = 0; generation < 2; generation++) {
				const { candidate, handle, readRequestedFromOutputByteOffset } = createFakeAdoptionCandidate({
					taskId,
					pid: 4747,
					terminalSessionAdoptionRecord: adoptionRecord,
					retainedOutputStartByteOffset: 100,
					outputEndByteOffset: 300,
					catchUpOutputTexts: [`\u001b[2J\u001b[H第 ${generation} 次重绘`],
				});
				const manager = new TerminalSessionManager();
				manager.hydrateFromRecord({}, new Set([taskId]));
				try {
					await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);
					expect(readRequestedFromOutputByteOffset()).toBeUndefined();
					handle.outputByteOffsetAfterLastDeliveredChunk = 200;
					await manager.detachHostedPtySessionsForRuntimeHandover({
						readHostedSessionOrphanReclamationEligibleAtEpochMs: () => null,
					});
					adoptionRecord = handle.publishedAdoptionRecords.at(-1);
					expect(parseTerminalSessionAdoptionRecord(adoptionRecord)).toMatchObject({
						kind: "usable_adoption_record",
						adoptionRecord: {
							rederivationInputs: { terminalModesAreKnown: false },
							plannedHandoverTerminalMirrorCheckpoint: {
								outputByteOffsetCoveredBySnapshot: 200,
								terminalModesAreKnown: false,
							},
						},
					});
					expect(handle.stop).not.toHaveBeenCalled();
				} finally {
					manager.dispose();
				}
			}
		} finally {
			previousRuntime.previousRuntimeManager.dispose();
		}
	});

	it("Kimi 接管覆盖旧 suppress=true，追赶与 live 重绘均不叠加历史", async () => {
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
			taskId: "kimi-adopt",
			pid: 4343,
			prompt: "",
		});
		const parsed = parseTerminalSessionAdoptionRecord(previousRuntime.readLatestPublishedAdoptionRecord());
		if (parsed.kind !== "usable_adoption_record") throw new Error("缺少接管记录");
		const oldRecord = {
			...parsed.adoptionRecord,
			summary: { ...parsed.adoptionRecord.summary, agentId: "kimi" },
			rederivationInputs: { ...parsed.adoptionRecord.rederivationInputs, suppressScrollbackErasure: true },
		};
		const history = Array.from({ length: 65 }, (_, index) => `kimi-adopt-history-${index}`).join("\r\n");
		const redraw = `\u001b[2J\u001b[H\u001b[3J${history}\r\ncomposer`;
		const { candidate, emitLiveOutput, handle } = createFakeAdoptionCandidate({
			taskId: "kimi-adopt",
			pid: 4343,
			terminalSessionAdoptionRecord: oldRecord,
			catchUpOutputTexts: [redraw, redraw],
		});
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({}, new Set(["kimi-adopt"]));
		try {
			await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);
			expect((await manager.getRestoreSnapshot("kimi-adopt"))?.snapshot.split("kimi-adopt-history-0")).toHaveLength(
				2,
			);
			emitLiveOutput(redraw);
			emitLiveOutput(redraw);
			expect((await manager.getRestoreSnapshot("kimi-adopt"))?.snapshot.split("kimi-adopt-history-0")).toHaveLength(
				2,
			);
			expect(parseTerminalSessionAdoptionRecord(handle.publishedAdoptionRecords.at(-1))).toMatchObject({
				kind: "usable_adoption_record",
				adoptionRecord: { rederivationInputs: { suppressScrollbackErasure: false } },
			});
		} finally {
			manager.dispose();
			previousRuntime.previousRuntimeManager.dispose();
		}
	});

	it("重启接管保留 Stop 误判证据，当前原生回合复核后恢复执行且不制造新回合", async () => {
		const taskId = "codex-stop-adopt";
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ taskId, pid: 4545, prompt: "" });
		const parsed = parseTerminalSessionAdoptionRecord(previousRuntime.readLatestPublishedAdoptionRecord());
		if (parsed.kind !== "usable_adoption_record") throw new Error("缺少原生接管记录");
		const stoppedAt = Date.now() + 10;
		vi.useFakeTimers();
		vi.setSystemTime(stoppedAt + 2);
		const incarnation = parsed.adoptionRecord.summary.runtimeSessionIncarnationId;
		if (!incarnation) throw new Error("接管记录缺少进程代际");
		const summary: RuntimeTaskSessionSummary = {
			...parsed.adoptionRecord.summary,
			agentId: "codex",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			reviewReason: "hook",
			updatedAt: stoppedAt + 1,
			agentResponseGenerationTurnSequence: 7,
			agentResponseGenerationTurnStarted: { startedAt: stoppedAt - 1, turnSequence: 7 },
			currentAgentProcessUserTurnIdleRetentionStarted: {
				stoppedAt,
				signalConfidence: "harness_turn_complete",
				turnSequence: 7,
			},
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: stoppedAt,
				signalConfidence: "harness_turn_complete",
				turnSequence: 7,
			},
			lastEffectiveAgentConversationActivityObservation: {
				observedAtMs: stoppedAt + 1,
				activityKind: "tool_activity",
				evidenceKind: "persisted_agent_transcript",
				nativeSessionId: "native",
				eventId: "codex:native:turn:tool",
			},
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				transcriptPath: "/isolated/adopt.jsonl",
				observedAt: stoppedAt,
			},
			codexNativeSessionControlEndpoint: {
				workspaceId: "isolated",
				conversationSessionId: taskId,
				runtimeSessionIncarnationId: incarnation,
				socketPath: "/isolated/adopt.sock",
			},
		};
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({}, new Set([taskId]));
		const { candidate } = createFakeAdoptionCandidate({
			taskId,
			pid: 4545,
			terminalSessionAdoptionRecord: { ...parsed.adoptionRecord, summary },
		});
		const persist = vi.fn(async (_before, _observation, applyCorrection) => applyCorrection());
		manager.setCodexReviewMisclassificationPersistenceHandler(persist);
		try {
			await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);
			const before = manager.getSummary(taskId);
			if (!before) throw new Error("未接管原会话");
			expect(before.turnOwner).toBe("user");
			await manager.reconcileCodexReviewMisclassificationWithNativeAgentTurnExecution(taskId, before, {
				workspaceId: "isolated",
				conversationSessionId: taskId,
				runtimeSessionIncarnationId: incarnation,
				nativeSessionId: "native",
				nativeTurnId: "turn",
				nativeTurnStartedAtMs: stoppedAt - 1,
				observedAtMs: stoppedAt + 2,
				threadStatus: "active",
				nativeTurnStatus: "inProgress",
				activeFlags: [],
				canAcceptDirectInput: true,
				executionStatus: "running",
			});
			expect(manager.getSummary(taskId)).toMatchObject({
				turnOwner: "agent",
				liveness: "live",
				userTurnKind: null,
				reviewReason: null,
				agentResponseGenerationTurnSequence: 7,
				agentResponseGenerationTurnStarted: summary.agentResponseGenerationTurnStarted,
				lastAgentConversationUserHandoffObservation: null,
				currentAgentProcessUserTurnIdleRetentionStarted: null,
			});
			expect(persist).toHaveBeenCalledOnce();
		} finally {
			manager.dispose();
			previousRuntime.previousRuntimeManager.dispose();
		}
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

	it("carries applied hook delivery keys across the restart so a spooled replay of an applied event is recognized", async () => {
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
			taskId: "task-hook-delivery-keys",
			pid: 5252,
			prompt: "",
		});
		// 生命周期事件立即推接管记录：旧 runtime 应用完就被 kill -9，host 里的记录也已带上这个 key。
		previousRuntime.previousRuntimeManager.rememberAppliedHookEventDeliveryIdempotencyKey(
			"task-hook-delivery-keys",
			"stop-applied-just-before-crash",
			{ publishAdoptionRecordImmediately: true },
		);

		const restartedRuntimeManager = new TerminalSessionManager();
		const { candidate } = createFakeAdoptionCandidate({
			taskId: "task-hook-delivery-keys",
			pid: 5252,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
		});
		await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);

		expect(
			restartedRuntimeManager.hasAppliedHookEventDeliveryIdempotencyKey(
				"task-hook-delivery-keys",
				"stop-applied-just-before-crash",
			),
		).toBe(true);
	});

	it("reads an adoption record written before delivery keys existed as having no applied keys", () => {
		expect(readRecentlyAppliedHookEventDeliveryIdempotencyKeysFromCarriedFields({} as never)).toEqual([]);
		expect(readRecentlyAppliedHookEventDeliveryIdempotencyKeysFromCarriedFields(null)).toEqual([]);
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

describe("TerminalSessionManager planned handover restart", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async () => ({
			args: [],
			env: {},
			...resolveAgentOutputTransitionDetectionForAgentId("claude"),
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each([
		["task_collaborator", "detach"],
		["by_the_way", "detach"],
		["task_collaborator", "interrupt"],
		["by_the_way", "interrupt"],
	] as const)("接管 %s 后保留真实身份与启动快照，%s 按会话去向处理 Codex cleanup", async (role, disposition) => {
		const taskId = `task-codex-${role}-${disposition}`;
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ taskId, pid: 9595, prompt: "" });
		const parsedRecord = parseTerminalSessionAdoptionRecord(previousRuntime.readLatestPublishedAdoptionRecord());
		if (parsedRecord.kind !== "usable_adoption_record") throw new Error("测试接管记录不可用");
		const runtimeSessionIncarnationId = parsedRecord.adoptionRecord.summary.runtimeSessionIncarnationId;
		if (!runtimeSessionIncarnationId) throw new Error("测试会话 incarnation 不存在");
		const adoptedCodexControlHostCleanup = vi.fn(async () => undefined);
		const restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart = vi.fn(
			async () => adoptedCodexControlHostCleanup,
		);
		const expectedSummary: RuntimeTaskSessionSummary = {
			...parsedRecord.adoptionRecord.summary,
			agentId: "codex",
			codexNativeSessionControlEndpoint: {
				socketPath: "/tmp/test-codex-control-host/socket",
				workspaceId: "test-hosted-session-adoption-workspace",
				conversationSessionId: taskId,
				runtimeSessionIncarnationId,
			},
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native-codex-conversation-before-runtime-restart",
				transcriptPath: null,
				observedAt: 1,
			},
			taskConversationSessionMetadata: {
				workspaceTaskId: "card-with-side-conversation-sessions",
				sideSessionCreatedAt: 1,
				sideSessionOriginMainSessionId: "source-main-conversation-session",
				sideSessionOriginMainNativeSessionId: "source-main-native-conversation-session",
				taskConversationSessionRole: role,
				taskConversationSessionRoleAtCreation: role,
				taskConversationSessionContextSource: "forked_from_main_current_turn",
				parentTaskConversationSessionId: "source-main-conversation-session",
				mainSessionOriginTurnNumber: 2,
				mainSessionOriginUserMessagePreview: "来源主会话请求",
				latestUserMessagePreview: "侧会话请求",
				taskAutomationSuspendedForMainSessionHandover: true,
				taskConversationSessionLaunchSettings: {
					taskAgentPermissionMode: "auto_approve_file_edits_only",
					startInPlanMode: true,
					sessionTransport: "pty_terminal",
				},
			},
		};
		const restartedRuntimeManager = new TerminalSessionManager({
			restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart,
		});
		const { candidate, handle } = createFakeAdoptionCandidate({
			taskId,
			pid: 9595,
			terminalSessionAdoptionRecord: { ...parsedRecord.adoptionRecord, summary: expectedSummary },
		});

		await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);

		expect(restoreCodexNativeSessionControlHostCleanupAfterRuntimeRestart).toHaveBeenCalledWith(
			expectedSummary.codexNativeSessionControlEndpoint,
		);
		expect(restartedRuntimeManager.getSummary(taskId)).toEqual(expectedSummary);
		if (disposition === "detach") {
			await restartedRuntimeManager.detachHostedPtySessionsForRuntimeHandover({
				readHostedSessionOrphanReclamationEligibleAtEpochMs: () => null,
			});
			expect(adoptedCodexControlHostCleanup).not.toHaveBeenCalled();
			expect(handle.stop).not.toHaveBeenCalled();
			expect(handle.detachFromRuntimeForHandoverRestartWithoutSignallingProcess).toHaveBeenCalledOnce();
			const finalRecord = parseTerminalSessionAdoptionRecord(handle.publishedAdoptionRecords.at(-1));
			expect(finalRecord.kind === "usable_adoption_record" && finalRecord.adoptionRecord.summary).toEqual(
				expectedSummary,
			);
		} else {
			restartedRuntimeManager.markInterruptedAndStopAll();
			expect(adoptedCodexControlHostCleanup).toHaveBeenCalledOnce();
			expect(handle.stop).toHaveBeenCalledWith({ interrupted: true });
		}
		previousRuntime.previousRuntimeManager.dispose();
		restartedRuntimeManager.dispose();
	});

	it("handover 取消没有活 PTY 的后台会话回收盯梢，阻止旧 runtime 再续跑", async () => {
		const taskId = "task-watching-background-conversation-during-handover";
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ taskId, pid: 9696, prompt: "" });
		const persistedSummary = previousRuntime.previousRuntimeManager.getSummary(taskId);
		if (!persistedSummary) throw new Error("测试会话 summary 不存在");
		previousRuntime.previousRuntimeManager.dispose();
		vi.useFakeTimers();
		const nativeSessionId = "native-claude-conversation-held-by-background-session";
		const listLiveSessionsStartedUnderWorkingDirectory = vi.fn<
			ClaudeCodeBackgroundSessionDaemonClient["listLiveSessionsStartedUnderWorkingDirectory"]
		>(async () => ({
			ok: true,
			liveSessions: [
				{
					claudeCodeSessionShortId: "held-session",
					nativeSessionId,
					startedInWorkingDirectoryPath: `/tmp/${taskId}`,
					sessionHostKind: "background",
					processId: 9797,
					turnActivityStatus: "busy",
				},
			],
		}));
		const manager = new TerminalSessionManager({
			claudeCodeBackgroundSessionDaemonClient: {
				listLiveSessionsStartedUnderWorkingDirectory,
				readBackgroundSessionRecentTerminalOutput: async () => ({
					ok: true,
					recentTerminalOutputBytes: Buffer.alloc(0),
				}),
				stopBackgroundSession: async () => ({ ok: true }),
			},
		});
		manager.hydrateFromRecord({ [taskId]: persistedSummary });
		manager.applyAgentNativeConversationSessionIdentity(taskId, {
			sourceAgentId: "claude",
			nativeSessionId,
			transcriptPath: null,
			observedAt: 1,
		});
		await expect(
			manager.startTaskSession({
				taskId,
				agentId: "claude",
				binary: "claude",
				args: [],
				cwd: `/tmp/${taskId}`,
				prompt: "",
				resumeFromTrash: true,
			}),
		).rejects.toThrow();
		expect(
			manager.getSummary(taskId)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation,
		).toMatchObject({ automaticReclaimWatchActive: true });

		const result = await manager.detachHostedPtySessionsForRuntimeHandover({
			readHostedSessionOrphanReclamationEligibleAtEpochMs: () => null,
		});

		expect(result).toEqual({ detachedHostedSessionSummaries: [], interruptedInProcessSessionSummaries: [] });
		expect(
			manager.getSummary(taskId)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation,
		).toMatchObject({ nativeSessionId, automaticReclaimWatchActive: false });
		await vi.advanceTimersByTimeAsync(5_001);
		expect(listLiveSessionsStartedUnderWorkingDirectory).toHaveBeenCalledOnce();
		manager.dispose();
	});

	// 协议过滤器还压着这段没结束的 OSC：它没进 mirror，checkpoint 的偏移必须把它让出来，交给下一个 runtime 重读。
	const UNTERMINATED_OSC_SEQUENCE_HELD_BACK_BY_PROTOCOL_FILTER = "\u001b]0;title-still-being-written";

	it.each(["defer_reclamation", "allow_reclamation", "failed"] as const)(
		"离线孤儿期限复用原生执行门禁：%s",
		async (eligibility) => {
			const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({
				taskId: "native-deadline",
				pid: 9595,
				prompt: "",
			});
			const inspect = vi.spyOn(
				previousRuntime.previousRuntimeManager,
				"inspectCodexNativeTurnBeforeReviewSessionReclamation",
			);
			if (eligibility === "failed") inspect.mockRejectedValue(new Error("原生状态暂时不可读"));
			else inspect.mockResolvedValue(eligibility);
			await previousRuntime.previousRuntimeManager.detachHostedPtySessionsForRuntimeHandover({
				readHostedSessionOrphanReclamationEligibleAtEpochMs: () => 1234,
			});
			expect(inspect).toHaveBeenCalledExactlyOnceWith("native-deadline");
			expect(previousRuntime.handle.publishedHostedSessionOrphanReclamationEligibleAtEpochMsList.at(-1)).toBe(
				eligibility === "allow_reclamation" ? 1234 : null,
			);
		},
	);

	async function detachAfterOutput(input: { taskId: string; pid: number }) {
		const previousRuntime = await startHostedClaudeTaskSessionInPreviousRuntime({ ...input, prompt: "" });
		previousRuntime.emitOutput("Claude Code\r\n⏺ Line before handover.\r\n");
		previousRuntime.emitOutput(UNTERMINATED_OSC_SEQUENCE_HELD_BACK_BY_PROTOCOL_FILTER);
		const outputByteOffsetDeliveredBeforeDetach = previousRuntime.handle.outputByteOffsetAfterLastDeliveredChunk;
		const detachResult = await previousRuntime.previousRuntimeManager.detachHostedPtySessionsForRuntimeHandover({
			readHostedSessionOrphanReclamationEligibleAtEpochMs: (summary) =>
				summary.taskId === input.taskId ? 1_800_000_000_000 : null,
		});
		const parsedFinalRecord = parseTerminalSessionAdoptionRecord(previousRuntime.readLatestPublishedAdoptionRecord());
		const checkpoint =
			parsedFinalRecord.kind === "usable_adoption_record"
				? parsedFinalRecord.adoptionRecord.plannedHandoverTerminalMirrorCheckpoint
				: undefined;
		return { previousRuntime, detachResult, outputByteOffsetDeliveredBeforeDetach, checkpoint };
	}

	it("detaches hosted sessions without signalling them and publishes a final record with an aligned screen checkpoint and the orphan reclamation deadline", async () => {
		const { previousRuntime, detachResult, outputByteOffsetDeliveredBeforeDetach, checkpoint } =
			await detachAfterOutput({ taskId: "task-handover-detach", pid: 9191 });

		expect(detachResult.detachedHostedSessionSummaries.map((summary) => summary.taskId)).toEqual([
			"task-handover-detach",
		]);
		expect(detachResult.interruptedInProcessSessionSummaries).toEqual([]);
		// 确定性断言：detach 绝不发信号。
		expect(previousRuntime.handle.stop).not.toHaveBeenCalled();
		expect(previousRuntime.handle.detachFromRuntimeForHandoverRestartWithoutSignallingProcess).toHaveBeenCalledTimes(
			1,
		);
		expect(previousRuntime.handle.publishedHostedSessionOrphanReclamationEligibleAtEpochMsList.at(-1)).toBe(
			1_800_000_000_000,
		);
		expect(checkpoint?.outputByteOffsetCoveredBySnapshot).toBe(
			outputByteOffsetDeliveredBeforeDetach -
				Buffer.byteLength(UNTERMINATED_OSC_SEQUENCE_HELD_BACK_BY_PROTOCOL_FILTER, "utf8"),
		);
		expect(checkpoint?.serializedTerminalMirrorSnapshot).toContain("Line before handover.");
		// summary 原样保留（仍是活着的会话），没有被记成中断。
		expect(previousRuntime.previousRuntimeManager.getSummary("task-handover-detach")).toMatchObject({ pid: 9191 });
		expect(previousRuntime.previousRuntimeManager.getSummary("task-handover-detach")?.reviewReason).not.toBe(
			"interrupted",
		);
	});

	it("adopts from the checkpoint: restores the screen, resumes output from the checkpoint offset and does not nudge a redraw", async () => {
		const { previousRuntime, checkpoint } = await detachAfterOutput({ taskId: "task-handover-adopt", pid: 9292 });
		const checkpointOutputByteOffset = checkpoint?.outputByteOffsetCoveredBySnapshot ?? -1;
		const restartedRuntimeManager = new TerminalSessionManager();
		restartedRuntimeManager.hydrateFromRecord({}, new Set(["task-handover-adopt"]));
		const { candidate, handle, readRequestedFromOutputByteOffset } = createFakeAdoptionCandidate({
			taskId: "task-handover-adopt",
			pid: 9292,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
			catchUpOutputTexts: ["\r\n⏺ Line written while the runtime was away.\r\n"],
			retainedOutputStartByteOffset: 0,
			outputEndByteOffset: checkpointOutputByteOffset + 200,
		});

		const [adoptionOutcome] = await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([
			candidate,
		]);

		expect(adoptionOutcome?.adoptionOutcome).toBe("adopted_running_session");
		expect(readRequestedFromOutputByteOffset()).toBe(checkpointOutputByteOffset);
		expect(handle.resize).not.toHaveBeenCalledWith(100, 29);
		const restoreSnapshot = await restartedRuntimeManager.getRestoreSnapshot("task-handover-adopt");
		expect(restoreSnapshot?.snapshot).toContain("Line before handover.");
		expect(restoreSnapshot?.snapshot).toContain("Line written while the runtime was away.");
	});

	it("attach 时新出现覆盖缺口会丢弃旧屏幕并重绘，不拼接旧 checkpoint", async () => {
		const { previousRuntime, checkpoint } = await detachAfterOutput({ taskId: "attach-gap", pid: 9696 });
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({}, new Set(["attach-gap"]));
		const { candidate, handle } = createFakeAdoptionCandidate({
			taskId: "attach-gap",
			pid: 9696,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
			retainedOutputStartByteOffset: 0,
			outputEndByteOffset: (checkpoint?.outputByteOffsetCoveredBySnapshot ?? 0) + 100,
			catchUpOutputGap: true,
			catchUpOutputTexts: ["new-tail"],
		});
		expect((await manager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]))[0].adoptionOutcome).toBe(
			"adopted_running_session",
		);
		const snapshot = await manager.getRestoreSnapshot("attach-gap");
		expect(snapshot?.snapshot).toContain("new-tail");
		expect(snapshot?.snapshot).not.toContain("Line before handover.");
		expect(handle.resize).toHaveBeenCalledWith(100, 29);
	});

	it("falls back to replaying the output ring buffer when the checkpoint offset is no longer retained by the host", async () => {
		const { previousRuntime, checkpoint } = await detachAfterOutput({
			taskId: "task-handover-overwritten",
			pid: 9393,
		});
		const checkpointOutputByteOffset = checkpoint?.outputByteOffsetCoveredBySnapshot ?? -1;
		const restartedRuntimeManager = new TerminalSessionManager();
		restartedRuntimeManager.hydrateFromRecord({}, new Set(["task-handover-overwritten"]));
		const { candidate, handle, readRequestedFromOutputByteOffset } = createFakeAdoptionCandidate({
			taskId: "task-handover-overwritten",
			pid: 9393,
			terminalSessionAdoptionRecord: previousRuntime.readLatestPublishedAdoptionRecord(),
			catchUpOutputTexts: ["Claude Code\r\n"],
			// 缺席期间输出超过了环形缓冲容量：checkpoint 之后的一段已被覆盖。
			retainedOutputStartByteOffset: checkpointOutputByteOffset + 1,
			outputEndByteOffset: checkpointOutputByteOffset + 5_000,
		});

		await restartedRuntimeManager.adoptHostedTerminalPtySessionsAfterRuntimeRestart([candidate]);

		expect(readRequestedFromOutputByteOffset()).toBeUndefined();
		expect(handle.resize).toHaveBeenCalledWith(100, 29);
	});

	it("still interrupts in-process PTY sessions, which cannot outlive the runtime, while detaching hosted ones", async () => {
		const inProcessHandle = createFakeHostedTerminalPtyProcessHandle(9494);
		const {
			detachFromRuntimeForHandoverRestartWithoutSignallingProcess: _detachIsHostedOnly,
			...inProcessPtyHandle
		} = inProcessHandle;
		const manager = new TerminalSessionManager({
			hostedTerminalPtyProcessSpawner: { spawnHostedTerminalPtyProcess: async () => inProcessPtyHandle },
		});
		await manager.startTaskSession({
			taskId: "task-in-process",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-in-process",
			prompt: "",
		});

		const detachResult = await manager.detachHostedPtySessionsForRuntimeHandover({
			readHostedSessionOrphanReclamationEligibleAtEpochMs: () => null,
		});

		expect(detachResult.detachedHostedSessionSummaries).toEqual([]);
		expect(detachResult.interruptedInProcessSessionSummaries.map((summary) => summary.taskId)).toEqual([
			"task-in-process",
		]);
		expect(inProcessHandle.stop).toHaveBeenCalledWith({ interrupted: true });
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

	function chooseBetweenHostAndPersistedSummary(
		adoptionRecordSummary: RuntimeTaskSessionSummary,
		persistedSummary: RuntimeTaskSessionSummary,
	) {
		return chooseTaskSessionSummaryForHostedSessionAdoption({
			parsedAdoptionRecord: {
				kind: "usable_adoption_record",
				adoptionRecord: {
					terminalSessionAdoptionRecordSchemaVersion: 1,
					recordedAtEpochMs: adoptionRecordSummary.updatedAt,
					summary: adoptionRecordSummary,
					carriedActiveProcessStateFields: {} as never,
					rederivationInputs: {
						suppressScrollbackErasure: true,
						suppressDeviceAttributeQueries: false,
						outputReactionEngineWasActive: false,
					},
				},
			},
			persistedSummary,
			summaryOfHydratedEntry: adoptionRecordSummary,
			hostReportedPid: adoptionRecordSummary.pid ?? -1,
			hostReportedSpawnedAtEpochMs: adoptionRecordSummary.startedAt ?? 1,
		});
	}

	function claudeNativeIdentityObservedAt(observedAt: number, nativeSessionId = "newer-durable-native-session") {
		return {
			sourceAgentId: "claude",
			nativeSessionId,
			transcriptPath: `/isolated-native-transcripts/${nativeSessionId}.jsonl`,
			observedAt,
		};
	}

	it("身份独立水位：host 尚未带身份且 activity 时间相等时保留已持久化的 native identity", async () => {
		const hostSummary = await captureRunningClaudeSummary(9797);
		const persistedSummary = {
			...hostSummary,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(200),
		};

		const choice = chooseBetweenHostAndPersistedSummary(hostSummary, persistedSummary);

		expect(choice).toEqual({
			kind: "chosen",
			summarySource: "adoption_record",
			summary: {
				...hostSummary,
				agentNativeConversationSessionIdentity: persistedSummary.agentNativeConversationSessionIdentity,
			},
		});
	});

	it("身份独立水位：disk 的较新身份不覆盖 host 的较新 activity", async () => {
		const originalSummary = await captureRunningClaudeSummary(9798);
		const hostSummary = {
			...originalSummary,
			updatedAt: originalSummary.updatedAt + 2_000,
			lastOutputAt: originalSummary.updatedAt + 1_500,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(100, "older-host-native-session"),
		};
		const persistedSummary = {
			...originalSummary,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(200),
		};

		const choice = chooseBetweenHostAndPersistedSummary(hostSummary, persistedSummary);

		expect(choice).toEqual({
			kind: "chosen",
			summarySource: "adoption_record",
			summary: {
				...hostSummary,
				agentNativeConversationSessionIdentity: persistedSummary.agentNativeConversationSessionIdentity,
			},
		});
		expect(hostSummary.agentNativeConversationSessionIdentity.nativeSessionId).toBe("older-host-native-session");
	});

	it("身份独立水位：disk activity 较新但身份较旧时，活动取 disk、身份保留 host 的较新观测", async () => {
		const originalSummary = await captureRunningClaudeSummary(9799);
		const hostSummary = {
			...originalSummary,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(200, "newer-host-native-session"),
		};
		const persistedSummary = {
			...originalSummary,
			updatedAt: originalSummary.updatedAt + 2_000,
			lastOutputAt: originalSummary.updatedAt + 1_500,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(100),
		};

		const choice = chooseBetweenHostAndPersistedSummary(hostSummary, persistedSummary);

		expect(choice).toEqual({
			kind: "chosen",
			summarySource: "persisted_sessions_json_of_same_incarnation",
			summary: {
				...persistedSummary,
				agentNativeConversationSessionIdentity: hostSummary.agentNativeConversationSessionIdentity,
			},
		});
	});

	it.each([100, 200])("身份独立水位：disk observedAt=%s 不比 host 新时不覆盖 host 身份", async (observedAt) => {
		const hostSummary = {
			...(await captureRunningClaudeSummary(9800)),
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(200, "host-native-session"),
		};
		const persistedSummary = {
			...hostSummary,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(observedAt),
		};

		expect(chooseBetweenHostAndPersistedSummary(hostSummary, persistedSummary)).toEqual({
			kind: "chosen",
			summarySource: "adoption_record",
			summary: hostSummary,
		});
	});

	it.each([
		{ bindingMismatch: "pid", patch: { pid: 9802 } },
		{ bindingMismatch: "incarnation", patch: { runtimeSessionIncarnationId: "another-live-process-incarnation" } },
		{ bindingMismatch: "空 incarnation", patch: { runtimeSessionIncarnationId: "" } },
		{ bindingMismatch: "agent", patch: { agentId: "codex" as const } },
		{ bindingMismatch: "startedAt", patch: { startedAt: 1 } },
	])("身份独立水位：$bindingMismatch 不匹配时不从磁盘拼入身份或活动", async ({ patch }) => {
		const hostSummary = await captureRunningClaudeSummary(9801);
		const persistedSummary: RuntimeTaskSessionSummary = {
			...hostSummary,
			...patch,
			updatedAt: hostSummary.updatedAt + 2_000,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(300),
		};

		expect(chooseBetweenHostAndPersistedSummary(hostSummary, persistedSummary)).toEqual({
			kind: "chosen",
			summarySource: "adoption_record",
			summary: hostSummary,
		});
	});

	it("身份独立水位：两份记录都缺少非空 incarnation 时不能仅凭 pid 和时间戳合并", async () => {
		const hostSummary = { ...(await captureRunningClaudeSummary(9803)), runtimeSessionIncarnationId: "" };
		const persistedSummary = {
			...hostSummary,
			updatedAt: hostSummary.updatedAt + 2_000,
			agentNativeConversationSessionIdentity: claudeNativeIdentityObservedAt(300),
		};

		expect(chooseBetweenHostAndPersistedSummary(hostSummary, persistedSummary)).toEqual({
			kind: "chosen",
			summarySource: "adoption_record",
			summary: hostSummary,
		});
	});

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
