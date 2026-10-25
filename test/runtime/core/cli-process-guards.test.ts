import { describe, expect, it, vi } from "vitest";

import {
	CLI_TASK_GROUP_WATCH_INTERRUPTED_SHUTDOWN_TIMEOUT_MS,
	installCliHardTimeoutIfNeeded,
	installCliTaskGroupWatchInterruptionGuard,
	registerCliFatalErrorReporter,
	registerCliProcessExit,
	resolveCliHardTimeoutMs,
	resolveCliTrpcTimeoutMs,
	safeErrorMessage,
	safeStringify,
} from "../../../src/core/cli-process-guards";

describe("cli-process-guards", () => {
	describe("watch 中断退出兜底", () => {
		it.each(["SIGINT", "SIGTERM"] as const)("%s 覆盖最终排空，第二次信号不重置退出期限或退出码", (signalName) => {
			vi.useFakeTimers();
			const previousExitCode = process.exitCode;
			const previousSigintListeners = process.listeners("SIGINT");
			const previousSigtermListeners = process.listeners("SIGTERM");
			const exit = vi.fn((exitCode: number): never => {
				throw new Error(`测试信号退出 ${exitCode}`);
			});
			registerCliProcessExit(exit);
			const guard = installCliTaskGroupWatchInterruptionGuard(["tasks", "watch", "--all-projects"]);
			try {
				const onSigint = process
					.listeners("SIGINT")
					.find((listener) => !previousSigintListeners.includes(listener));
				const onSigterm = process
					.listeners("SIGTERM")
					.find((listener) => !previousSigtermListeners.includes(listener));
				expect(onSigint).toBeDefined();
				expect(onSigterm).toBeDefined();
				if (signalName === "SIGINT") onSigint?.("SIGINT");
				else onSigterm?.("SIGTERM");
				const expectedExitCode = signalName === "SIGTERM" ? 143 : 130;
				expect(guard?.signal.reason).toBe(signalName);
				expect(process.exitCode).toBe(expectedExitCode);
				vi.advanceTimersByTime(CLI_TASK_GROUP_WATCH_INTERRUPTED_SHUTDOWN_TIMEOUT_MS - 1);
				if (signalName === "SIGINT") onSigterm?.("SIGTERM");
				else onSigint?.("SIGINT");
				expect(exit).not.toHaveBeenCalled();
				expect(guard?.signal.reason).toBe(signalName);
				expect(() => vi.advanceTimersByTime(1)).toThrow(`测试信号退出 ${expectedExitCode}`);
				expect(exit).toHaveBeenCalledExactlyOnceWith(expectedExitCode);
			} finally {
				guard?.dispose();
				process.exitCode = previousExitCode;
				vi.useRealTimers();
			}
			expect(process.listeners("SIGINT")).toEqual(previousSigintListeners);
			expect(process.listeners("SIGTERM")).toEqual(previousSigtermListeners);
		});

		it("普通 list 不安装信号处理器，watch 正常释放后不留下退出计时器", () => {
			vi.useFakeTimers();
			const previousSigintListeners = process.listeners("SIGINT");
			try {
				expect(installCliTaskGroupWatchInterruptionGuard(["task", "list"])).toBeUndefined();
				expect(process.listeners("SIGINT")).toEqual(previousSigintListeners);
				const guard = installCliTaskGroupWatchInterruptionGuard(["task", "watch"]);
				guard?.dispose();
				expect(process.listeners("SIGINT")).toEqual(previousSigintListeners);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("timeout defaults", () => {
		it("keeps hard timeout above tRPC timeout with shutdown margin", () => {
			const previousHard = process.env.KANBAN_CLI_HARD_TIMEOUT_MS;
			const previousTrpc = process.env.KANBAN_CLI_TRPC_TIMEOUT_MS;
			delete process.env.KANBAN_CLI_HARD_TIMEOUT_MS;
			delete process.env.KANBAN_CLI_TRPC_TIMEOUT_MS;
			try {
				expect(resolveCliHardTimeoutMs()).toBeGreaterThan(28_000 + 500);
				expect(resolveCliHardTimeoutMs(["support", "triage-incoming-work-item"])).toBe(240_000);
				expect(resolveCliTrpcTimeoutMs(["support", "triage-incoming-work-item"])).toBe(210_000);
				expect(resolveCliHardTimeoutMs(["support", "get-task-indexing-context"])).toBe(35_000);
				expect(resolveCliTrpcTimeoutMs(["task", "list"])).toBe(28_000);
			} finally {
				if (previousHard === undefined) {
					delete process.env.KANBAN_CLI_HARD_TIMEOUT_MS;
				} else {
					process.env.KANBAN_CLI_HARD_TIMEOUT_MS = previousHard;
				}
				if (previousTrpc === undefined) {
					delete process.env.KANBAN_CLI_TRPC_TIMEOUT_MS;
				} else {
					process.env.KANBAN_CLI_TRPC_TIMEOUT_MS = previousTrpc;
				}
			}
		});
	});

	describe("installCliHardTimeoutIfNeeded", () => {
		it("仅豁免 task watch 和 tasks watch，普通 list 继续安装硬超时", () => {
			const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
			try {
				installCliHardTimeoutIfNeeded(["task", "watch", "--all-projects"], false)();
				installCliHardTimeoutIfNeeded(["tasks", "watch", "--all-projects"], false)();
				expect(setTimeoutSpy).not.toHaveBeenCalled();
				installCliHardTimeoutIfNeeded(["task", "list", "--query", "watch"], false)();
				expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
			} finally {
				setTimeoutSpy.mockRestore();
			}
		});
		it("returns a no-op cancel function for server-style invocations", () => {
			const cancel = installCliHardTimeoutIfNeeded([], true);
			expect(() => {
				cancel();
			}).not.toThrow();
		});
	});

	describe("registerCliFatalErrorReporter", () => {
		it("accepts a reporter without throwing", () => {
			expect(() => {
				registerCliFatalErrorReporter(() => {});
			}).not.toThrow();
		});
	});

	describe("safeErrorMessage", () => {
		it("returns message without reading stack", () => {
			const error = new Error("boom");
			error.stack = "should not be read";
			expect(safeErrorMessage(error)).toBe("boom");
		});

		it("stringifies non-error values", () => {
			expect(safeErrorMessage("plain")).toBe("plain");
			expect(safeErrorMessage(42)).toBe("42");
		});
	});

	describe("safeStringify", () => {
		it("保留非循环的共享数组与对象，输出遵循原生 JSON 字段类型", () => {
			const sharedObservation = { observedAtMs: 123, evidence: ["native_record"] };
			const sharedTask = { taskConversationSessionActivityObservations: [sharedObservation] };
			const payload = { pinned: sharedTask, running: sharedTask, latestObservation: sharedObservation };
			expect(safeStringify(payload, 2)).toBe(JSON.stringify(payload, null, 2));
		});

		it("serializes circular structures", () => {
			const payload: Record<string, unknown> = { ok: true };
			payload.self = payload;
			expect(safeStringify(payload, 2)).toContain("[Circular]");
		});

		it("仅替换当前祖先链上的循环回指，同一循环对象可出现在多个兄弟字段", () => {
			const sharedTask: Record<string, unknown> = { taskId: "pinned-running" };
			sharedTask.self = sharedTask;
			expect(JSON.parse(safeStringify({ pinned: sharedTask, running: sharedTask }))).toEqual({
				pinned: { taskId: "pinned-running", self: "[Circular]" },
				running: { taskId: "pinned-running", self: "[Circular]" },
			});
		});

		it("returns a fallback object when serialization fails", () => {
			const payload = {
				toJSON() {
					throw new Error("nope");
				},
			};
			expect(safeStringify(payload)).toBe(JSON.stringify({ ok: false, error: "serialization failed" }));
		});
	});
});
