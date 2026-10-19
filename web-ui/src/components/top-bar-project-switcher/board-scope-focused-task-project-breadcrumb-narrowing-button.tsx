import type { ReactElement } from "react";
import { ProjectIcon } from "@/components/project-visual-identity";
import { formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel } from "@/components/top-bar-project-switcher/board-or-focused-task-project-scope-toggle-hotkey-descriptor";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeProjectSummary } from "@/runtime/types";

/**
 * Board Scope 的 Focus View 里，顶栏「All projects」后面那段「› 焦点任务所属项目」。
 * 它和切换器触发按钮是两个按钮：点它直接收窄到这个项目（与 ⌘E 同一动作），不必打开切换器再找一遍。
 */
export function BoardScopeFocusedTaskProjectBreadcrumbNarrowingButton({
	focusedTaskProjectName,
	project,
	isMobile,
	onNarrowToFocusedTaskProject,
}: {
	focusedTaskProjectName: string;
	project?: RuntimeProjectSummary;
	isMobile: boolean;
	onNarrowToFocusedTaskProject: () => void;
}): ReactElement {
	return (
		<Button
			variant="ghost"
			size="sm"
			// 与切换器触发按钮同样的收缩规则：桌面不收缩（否则被挤成 0 宽、藏到搜索按钮底下），项目名靠自身 truncate 让位。
			className={cn(
				"gap-1 px-1 text-text-secondary hover:text-text-primary",
				isMobile ? "min-w-0 shrink" : "shrink-0",
			)}
			onClick={onNarrowToFocusedTaskProject}
			title={`Show only ${focusedTaskProjectName} (${formatBoardOrFocusedTaskProjectScopeToggleHotkeyLabel()})`}
			aria-label={`Show only project ${focusedTaskProjectName}`}
			data-testid="top-bar-project-switcher-board-scope-focused-task-project-breadcrumb"
		>
			<span className="shrink-0" aria-hidden>
				›
			</span>
			{project ? <ProjectIcon project={project} /> : null}
			<span className={cn("truncate", isMobile ? "max-w-[80px]" : "max-w-[140px]")}>{focusedTaskProjectName}</span>
		</Button>
	);
}
