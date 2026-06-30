import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

interface MockPtySession {
	pid: number;
	write: ReturnType<typeof vi.fn>;
	resize: ReturnType<typeof vi.fn>;
	pause: ReturnType<typeof vi.fn>;
	resume: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	wasInterrupted: ReturnType<typeof vi.fn>;
	hasExited: ReturnType<typeof vi.fn>;
	exitedFlag: boolean;
	stopCalls: Array<{ force: boolean }>;
	triggerData: (chunk: string | Buffer) => void;
	triggerExit: (exitCode: number | null) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest): MockPtySession {
	const session: MockPtySession = {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		hasExited: vi.fn(() => session.exitedFlag),
		exitedFlag: false,
		stopCalls: [],
		triggerData: (chunk) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode) => {
			session.exitedFlag = true;
			request.onExit?.({ exitCode });
		},
	};
	session.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
		session.stopCalls.push({ force: Boolean(opts?.force) });
	});
	return session;
}

const CLAUDE_RESUME_MENU = [
	"╭────────────────────────────────────────────────╮",
	"│ Cache hit is past due                          │",
	"│  1. Continue from summary                      │",
	"│  2. Continue as is (full session context)      │",
	"│  3. Start a new session                        │",
	"╰────────────────────────────────────────────────╯",
].join("\r\n");

describe("TerminalSessionManager resume substantive guard", () => {
	beforeEach(async () => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		const actual = await vi.importActual<typeof import("../../../src/terminal/agent-session-adapters.js")>(
			"../../../src/terminal/agent-session-adapters.js",
		);
		prepareAgentLaunchMock.mockImplementation(actual.prepareAgentLaunch);
	});

	function wireStopToExit(spawnedSessions: MockPtySession[]): void {
		for (const session of spawnedSessions) {
			session.stop.mockImplementation((opts?: { interrupted?: boolean; force?: boolean }) => {
				session.stopCalls.push({ force: Boolean(opts?.force) });
				if (!session.exitedFlag) {
					session.triggerExit(0);
				}
			});
		}
	}

	it("keeps lastSubstantiveOutputAt across refresh when Claude resume UI appears", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		manager.attach("task-guard", {
			onState: vi.fn(),
			onOutput: vi.fn(),
			onExit: vi.fn(),
		});

		await manager.startTaskSession({
			taskId: "task-guard",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard",
			prompt: "Implement the task",
		});

		const firstSession = spawnedSessions[0];
		expect(firstSession).toBeDefined();
		firstSession?.triggerData("Claude Code\nHow can I help you today?\n");
		firstSession?.triggerData("⏺ Earlier real agent response before refresh.\n");

		const substantiveBefore = manager.getSummary("task-guard")?.lastSubstantiveOutputAt;
		expect(substantiveBefore).not.toBeNull();

		wireStopToExit(spawnedSessions);

		await manager.refreshTaskTerminal({
			taskId: "task-guard",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard",
			prompt: "",
			resumeFromTrash: true,
		});

		const secondSession = spawnedSessions[1];
		expect(secondSession).toBeDefined();
		secondSession?.triggerData("Claude Code\nHow can I help you today?\n");
		secondSession?.triggerData(CLAUDE_RESUME_MENU);

		const afterResumeUi = manager.getSummary("task-guard");
		expect(afterResumeUi?.lastSubstantiveOutputAt).toBe(substantiveBefore);
	});

	it("advances lastSubstantiveOutputAt after user continues and agent produces real output", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(spawnedSessions.length === 0 ? 111 : 222, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-guard-2",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard-2",
			prompt: "Implement the task",
		});

		spawnedSessions[0]?.triggerData("⏺ Seed response.\n");
		const substantiveBefore = manager.getSummary("task-guard-2")?.lastSubstantiveOutputAt;
		wireStopToExit(spawnedSessions);

		await manager.refreshTaskTerminal({
			taskId: "task-guard-2",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard-2",
			prompt: "",
			resumeFromTrash: true,
		});

		spawnedSessions[1]?.triggerData(CLAUDE_RESUME_MENU);
		manager.transitionToRunning("task-guard-2");
		spawnedSessions[1]?.triggerData("⏺ Resuming from summary.\n");

		const afterContinue = manager.getSummary("task-guard-2");
		expect(afterContinue?.lastSubstantiveOutputAt).not.toBe(substantiveBefore);
		expect(afterContinue?.lastSubstantiveOutputAt ?? 0).toBeGreaterThan(substantiveBefore ?? 0);
	});

	it("clears resume guard on transitionToRunning (UserPromptSubmit hook path)", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-guard-3",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-guard-3",
			prompt: "",
			resumeFromTrash: true,
		});

		spawnedSessions[0]?.triggerData(CLAUDE_RESUME_MENU);
		const beforeHook = manager.getSummary("task-guard-3")?.lastSubstantiveOutputAt;

		manager.transitionToRunning("task-guard-3");
		spawnedSessions[0]?.triggerData("⏺ Continued after hook.\n");

		const afterHook = manager.getSummary("task-guard-3");
		expect(afterHook?.lastSubstantiveOutputAt).not.toBe(beforeHook);
	});

	it("does not enable resume guard for non-Claude agents on resumeFromTrash", async () => {
		const spawnedSessions: MockPtySession[] = [];
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			const session = createMockPtySession(111, request);
			spawnedSessions.push(session);
			return session;
		});

		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
		}));

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-codex-resume",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp/task-codex-resume",
			prompt: "",
			resumeFromTrash: true,
		});

		manager.transitionToRunning("task-codex-resume");
		spawnedSessions[0]?.triggerData("Applying the requested change to foo.ts\n");
		expect(manager.getSummary("task-codex-resume")?.lastSubstantiveOutputAt).not.toBeNull();
	});
});
