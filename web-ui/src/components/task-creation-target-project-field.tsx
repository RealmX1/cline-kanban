import type { ProjectVisualIdentity } from "@runtime-project-visual-identity";
import type { ReactElement } from "react";
import { ProjectIcon } from "@/components/project-visual-identity";

import { SearchSelectDropdown } from "@/components/search-select-dropdown";

/**
 * 任务编辑对话框的「目标项目」（Task Creation Target Project，见 docs/context-board-scope-all-projects-and-single-project-scope.md）字段怎么呈现。
 * 单项目与编辑任务时均显示只读归属；全项目建卡时允许选择目标。
 *   - Board Scope 建卡：可选，默认取上下文项目（焦点任务所属项目，否则当前项目）；
 *   - 编辑其他项目的卡（All projects 面板原地编辑）：只读标签，卡不能换项目。
 * 不复用顶栏项目切换器的 popover：那是导航语义，这里只是给新卡挑归属。
 */
export type TaskCreationTargetProjectField =
	| {
			taskCreationTargetProjectFieldPresentation: "target_project_selectable_in_board_scope";
			selectableProjects: ReadonlyArray<{
				workspaceId: string;
				projectName: string;
				visualIdentity?: ProjectVisualIdentity;
			}>;
			selectedTargetWorkspaceId: string | null;
			onSelectTargetWorkspaceId: (workspaceId: string) => void;
	  }
	| {
			taskCreationTargetProjectFieldPresentation: "target_project_shown_read_only";
			projectName: string;
			workspaceId?: string;
			visualIdentity?: ProjectVisualIdentity;
	  };

export function TaskCreationTargetProjectFieldControl({
	taskCreationTargetProjectField,
}: {
	taskCreationTargetProjectField: TaskCreationTargetProjectField;
}): ReactElement {
	return (
		<div data-testid="task-creation-target-project-field">
			<span className="text-sm text-text-secondary block mb-1.5">Project</span>
			{taskCreationTargetProjectField.taskCreationTargetProjectFieldPresentation ===
			"target_project_selectable_in_board_scope" ? (
				<SearchSelectDropdown
					options={taskCreationTargetProjectField.selectableProjects.map((project) => ({
						value: project.workspaceId,
						label: project.projectName,
						icon: (
							<ProjectIcon
								workspaceId={project.workspaceId}
								projectName={project.projectName}
								visualIdentity={project.visualIdentity}
							/>
						),
					}))}
					selectedValue={taskCreationTargetProjectField.selectedTargetWorkspaceId}
					onSelect={taskCreationTargetProjectField.onSelectTargetWorkspaceId}
					icon={
						<ProjectIcon
							workspaceId={taskCreationTargetProjectField.selectedTargetWorkspaceId ?? undefined}
							projectName={
								taskCreationTargetProjectField.selectableProjects.find(
									(project) =>
										project.workspaceId === taskCreationTargetProjectField.selectedTargetWorkspaceId,
								)?.projectName
							}
							size={22}
						/>
					}
					buttonClassName="min-h-11 font-medium [&>span]:text-base"
					fill
					size="sm"
					placeholder="Search projects..."
					emptyText="No projects"
					noResultsText="No matching projects"
				/>
			) : (
				<div
					className="flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface-2 px-3 text-base font-medium text-text-primary"
					role="group"
					aria-label="所属项目（只读）"
				>
					<ProjectIcon
						workspaceId={taskCreationTargetProjectField.workspaceId}
						projectName={taskCreationTargetProjectField.projectName}
						visualIdentity={taskCreationTargetProjectField.visualIdentity}
						size={22}
					/>
					<span className="truncate">{taskCreationTargetProjectField.projectName}</span>
				</div>
			)}
		</div>
	);
}
