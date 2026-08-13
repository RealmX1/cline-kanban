// 应用内通知中心的「全部历史」弹窗：展示全部通知（含已读条目、含已 move-to-done 的组，打 Done 标记但仍可见）。
// 顶部 toggle 在两种排列间切换：
//   - flat_chronological（默认）：跨 task 展平成一条时间流，严格按 triggeredAt 降序
//   - grouped_by_task：按 task 分组，组之间按各组最新通知时间降序
// 底部「全部已读」（范围含 done 组，与本弹窗可见范围一致）+「清空」。
import { CheckCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Dialog,
	DialogBody,
	DialogFooter,
	DialogHeader,
} from "@/components/ui/dialog";
import type { NotificationGroup } from "@/hooks/use-notification-center";
import { resolveReviewReadyNotificationTitle } from "@/hooks/use-review-ready-notifications";
import type { RuntimeNotificationFeedEntry } from "@/runtime/types";

export type NotificationHistoryArrangement = "flat_chronological" | "grouped_by_task";

const NOTIFICATION_HISTORY_ARRANGEMENT_TABS: { id: NotificationHistoryArrangement; label: string }[] = [
	{ id: "flat_chronological", label: "时间流" },
	{ id: "grouped_by_task", label: "按 task 分组" },
];

function formatAbsoluteTimestamp(epochMs: number): string {
	return new Date(epochMs).toLocaleString();
}

function NotificationHistoryArrangementTabs({
	arrangement,
	onArrangementChange,
}: {
	arrangement: NotificationHistoryArrangement;
	onArrangementChange: (arrangement: NotificationHistoryArrangement) => void;
}): React.ReactElement {
	return (
		<div role="tablist" aria-label="通知历史排列方式" className="ml-auto mr-1 flex min-w-0 items-center gap-0.5">
			{NOTIFICATION_HISTORY_ARRANGEMENT_TABS.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={arrangement === tab.id}
					className={cn(
						"inline-flex h-6 min-w-0 items-center rounded-sm px-2 text-xs font-medium transition-colors",
						arrangement === tab.id
							? "bg-surface-3 text-text-primary"
							: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
					)}
					onClick={() => onArrangementChange(tab.id)}
				>
					<span className="truncate">{tab.label}</span>
				</button>
			))}
		</div>
	);
}

function NotificationHistoryChronologicalList({
	entries,
	onSelectTask,
}: {
	entries: RuntimeNotificationFeedEntry[];
	onSelectTask: (workspaceId: string, taskId: string, hasUnvisited: boolean) => void;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-0.5">
			{entries.map((entry) => {
				const visitedAt = entry.visitedAt;
				const isUnvisited = visitedAt === null;
				return (
					<button
						key={entry.id}
						type="button"
						onClick={() => onSelectTask(entry.workspaceId, entry.taskId, isUnvisited)}
						className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-border-focus"
					>
						{isUnvisited ? (
							<span role="img" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="未读" />
						) : (
							<span className="h-1.5 w-1.5 shrink-0" />
						)}
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span
									className={cn(
										"truncate text-[13px]",
										isUnvisited ? "font-medium text-text-primary" : "text-text-secondary",
									)}
								>
									{resolveReviewReadyNotificationTitle(entry.userTurnKind ?? undefined)}
								</span>
								{entry.isDone ? (
									<span className="shrink-0 rounded-sm bg-surface-4 px-1 py-0.5 text-[10px] uppercase text-text-tertiary">
										Done
									</span>
								) : null}
							</div>
							<p
								className="m-0 truncate text-[12px] text-text-tertiary"
								title={`${entry.repoName} · ${entry.taskTitle}`}
							>
								{entry.repoName} · {entry.taskTitle}
							</p>
						</div>
						<div className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] text-text-tertiary">
							<span>{formatAbsoluteTimestamp(entry.triggeredAt)}</span>
							<span className={cn(isUnvisited && "text-accent")}>
								{visitedAt === null ? "未读" : `已读 ${formatAbsoluteTimestamp(visitedAt)}`}
							</span>
						</div>
					</button>
				);
			})}
		</div>
	);
}

