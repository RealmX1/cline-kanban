// 续跑前的 Claude 后台会话预检在启动漏斗里的接线（修的是 2026-10-07 任务 99b7e：终端里 `/background` 之后，
// kanban 按 id 续跑被 Claude 拒绝、秒退 exit 1）。守的不变量：
//  1. 记录的对话被后台会话占着且**能安全收回**（idle + 输入框为空）⇒ 先 `claude stop`，再照常按 id 续跑；
//  2. **不能安全收回** ⇒ 拒绝且一动不动（不 spawn、不 stop、不杀现有会话），原因写进 warningMessage 与观测
//     sidecar，并武装盯梢：等它能安全收回时自动再续一次；人工停止会取消盯梢；
//  3. 用户在终端面板上确认接管 ⇒ 不看是否安全，停掉后续跑；
//  4. 原转录末尾有 `continued-in` ⇒ 改钉到对话最新所在的 id 再续跑；
//  5. 全新开局、非 Claude agent 都不去问守护进程；运行时重启后「正在盯」的标记复位。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prepareAgentLaunchMock = vi.hoisted(() => vi.fn());
const ptySessionSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/terminal/agent-session-adapters.js", () => ({
	prepareAgentLaunch: prepareAgentLaunchMock,
}));

vi.mock("../../../src/terminal/pty-session.js", () => ({
	PtySession: {
		spawn: ptySessionSpawnMock,
	},
}));

import type { RuntimeTaskAgentSessionInitialization } from "../../../src/core/api-contract";
import type {
	ClaudeCodeBackgroundSessionDaemonClient,
	ClaudeCodeLiveSessionListingEntry,
} from "../../../src/terminal/claude-code-background-session-ownership-preflight-before-resume";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	const session = {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(() => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode: 0 });
		}),
		wasInterrupted: vi.fn(() => false),
		hasExited: vi.fn(() => session.exitedFlag),
		exitedFlag: false,
	};
	return session;
}

const TASK_ID = "card-99b7e";
const TASK_WORKING_DIRECTORY = "/tmp/kanban-task-worktree-99b7e";
const RECORDED_NATIVE_SESSION_ID = "fd026429-0e21-47c4-91c1-1705a09dbf05";
const BACKGROUND_CONTINUATION_NATIVE_SESSION_ID = "bdd73afb-38f0-4ec6-8c4e-9c488e8667f1";

function buildBackgroundSessionHolding(
	nativeSessionId: string,
	turnActivityStatus: string,
): ClaudeCodeLiveSessionListingEntry {
	return {
		claudeCodeSessionShortId: nativeSessionId.slice(0, 8),
		nativeSessionId,
		startedInWorkingDirectoryPath: TASK_WORKING_DIRECTORY,
		sessionHostKind: "background",
		processId: 66849,
		turnActivityStatus,
	};
}

// 合成的 Claude TUI 屏幕（输入框为空）：`claude logs` 回放出来的样子。
const CLAUDE_SCREEN_BYTES_WITH_EMPTY_INPUT_BOX = Buffer.from(
	`\u001b[2J\u001b[H Claude Code\r\n${"─".repeat(120)}\r\n❯\u00a0\r\n${"─".repeat(120)}\r\n`,
	"utf8",
);

function createFakeDaemonClient(listings: ClaudeCodeLiveSessionListingEntry[][]) {
	const remainingListings = [...listings];
	return {
		listLiveSessionsStartedUnderWorkingDirectory: vi.fn<
			ClaudeCodeBackgroundSessionDaemonClient["listLiveSessionsStartedUnderWorkingDirectory"]
		>(async () => ({ ok: true, liveSessions: remainingListings.shift() ?? [] })),
		readBackgroundSessionRecentTerminalOutput: vi.fn<
			ClaudeCodeBackgroundSessionDaemonClient["readBackgroundSessionRecentTerminalOutput"]
		>(async () => ({ ok: true, recentTerminalOutputBytes: CLAUDE_SCREEN_BYTES_WITH_EMPTY_INPUT_BOX })),
		stopBackgroundSession: vi.fn<ClaudeCodeBackgroundSessionDaemonClient["stopBackgroundSession"]>(async () => ({
			ok: true,
		})),
	};
}

