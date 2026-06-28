import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { buildShellCommandLine } from "../../../src/core/shell";
import { buildTerminalEnvironment, TerminalSessionManager } from "../../../src/terminal/session-manager";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe("TerminalSessionManager", () => {
	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (sessionEntry: unknown, event: { type: "hook.to_review" }) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("transitionToReview(manual_review)：running 终端 agent 手动翻入 awaiting_review/user/review，reason=manual_review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, unknown> }).entries.set("task-1", entry);
		const result = manager.transitionToReview("task-1", "manual_review");
		expect(result?.state).toBe("awaiting_review");
		expect(result?.reviewReason).toBe("manual_review");
		expect(result?.turnOwner).toBe("user");
		expect(result?.liveness).toBe("live");
		expect(result?.userTurnKind).toBe("review");
	});

	it("transitionToReview：非 hook/manual_review reason（如 exit）→ no-op，summary 原样不变", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(manager as unknown as { entries: Map<string, unknown> }).entries.set("task-1", entry);
		const result = manager.transitionToReview("task-1", "exit");
		expect(result?.state).toBe("running");
		expect(result?.reviewReason).toBe(null);
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("cline", ["--auto-approve-all", "hello world"]);
		expect(commandLine).toContain("cline");
		expect(commandLine).toContain("--auto-approve-all");
		expect(commandLine).toContain("hello world");
	});

	it("advertises truecolor support to terminal agents", () => {
		const env = buildTerminalEnvironment(
			{ forceColor: true },
			{
				NO_COLOR: "1",
				NODE_DISABLE_COLORS: "1",
				FORCE_COLOR: "0",
			},
		);

		expect(env.TERM).toBe("xterm-256color");
		expect(env.COLORTERM).toBe("truecolor");
		expect(env.FORCE_COLOR).toBe("3");
		expect(env.CLICOLOR).toBe("1");
		expect(env.CLICOLOR_FORCE).toBe("1");
		expect(env.NO_COLOR).toBeUndefined();
		expect(env.NODE_DISABLE_COLORS).toBeUndefined();
	});

	it("preserves explicit color opt-outs for shell sessions", () => {
		const env = buildTerminalEnvironment(
			{ forceColor: false },
			{
				NO_COLOR: "1",
				NODE_DISABLE_COLORS: "1",
				FORCE_COLOR: "0",
				CLICOLOR: "0",
				CLICOLOR_FORCE: undefined,
			},
		);

		expect(env.TERM).toBe("xterm-256color");
		expect(env.COLORTERM).toBe("truecolor");
		expect(env.CLICOLOR).toBe("0");
		expect(env.CLICOLOR_FORCE).toBeUndefined();
		expect(env.FORCE_COLOR).toBe("0");
		expect(env.NO_COLOR).toBe("1");
		expect(env.NODE_DISABLE_COLORS).toBe("1");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("resets stale running sessions without active processes", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBeNull();
		expect(recovered?.reviewReason).toBeNull();
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/kanban/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				session: {},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(onOutput).not.toHaveBeenCalled();
		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(false);
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				session: {
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = new TerminalSessionManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			summary: createSummary({ taskId: "task-restore", state: "running" }),
			active: null,
			terminalStateMirror: {
				getSnapshot: getSnapshotSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		});
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});

	// Stage 3 余区：session-manager 的活跃回合 / Codex 回车门控从 legacy `state` 读 → 双轴 facet 真相源。
	// 锁定「迁移前可见行为基线」：isActiveState(running|awaiting_review) ⟺ isSummaryInActiveTurn(facets)；
	// Codex 回车旧 `state==="awaiting_review"` ⟺ isAwaitingUserReviewTurn(facets) + reviewReason 门控保留。
	// 含 live↔exited 折叠反证（exited 待审仍判活跃 / 仍触发 Codex 回车，不偷渡 distinction ②）。
	describe("facet 真相源迁移（行为保持）", () => {
		it("recoverStaleSession 重置 awaiting_review（活跃回合）的无进程会话", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({ state: "awaiting_review", reviewReason: "hook" }),
			});

			const recovered = manager.recoverStaleSession("task-1");

			expect(recovered?.state).toBe("idle");
			expect(recovered?.pid).toBeNull();
			expect(recovered?.workspacePath).toBeNull();
		});

		it("recoverStaleSession 不动非活跃回合（interrupted）的会话", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({
					state: "interrupted",
					reviewReason: "interrupted",
					workspacePath: "/tmp/keep",
					pid: 999,
				}),
			});

			const recovered = manager.recoverStaleSession("task-1");

			// interrupted 不属 {running, awaiting_review} → 旧 isActiveState 为 false → 不重置；facet 下同。
			expect(recovered?.state).toBe("interrupted");
			expect(recovered?.workspacePath).toBe("/tmp/keep");
			expect(recovered?.pid).toBe(999);
		});

		it("recoverStaleSession 反证：exited（进程已退仍等人审）仍判活跃 → 仍重置", () => {
			const manager = new TerminalSessionManager();
			manager.hydrateFromRecord({
				"task-1": createSummary({
					state: "awaiting_review",
					reviewReason: "hook",
					pid: null,
					exitCode: 0,
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
				}),
			});

			const recovered = manager.recoverStaleSession("task-1");

			expect(recovered?.state).toBe("idle");
		});

		function injectCodexEntry(
			manager: TerminalSessionManager,
			summaryOverrides: Partial<RuntimeTaskSessionSummary>,
		): { awaitingFlag: () => boolean; writeSpy: ReturnType<typeof vi.fn> } {
			const writeSpy = vi.fn();
			const entry = {
				summary: createSummary({ agentId: "codex", ...summaryOverrides }),
				active: {
					session: { write: writeSpy },
					awaitingCodexPromptAfterEnter: false,
				},
				listenerIdCounter: 1,
				listeners: new Map(),
			};
			(manager as unknown as { entries: Map<string, typeof entry> }).entries.set("task-1", entry);
			return { awaitingFlag: () => entry.active.awaitingCodexPromptAfterEnter, writeSpy };
		}

		it("writeInput：Codex 在 awaiting_review + reviewReason∈{hook,attention,error} 回车 → 置位等待标记", () => {
			for (const reviewReason of ["hook", "attention", "error"] as const) {
				const manager = new TerminalSessionManager();
				const { awaitingFlag, writeSpy } = injectCodexEntry(manager, { state: "awaiting_review", reviewReason });
				manager.writeInput("task-1", Buffer.from([13]));
				expect(awaitingFlag()).toBe(true);
				expect(writeSpy).toHaveBeenCalledTimes(1);
			}
		});

		it("writeInput：换行(LF)同样触发 Codex 等待标记", () => {
			const manager = new TerminalSessionManager();
			const { awaitingFlag } = injectCodexEntry(manager, { state: "awaiting_review", reviewReason: "attention" });
			manager.writeInput("task-1", Buffer.from([10]));
			expect(awaitingFlag()).toBe(true);
		});

		it("writeInput：reviewReason 不在白名单（exit）即便回车也不置位（保留 reviewReason 门控）", () => {
			const manager = new TerminalSessionManager();
			const { awaitingFlag } = injectCodexEntry(manager, { state: "awaiting_review", reviewReason: "exit" });
			manager.writeInput("task-1", Buffer.from([13]));
			expect(awaitingFlag()).toBe(false);
		});

		it("writeInput：非 awaiting_review（running）回车不置位", () => {
			const manager = new TerminalSessionManager();
			const { awaitingFlag } = injectCodexEntry(manager, { state: "running", reviewReason: null });
			manager.writeInput("task-1", Buffer.from([13]));
			expect(awaitingFlag()).toBe(false);
		});

		it("writeInput：非 Codex（claude）即便 awaiting_review+hook+回车也不置位（保留 agentId 门控）", () => {
			const manager = new TerminalSessionManager();
			const { awaitingFlag } = injectCodexEntry(manager, {
				agentId: "claude",
				state: "awaiting_review",
				reviewReason: "hook",
			});
			manager.writeInput("task-1", Buffer.from([13]));
			expect(awaitingFlag()).toBe(false);
		});

		it("writeInput：无回车字节不置位", () => {
			const manager = new TerminalSessionManager();
			const { awaitingFlag } = injectCodexEntry(manager, { state: "awaiting_review", reviewReason: "hook" });
			manager.writeInput("task-1", Buffer.from("hello"));
			expect(awaitingFlag()).toBe(false);
		});

		it("writeInput 反证：Codex exited（进程已退仍等人审）+hook+回车仍置位（exited 折叠为活跃）", () => {
			const manager = new TerminalSessionManager();
			const { awaitingFlag } = injectCodexEntry(manager, {
				state: "awaiting_review",
				reviewReason: "hook",
				pid: null,
				exitCode: 0,
				turnOwner: "user",
				liveness: "exited",
				userTurnKind: "review",
			});
			manager.writeInput("task-1", Buffer.from([13]));
			expect(awaitingFlag()).toBe(true);
		});
	});
});
