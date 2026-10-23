import * as Popover from "@radix-ui/react-popover";
import { Rocket } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { RuntimeTaskCommitCoverageInCurrentDeployment } from "@/runtime/types";

const unavailableReasonDescriptions: Record<string, string> = {
	current_deployment_record_unavailable: "该项目没有可用的当前部署记录，不能据此认定从未部署。",
	task_commit_history_unavailable: "任务的保留提交归属记录不完整，无法确定覆盖范围。",
	task_commit_ownership_history_incomplete: "任务的最新提交归属记录不完整，无法确定当前覆盖范围。",
	legacy_history_unavailable: "任务的历史提交归属记录不可用，无法确定当前覆盖范围。",
	inplace_task_commit_ownership_unavailable: "原地任务无法区分自有提交，无法确定当前覆盖范围。",
	deployment_git_history_unavailable: "当前部署源的 Git 历史不可用或不完整，暂时无法核对。",
	task_git_observation_unavailable: "任务的最新 Git 观测暂时不可用。",
	current_deployment_changed_during_inspection: "核对期间部署版本发生变化，正在等待下一次刷新。",
};

export function TaskCommitCoverageInCurrentDeploymentIndicator({
	coverage,
}: {
	coverage?: RuntimeTaskCommitCoverageInCurrentDeployment;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pinnedOpenRef = useRef(false);
	const clearCloseTimer = () => {
		if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	};
	useEffect(
		() => () => {
			if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
		},
		[],
	);
	if (coverage?.coverageStatus === "no_known_task_commits") return null;
	const unknown = !coverage || coverage.coverageStatus === "unknown";
	const countText = unknown
		? "?"
		: `${coverage.matchedTaskCommitCountInCurrentDeployment}/${coverage.knownTaskCommitCount}`;
	const description = unknown ? "部署覆盖：无法判断" : `部署覆盖：${countText} 个已知提交`;
	const scheduleClose = () => {
		clearCloseTimer();
		if (!pinnedOpenRef.current) closeTimerRef.current = setTimeout(() => setIsOpen(false), 200);
	};
	const open = () => {
		clearCloseTimer();
		setIsOpen(true);
	};
	return (
		<span
			className="inline-flex align-baseline whitespace-nowrap"
			data-task-commit-coverage-in-current-deployment={coverage?.coverageStatus ?? "unknown"}
		>
			<button
				ref={triggerRef}
				type="button"
				className={cn(
					"inline-flex cursor-pointer items-center gap-0.5 rounded-sm font-mono focus-visible:outline-2 focus-visible:outline-accent",
					coverage?.coverageStatus === "all_known_task_commits_in_current_deployment"
						? "text-status-green"
						: coverage?.coverageStatus === "some_known_task_commits_in_current_deployment"
							? "text-status-blue"
							: "text-text-secondary",
				)}
				aria-label={description}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				onPointerEnter={open}
				onPointerLeave={scheduleClose}
				onFocus={open}
				onBlur={scheduleClose}
				onPointerDown={(event) => event.stopPropagation()}
				onMouseDown={(event) => event.stopPropagation()}
				onKeyDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					pinnedOpenRef.current = true;
					open();
				}}
			>
				<Rocket size={10} aria-hidden="true" />
				部署 {countText}
			</button>
			{isOpen ? (
				<Popover.Root
					open
					onOpenChange={(value) => {
						setIsOpen(value);
						if (!value) pinnedOpenRef.current = false;
					}}
				>
					<Popover.Anchor virtualRef={triggerRef} />
					<Popover.Portal>
						<Popover.Content
							aria-label="当前部署的提交覆盖"
							side="bottom"
							align="start"
							sideOffset={6}
							collisionPadding={12}
							className="z-50 max-w-[min(22rem,calc(100vw-24px))] rounded-md border border-border-bright bg-surface-2 p-3 text-xs text-text-primary"
							onOpenAutoFocus={(event) => event.preventDefault()}
							onCloseAutoFocus={(event) => event.preventDefault()}
							onPointerEnter={clearCloseTimer}
							onPointerLeave={scheduleClose}
							onClick={(event) => event.stopPropagation()}
							onPointerDown={(event) => event.stopPropagation()}
							onKeyDown={(event) => event.stopPropagation()}
						>
							<p>
								{unknown
									? (unavailableReasonDescriptions[coverage?.unavailableReason ?? ""] ??
										"当前运行时尚未提供可靠的部署覆盖信息。")
									: `当前部署版本包含 ${coverage.knownTaskCommitCount} 个已知自有提交中的 ${coverage.matchedTaskCommitCountInCurrentDeployment} 个。`}
							</p>
							{coverage?.currentDeployedSourceCommit ? (
								<p className="mt-2 break-all font-mono">
									部署源 {coverage.currentDeployedSourceCommit.slice(0, 12)}
								</p>
							) : null}
							{coverage?.currentDeploymentRecordedAtIso ? (
								<p className="mt-1">
									部署时间{" "}
									<time dateTime={coverage.currentDeploymentRecordedAtIso}>
										{new Date(coverage.currentDeploymentRecordedAtIso).toLocaleString()}
									</time>
								</p>
							) : null}
							<p className="mt-2 text-text-secondary">覆盖仅针对已知提交，不代表任务完成或部署后验证通过。</p>
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			) : null}
		</span>
	);
}
