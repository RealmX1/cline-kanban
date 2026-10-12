import { FolderGit2 } from "lucide-react";
import type { ReactElement } from "react";

import { SearchSelectDropdown } from "@/components/search-select-dropdown";

/**
 * 任务编辑对话框的「目标项目」（Task Creation Target Project，见 docs/context-stage-first-overview.md）字段怎么呈现。
 * 不传（undefined）= 隐藏：单项目范围里目标就是当前项目，对话框与改动前一致。
 *   - Board Scope 建卡：可选，默认取上下文项目（焦点任务所属项目，否则当前项目）；
 *   - 编辑其他项目的卡（All projects 面板原地编辑）：只读标签，卡不能换项目。
 * 不复用顶栏项目切换器的 popover：那是导航语义，这里只是给新卡挑归属。
 */
export type TaskCreationTargetProjectField =
	| {
			taskCreationTargetProjectFieldPresentation: "target_project_selectable_in_board_scope";
			selectableProjects: ReadonlyArray<{ workspaceId: string; projectName: string }>;
			selectedTargetWorkspaceId: string | null;
			onSelectTargetWorkspaceId: (workspaceId: string) => void;
	  }
	| {
			taskCreationTargetProjectFieldPresentation: "target_project_shown_read_only";
			projectName: string;
	  };

export function TaskCreationTargetProjectFieldControl({
	taskCreationTargetProjectField,
}: {
	taskCreationTargetProjectField: TaskCreationTargetProjectField;
}): ReactElement {
	return (
		<div data-testid="task-creation-target-project-field">
			<span className="text-[11px] text-text-secondary block mb-1">Project</span>
			{taskCreationTargetProjectField.taskCreationTargetProjectFieldPresentation ===
			"target_project_selectable_in_board_scope" ? (
				<SearchSelectDropdown
					options={taskCreationTargetProjectField.selectableProjects.map((project) => ({
						value: project.workspaceId,
						label: project.projectName,
					}))}
					selectedValue={taskCreationTargetProjectField.selectedTargetWorkspaceId}
					onSelect={taskCreationTargetProjectField.onSelectTargetWorkspaceId}
					icon={<FolderGit2 size={14} />}
					fill
					size="sm"
					placeholder="Search projects..."
					emptyText="No projects"
					noResultsText="No matching projects"
				/>
			) : (
				<div className="flex items-center gap-1.5 text-[12px] text-text-primary">
					<FolderGit2 size={14} className="shrink-0 text-text-secondary" />
					<span className="truncate">{taskCreationTargetProjectField.projectName}</span>
				</div>
			)}
		</div>
	);
}
