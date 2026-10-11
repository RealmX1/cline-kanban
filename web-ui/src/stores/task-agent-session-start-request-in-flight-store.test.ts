import { describe, expect, it } from "vitest";

import {
	beginTaskAgentSessionStartRequestInFlight,
	getTaskAgentSessionStartRequestInFlightPhase,
} from "@/stores/task-agent-session-start-request-in-flight-store";

describe("task-agent-session-start-request-in-flight-store", () => {
	it("walks a start request through its phases and clears it when it finishes", () => {
		const startRequest = beginTaskAgentSessionStartRequestInFlight("workspace-phases", "task-1");
		expect(getTaskAgentSessionStartRequestInFlightPhase("workspace-phases", "task-1")).toBe(
			"preparing_task_worktree",
		);

		startRequest.advanceToPhase("launching_agent_session");
		expect(getTaskAgentSessionStartRequestInFlightPhase("workspace-phases", "task-1")).toBe(
			"launching_agent_session",
		);

		startRequest.finish();
		expect(getTaskAgentSessionStartRequestInFlightPhase("workspace-phases", "task-1")).toBeNull();
	});

	it("keys by workspace so the same short task id in another workspace is not marked", () => {
		const startRequest = beginTaskAgentSessionStartRequestInFlight("workspace-a", "task-1");

		expect(getTaskAgentSessionStartRequestInFlightPhase("workspace-b", "task-1")).toBeNull();

		startRequest.finish();
	});

	it("does not let a superseded start request clear or advance the newer one", () => {
		// 连续启动两次：前一次的 finally 若能清掉标记，面板会在后一次完成前重新露出「已死」提示。
		const supersededStartRequest = beginTaskAgentSessionStartRequestInFlight("workspace-superseded", "task-1");
		const currentStartRequest = beginTaskAgentSessionStartRequestInFlight("workspace-superseded", "task-1");

		supersededStartRequest.advanceToPhase("launching_agent_session");
		supersededStartRequest.finish();
		expect(getTaskAgentSessionStartRequestInFlightPhase("workspace-superseded", "task-1")).toBe(
			"preparing_task_worktree",
		);

		currentStartRequest.finish();
		expect(getTaskAgentSessionStartRequestInFlightPhase("workspace-superseded", "task-1")).toBeNull();
	});
});
