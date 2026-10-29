import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeAgentSessionCountsAffectedByRuntimeExit } from "../../src/core/api-contract";
import {
	type GracefulShutdownProcess,
	getExitCodeForSignal,
	installGracefulShutdownHandlers,
	shouldSuppressImmediateDuplicateShutdownSignals,
} from "../../src/core/graceful-shutdown";
import {
	canAcceptPlannedHandoverRestartSignalWithoutInterruptingAgentSessions,
	KANBAN_RUNTIME_PLANNED_HANDOVER_RESTART_EXIT_CODE,
	resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger,
	resolveRuntimeShutdownDeadlineMilliseconds,
} from "../../src/core/runtime-shutdown-trigger";

function createDeferredPromise() {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: resolvePromise,
	};
}

type ListenedProcessSignalForTest = Parameters<GracefulShutdownProcess["on"]>[0];

function createProcessDouble(): GracefulShutdownProcess & {
	emitSignal: (signal: ListenedProcessSignalForTest) => void;
	listenerCount: (signal: ListenedProcessSignalForTest) => number;
} {
	const emitter = new EventEmitter();
	const processDouble: GracefulShutdownProcess & {
		emitSignal: (signal: ListenedProcessSignalForTest) => void;
		listenerCount: (signal: ListenedProcessSignalForTest) => number;
	} = {
		on(signal, listener) {
			emitter.on(signal, listener);
			return processDouble;
		},
		off(signal, listener) {
			emitter.off(signal, listener);
			return processDouble;
		},
		emitSignal(signal) {
			emitter.emit(signal);
		},
		listenerCount(signal) {
			return emitter.listenerCount(signal);
		},
	};
	return processDouble;
}

describe("installGracefulShutdownHandlers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("suppresses an immediate duplicate SIGINT while shutdown is already in progress", async () => {
		vi.useFakeTimers();

		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onSecondSignal = vi.fn();
		const deferred = createDeferredPromise();

		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onSecondSignal,
			onShutdown: async () => {
				await deferred.promise;
			},
			suppressImmediateDuplicateSignals: true,
		});

		processDouble.emitSignal("SIGINT");
		vi.advanceTimersByTime(100);
		processDouble.emitSignal("SIGINT");

		expect(onSecondSignal).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();

		deferred.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("calls reraiseSignal instead of exit when provided and shutdown was signal-triggered", async () => {
		vi.useFakeTimers();

		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const reraiseSignal = vi.fn();
		const deferred = createDeferredPromise();

		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			reraiseSignal,
			onShutdown: async () => {
				await deferred.promise;
			},
		});

		processDouble.emitSignal("SIGINT");

		deferred.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(reraiseSignal).toHaveBeenCalledTimes(1);
		expect(reraiseSignal).toHaveBeenCalledWith("SIGINT");
		expect(exit).not.toHaveBeenCalled();
	});

	it("still force-exits on a later second Ctrl+C", () => {
		vi.useFakeTimers();

		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onSecondSignal = vi.fn();
		const deferred = createDeferredPromise();

		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onSecondSignal,
			onShutdown: async () => {
				await deferred.promise;
			},
			suppressImmediateDuplicateSignals: true,
		});

		processDouble.emitSignal("SIGINT");
		vi.advanceTimersByTime(1_000);
		processDouble.emitSignal("SIGINT");

		expect(onSecondSignal).toHaveBeenCalledTimes(1);
		expect(onSecondSignal).toHaveBeenCalledWith("SIGINT");
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(130);

		deferred.resolve();
	});
});

