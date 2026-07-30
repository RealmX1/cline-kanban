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
	});
});
