import {
	type CrossProjectTaskSwitcherEntryInProject,
	isCrossProjectTaskSwitcherEntryPreparingAgentStartup,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { cn } from "@/components/ui/cn";

export function CrossProjectTaskSwitcherAgentStartupProgressStatusNotice({
	entryInProject,
	isHiddenByHoverFloatingCard = false,
}: {
	entryInProject: CrossProjectTaskSwitcherEntryInProject;
	isHiddenByHoverFloatingCard?: boolean;
}) {
	const { entry, workspaceId } = entryInProject;
	if (!isCrossProjectTaskSwitcherEntryPreparingAgentStartup(entry, workspaceId)) return null;
	const progress = entry.taskEditorCreationAgentStartupProgress;
	const label =
		progress?.phase === "waiting_for_evidence"
			? "正在核验启动结果"
			: progress?.phase === "waiting_for_dependency"
				? "启动等待恢复"
				: "正在启动";
	return (
		<span
			role="status"
			aria-hidden={isHiddenByHoverFloatingCard || undefined}
			className={cn("relative min-w-0 text-xs text-status-orange", isHiddenByHoverFloatingCard && "invisible")}
			title={progress?.lastError ?? progress?.recoveryCondition ?? "任务已保存，等待 Agent 进程启动"}
			data-verification-anchor={
				isHiddenByHoverFloatingCard ? undefined : `task-editor-creation-agent-startup:${entry.taskId}`
			}
		>
			{label}
		</span>
	);
}
