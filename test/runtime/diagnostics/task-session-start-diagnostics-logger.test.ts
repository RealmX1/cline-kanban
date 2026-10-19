import { describe, expect, it } from "vitest";

import { formatTaskSessionStartDiagnosticLine } from "../../../src/diagnostics/task-session-start-diagnostics-logger";

describe("task-session-start diagnostics logger", () => {
	it("formats the launch phase, elapsed time, error, and observed live session on one searchable line", () => {
		const line = formatTaskSessionStartDiagnosticLine(
			{
				event: "failed",
				workspaceId: "my-ai-setup",
				taskId: "w0n47",
				requestedAgentId: "claude",
				effectiveAgentId: "claude",
				phase: "capture_initial_turn_checkpoint",
				elapsedMs: 217_871,
				error: "response transport closed",
				session: {
					state: "running",
					turnOwner: "agent",
					liveness: "live",
					pid: 79_712,
					startedAt: 1785361949203,
					updatedAt: 1785362167074,
				},
			},
			"2026-07-30T05:56:07.074Z",
		);

		expect(line).toContain("event=failed");
		expect(line).toContain("taskId=w0n47");
		expect(line).toContain("phase=capture_initial_turn_checkpoint");
		expect(line).toContain("elapsedMs=217871");
		expect(line).toContain('"liveness":"live"');
		expect(line).toContain('error="response transport closed"');
		expect(line).toContain("requestedTerminalColumns=null");
		expect(line).toContain("requestedTerminalRows=null");
	});

	it("记录浏览器请求的终端列数和行数，便于定位手机后台启动尺寸", () => {
		const line = formatTaskSessionStartDiagnosticLine(
			{
				event: "runtime_started",
				workspaceId: "mobile-startup-project",
				taskId: "mobile-startup-task",
				requestedAgentId: "codex",
				effectiveAgentId: "codex",
				requestedTerminalColumns: 43,
				requestedTerminalRows: 50,
				phase: "start_pty_terminal_runtime_session",
				elapsedMs: 80,
				error: null,
				session: null,
			},
			"2026-10-19T10:00:00.000Z",
		);
		expect(line).toContain("requestedTerminalColumns=43");
		expect(line).toContain("requestedTerminalRows=50");
	});
});
