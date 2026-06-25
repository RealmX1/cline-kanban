import { describe, expect, it, vi } from "vitest";

import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { resolveSessionFacets } from "../../../src/core/session-activity";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

// 非 native dispatch park 的会话层行为（park / unpark / 空闲守卫 / facet 不变量 / resume 自动清标）。
// 直接构造 manager 并经私有 entries 注入一个最小会话条目（不 spawn 真 PTY，规避 AGENTS.md Node22 SDK-host 隐患）。

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

function makeEntry(summaryOverrides: Partial<RuntimeTaskSessionSummary> = {}) {
	return {
		summary: createSummary(summaryOverrides),
		active: {
			outputReactionEngine: null,
			outputReactionSession: null,
			taskChatInputDeliveryTimer: null as NodeJS.Timeout | null,
			taskChatInputDeliveryGeneration: 0,
			deferredStartupInput: null,
			lastUserInputAt: null,
			session: { write: vi.fn() },
		},
		terminalStateMirror: null,
		listenerIdCounter: 1,
		listeners: new Map(),
		restartRequest: null,
		suppressAutoRestartOnExit: false,
		autoRestartTimestamps: [] as number[],
		pendingAutoRestart: null,
		lastStallLoggedAt: null,
	};
}

type InjectableEntry = ReturnType<typeof makeEntry>;

function injectEntry(manager: TerminalSessionManager, entry: InjectableEntry, taskId = "task-1"): void {
	(manager as unknown as { entries: Map<string, InjectableEntry> }).entries.set(taskId, entry);
}

