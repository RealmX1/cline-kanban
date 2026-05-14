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

import {
	CLAUDE_STARTUP_READINESS_TIMEOUT_MS,
	hasClaudeInteractivePrompt,
	hasClaudeStartupUiRendered,
} from "../../../src/terminal/claude-readiness";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

interface MockSpawnRequest {
	env?: Record<string, string | undefined>;
	onData?: (chunk: Buffer) => void;
	onExit?: (event: { exitCode: number | null; signal?: number }) => void;
}

function createMockPtySession(pid: number, request: MockSpawnRequest) {
	return {
		pid,
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		stop: vi.fn(),
		wasInterrupted: vi.fn(() => false),
		triggerData: (chunk: string | Buffer) => {
			request.onData?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
		},
		triggerExit: (exitCode: number | null) => {
			request.onExit?.({ exitCode });
		},
	};
}

describe("hasClaudeStartupUiRendered", () => {
	it("matches the 'Claude Code' banner string", () => {
		expect(hasClaudeStartupUiRendered("Welcome to Claude Code v1.2.3")).toBe(true);
	});

	it("matches lowercase / mixed-case 'how can i help'", () => {
		expect(hasClaudeStartupUiRendered("How can I help you today?")).toBe(true);
	});

	it("matches the 'Tips for getting started' hint", () => {
		expect(hasClaudeStartupUiRendered("Tips for getting started:")).toBe(true);
	});

	it("ignores ANSI color codes around the banner", () => {
		expect(hasClaudeStartupUiRendered("[31mClaude Code[0m starting…")).toBe(true);
	});

	it("returns false for plain workspace trust prompts that do not include the banner", () => {
		expect(hasClaudeStartupUiRendered("Do you trust the contents of this directory?")).toBe(false);
	});

	it("returns false for empty input", () => {
		expect(hasClaudeStartupUiRendered("")).toBe(false);
	});
});

describe("hasClaudeInteractivePrompt", () => {
	it("matches the top border of the Claude input box", () => {
		expect(hasClaudeInteractivePrompt("╭──────────────────────╮")).toBe(true);
	});

	it("matches the bottom border of the Claude input box", () => {
		expect(hasClaudeInteractivePrompt("╰──────────────────────╯")).toBe(true);
	});

	it("matches a line-leading '> ' prompt marker", () => {
		expect(hasClaudeInteractivePrompt("some preamble\n> ")).toBe(true);
	});

	it("ignores ANSI styling on the box border", () => {
		expect(hasClaudeInteractivePrompt("[2m╭────╮[0m")).toBe(true);
	});

	it("returns false for plain output without input box or '>' marker", () => {
		expect(hasClaudeInteractivePrompt("Loading hooks settings…")).toBe(false);
	});

	it("returns false for the banner alone (banner is handled by hasClaudeStartupUiRendered)", () => {
		expect(hasClaudeInteractivePrompt("Claude Code")).toBe(false);
	});
});

describe("CLAUDE_STARTUP_READINESS_TIMEOUT_MS", () => {
	it("exposes a positive fallback window", () => {
		expect(CLAUDE_STARTUP_READINESS_TIMEOUT_MS).toBeGreaterThan(0);
	});
});

describe("Claude startup readiness wall-clock fallback (RVF G1-001)", () => {
	beforeEach(() => {
		prepareAgentLaunchMock.mockReset();
		ptySessionSpawnMock.mockReset();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("injects the deferred Claude startup prompt via wall-clock timer even when no further output arrives", async () => {
		// 回归测试 RVF G1-001：claudeReadyByDeadline 分支只在新 chunk 进来时检查
		// deadline，如果 Claude 在一个 chunk 里渲染完整启动 UI 而 readiness predicate
		// 漏识别（例如 TUI 文案改写、边框被切到两个 chunk），后续不会再有新的 output
		// 触发检查，deferred prompt 就永远注不进去。修复后通过 wall-clock setTimeout
		// 兜底，即便零额外 output 也能在 CLAUDE_STARTUP_READINESS_TIMEOUT_MS 后注入。
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
			// 模拟真实 Claude adapter：非空 prompt 会产出 deferredStartupInput。
			deferredStartupInput: "[200~Implement the task[201~\r\r",
		}));

		let spawnedSession: ReturnType<typeof createMockPtySession> | null = null;
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			spawnedSession = createMockPtySession(4321, request);
			return spawnedSession;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-claude-readiness-fallback",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-claude-readiness-fallback",
			prompt: "Implement the task",
		});

		expect(ptySessionSpawnMock).toHaveBeenCalledTimes(1);
		expect(spawnedSession).not.toBeNull();
		const session = spawnedSession as unknown as { write: ReturnType<typeof vi.fn> };
		// 关键：到这一步还没有任何 output / data 进来，旧实现里 prompt 永远不会被注入。
		expect(session.write).not.toHaveBeenCalled();

		// 推进到 readiness deadline 之后 — 独立 wall-clock 兜底 timer 应当触发并注入 prompt。
		await vi.advanceTimersByTimeAsync(CLAUDE_STARTUP_READINESS_TIMEOUT_MS + 50);

		expect(session.write).toHaveBeenCalledTimes(1);
		expect(session.write).toHaveBeenCalledWith("[200~Implement the task[201~\r\r");

		// stopTaskSession 应该把残留 timer / 句柄都清掉，不会再有额外的 write。
		manager.stopTaskSession("task-claude-readiness-fallback");
		await vi.advanceTimersByTimeAsync(CLAUDE_STARTUP_READINESS_TIMEOUT_MS * 2);
		expect(session.write).toHaveBeenCalledTimes(1);
	});

	it("does not re-fire the wall-clock fallback after readiness predicate already injected the prompt", async () => {
		// 一旦 readiness predicate（输入框 / 启动横幅）触发 trySendDeferredStartupInput，
		// 兜底 timer 应当被清除，避免重复写入 prompt。
		prepareAgentLaunchMock.mockImplementation(async (input: { args: string[]; binary?: string }) => ({
			binary: input.binary,
			args: [...input.args],
			env: {},
			deferredStartupInput: "[200~Hello[201~\r\r",
		}));

		let spawnedSession: ReturnType<typeof createMockPtySession> | null = null;
		ptySessionSpawnMock.mockImplementation((request: MockSpawnRequest) => {
			spawnedSession = createMockPtySession(7777, request);
			return spawnedSession;
		});

		const manager = new TerminalSessionManager();
		await manager.startTaskSession({
			taskId: "task-claude-readiness-no-double",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp/task-claude-readiness-no-double",
			prompt: "Hello",
		});

		const session = spawnedSession as unknown as {
			write: ReturnType<typeof vi.fn>;
			triggerData: (chunk: string | Buffer) => void;
		};

		// 模拟 Claude TUI 渲染输入框边框 — readiness predicate 命中并注入 prompt。
		session.triggerData("╭──────────────────────╮\n│ > │\n╰──────────────────────╯");
		expect(session.write).toHaveBeenCalledTimes(1);

		// 后续即便超过 deadline，wall-clock timer 也不该再次注入 prompt。
		await vi.advanceTimersByTimeAsync(CLAUDE_STARTUP_READINESS_TIMEOUT_MS * 2);
		expect(session.write).toHaveBeenCalledTimes(1);

		manager.stopTaskSession("task-claude-readiness-no-double");
	});
});
