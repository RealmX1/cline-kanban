import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ProjectVisualIdentityProvider } from "@/components/project-visual-identity";
import { TaskCardSummaryMetadata } from "@/components/task-card-summary-metadata";
import { TooltipProvider } from "@/components/ui/tooltip";

it.each([false, true])("摘要固定六格并按可见字符截断项目名，优先读取正式项目名=%s", async (hasProjectSummary) => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const projectName = `${"👩🏽‍💻".repeat(21)}项目`;
	try {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<ProjectVisualIdentityProvider
						projects={
							hasProjectSummary
								? [
										{
											id: "project-a",
											name: projectName,
											path: "/isolated/directory-fallback",
											availability: { status: "available" },
											taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
											inProgressTaskDetails: [],
											crossProjectTaskSwitcherEntries: [],
										},
									]
								: []
						}
					>
						<TaskCardSummaryMetadata
							workspaceId="project-a"
							projectName={hasProjectSummary ? "directory-fallback" : projectName}
							task={{ id: "summary-task" }}
							snapshot={null}
							showGitMetadata
							timePills={<span>1m</span>}
						/>
					</ProjectVisualIdentityProvider>
				</TooltipProvider>,
			),
		);
		const row = container.querySelector("[data-task-card-secondary-metadata-row]")!;
		expect([...row.children].map((cell) => cell.getAttribute("data-task-card-summary-cell"))).toEqual([
			"project",
			"base_relation",
			"dirty",
			"time",
			"deployment_coverage",
			"committed_diff",
		]);
		const project = container.querySelector("[data-task-card-project-metadata-group]")!;
		expect(project.textContent).toBe(`${"👩🏽‍💻".repeat(20)}…`);
		expect(project.getAttribute("aria-label")).toBe(projectName);
		expect(row.querySelector('[data-task-card-summary-cell="dirty"]')?.textContent).toBe("");
		expect(row.querySelector('[data-task-card-summary-cell="deployment_coverage"]')?.textContent).toContain("?");
		expect(row.querySelector('[data-task-card-summary-cell="committed_diff"]')?.textContent).toContain("—");
	} finally {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
