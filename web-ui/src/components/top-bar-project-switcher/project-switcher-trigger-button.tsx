import { AlertTriangle, ChevronDown } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef } from "react";

import { MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME } from "@/components/shared/mobile-minimum-touch-target";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";

interface ProjectSwitcherTriggerButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	projectName: string | null;
	/** 有 live main agent 的任务数。0 时不渲染徽章——空闲是常态，渲染一个「0」只是噪声。 */
	liveAgentTaskCount: number;
	isProjectUnavailable: boolean;
	isProjectSwitching: boolean;
	isMobile: boolean;
	isOpen: boolean;
}

export const ProjectSwitcherTriggerButton = forwardRef<HTMLButtonElement, ProjectSwitcherTriggerButtonProps>(
	function ProjectSwitcherTriggerButton(
		{
			projectName,
			liveAgentTaskCount,
			isProjectUnavailable,
			isProjectSwitching,
			isMobile,
			isOpen,
			className,
			...buttonProps
		},
		ref,
	) {
		return (
			<Button
				ref={ref}
				variant="ghost"
				size="sm"
				aria-label="Switch project"
				data-testid="top-bar-project-switcher-trigger"
				className={cn(
					"shrink-0 gap-1.5 px-1.5",
					isMobile && MOBILE_MINIMUM_TOUCH_TARGET_CLASS_NAME,
					isOpen && "bg-surface-3 text-text-primary",
					className,
				)}
				{...buttonProps}
			>
				{isProjectUnavailable ? (
					<AlertTriangle size={13} className="shrink-0 text-status-orange" aria-hidden />
				) : null}
				<span
					className={cn("truncate font-medium text-text-primary", isMobile ? "max-w-[100px]" : "max-w-[160px]")}
				>
					{projectName ?? "Select project"}
				</span>
				{liveAgentTaskCount > 0 ? (
					<span
						className="inline-flex shrink-0 items-center rounded-full bg-accent/20 px-1.5 py-px text-[10px] font-medium text-accent"
						data-testid="top-bar-project-switcher-live-agent-task-count"
					>
						{liveAgentTaskCount}
					</span>
				) : null}
				{isProjectSwitching ? (
					<Spinner size={12} className="shrink-0" />
				) : (
					<ChevronDown size={12} className="shrink-0 opacity-70" aria-hidden />
				)}
			</Button>
		);
	},
);
