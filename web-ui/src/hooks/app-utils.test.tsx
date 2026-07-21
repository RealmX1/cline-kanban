import { describe, expect, it } from "vitest";

import {
	buildDetailTaskUrl,
	buildProjectTaskDeepLinkUrl,
	parseDetailTaskIdFromSearch,
	parseProjectIdFromPathname,
} from "@/hooks/app-utils";

describe("parseDetailTaskIdFromSearch", () => {
	it("returns the selected task id when present", () => {
		expect(parseDetailTaskIdFromSearch("?task=task-123")).toBe("task-123");
	});

	it("returns null when the task id is missing or blank", () => {
		expect(parseDetailTaskIdFromSearch("")).toBeNull();
		expect(parseDetailTaskIdFromSearch("?task=")).toBeNull();
		expect(parseDetailTaskIdFromSearch("?task=%20%20")).toBeNull();
	});
});

describe("buildDetailTaskUrl", () => {
	it("adds the task id while preserving other query params and hash", () => {
		expect(
			buildDetailTaskUrl({
				pathname: "/project-1",
				search: "?view=board",
				hash: "#panel",
				taskId: "task-123",
			}),
		).toBe("/project-1?view=board&task=task-123#panel");
	});

	it("removes the task id while preserving other query params", () => {
		expect(
			buildDetailTaskUrl({
				pathname: "/project-1",
				search: "?view=board&task=task-123",
				hash: "",
				taskId: null,
			}),
		).toBe("/project-1?view=board");
	});
});

describe("buildProjectTaskDeepLinkUrl", () => {
	it("builds /<project>?task=<taskId> for plain identifiers", () => {
		expect(buildProjectTaskDeepLinkUrl("project-1", "task-123")).toBe("/project-1?task=task-123");
	});

	it("percent-encodes the project id and task id where needed", () => {
		expect(buildProjectTaskDeepLinkUrl("my project/α", "task with space")).toBe(
			"/my%20project%2F%CE%B1?task=task+with+space",
		);
	});

	it("round-trips through the cold-start URL parsers (parseProjectIdFromPathname + parseDetailTaskIdFromSearch)", () => {
		const projectId = "my project/α";
		const taskId = "task-123";
		const deepLinkUrl = buildProjectTaskDeepLinkUrl(projectId, taskId);
		const parsedUrl = new URL(deepLinkUrl, "http://localhost");
		expect(parseProjectIdFromPathname(parsedUrl.pathname)).toBe(projectId);
		expect(parseDetailTaskIdFromSearch(parsedUrl.search)).toBe(taskId);
	});
});
