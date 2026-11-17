import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowLeft, ArrowRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { VisitedTaskNavigationHistoryController } from "@/hooks/use-visited-task-navigation-history-controller";
import type { VisitedTaskHistoryEntry } from "@/state/visited-task-navigation-history";
import { isMacPlatform } from "@/utils/platform";

function targetLabel(target: VisitedTaskHistoryEntry | null): string {
	return target ? `${target.titleSnapshot} · ${target.projectNameSnapshot} · ${target.taskId}` : "没有可访问的任务";
}

export function VisitedTaskNavigationControls({ controller }: { controller: VisitedTaskNavigationHistoryController }) {
	return (
		<nav
			className="flex shrink-0 items-center"
			aria-label="已访问任务导航"
			data-verification-anchor="visited-task-navigation"
			aria-busy={controller.isNavigationPending}
		>
			{[
				{
					label: "后退",
					target: controller.backwardTarget,
					navigate: controller.navigateBackward,
					Icon: ArrowLeft,
					shortcut: isMacPlatform ? "Ctrl+-" : "Alt+←",
				},
				{
					label: "前进",
					target: controller.forwardTarget,
					navigate: controller.navigateForward,
					Icon: ArrowRight,
					shortcut: isMacPlatform ? "Ctrl+Shift+-" : "Alt+→",
				},
			].map(({ label, target, navigate, Icon, shortcut }) => (
				<Tooltip key={label} side="bottom" content={`${label}：${targetLabel(target)}（${shortcut}）`}>
					<span className="inline-flex" title={`${label}：${targetLabel(target)}（${shortcut}）`}>
						<Button
							variant="ghost"
							size="sm"
							className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
							aria-label={`${label}到已访问任务`}
							disabled={!target}
							onClick={navigate}
							icon={<Icon size={15} />}
						/>
					</span>
				</Tooltip>
			))}
			<DropdownMenu.Root modal={false}>
				<DropdownMenu.Trigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
						aria-label="最近访问任务"
						title="最近访问任务"
						icon={controller.isNavigationPending ? <Spinner size={15} /> : <History size={15} />}
					/>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						align="start"
						sideOffset={4}
						collisionPadding={8}
						aria-label="最近访问任务"
						className="z-50 max-h-[min(70dvh,520px)] w-[min(380px,calc(100vw-16px))] overflow-y-auto rounded-md border border-border-bright bg-surface-1 p-1 text-text-primary"
					>
						<DropdownMenu.Label className="px-2 py-2 text-xs font-medium">最近访问</DropdownMenu.Label>
						{controller.isHistoryPersistenceUnavailable ? (
							<p role="status" className="px-2 pb-2 text-xs text-status-orange">
								历史暂时无法保存，当前页面仍可导航。
							</p>
						) : null}
						{controller.history.recentTasks.length === 0 ? (
							<p className="px-2 py-3 text-xs">打开任务详情或 Backlog 编辑窗后，会在这里显示。</p>
						) : (
							controller.history.recentTasks.map((entry) => (
								<DropdownMenu.Item
									key={JSON.stringify([
										entry.workspaceId,
										entry.taskId,
										entry.taskIncarnationCreatedAtEpochMs,
									])}
									disabled={entry.unavailable}
									onSelect={() => controller.openRecentTask(entry)}
									className={cn(
										"flex min-h-11 cursor-pointer flex-col justify-center rounded px-2 py-2 outline-none data-highlighted:bg-surface-3",
										entry.unavailable && "cursor-default opacity-60",
									)}
								>
									<span className="w-full truncate text-sm">{entry.titleSnapshot || entry.taskId}</span>
									<span className="flex w-full min-w-0 gap-2 text-xs">
										<span className="truncate">{entry.projectNameSnapshot}</span>
										<span className="shrink-0 font-mono">{entry.taskId}</span>
										{entry.unavailable ? <span className="shrink-0">不可用</span> : null}
									</span>
								</DropdownMenu.Item>
							))
						)}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</nav>
	);
}
