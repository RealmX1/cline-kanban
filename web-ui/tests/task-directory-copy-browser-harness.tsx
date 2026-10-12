import { createRoot } from "react-dom/client";

import { TaskCardBody, type TaskCardBodyRenderRole } from "../src/components/task-card-body";
import { TaskCardBodyVisualDensityProvider } from "../src/components/task-card-body-visual-density-context";
import { TooltipProvider } from "../src/components/ui/tooltip";
import "../src/styles/globals.css";

// 只挂真实卡体，不连接运行时、不写用户看板；覆盖无 Git 元数据的所有共享渲染角色。
const renderRoles: TaskCardBodyRenderRole[] = [
	"canonical_card_in_its_stage_list",
	"focused_card_copy_under_sticky_stage_header",
	"pinned_card_copy_in_task_pinboard",
	"expanded_card_copy_in_cross_project_task_switcher_row",
];
const useKnownInplaceWorkspacePath = new URLSearchParams(location.search).has("known-inplace-path");
const harnessContainer = document.createElement("main");
document.body.append(harnessContainer);
createRoot(harnessContainer).render(
	<TooltipProvider>
		{renderRoles.map((renderRole, index) => (
			<div key={renderRole} data-browser-test-card-role={renderRole} className="m-8 w-80">
				<TaskCardBodyVisualDensityProvider
					value={index === 0 ? "standard_card_with_floating_capsule" : "compact_row_in_focus_view_left_column"}
				>
					<TaskCardBody
						card={{
							id: `complete-task-id-${index}`,
							title: "测试任务",
							prompt: "测试任务",
							baseRef: "main",
							...(useKnownInplaceWorkspacePath ? { worktreeMode: "inplace" as const } : {}),
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							createdAt: 1,
							updatedAt: 1,
						}}
						columnId="backlog"
						renderRole={renderRole}
						workspacePath="/Users/test/example-project"
						resolveTaskWorkspaceAbsoluteDirectoryPath={async (card) => {
							const response = await fetch(`/task-workspace-directory?taskId=${card.id}`);
							const directoryPath = await response.text();
							document.body.dataset.resolvedTaskDirectoryPath = directoryPath;
							return directoryPath;
						}}
						onOpenTaskEditor={(card) => {
							document.body.dataset.editedTaskId = card.id;
						}}
						onStart={() => {
							document.body.dataset.unexpectedTaskStart = "true";
						}}
						onClick={() => {
							document.body.dataset.unexpectedCardActivation = "true";
						}}
					/>
				</TaskCardBodyVisualDensityProvider>
			</div>
		))}
	</TooltipProvider>,
);