function NotificationHistoryGroupedList({
	groups,
	onSelectTask,
}: {
	groups: NotificationGroup[];
	onSelectTask: (workspaceId: string, taskId: string, hasUnvisited: boolean) => void;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-2">
			{groups.map((group) => (
				<div key={group.key} className="rounded-lg border border-border bg-surface-2 p-2.5">
					<button
						type="button"
						onClick={() => onSelectTask(group.workspaceId, group.taskId, group.hasUnvisited)}
						className="flex w-full items-center gap-2 rounded-md text-left transition-colors hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-border-focus"
					>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<span className="truncate text-[13px] font-medium text-text-primary">{group.taskTitle}</span>
								{group.isDone ? (
									<span className="shrink-0 rounded-sm bg-surface-4 px-1 py-0.5 text-[10px] uppercase text-text-tertiary">
										Done
									</span>
								) : null}
								{group.hasUnvisited ? (
									<span
										role="img"
										className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
										aria-label="有未读"
									/>
								) : null}
							</div>
							<span className="truncate text-[12px] text-text-tertiary">{group.repoName}</span>
						</div>
					</button>
					<div className="mt-1.5 flex flex-col gap-1 border-t border-border pt-1.5">
						{group.entries.map((entry) => (
							<div key={entry.id} className="flex items-center justify-between gap-2 text-[12px]">
								<span className="truncate text-text-secondary">
									{resolveReviewReadyNotificationTitle(entry.userTurnKind ?? undefined)}
								</span>
								<span className="shrink-0 text-text-tertiary">
									{formatAbsoluteTimestamp(entry.triggeredAt)}
									{" · "}
									<span className={cn(entry.visitedAt === null && "text-accent")}>
										{entry.visitedAt === null ? "未读" : `已读 ${formatAbsoluteTimestamp(entry.visitedAt)}`}
									</span>
								</span>
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

export function NotificationLogDialog({
	open,
	onOpenChange,
	groups,
	entriesSortedByTriggeredAtDescending,
	onFocusTask,
	onMarkGroupVisited,
	onMarkAllHistoryVisited,
	onClearAll,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	groups: NotificationGroup[];
	entriesSortedByTriggeredAtDescending: RuntimeNotificationFeedEntry[];
	onFocusTask: (workspaceId: string, taskId: string) => void;
	onMarkGroupVisited: (workspaceId: string, taskId: string) => void;
	onMarkAllHistoryVisited: () => void;
	onClearAll: () => void;
}): React.ReactElement {
	const [isConfirmingClear, setIsConfirmingClear] = useState(false);
	// 默认平铺时间流：历史的首要用途是「按时间回看发生过什么」，分组是次选排列。
	const [arrangement, setArrangement] = useState<NotificationHistoryArrangement>("flat_chronological");

	const hasAnyUnvisited = groups.some((group) => group.hasUnvisited);
	const isEmpty = groups.length === 0;

	// 点击条目/组头：未读则先标记整组已读（与铃铛面板的点击语义一致），再跳转并关闭弹窗。
	const handleSelectTask = (workspaceId: string, taskId: string, hasUnvisited: boolean) => {
		if (hasUnvisited) {
			onMarkGroupVisited(workspaceId, taskId);
		}
		onFocusTask(workspaceId, taskId);
		onOpenChange(false);
	};

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogHeader title="通知历史">
					<NotificationHistoryArrangementTabs arrangement={arrangement} onArrangementChange={setArrangement} />
				</DialogHeader>
				<DialogBody>
					{isEmpty ? (
						<p className="m-0 py-8 text-center text-[13px] text-text-secondary">
							{arrangement === "flat_chronological"
								? "暂无通知历史，这里会按时间倒序列出全部通知（含已读）。"
								: "暂无通知历史，这里会按 task 分组列出全部通知（含已读）。"}
						</p>
					) : arrangement === "flat_chronological" ? (
						<NotificationHistoryChronologicalList
							entries={entriesSortedByTriggeredAtDescending}
							onSelectTask={handleSelectTask}
						/>
					) : (
						<NotificationHistoryGroupedList groups={groups} onSelectTask={handleSelectTask} />
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="ghost"
						icon={<CheckCheck size={14} />}
						disabled={!hasAnyUnvisited}
						onClick={onMarkAllHistoryVisited}
					>
						全部已读
					</Button>
					<Button
						variant="ghost"
						icon={<Trash2 size={14} />}
						disabled={isEmpty}
						onClick={() => setIsConfirmingClear(true)}
					>
						清空
					</Button>
				</DialogFooter>
			</Dialog>
			<AlertDialog open={isConfirmingClear} onOpenChange={setIsConfirmingClear}>
				<AlertDialogHeader>
					<AlertDialogTitle>清空全部通知历史？</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						这会永久删除所有 repo 的通知日志（含已读与未读），无法撤销。
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setIsConfirmingClear(false)}>
							取消
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								onClearAll();
								setIsConfirmingClear(false);
							}}
						>
							清空
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
