import { describe, expect, it } from "vitest";

import {
	deriveAwaitingUserTaskCount,
	deriveLiveAgentTaskCount,
} from "@/components/top-bar-project-switcher/project-switcher-session-activity-counts";
import type { RuntimeInProgressTaskDetail, RuntimeProjectSummary } from "@/runtime/types";

function createInProgressTaskDetail(
	taskId: string,
	turnOwner: RuntimeInProgressTaskDetail["turnOwner"],
	liveness: RuntimeInProgressTaskDetail["liveness"],
): RuntimeInProgressTaskDetail {
	return {
		taskId,
		title: taskId,
		agentId: "claude",
		createdAt: 1_000,
		lastOutputAt: 2_000,
		lastSubstantiveOutputAt: 2_000,
		turnOwner,
		liveness,
	};
}

function createProject(overrides: Partial<RuntimeProjectSummary> = {}): RuntimeProjectSummary {
	return {
		id: "project-a",
		name: "alpha",
		path: "/repos/alpha",
		taskCounts: { backlog: 3, in_progress: 2, review: 4, validation: 1, trash: 0 },
		availability: { status: "available" },
		inProgressTaskDetails: [],
		...overrides,
	};
}

describe("deriveLiveAgentTaskCount", () => {
	it("counts only the tasks whose turn the agent currently holds", () => {
		const project = createProject({
			inProgressTaskDetails: [
				createInProgressTaskDetail("task-1", "agent", "live"),
				createInProgressTaskDetail("task-2", "agent", "starting"),
				createInProgressTaskDetail("task-3", "user", "live"),
				createInProgressTaskDetail("task-4", null, "exited"),
			],
		});
		expect(deriveLiveAgentTaskCount(project)).toBe(2);
	});

	it("reports zero for a project this runtime has never connected to", () => {
		expect(deriveLiveAgentTaskCount(createProject({ inProgressTaskDetails: [] }))).toBe(0);
	});
});

describe("deriveAwaitingUserTaskCount", () => {
	it("reads the overlay-applied review column count", () => {
		expect(deriveAwaitingUserTaskCount(createProject())).toBe(4);
	});
});
