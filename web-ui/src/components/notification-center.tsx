// 顶栏全局通知铃铛：跨全部 repo 聚合的应用内通知中心。徽标显示「未读且非 done」的组数（跨 repo），
// 点开是 Popover 面板（排除 done 的组），点某组跳到对应 repo/task 并标记整组已读。底部「全部已读」+「全部历史」。
//
// 面板刻意只做「待处理速览」：每组只显示最新一条、且不含 done 组。要看含已读/含 done 的全量历史，
// 走「全部历史」弹窗（NotificationLogDialog），那里才有时间流 / 按 task 分组的排列 toggle。
//
// 与 OS 系统通知并行：OS 横幅一点即消失、不留历史；这里持久化、可回看、可管理。
// 自身无数据获取：分组数据与回调由 App.tsx 经 useNotificationCenter 派生后下传。
import * as RadixPopover from "@radix-ui/react-popover";
import { Bell, CheckCheck } from "lucide-react";
import { useState } from "react";
import { NotificationLogDialog } from "@/components/notification-log-dialog";
import {
	topBarNotificationCenterBellTriggerAnchorKey,
	VERIFICATION_ANCHOR_ATTR,
} from "@/components/post-deploy-verification/verification-anchor-registry";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { NotificationGroup } from "@/hooks/use-notification-center";
import { resolveReviewReadyNotificationTitle } from "@/hooks/use-review-ready-notifications";
import type { RuntimeNotificationFeedEntry } from "@/runtime/types";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";

function formatUnreadBadge(count: number): string {
	return count > 99 ? "99+" : String(count);
}

export function NotificationCenter({
	panelGroups,
	allGroups,
	allEntriesSortedByTriggeredAtDescending,
	unreadCount,
	onFocusTask,
	onMarkGroupVisited,
	onMarkAllPanelGroupsVisited,
	onMarkAllHistoryGroupsVisited,
	onClearAll,
}: {
	panelGroups: NotificationGroup[];
	allGroups: NotificationGroup[];
	allEntriesSortedByTriggeredAtDescending: RuntimeNotificationFeedEntry[];
	unreadCount: number;
	onFocusTask: (workspaceId: string, taskId: string) => void;
	onMarkGroupVisited: (workspaceId: string, taskId: string) => void;
	onMarkAllPanelGroupsVisited: () => void;
	onMarkAllHistoryGroupsVisited: () => void;
	onClearAll: () => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const [isLogOpen, setIsLogOpen] = useState(false);
	const nowMs = Date.now();

	const handleFocusGroup = (group: NotificationGroup) => {
		onMarkGroupVisited(group.workspaceId, group.taskId);
		onFocusTask(group.workspaceId, group.taskId);
		setOpen(false);
	};

	return (
		<>
			<RadixPopover.Root open={open} onOpenChange={setOpen}>
				<RadixPopover.Trigger asChild>
					<button
						type="button"
						{...{ [VERIFICATION_ANCHOR_ATTR]: topBarNotificationCenterBellTriggerAnchorKey() }}
						aria-label={unreadCount > 0 ? `${unreadCount} 条未读通知` : "通知"}
						className="relative ml-0.5 inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary focus:outline-none focus:ring-2 focus:ring-border-focus"
					>
						<Bell size={16} />
						{unreadCount > 0 ? (
							<span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-status-red px-1 text-[10px] font-semibold leading-[15px] text-white">
								{formatUnreadBadge(unreadCount)}
							</span>
						) : null}
					</button>
				</RadixPopover.Trigger>
				<RadixPopover.Portal>
					<RadixPopover.Content
						side="bottom"
						align="end"
						sideOffset={5}
						className="z-50 w-[340px] rounded-lg border border-border bg-surface-2 p-2 shadow-xl"
						style={{ animation: "kb-tooltip-show 100ms ease" }}
					>
						<div className="flex items-center justify-between px-1.5 py-1">
							<p className="m-0 text-[13px] font-semibold text-text-primary">通知</p>
							<button
								type="button"
								disabled={unreadCount === 0}
								onClick={onMarkAllPanelGroupsVisited}
								className="inline-flex items-center gap-1 rounded-sm text-[12px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-default disabled:opacity-40"
							>
								<CheckCheck size={13} />
								全部已读
							</button>
						</div>
						<div className="mt-1 max-h-[320px] overflow-y-auto">
							{panelGroups.length === 0 ? (
								<p className="m-0 px-1.5 py-6 text-center text-[13px] text-text-secondary">暂无待处理通知。</p>
							) : (
								panelGroups.map((group) => (
									<button
										key={group.key}
										type="button"
										onClick={() => handleFocusGroup(group)}
										className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-border-focus"
									>
										{group.hasUnvisited ? (
											<span
												role="img"
												className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
												aria-label="未读"
											/>
										) : (
											<span className="h-1.5 w-1.5 shrink-0" />
										)}
										<div className="min-w-0 flex-1">
											<p
												className={cn(
													"m-0 truncate text-[13px]",
													group.hasUnvisited ? "font-medium text-text-primary" : "text-text-secondary",
												)}
											>
												{resolveReviewReadyNotificationTitle(group.latestUserTurnKind ?? undefined)}
											</p>
											<p
												className="m-0 truncate text-[12px] text-text-tertiary"
												title={`${group.repoName} · ${group.taskTitle}`}
											>
												{group.repoName} · {group.taskTitle}
											</p>
										</div>
										<div className="flex shrink-0 flex-col items-end gap-0.5">
											<span className="text-[11px] text-text-tertiary">
												{formatCompactElapsedSince(group.latestTriggeredAt, nowMs)}
											</span>
											{group.entries.length > 1 ? (
												<span className="rounded-full bg-surface-4 px-1 text-[10px] text-text-tertiary">
													{group.entries.length}
												</span>
											) : null}
										</div>
									</button>
								))
							)}
						</div>
						<div className="mt-1 border-t border-border pt-1.5">
							<Button
								size="sm"
								variant="ghost"
								fill
								onClick={() => {
									setIsLogOpen(true);
									setOpen(false);
								}}
							>
								全部历史
							</Button>
						</div>
					</RadixPopover.Content>
				</RadixPopover.Portal>
			</RadixPopover.Root>
			<NotificationLogDialog
				open={isLogOpen}
				onOpenChange={setIsLogOpen}
				groups={allGroups}
				entriesSortedByTriggeredAtDescending={allEntriesSortedByTriggeredAtDescending}
				onFocusTask={onFocusTask}
				onMarkGroupVisited={onMarkGroupVisited}
				onMarkAllHistoryVisited={onMarkAllHistoryGroupsVisited}
				onClearAll={onClearAll}
			/>
		</>
	);
}