describe("TerminalSessionManager park（已派发后台工作）", () => {
	it("park：写 sidecar、保留 {agent,live,null} 三元组、设 suppressAutoRestartOnExit，且 summary 仍过 schema 校验", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		injectEntry(manager, entry);

		const result = manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1", { label: "child-x" });

		expect(result.ok).toBe(true);
		expect(entry.summary.awaitingDispatchedBackgroundWork).toEqual({
			sinceMs: expect.any(Number),
			label: "child-x",
		});
		expect(entry.suppressAutoRestartOnExit).toBe(true);
		// facet 不变量：park 是纯 metadata-only 写，三元组必须仍是普通 running 的 {agent,live,null}。
		expect(resolveSessionFacets(entry.summary)).toEqual({
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
		});
		// superRefine 共生 / 合法组合护栏在校验边界通过（与「仅 connectionRetry 写」同形、不写部分三元组）。
		expect(() => runtimeTaskSessionSummarySchema.parse(entry.summary)).not.toThrow();
	});

	it("park：非 agent 回合（awaiting_review）拒绝", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({
			state: "awaiting_review",
			reviewReason: "hook",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
		});
		injectEntry(manager, entry);

		const result = manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1");

		expect(result.ok).toBe(false);
		expect(entry.summary.awaitingDispatchedBackgroundWork ?? null).toBeNull();
	});

	it("park：无活跃会话拒绝；不存在的任务也拒绝", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		entry.active = null as unknown as InjectableEntry["active"];
		injectEntry(manager, entry);

		expect(manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1").ok).toBe(false);
		expect(manager.parkTaskSessionAwaitingDispatchedBackgroundWork("missing").ok).toBe(false);
	});

	it("park 幂等：重复 park 保留原 sinceMs、刷新 label", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		injectEntry(manager, entry);

		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1", { label: "first" });
		const firstSince = entry.summary.awaitingDispatchedBackgroundWork?.sinceMs;
		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1", { label: "second" });

		expect(entry.summary.awaitingDispatchedBackgroundWork?.sinceMs).toBe(firstSince);
		expect(entry.summary.awaitingDispatchedBackgroundWork?.label).toBe("second");
	});

	it("unpark：清 sidecar、复位 suppressAutoRestartOnExit；未 parked 时幂等 no-op", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		injectEntry(manager, entry);

		// 未 parked：no-op、不抛、suppress 不变。
		entry.suppressAutoRestartOnExit = false;
		expect(manager.unparkTaskSession("task-1")).not.toBeNull();
		expect(entry.summary.awaitingDispatchedBackgroundWork ?? null).toBeNull();

		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1", { label: "child-x" });
		expect(entry.suppressAutoRestartOnExit).toBe(true);

		manager.unparkTaskSession("task-1");
		expect(entry.summary.awaitingDispatchedBackgroundWork ?? null).toBeNull();
		expect(entry.suppressAutoRestartOnExit).toBe(false);
	});

	it("getAwaitingDispatchedBackgroundWork：反映 park 状态与元数据", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		injectEntry(manager, entry);

		expect(manager.getAwaitingDispatchedBackgroundWork("task-1")).toEqual({
			parked: false,
			label: null,
			sinceMs: null,
		});

		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1", { label: "child-x" });
		const state = manager.getAwaitingDispatchedBackgroundWork("task-1");
		expect(state.parked).toBe(true);
		expect(state.label).toBe("child-x");
		expect(typeof state.sinceMs).toBe("number");

		// 不存在的任务：未 parked。
		expect(manager.getAwaitingDispatchedBackgroundWork("missing").parked).toBe(false);
	});

	it("空闲守卫·isAgentTurnActive：parked 时返回 false，非 parked 的 agent 回合返回 true", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		injectEntry(manager, entry);

		const actions = (
			manager as unknown as {
				buildOutputReactionActions: (taskId: string) => { isAgentTurnActive: () => boolean };
			}
		).buildOutputReactionActions("task-1");

		expect(actions.isAgentTurnActive()).toBe(true);
		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1");
		expect(actions.isAgentTurnActive()).toBe(false);
		manager.unparkTaskSession("task-1");
		expect(actions.isAgentTurnActive()).toBe(true);
	});

	it("空闲守卫·shouldAutoRestart：parked 时返回 false（即便 suppress 已被消费、有监听者与 task restartRequest）", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		entry.listeners.set(1, {} as never);
		entry.restartRequest = { kind: "task", request: {} } as unknown as InjectableEntry["restartRequest"];
		injectEntry(manager, entry);

		const shouldAutoRestart = (
			manager as unknown as { shouldAutoRestart: (entry: InjectableEntry) => boolean }
		).shouldAutoRestart.bind(manager);

		// 控制组：非 parked、suppress=false、有监听者+task restartRequest → 会重启。
		entry.suppressAutoRestartOnExit = false;
		expect(shouldAutoRestart(entry)).toBe(true);

		// parked：即便把 suppress 显式置回 false（模拟其被提前消费），parked 守卫仍拦下重启。
		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1");
		entry.suppressAutoRestartOnExit = false;
		expect(shouldAutoRestart(entry)).toBe(false);
	});

	it("空闲守卫·scanForStalls：parked 会话被跳过，不报 [tui-freeze] stall-detected", () => {
		const manager = new TerminalSessionManager();
		// lastOutputAt 远早于现在 → 非 parked 会越过卡顿阈值并记日志；parked 应被跳过。
		const entry = makeEntry({ state: "running", lastOutputAt: 1, startedAt: 1 });
		injectEntry(manager, entry);
		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1");

		const scanForStalls = (manager as unknown as { scanForStalls: () => void }).scanForStalls.bind(manager);
		expect(() => scanForStalls()).not.toThrow();
		// parked 跳过分支会把 lastStallLoggedAt 复位为 null（与「非活跃回合」同路径）。
		expect(entry.lastStallLoggedAt).toBeNull();
	});

	it("resume 自动清标：submitTaskChatInputWhenReady（程序化 followup 投递）清掉 park", () => {
		const manager = new TerminalSessionManager();
		const entry = makeEntry({ state: "running" });
		injectEntry(manager, entry);
		manager.parkTaskSessionAwaitingDispatchedBackgroundWork("task-1", { label: "child-x" });
		expect(manager.getAwaitingDispatchedBackgroundWork("task-1").parked).toBe(true);

		manager.submitTaskChatInputWhenReady("task-1", "续：子任务已完成，请继续。");

		expect(manager.getAwaitingDispatchedBackgroundWork("task-1").parked).toBe(false);
		// 清掉投递调度的定时器，避免悬挂句柄在测试后触发。
		const timer = entry.active.taskChatInputDeliveryTimer;
		if (timer) {
			clearTimeout(timer);
		}
	});

	it("hydrateFromRecord：磁盘重载边界清掉 stale park sidecar（active 为 null 的重建会话按定义非 parked）", () => {
		const manager = new TerminalSessionManager();
		// 模拟 graceful shutdown 经 listSummaries() 落盘、带 stale park marker 的持久化 summary。
		const persisted = createSummary({
			state: "running",
			awaitingDispatchedBackgroundWork: { sinceMs: Date.now() - 10_000, label: "child-x" },
		});

		manager.hydrateFromRecord({ "task-1": persisted });

		// 重建条目不得带 stale marker，否则全新 agent run 的真实 Stop 会在 to_review 闸被误抑制、漏发通知。
		expect(manager.getAwaitingDispatchedBackgroundWork("task-1").parked).toBe(false);
		expect(manager.getSummary("task-1")?.awaitingDispatchedBackgroundWork ?? null).toBeNull();
		// 入参不应被原地改动（clone 边界）。
		expect(persisted.awaitingDispatchedBackgroundWork).not.toBeNull();
	});
});