describe("shouldSuppressImmediateDuplicateShutdownSignals", () => {
	it("enables duplicate suppression for npm-style wrapper launches", () => {
		expect(
			shouldSuppressImmediateDuplicateShutdownSignals({
				argv: ["/usr/local/bin/node", "/repo/node_modules/kanban/dist/cli.js"],
				env: {
					npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
				},
			}),
		).toBe(true);
	});

	it("enables duplicate suppression for transient npx cache entrypoints", () => {
		expect(
			shouldSuppressImmediateDuplicateShutdownSignals({
				argv: ["/usr/local/bin/node", "/Users/example/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
				env: {},
			}),
		).toBe(true);
	});

	it("leaves normal direct launches unchanged", () => {
		expect(
			shouldSuppressImmediateDuplicateShutdownSignals({
				argv: ["/usr/local/bin/node", "/repo/dist/cli.js"],
				env: {},
			}),
		).toBe(false);
	});
});

describe("installGracefulShutdownHandlers runtime shutdown triggers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	async function flushShutdownPromise(): Promise<void> {
		for (let microtaskTurn = 0; microtaskTurn < 4; microtaskTurn += 1) {
			await Promise.resolve();
		}
	}

	it.each([
		{ blockingReason: "host mode 已关闭", hostModeEnabled: false, runtimeOwnedPtyCount: 0, conversationCount: 0 },
		{
			blockingReason: "有降级的 runtime-owned PTY",
			hostModeEnabled: true,
			runtimeOwnedPtyCount: 1,
			conversationCount: 0,
		},
		{
			blockingReason: "有 ACP 等 runtime-owned 会话",
			hostModeEnabled: true,
			runtimeOwnedPtyCount: 0,
			conversationCount: 1,
		},
	])("SIGUSR2 活动会话保护：$blockingReason 时忽略，实时阻塞解除后可再次触发 handover", async (testCase) => {
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onShutdown = vi.fn(async () => {});
		const onPlannedHandoverRestartSignalIgnored = vi.fn();
		let agentSessionPtyHostModeEnabled = true;
		const counts: RuntimeAgentSessionCountsAffectedByRuntimeExit = {
			agentSessionsHostedByAgentSessionPtyHost: 2,
			agentSessionsWithPtyOwnedByRuntimeProcess: 0,
			conversationAgentSessionsRunningInsideRuntimeProcess: 0,
			inFlightExplorationThreadGraphMaintenanceJobs: 3,
		};
		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			onShutdown,
			onPlannedHandoverRestartSignalIgnored,
			acceptPlannedHandoverRestartSignal: () =>
				canAcceptPlannedHandoverRestartSignalWithoutInterruptingAgentSessions({
					agentSessionPtyHostModeEnabled,
					agentSessionCountsAffectedByRuntimeExit: counts,
				}),
		});
		// handler 安装后才改变活体计数：门禁必须在每一次信号到达时读取，不能缓存启动时的安全结论。
		agentSessionPtyHostModeEnabled = testCase.hostModeEnabled;
		counts.agentSessionsWithPtyOwnedByRuntimeProcess = testCase.runtimeOwnedPtyCount;
		counts.conversationAgentSessionsRunningInsideRuntimeProcess = testCase.conversationCount;
		processDouble.emitSignal("SIGUSR2");
		await flushShutdownPromise();

		expect(onPlannedHandoverRestartSignalIgnored).toHaveBeenCalledOnce();
		expect(onShutdown).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();

		// hosted 活体和可中止的 exploration 作业不阻断 handover；被忽略的信号也不应留下“已经在退出”的闩。
		agentSessionPtyHostModeEnabled = true;
		counts.agentSessionsWithPtyOwnedByRuntimeProcess = 0;
		counts.conversationAgentSessionsRunningInsideRuntimeProcess = 0;
		processDouble.emitSignal("SIGUSR2");
		await flushShutdownPromise();
		expect(onShutdown).toHaveBeenCalledExactlyOnceWith({
			kind: "planned_handover_restart_preserving_hosted_agent_sessions",
			requestedVia: "process_signal_sigusr2",
		});
		expect(exit).toHaveBeenCalledExactlyOnceWith(KANBAN_RUNTIME_PLANNED_HANDOVER_RESTART_EXIT_CODE);
	});

	it("starts a planned handover on SIGUSR2 when accepted, hands the trigger to onShutdown and exits 75 without re-raising", async () => {
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const reraiseSignal = vi.fn();
		const onShutdown = vi.fn(async () => {});

		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			reraiseSignal,
			onShutdown,
			acceptPlannedHandoverRestartSignal: () => true,
		});
		processDouble.emitSignal("SIGUSR2");
		await flushShutdownPromise();

		expect(onShutdown).toHaveBeenCalledWith({
			kind: "planned_handover_restart_preserving_hosted_agent_sessions",
			requestedVia: "process_signal_sigusr2",
		});
		expect(exit).toHaveBeenCalledWith(KANBAN_RUNTIME_PLANNED_HANDOVER_RESTART_EXIT_CODE);
		expect(reraiseSignal).not.toHaveBeenCalled();
	});

	it("ignores SIGUSR2 when the caller refuses it, and does not listen at all without an acceptance predicate", async () => {
		const processDouble = createProcessDouble();
		const onShutdown = vi.fn(async () => {});
		const onPlannedHandoverRestartSignalIgnored = vi.fn();

		installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit: vi.fn(),
			onShutdown,
			acceptPlannedHandoverRestartSignal: () => false,
			onPlannedHandoverRestartSignalIgnored,
		});
		processDouble.emitSignal("SIGUSR2");
		await flushShutdownPromise();

		expect(onShutdown).not.toHaveBeenCalled();
		expect(onPlannedHandoverRestartSignalIgnored).toHaveBeenCalledTimes(1);

		const processDoubleWithoutHandover = createProcessDouble();
		installGracefulShutdownHandlers({
			process: processDoubleWithoutHandover,
			delayMs: 10_000,
			exit: vi.fn(),
			onShutdown,
		});
		expect(processDoubleWithoutHandover.listenerCount("SIGUSR2")).toBe(0);
	});

	it("re-raises SIGTERM after an explicit stop requested over the API so supervisors stop restarting", async () => {
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const reraiseSignal = vi.fn();

		const { requestShutdown } = installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			exit,
			reraiseSignal,
			onShutdown: async () => {},
		});
		expect(
			requestShutdown({
				kind: "explicit_stop_terminating_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			}),
		).toBe("shutdown_started");
		expect(
			requestShutdown({
				kind: "planned_handover_restart_preserving_hosted_agent_sessions",
				requestedVia: "runtime_trpc_procedure",
			}),
		).toBe("shutdown_already_in_progress");
		await flushShutdownPromise();

		expect(reraiseSignal).toHaveBeenCalledWith("SIGTERM");
		expect(exit).not.toHaveBeenCalled();
	});

	it("gives a planned handover its own deadline and exits 1 when it is exceeded", () => {
		vi.useFakeTimers();
		const processDouble = createProcessDouble();
		const exit = vi.fn();
		const onTimeout = vi.fn();
		const deferred = createDeferredPromise();

		const { requestShutdown } = installGracefulShutdownHandlers({
			process: processDouble,
			delayMs: 10_000,
			resolveShutdownDeadlineMs: resolveRuntimeShutdownDeadlineMilliseconds,
			exit,
			onTimeout,
			onShutdown: async () => {
				await deferred.promise;
			},
		});
		requestShutdown({
			kind: "planned_handover_restart_preserving_hosted_agent_sessions",
			requestedVia: "runtime_trpc_procedure",
		});
		vi.advanceTimersByTime(10_000);
		expect(exit).not.toHaveBeenCalled();
		vi.advanceTimersByTime(20_000);

		expect(onTimeout).toHaveBeenCalledWith(30_000);
		expect(exit).toHaveBeenCalledWith(1);
		deferred.resolve();
	});
});

