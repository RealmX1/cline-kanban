import type { ReactElement } from "react";

import { getAgentVisual } from "@/components/agent-visual";
import { SESSION_ACTIVITY_COLOR } from "@/components/board-card-session-activity";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentId } from "@/runtime/types";

/**
 * 一行首行最前面的点：Running 区是脉动点，其余区有未读交接时是强调色点，否则不占位。
 * 精简行、hover 展开与固定展开的完整卡片（TaskCardBody 首行前导位）用同一个元素，三态之间标题左沿不动。
 * 度量按「items-start + 13px leading-snug 标题」算：6px 点垂直居中在约 18px 行高里。
 */
export function CrossProjectTaskSwitcherRowLeadingActivityIndicator({
	section,
	isUnreadHandoff,
}: {
	section: CrossProjectTaskSwitcherTaskRowSection;
	isUnreadHandoff: boolean;
}): ReactElement | null {
	if (section === "running") {
		return (
			<span
				data-cross-project-task-switcher-row-leading-activity-indicator="running"
				className="mt-[6px] inline-block size-1.5 shrink-0 animate-pulse rounded-full"
				style={{ backgroundColor: SESSION_ACTIVITY_COLOR.thinking }}
			/>
		);
	}
	if (isUnreadHandoff) {
		return (
			<span
				data-cross-project-task-switcher-row-leading-activity-indicator="unread_handoff"
				className="mt-[6px] inline-block size-1.5 shrink-0 rounded-full bg-accent"
				title="Unread handoff notification"
			/>
		);
	}
	return null;
}

/**
 * 精简行的首行（前导点 + agent 图标 + 标题）。与完整卡片首行同一套度量（gap-1.5、图标 13px + mt-[3px]、
 * 标题 13px leading-snug font-medium），所以换成完整卡片时标题一像素不动。
 * 其他项目的卡快照还没到 / 读失败时，展开的卡先画这一行再在下面放提示，标题不会整行消失。
 * 用 span：精简行的首行在按钮里，按钮里只能放短语内容。
 */
export function CrossProjectTaskSwitcherRowFirstLine({
	section,
	isUnreadHandoff,
	agentId,
	title,
}: {
	section: CrossProjectTaskSwitcherTaskRowSection;
	isUnreadHandoff: boolean;
	agentId: RuntimeAgentId | null;
	title: string;
}): ReactElement {
	const visual = getAgentVisual(agentId);
	return (
		<span className="flex min-w-0 items-start gap-1.5">
			<CrossProjectTaskSwitcherRowLeadingActivityIndicator section={section} isUnreadHandoff={isUnreadHandoff} />
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