function createManager(daemonClient: ClaudeCodeBackgroundSessionDaemonClient) {
	const spawnedSessions: Array<ReturnType<typeof createMockPtySession>> = [];
	ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
		const session = createMockPtySession(100 + spawnedSessions.length, request);
		spawnedSessions.push(session);
		return session;
	});
	return {
		manager: new TerminalSessionManager({ claudeCodeBackgroundSessionDaemonClient: daemonClient }),
		spawnedSessions,
	};
}

function readMostRecentResumeAddressing(): RuntimeTaskAgentSessionInitialization | undefined {
	const calls = prepareAgentLaunchMock.mock.calls;
	const lastCall = calls[calls.length - 1]?.[0] as
		| { observedAgentNativeConversationSessionResumeAddressing?: RuntimeTaskAgentSessionInitialization }
		| undefined;
	return lastCall?.observedAgentNativeConversationSessionResumeAddressing;
}

async function startFreshClaudeSession(manager: TerminalSessionManager): Promise<void> {
	await manager.startTaskSession({
		taskId: TASK_ID,
		agentId: "claude",
		binary: "claude",
		args: [],
		cwd: TASK_WORKING_DIRECTORY,
		prompt: "Orchestrate the parallel tasks",
	});
}

function buildRefreshRequest() {
	return {
		taskId: TASK_ID,
		agentId: "claude" as const,
		binary: "claude",
		args: [],
		cwd: TASK_WORKING_DIRECTORY,
		prompt: "",
		resumeFromTrash: true,
	};
}

