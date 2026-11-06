import type { ReactElement } from "react";

import { getAgentVisual } from "@/components/agent-visual";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentId } from "@/runtime/types";

/**
 * 缩略行与快照未到时的兜底共用 Agent 图标和单行标题；完整卡片沿用同一字号与间距，最多展开三行。
 * 摘要排在此行之前，标题增高只向下延伸。
 */
export function CrossProjectTaskSwitcherRowAgentAndTitle({
	agentId,
	title,
}: {
	agentId: RuntimeAgentId | null;
	title: string;
}): ReactElement {
	const visual = getAgentVisual(agentId);
	return (
		<span className="flex min-w-0 items-start gap-1.5">
			<visual.Icon size={13} className={cn("mt-[3px] shrink-0", visual.className)} />
			<span
				data-cross-project-task-switcher-row-title=""
				className="min-w-0 flex-1 truncate text-[13px] font-medium leading-snug text-text-primary"
			>
				{title}
			</span>
		</span>
	);
}
