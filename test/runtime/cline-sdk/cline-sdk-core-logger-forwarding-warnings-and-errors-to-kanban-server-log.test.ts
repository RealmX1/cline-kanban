import { afterEach, describe, expect, it, vi } from "vitest";

import { createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog } from "../../../src/cline-sdk/cline-sdk-core-logger-forwarding-warnings-and-errors-to-kanban-server-log";

function captureStderrWrites() {
	const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	return {
		lines: () => stderrWrite.mock.calls.map((call) => String(call[0])),
	};
}

describe("createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("把 severity=warn 的 log（SDK 的后端回退提示）写成一行 [warn] 服务器日志，且不重复打印 severity", () => {
		const stderr = captureStderrWrites();
		const logger = createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog();

		logger.log("Falling back to local runtime host", { reason: "compatible_hub_unavailable", severity: "warn" });

		expect(stderr.lines()).toEqual([
			'[warn] [cline-sdk-core] Falling back to local runtime host {"reason":"compatible_hub_unavailable"}\n',
		]);
	});

	it("丢弃 debug 与不带 warn/error severity 的普通 log", () => {
		const stderr = captureStderrWrites();
		const logger = createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog();

		logger.debug("telemetry.metric", { name: "x" });
		logger.log("Using hub runtime host", { url: "ws://127.0.0.1:1" });
		logger.log("telemetry.event", { severity: "info" });

		expect(stderr.lines()).toEqual([]);
	});

	it("error() 写 [error] 行，Error 序列化为 name/message，并补打 stack", () => {
		const stderr = captureStderrWrites();
		const logger = createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog();
		const cause = new Error("boom");

		logger.error?.("cron.event.failed", { eventId: "e1", error: cause });

		const lines = stderr.lines();
		expect(lines[0]).toBe(
			'[error] [cline-sdk-core] cron.event.failed {"eventId":"e1","error":{"name":"Error","message":"boom"}}\n',
		);
		expect(lines[1]).toBe(`${cause.stack}\n`);
		expect(lines).toHaveLength(2);
	});

	it("severity=error 的 log 按 [error] 输出", () => {
		const stderr = captureStderrWrites();
		const logger = createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog();

		logger.log("hub command failed", { severity: "error" });

		expect(stderr.lines()).toEqual(["[error] [cline-sdk-core] hub command failed\n"]);
	});

	it("元数据无法序列化（循环引用）时不抛出，退回占位文本", () => {
		const stderr = captureStderrWrites();
		const logger = createClineSdkCoreLoggerForwardingWarningsAndErrorsToKanbanServerLog();
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => logger.log("Falling back to local runtime host", { severity: "warn", circular })).not.toThrow();
		expect(stderr.lines()).toEqual([
			"[warn] [cline-sdk-core] Falling back to local runtime host [unserializable metadata]\n",
		]);
	});
});
