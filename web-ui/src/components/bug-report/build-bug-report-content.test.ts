import { describe, expect, it } from "vitest";
import {
	type BugReportDiagnosticContext,
	buildBugReportBody,
	buildGitHubIssueUrl,
	deriveBugReportTitle,
} from "./build-bug-report-content";

const diagnostics: BugReportDiagnosticContext = {
	appVersion: "1.2.3",
	currentProjectName: "cline-kanban",
	currentProjectPath: "/repos/cline-kanban",
	activeView: "board",
	platform: "MacIntel",
	userAgent: "TestAgent/1.0",
	viewport: "1440×900",
	capturedAtIso: "2026-07-01T00:00:00.000Z",
};

describe("deriveBugReportTitle", () => {
	it("prefers an explicit title, else derives from the first description line", () => {
		expect(deriveBugReportTitle("  Explicit  ", "ignored")).toBe("Explicit");
		expect(deriveBugReportTitle("", "First line\nsecond")).toBe("First line");
		expect(deriveBugReportTitle("", "")).toBe("Bug report");
	});
});

describe("buildBugReportBody", () => {
	it("includes the description and the auto-collected environment section", () => {
		const body = buildBugReportBody({
			title: "t",
			description: "It broke",
			diagnostics,
			hasScreenshot: false,
			forGitHubIssue: false,
		});
		expect(body).toContain("## Bug 描述");
		expect(body).toContain("It broke");
		expect(body).toContain("App 版本: 1.2.3");
		expect(body).toContain("cline-kanban");
	});

	it("tells GitHub-issue readers to paste the screenshot manually", () => {
		const body = buildBugReportBody({
			title: "t",
			description: "d",
			diagnostics,
			hasScreenshot: true,
			forGitHubIssue: true,
		});
		expect(body).toContain("手动");
	});
});

describe("buildGitHubIssueUrl", () => {
	it("encodes title and body into a /new query", () => {
		const url = buildGitHubIssueUrl("https://github.com/RealmX1/cline-kanban/issues", "Ti tle", "Bo & dy");
		expect(url.startsWith("https://github.com/RealmX1/cline-kanban/issues/new?")).toBe(true);
		expect(url).toContain("title=Ti+tle");
		expect(url).toContain("body=Bo+%26+dy");
	});
});
