/**
 * Build the title + body for a bug report from the dialog fields plus auto-collected
 * diagnostic context. The same body feeds both the auto-created Kanban task prompt and the
 * GitHub-issue fallback (`?body=`), so a coding agent and a human reader both land on the
 * same structured, environment-annotated report.
 */

export interface BugReportDiagnosticContext {
	appVersion: string | null;
	currentProjectName: string | null;
	currentProjectPath: string | null;
	activeView: string;
	platform: string;
	userAgent: string;
	viewport: string;
	capturedAtIso: string;
}

export interface BuildBugReportContentInput {
	title: string;
	description: string;
	diagnostics: BugReportDiagnosticContext;
	/** Whether a screenshot is attached — noted in the body so a human reader looks for it. */
	hasScreenshot: boolean;
	/** True for the GitHub-issue fallback path, where inline image attachments can't ride along. */
	forGitHubIssue: boolean;
}

/** Read the diagnostic context available from the running browser. */
export function collectBugReportDiagnostics(input: {
	currentProjectName: string | null;
	currentProjectPath: string | null;
	activeView: string;
	capturedAtIso: string;
	appVersion: string | null;
}): BugReportDiagnosticContext {
	return {
		appVersion: input.appVersion,
		currentProjectName: input.currentProjectName,
		currentProjectPath: input.currentProjectPath,
		activeView: input.activeView,
		platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
		userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
		viewport: typeof window !== "undefined" ? `${window.innerWidth}×${window.innerHeight}` : "unknown",
		capturedAtIso: input.capturedAtIso,
	};
}

export function deriveBugReportTitle(title: string, description: string): string {
	const trimmedTitle = title.trim();
	if (trimmedTitle) {
		return trimmedTitle;
	}
	const firstLine = description.trim().split("\n")[0]?.trim() ?? "";
	const derived = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
	return derived || "Bug report";
}

function formatDiagnosticsSection(diagnostics: BugReportDiagnosticContext): string {
	const rows = [
		`- App 版本: ${diagnostics.appVersion ?? "unknown"}`,
		`- 当前项目: ${diagnostics.currentProjectName ?? "(none)"}${
			diagnostics.currentProjectPath ? ` (${diagnostics.currentProjectPath})` : ""
		}`,
		`- 视图: ${diagnostics.activeView}`,
		`- 平台: ${diagnostics.platform}`,
		`- 视口: ${diagnostics.viewport}`,
		`- User-Agent: ${diagnostics.userAgent}`,
		`- 采集时间: ${diagnostics.capturedAtIso}`,
	];
	return `### 环境信息（自动采集）\n${rows.join("\n")}`;
}

export function buildBugReportBody(input: BuildBugReportContentInput): string {
	const description = input.description.trim() || "(未填写描述)";
	const sections: string[] = [`## Bug 描述\n${description}`, formatDiagnosticsSection(input.diagnostics)];

	if (input.hasScreenshot) {
		sections.push(
			input.forGitHubIssue
				? "### 截图\n已在提交时自动截图，但 GitHub issue 链接无法自动携带附件——请手动把截图粘贴到本 issue。"
				: "### 截图\n已附当前页面自动截图（见任务附件）。",
		);
	}

	return sections.join("\n\n");
}

/** Build a GitHub "new issue" URL with title/body prefilled. */
export function buildGitHubIssueUrl(issuesBaseUrl: string, title: string, body: string): string {
	const params = new URLSearchParams({ title, body });
	return `${issuesBaseUrl}/new?${params.toString()}`;
}
