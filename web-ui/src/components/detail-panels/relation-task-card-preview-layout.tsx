import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useCrossProjectRecentlyActiveTaskSwitcherHostContext } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { RelatedTaskPreviewFullTaskCard } from "@/components/related-task-preview-full-task-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { useExpandedForegroundViewNavigation } from "@/expanded-foreground-view/expanded-foreground-view-context";
import { useRelatedTaskPreviewFocusReturnAfterModalDialog } from "@/hooks/use-related-task-preview-focus-return-after-modal-dialog";
import {
	RelationTaskCardPreviewContext,
	type RelationTaskCardPreviewController,
} from "@/hooks/use-relation-task-card-preview";

export function RelationTaskCardPreviewLayout({
	controller,
	children,
	previewActions,
}: {
	controller: RelationTaskCardPreviewController;
	children: ReactNode;
	previewActions?: ReactNode;
}) {
	const host = useCrossProjectRecentlyActiveTaskSwitcherHostContext();
	const navigation = useExpandedForegroundViewNavigation();
	const rememberInteractionTarget = useRelatedTaskPreviewFocusReturnAfterModalDialog(
		Boolean(controller.selection),
		controller.paneRef,
	);
	const selected = controller.selection?.target;
	const project = selected?.task ? host?.projects.find((item) => item.id === selected.task?.workspaceId) : null;
	const unavailableReason = selected
		? (selected.unavailableReason ??
			(!project
				? "这张卡所在的项目未注册或已移除，无法预览。"
				: project.availability?.status === "unavailable"
					? "这张卡所在的项目当前不可用。"
					: null))
		: null;
	return (
		<RelationTaskCardPreviewContext.Provider value={controller}>
			<div ref={controller.layoutRef} className="@container/relations-preview min-h-0 min-w-0">
				<div
					className={cn(
						"grid min-h-0 min-w-0",
						selected && "@min-[900px]/relations-preview:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]",
					)}
				>
					<div className="min-h-0 min-w-0">{children}</div>
					{selected ? (
						<div
							ref={controller.paneRef}
							tabIndex={-1}
							role="region"
							aria-label="Relations 任务卡片预览"
							data-relations-task-card-preview=""
							data-preview-pinned={controller.selection?.pinned}
							className="min-h-0 min-w-0 self-start border-t border-border bg-surface-1 focus:outline-none @min-[900px]/relations-preview:sticky @min-[900px]/relations-preview:top-0 @min-[900px]/relations-preview:border-l @min-[900px]/relations-preview:border-t-0"
							onPointerDownCapture={(event) => {
								controller.pinCurrentPreview();
								rememberInteractionTarget(event.target);
							}}
							onFocusCapture={(event) => {
								controller.pinCurrentPreview();
								rememberInteractionTarget(event.target);
							}}
						>
							<div className="flex min-h-10 items-center justify-between gap-2 border-b border-border px-3 text-xs text-text-secondary">
								<span>{controller.selection?.pinned ? "已固定任务卡片" : "任务卡片预览 · 点击任务可固定"}</span>
								<Button
									variant="ghost"
									size="sm"
									aria-label="关闭任务卡片预览"
									className="shrink-0 max-md:min-h-11 max-md:min-w-11"
									onClick={controller.closePreview}
								>
									<X size={14} />
								</Button>
							</div>
							<div className="max-h-[min(38rem,65dvh)] min-w-0 overflow-y-auto overscroll-contain">
								{unavailableReason || !selected.task ? (
									<div role="status" className="space-y-2 p-3 text-xs text-text-secondary">
										<p className="break-words font-medium text-text-primary">{selected.title}</p>
										<p>{unavailableReason}</p>
									</div>
								) : (
									<RelatedTaskPreviewFullTaskCard
										key={JSON.stringify(selected.task)}
										task={selected.task}
										workspaceRepositoryPath={selected.workspaceRepositoryPath ?? project?.path ?? null}
										onOpen={() => {
											if (!selected.task) return;
											navigation?.dismissForTaskNavigation();
											controller.closePreview();
											host?.onOpenTaskInProject(
												selected.task.workspaceId,
												selected.task.taskId,
												selected.task.taskIncarnationCreatedAtEpochMs,
											);
										}}
									/>
								)}
								{!unavailableReason && previewActions ? (
									<div className="border-t border-border p-3">{previewActions}</div>
								) : null}
							</div>
						</div>
					) : null}
				</div>
			</div>
		</RelationTaskCardPreviewContext.Provider>
	);
}
