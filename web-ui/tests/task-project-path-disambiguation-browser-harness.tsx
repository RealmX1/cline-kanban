import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TaskCreationTargetProjectFieldControl } from "@/components/task-creation-target-project-field";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/styles/globals.css";

function SameNameProjectSelector() {
	const [selected, setSelected] = useState("canonical-project");
	return <TooltipProvider><main className="mx-auto max-w-lg p-4">
		<TaskCreationTargetProjectFieldControl taskCreationTargetProjectField={{
			taskCreationTargetProjectFieldPresentation: "target_project_selectable_in_board_scope",
			selectableProjects: [
				{ workspaceId: "canonical-project", projectName: "cline-kanban", repositoryPath: "/Users/bominzhang/Documents/GitHub/cline-kanban" },
				{ workspaceId: "duplicate-project", projectName: "cline-kanban", repositoryPath: "/Users/bominzhang/.cline/worktrees/515ad/cline-kanban" },
			], selectedTargetWorkspaceId: selected, onSelectTargetWorkspaceId: setSelected,
		}} />
	</main></TooltipProvider>;
}
const container = document.createElement("div");
document.body.append(container);
createRoot(container).render(<SameNameProjectSelector />);
