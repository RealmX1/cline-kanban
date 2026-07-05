// 应用内通知中心的「完整日志」弹窗：展示全部通知组（含已 move-to-done 的组，打 Done 标记但仍可见）。
// 逐组列出每条通知的「人轴」种类 / 触发时间 / 已访问时间（未读显式标注）。底部「清空」。
import { Trash2 } from "lucide-react";
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

function formatAbsoluteTimestamp(epochMs: number): string {
	return new Date(epochMs).toLocaleString();
}

export function NotificationLogDialog({
	open,
	onOpenChange,
	groups,
	onFocusTask,
	onClearAll,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	groups: NotificationGroup[];
	onFocusTask: (workspaceId: string, taskId: string) => void;
	onClearAll: () => void;
}): React.ReactElement {
	const [isConfirmingClear, setIsConfirmingClear] = useState(false);

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogHeader title="通知日志" />
				<DialogBody>
					{groups.length === 0 ? (
						<p className="m-0 py-8 text-center text-[13px] text-text-secondary">暂无通知历史。</p>
					) : (
						<div className="flex flex-col gap-2">
							{groups.map((group) => (
								<div key={group.key} className="rounded-lg border border-border bg-surface-2 p-2.5">
									<button
										type="button"
										onClick={() => {
											onFocusTask(group.workspaceId, group.taskId);
											onOpenChange(false);
										}}
										className="flex w-full items-center gap-2 rounded-md text-left transition-colors hover:bg-surface-3 focus:outline-none focus:ring-2 focus:ring-border-focus"
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-1.5">
												<span className="truncate text-[13px] font-medium text-text-primary">
													{group.taskTitle}
												</span>
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
														{entry.visitedAt === null
															? "未读"
															: `已读 ${formatAbsoluteTimestamp(entry.visitedAt)}`}
													</span>
												</span>
											</div>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="ghost"
						icon={<Trash2 size={14} />}
						disabled={groups.length === 0}
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
