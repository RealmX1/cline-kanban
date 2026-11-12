import type { ReactElement } from "react";
import { ProjectIcon } from "@/components/project-visual-identity";
import { formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel } from "@/components/top-bar-project-switcher/board-or-focused-task-project-scope-toggle-hotkey-descriptor";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeProjectSummary } from "@/runtime/types";

/** All Projects View 中，会话工具栏的项目入口沿用范围切换快捷键的导航动作。 */
export function AgentSessionToolbarFocusedTaskProjectNarrowingButton({
	project,
	isMobile,
	onNarrowToFocusedTaskProject,
}: {
	project: RuntimeProjectSummary;
	isMobile: boolean;
	onNarrowToFocusedTaskProject: () => void;
}): ReactElement {
	return (
		<Button
			variant="ghost"
			size="sm"
			className={cn(
				"min-w-0 gap-1 px-1 text-text-secondary hover:text-text-primary",
				isMobile ? "h-11 min-w-11 max-w-[100px] shrink" : "shrink-0",
			)}
			onClick={onNarrowToFocusedTaskProject}
			title={`仅显示项目 ${project.name} (${formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel()})`}
			aria-label={`仅显示项目 ${project.name}`}
			data-testid="agent-session-toolbar-focused-task-project-narrowing-button"
		>
			<ProjectIcon project={project} />
			<span className={cn("truncate", isMobile ? "max-w-[80px]" : "max-w-[140px]")}>{project.name}</span>
		</Button>
	);
}
