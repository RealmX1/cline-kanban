// 用假时钟钉住 CLI 硬超时的计时精度：集成测试里的墙钟等待已改为两档（负载下只告警），
// 「恰好在 KANBAN_CLI_HARD_TIMEOUT_MS 触发、以 124 退出」这条产品契约由这里确定性守护。
//
// 整个文件只有这一个用例会触发 fatal：cli-process-guards 的 handlingFatalError 是模块级一次性标志，
// 拆成多个用例就会依赖执行顺序，所以 cancel / 1499ms / 1500ms 三步写在同一个用例里。
import { expect, it, vi } from "vitest";

import { installCliHardTimeoutIfNeeded, registerCliProcessExit } from "../../../src/core/cli-process-guards";

class CliProcessExitCalledByHardTimeoutSentinel extends Error {
	constructor(readonly requestedExitCode: number) {
		super(`CLI process exit requested with code ${requestedExitCode}`);
	}
}

it("CLI 硬超时：cancel 后不触发；1499ms 时不触发；恰好 1500ms 时打印超时文案并以 exit 124 退出", () => {
	vi.useFakeTimers();
	vi.stubEnv("KANBAN_CLI_HARD_TIMEOUT_MS", "1500");
	const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	registerCliProcessExit((requestedExitCode) => {
		throw new CliProcessExitCalledByHardTimeoutSentinel(requestedExitCode);
	});
	try {
		const cancelFirstHardTimeout = installCliHardTimeoutIfNeeded(["task", "list"], false);
		cancelFirstHardTimeout();
		vi.advanceTimersByTime(10_000);
		expect(stderrWriteSpy).not.toHaveBeenCalled();

		installCliHardTimeoutIfNeeded(["task", "list"], false);
		vi.advanceTimersByTime(1_499);
		expect(stderrWriteSpy).not.toHaveBeenCalled();

		let exitRequestedByHardTimeout: unknown;
		try {
			vi.advanceTimersByTime(1);
		} catch (timerCallbackFailure) {
			exitRequestedByHardTimeout = timerCallbackFailure;
		}
		expect(exitRequestedByHardTimeout).toBeInstanceOf(CliProcessExitCalledByHardTimeoutSentinel);
		expect((exitRequestedByHardTimeout as CliProcessExitCalledByHardTimeoutSentinel).requestedExitCode).toBe(124);
		expect(stderrWriteSpy).toHaveBeenCalledWith("kanban: fatal: command timed out after 1500ms\n");
	} finally {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		stderrWriteSpy.mockRestore();
	}
});
