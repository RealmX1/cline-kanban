import { SESSION_ACTIVITY_COLOR } from "@/components/board-card-session-activity";
import { useSessionActivityDotBreathingOpacityOnSharedFineClock } from "@/hooks/use-session-activity-dot-breathing-opacity-on-shared-fine-clock";

/** 角标不参与文本流，两项独立显示；宿主需提供 relative 定位。 */
export function TaskCardCornerStatusIndicators({
	isAgentRunning,
	hasUnreadHandoffNotification,
}: {
	isAgentRunning: boolean;
	hasUnreadHandoffNotification: boolean;
}) {
	const runningDotOpacity = useSessionActivityDotBreathingOpacityOnSharedFineClock(isAgentRunning);
	return (
		<>
			{isAgentRunning ? (
				<span
					data-task-card-corner-status-indicator="running"
					className="pointer-events-none absolute -left-[3px] -top-[3px] z-20 size-1.5 rounded-full"
					style={{ backgroundColor: SESSION_ACTIVITY_COLOR.thinking, opacity: runningDotOpacity }}
					role="img"
					aria-label="Agent 正在工作"
				/>
			) : null}
			{hasUnreadHandoffNotification ? (
				<span
					data-task-card-corner-status-indicator="unread_handoff"
					className="pointer-events-none absolute -right-[3px] -top-[3px] z-20 size-1.5 rounded-full bg-accent"
					role="img"
					aria-label="有未读交接消息"
				/>
			) : null}
		</>
	);
}
