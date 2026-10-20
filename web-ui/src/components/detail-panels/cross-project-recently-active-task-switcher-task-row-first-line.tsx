import type { ReactElement } from "react";

import { getAgentVisual } from "@/components/agent-visual";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentId } from "@/runtime/types";

/**
 * 精简行的首行（agent 图标 + 标题）。与完整卡片首行同一套度量（gap-1.5、图标 13px + mt-[3px]、
 * 标题 13px leading-snug font-medium），所以换成完整卡片时标题一像素不动。
 * 其他项目的卡快照还没到 / 读失败时，展开的卡先画这一行再在下面放提示，标题不会整行消失。
 * 用 span：精简行的首行在按钮里，按钮里只能放短语内容。
 */
export function CrossProjectTaskSwitcherRowFirstLine({
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
