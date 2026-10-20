import { GitBranch, Home } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeTaskWorktreeMode } from "@/runtime/types";

/** 简洁行与完整卡片共用工作区类型图标，类型文字只在悬停时显示。 */
export function TaskWorkspaceModeIconWithTooltip({ worktreeMode }: { worktreeMode?: RuntimeTaskWorktreeMode | null }) {
	const isInplace = worktreeMode === "inplace";
	const label = isInplace ? "inplace" : "worktree";
	const Icon = isInplace ? Home : GitBranch;
	return (
		<Tooltip side="bottom" content={label} delayDuration={0}>
			<span
				className="inline-flex shrink-0 items-center"
				data-task-workspace-mode-icon={label}
				role="img"
				aria-label={label}
			>
				<Icon size={10} />
			</span>
		</Tooltip>
	);
}
