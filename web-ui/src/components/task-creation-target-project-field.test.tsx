import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { TaskCreationTargetProjectFieldControl } from "./task-creation-target-project-field";
import { TooltipProvider } from "./ui/tooltip";

function SameNameProjectSelector() {
	const [selected, setSelected] = useState("canonical");
	return (
		<TooltipProvider>
			<TaskCreationTargetProjectFieldControl
				taskCreationTargetProjectField={{
					taskCreationTargetProjectFieldPresentation: "target_project_selectable_in_board_scope",
					selectableProjects: [
						{ workspaceId: "canonical", projectName: "cline-kanban", repositoryPath: "/repos/cline-kanban" },
						{
							workspaceId: "duplicate",
							projectName: "cline-kanban",
							repositoryPath: "/worktrees/515ad/cline-kanban",
						},
					],
					selectedTargetWorkspaceId: selected,
					onSelectTargetWorkspaceId: setSelected,
				}}
			/>
		</TooltipProvider>
	);
}

describe("任务编辑器中的同名项目", () => {
	it("选项与选中结果均显示仓库路径", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<SameNameProjectSelector />));
			const trigger = container.querySelector("button")!;
			expect(trigger.textContent).toContain("/repos/cline-kanban");
			await act(async () => trigger.click());
			const option = [...document.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("/worktrees/515ad/cline-kanban"),
			);
			expect(option).toBeDefined();
			await act(async () => option!.click());
			expect(container.querySelector("button")?.textContent).toContain("/worktrees/515ad/cline-kanban");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