describe("TerminalSessionManager Claude Code background session ownership preflight", () => {
	let transcriptDirectoryPath: string;

	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));
		transcriptDirectoryPath = mkdtempSync(join(tmpdir(), "kanban-claude-background-session-preflight-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(transcriptDirectoryPath, { recursive: true, force: true });
	});

	it("stops the idle background session holding the conversation, then resumes it by id in the kanban terminal", async () => {
		const daemonClient = createFakeDaemonClient([
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "idle")],
			[],
		]);
		const { manager } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		// 全新开局不寻址，也就不去问守护进程。
		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory).not.toHaveBeenCalled();
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		const spawnCountBeforeRefresh = ptySessionSpawnMock.mock.calls.length;

		await manager.refreshTaskTerminal(buildRefreshRequest());

		expect(daemonClient.stopBackgroundSession).toHaveBeenCalledTimes(1);
		expect(daemonClient.stopBackgroundSession).toHaveBeenCalledWith({
			claudeBinary: "claude",
			claudeCodeSessionShortId: "bdd73afb",
		});
		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory).toHaveBeenCalledWith({
			claudeBinary: "claude",
			workingDirectoryPath: TASK_WORKING_DIRECTORY,
		});
		expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountBeforeRefresh + 1);
		expect(readMostRecentResumeAddressing()).toEqual({
			sourceAgentId: "claude",
			sourceSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			sourceSessionReuseMode: "resume_existing_session",
		});
	});

	it("refuses without touching anything while the background session is mid-turn, and records why", async () => {
		const daemonClient = createFakeDaemonClient([
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
		]);
		const { manager, spawnedSessions } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		const spawnCountBeforeRefresh = ptySessionSpawnMock.mock.calls.length;
		const pidBeforeRefusal = manager.getSummary(TASK_ID)?.pid;

		const refusal = await manager.refreshTaskTerminal(buildRefreshRequest()).catch((error: unknown) => error);

		expect(refusal).toBeInstanceOf(Error);
		expect((refusal as Error).message).toContain("claude attach bdd73afb");
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountBeforeRefresh);
		// 拒绝站在 forceStop 之前：现有会话一动不动。
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		expect(manager.getSummary(TASK_ID)?.pid).toBe(pidBeforeRefusal);
		expect(manager.getSummary(TASK_ID)?.warningMessage).toContain("claude attach bdd73afb");
		expect(
			manager.getSummary(TASK_ID)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation,
		).toMatchObject({
			harnessBackgroundSessionShortId: "bdd73afb",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			reclaimBlockedReason: "background_session_generating_response_mid_turn",
			automaticReclaimWatchActive: true,
		});
		manager.stopTaskSession(TASK_ID);
	});

	it("keeps watching the busy background session and reclaims it as soon as it becomes safe", async () => {
		vi.useFakeTimers();
		const daemonClient = createFakeDaemonClient([
			// 被拒那一次
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
			// 盯梢第一拍：还在跑
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
			// 第二拍：停在对话框上——仍不能收回，但原因要更新
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "waiting")],
			// 第三拍：空闲且输入框为空 ⇒ 交给启动漏斗；漏斗里的预检再看一次、stop、复查
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "idle")],
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "idle")],
			[],
		]);
		const { manager } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		// 99b7e 现场：`/background` 之后 kanban 终端里的那条进程早已退出，留下的只是对话身份。
		manager.stopTaskSession(TASK_ID);
		await manager.refreshTaskTerminal(buildRefreshRequest()).catch(() => undefined);
		const spawnCountAfterRefusal = ptySessionSpawnMock.mock.calls.length;

		await vi.advanceTimersByTimeAsync(5_000);
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(
			manager.getSummary(TASK_ID)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation
				?.reclaimBlockedReason,
		).toBe("background_session_waiting_for_user_decision");
		await vi.advanceTimersByTimeAsync(5_000);
		// 这一拍要读屏：无头镜像的写入在假时钟下要靠推进计时器才完成，vi.waitFor 会边等边推进。
		await vi.waitFor(() => expect(daemonClient.stopBackgroundSession).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountAfterRefusal + 1));

		expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountAfterRefusal + 1);
		expect(readMostRecentResumeAddressing()?.sourceSessionId).toBe(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID);
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation).toBeNull();
		// 接回之后盯梢就停了：再过多久都不会再去问守护进程。
		const listingCallsAfterReclaim = daemonClient.listLiveSessionsStartedUnderWorkingDirectory.mock.calls.length;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory.mock.calls.length).toBe(
			listingCallsAfterReclaim,
		);
	});

	it("ends the watch visibly when its auto-resume is folded into a live kanban session that is mid-turn", async () => {
		vi.useFakeTimers();
		const daemonClient = createFakeDaemonClient([
			// 被拒那一次：refresh 被拒时现有 kanban 会话一动不动，仍在回合中
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
			// 盯梢第一拍：空闲且输入框为空 ⇒ 交给启动漏斗，却被折叠进那条活会话，根本走不到预检
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "idle")],
		]);
		const { manager, spawnedSessions } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		await manager.refreshTaskTerminal(buildRefreshRequest()).catch(() => undefined);
		const spawnCountAfterRefusal = ptySessionSpawnMock.mock.calls.length;
		const readHeldObservation = () =>
			manager.getSummary(TASK_ID)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation;
		expect(readHeldObservation()?.automaticReclaimWatchActive).toBe(true);

		await vi.advanceTimersByTimeAsync(5_000);
		// 这一拍要读屏：无头镜像的写入在假时钟下要靠推进计时器才完成，vi.waitFor 会边等边推进。
		await vi.waitFor(() => expect(readHeldObservation()?.automaticReclaimWatchActive).toBe(false));

		// 不停摆、不说谎：盯梢明确结束，面板改为「已停止自动等待」；活会话与后台会话都没被动。
		expect(readHeldObservation()).toMatchObject({
			harnessBackgroundSessionShortId: "bdd73afb",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			automaticReclaimWatchActive: false,
		});
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountAfterRefusal);
		expect(spawnedSessions[0]?.stop).not.toHaveBeenCalled();
		const listingCallsAfterWatchEnded = daemonClient.listLiveSessionsStartedUnderWorkingDirectory.mock.calls.length;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory.mock.calls.length).toBe(
			listingCallsAfterWatchEnded,
		);
		manager.stopTaskSession(TASK_ID);
	});

	it("stops watching once the user stops the task session by hand", async () => {
		vi.useFakeTimers();
		const daemonClient = createFakeDaemonClient([
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
		]);
		const { manager } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		await manager.refreshTaskTerminal(buildRefreshRequest()).catch(() => undefined);
		const listingCallsAfterRefusal = daemonClient.listLiveSessionsStartedUnderWorkingDirectory.mock.calls.length;

		manager.stopTaskSession(TASK_ID);
		await vi.advanceTimersByTimeAsync(30_000);

		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory.mock.calls.length).toBe(
			listingCallsAfterRefusal,
		);
	});

	it("abandons the watch's auto-resume that is still queued for the start gate once the user stops the task", async () => {
		vi.useFakeTimers();
		const daemonClient = createFakeDaemonClient([
			// 被拒那一次
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
			// 盯梢第一拍：后台会话已经不在了 ⇒ 交给启动链，但闸门被下面那次 refresh 占着，只能排队
			[],
			// 排进链里的那一次若照样跑下去，漏斗里的预检会看到它 idle：stop 掉再 spawn
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "idle")],
			[],
		]);
		const { manager } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		manager.stopTaskSession(TASK_ID);
		await manager.refreshTaskTerminal(buildRefreshRequest()).catch(() => undefined);
		const spawnCountAfterRefusal = ptySessionSpawnMock.mock.calls.length;
		// 占住 per-task 启动闸门：另一次 refresh 卡在它自己的预检里（列举挂起）。预检还没下结论，盯梢也就还没被它取消。
		let failGateHoldingRefreshListing: (error: Error) => void = () => undefined;
		daemonClient.listLiveSessionsStartedUnderWorkingDirectory.mockImplementationOnce(
			() =>
				new Promise<never>((_resolve, reject) => {
					failGateHoldingRefreshListing = reject;
				}),
		);
		const gateHoldingRefresh = manager.refreshTaskTerminal(buildRefreshRequest()).catch((error: unknown) => error);
		await vi.waitFor(() =>
			expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory).toHaveBeenCalledTimes(2),
		);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory).toHaveBeenCalledTimes(3);
		// 盯梢已把续跑交给启动链、正排在闸门后面；此时用户停掉任务。
		manager.stopTaskSession(TASK_ID);
		failGateHoldingRefreshListing(new Error("claude agents --json interrupted"));
		expect(await gateHoldingRefresh).toBeInstanceOf(Error);
		await vi.advanceTimersByTimeAsync(30_000);

		// 排队的那一次拿到闸门后自行放弃：没进预检、没 stop 后台会话、没 spawn。
		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory).toHaveBeenCalledTimes(3);
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
		expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountAfterRefusal);
	});

	it("takes over a busy background session when the user confirmed it on the terminal panel", async () => {
		const daemonClient = createFakeDaemonClient([
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
			[],
		]);
		const { manager } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		const spawnCountBeforeTakeover = ptySessionSpawnMock.mock.calls.length;

		await manager.refreshTaskTerminal(buildRefreshRequest(), "refresh_task_terminal", {
			forceStopHarnessBackgroundSessionHoldingResumeTargetConfirmedByUser: true,
		});

		expect(daemonClient.stopBackgroundSession).toHaveBeenCalledWith({
			claudeBinary: "claude",
			claudeCodeSessionShortId: "bdd73afb",
		});
		expect(ptySessionSpawnMock.mock.calls.length).toBe(spawnCountBeforeTakeover + 1);
		expect(readMostRecentResumeAddressing()?.sourceSessionId).toBe(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID);
	});

	it("stops claiming to watch once the watch is cancelled by a manual stop or a manager shutdown", async () => {
		const daemonClient = createFakeDaemonClient([
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
			[buildBackgroundSessionHolding(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID, "busy")],
		]);
		const { manager } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: null,
			observedAt: 1,
		});
		const broadcastWatchFlags: Array<boolean | undefined> = [];
		manager.onSummary((summary) => {
			broadcastWatchFlags.push(
				summary.agentNativeConversationHeldByHarnessBackgroundSessionObservation?.automaticReclaimWatchActive,
			);
		});
		const readHeldObservation = () =>
			manager.getSummary(TASK_ID)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation;
		await manager.refreshTaskTerminal(buildRefreshRequest()).catch(() => undefined);
		expect(readHeldObservation()?.automaticReclaimWatchActive).toBe(true);

		manager.stopTaskSession(TASK_ID);

		// 观测（被谁占着、为什么）保留，只是不再说「正在盯」，并且广播出去了。
		expect(readHeldObservation()).toMatchObject({
			harnessBackgroundSessionShortId: "bdd73afb",
			reclaimBlockedReason: "background_session_generating_response_mid_turn",
			automaticReclaimWatchActive: false,
		});
		expect(broadcastWatchFlags).toContain(false);

		// 再被拒一次就重新武装；manager 关停取消盯梢时同样要复位。
		await manager.refreshTaskTerminal(buildRefreshRequest()).catch(() => undefined);
		expect(readHeldObservation()?.automaticReclaimWatchActive).toBe(true);
		manager.dispose();
		expect(readHeldObservation()?.automaticReclaimWatchActive).toBe(false);
	});

	it("does not claim to be watching after a runtime restart", () => {
		const manager = new TerminalSessionManager({
			claudeCodeBackgroundSessionDaemonClient: createFakeDaemonClient([]),
		});
		manager.hydrateFromRecord({
			[TASK_ID]: {
				taskId: TASK_ID,
				state: "awaiting_review",
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "error",
				agentId: "claude",
				workspacePath: null,
				pid: null,
				startedAt: 1,
				updatedAt: 2,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: 1,
				lastHookAt: null,
				latestHookActivity: null,
				agentNativeConversationHeldByHarnessBackgroundSessionObservation: {
					harnessBackgroundSessionShortId: "bdd73afb",
					nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
					reclaimBlockedReason: "background_session_generating_response_mid_turn",
					automaticReclaimWatchActive: true,
					observedAt: 1,
				},
			},
		});
		expect(
			manager.getSummary(TASK_ID)?.agentNativeConversationHeldByHarnessBackgroundSessionObservation,
		).toMatchObject({
			harnessBackgroundSessionShortId: "bdd73afb",
			automaticReclaimWatchActive: false,
		});
	});

	it("follows the transcript's continued-in record to the conversation's latest session id before resuming", async () => {
		const recordedTranscriptPath = join(transcriptDirectoryPath, `${RECORDED_NATIVE_SESSION_ID}.jsonl`);
		writeFileSync(
			recordedTranscriptPath,
			[
				JSON.stringify({ type: "user", message: { content: "hello" } }),
				JSON.stringify({ type: "continued-in", continuedInSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID }),
				JSON.stringify({ type: "cost-state", totalCostUSD: 1 }),
			].join("\n"),
		);
		const continuationTranscriptPath = join(
			transcriptDirectoryPath,
			`${BACKGROUND_CONTINUATION_NATIVE_SESSION_ID}.jsonl`,
		);
		writeFileSync(continuationTranscriptPath, `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`);
		const daemonClient = createFakeDaemonClient([]);
		const { manager } = createManager(daemonClient);
		await startFreshClaudeSession(manager);
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "claude",
			nativeSessionId: RECORDED_NATIVE_SESSION_ID,
			transcriptPath: recordedTranscriptPath,
			observedAt: 1,
		});

		await manager.refreshTaskTerminal(buildRefreshRequest());

		expect(readMostRecentResumeAddressing()?.sourceSessionId).toBe(BACKGROUND_CONTINUATION_NATIVE_SESSION_ID);
		expect(manager.getSummary(TASK_ID)?.agentNativeConversationSessionIdentity).toMatchObject({
			sourceAgentId: "claude",
			nativeSessionId: BACKGROUND_CONTINUATION_NATIVE_SESSION_ID,
			transcriptPath: continuationTranscriptPath,
			identityEstablishmentMethod:
				"followed_claude_code_transcript_continued_in_record_to_conversation_continuation",
		});
	});

	it("does not consult the Claude background daemon for an agent that has none", async () => {
		const daemonClient = createFakeDaemonClient([]);
		const { manager } = createManager(daemonClient);
		await manager.startTaskSession({
			taskId: TASK_ID,
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: TASK_WORKING_DIRECTORY,
			prompt: "Implement the feature",
		});
		manager.applyAgentNativeConversationSessionIdentity(TASK_ID, {
			sourceAgentId: "codex",
			nativeSessionId: "019a0000-0000-7000-8000-000000000000",
			transcriptPath: null,
			observedAt: 1,
		});

		await manager.refreshTaskTerminal({ ...buildRefreshRequest(), agentId: "codex", binary: "codex" });

		expect(daemonClient.listLiveSessionsStartedUnderWorkingDirectory).not.toHaveBeenCalled();
		expect(daemonClient.stopBackgroundSession).not.toHaveBeenCalled();
	});
});