describe("resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger", () => {
	it("keeps hosted agent sessions on every signal unless the environment asks for the old terminate semantics", () => {
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			expect(
				resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger(
					{ kind: "process_signal", signal },
					undefined,
				),
			).toBe("detach_hosted_agent_sessions_for_successor_runtime");
		}
		expect(
			resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger(
				{ kind: "process_signal", signal: "SIGTERM" },
				" Terminate ",
			),
		).toBe("terminate_hosted_agent_sessions");
		// 覆写只管信号：handover 永远保活，显式全停永远终止。
		expect(
			resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger(
				{
					kind: "planned_handover_restart_preserving_hosted_agent_sessions",
					requestedVia: "process_signal_sigusr2",
				},
				"terminate",
			),
		).toBe("detach_hosted_agent_sessions_for_successor_runtime");
		expect(
			resolveHostedAgentSessionDispositionForRuntimeShutdownTrigger(
				{ kind: "explicit_stop_terminating_hosted_agent_sessions", requestedVia: "runtime_trpc_procedure" },
				undefined,
			),
		).toBe("terminate_hosted_agent_sessions");
	});
});

describe("getExitCodeForSignal", () => {
	it("maps handled shutdown signals to shell-standard exit codes", () => {
		expect(getExitCodeForSignal("SIGHUP")).toBe(129);
		expect(getExitCodeForSignal("SIGINT")).toBe(130);
		expect(getExitCodeForSignal("SIGTERM")).toBe(143);
	});
});
