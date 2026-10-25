import * as Popover from "@radix-ui/react-popover";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type {
	DirectlyRelatedTaskPreviewEntry,
	DirectlyRelatedTaskRelationSummary,
} from "@runtime-work-unit-relation-read-api-contract";
import { Eye, Link2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useCrossProjectRecentlyActiveTaskSwitcherHostContext } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { RelatedTaskPreviewFullTaskCard } from "@/components/related-task-preview-full-task-card";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { useDirectlyRelatedTaskPreviewPages } from "@/hooks/use-directly-related-task-preview-pages";
import {
	hasOpenModalDialogOutsideRelatedTaskPreview,
	useRelatedTaskPreviewFocusReturnAfterModalDialog,
} from "@/hooks/use-related-task-preview-focus-return-after-modal-dialog";
import { resolveAssertedRelationDecisionSourceCategory } from "@/hooks/work-unit-asserted-relation-neighborhood-presentation-model";
import { RELATION_GRAPH_LABELS } from "@/hooks/work-unit-relation-kind-display-labels";
import { buildQualifiedTaskPreviewIdentityKey } from "@/runtime/directly-related-task-preview-query";

let activeRelatedTaskPreview: { id: string; close: () => void } | null = null;

const COLUMN_LABELS: Record<string, string> = {
	backlog: "待办",
	in_progress: "进行中",
	review: "待审阅",
	validation: "待验证",
	trash: "Done",
};
const ASSERTION_SOURCE_LABELS = {
	asserted_directly_by_user_in_web_ui: "用户声明",
	confirmed_by_user_in_web_ui: "用户确认",
	independently_verified_by_automated_verifier: "独立核验",
	agent_assertion_not_reviewed_by_user: "Agent 声明·未确认",
};

function relationDescription(relation: DirectlyRelatedTaskRelationSummary): string {
	const direction =
		relation.directionFromPreviewSubject === "outgoing"
			? "本任务 → 对方"
			: relation.directionFromPreviewSubject === "incoming"
				? "对方 → 本任务"
				: "双向";
	const source =
		relation.relationClass === "recorded"
			? "系统记录"
			: ASSERTION_SOURCE_LABELS[resolveAssertedRelationDecisionSourceCategory(relation.assertionDecisionSources)];
	const asserter = relation.assertionAsserterWorkUnitRef;
	const asserterLabel =
		asserter?.workUnitType === "kanban_board_card"
			? ` · 声明方 ${asserter.workspaceId}/${asserter.taskId}`
			: asserter
				? ` · 声明方 ${asserter.conversationSessionHostKanbanAgentId} 独立会话`
				: "";
	return `${RELATION_GRAPH_LABELS[relation.relationKind] ?? relation.relationKind} · ${direction} · ${source}${asserterLabel}${relation.mutedInPresentation ? " · 已静音" : ""}`;
}

function isEditingWithinRelatedPreview(): boolean {
	const active = document.activeElement;
	return (
		active instanceof HTMLElement &&
		Boolean(active.closest("[data-related-tasks-preview-dialog]")) &&
		active.matches('input, textarea, [contenteditable="true"]')
	);
}

function RelatedTasksPreviewContents({
	task,
	onNavigate,
	onKeepOpen,
	onTotalCount,
}: {
	task: KanbanBoardCardWorkUnitQualifiedReference;
	onNavigate: (entry: DirectlyRelatedTaskPreviewEntry) => void;
	onKeepOpen: () => void;
	onTotalCount: (count: number) => void;
}) {
	const host = useCrossProjectRecentlyActiveTaskSwitcherHostContext();
	const load = useDirectlyRelatedTaskPreviewPages(task, true);
	const [selectedTask, setSelectedTask] = useState<DirectlyRelatedTaskPreviewEntry | null>(null);
	const [currentCardMetadataByIdentityKey, setCurrentCardMetadataByIdentityKey] = useState(
		new Map<string, Pick<DirectlyRelatedTaskPreviewEntry, "title" | "lastKnownBoardColumnId">>(),
	);
	const rememberCurrentCardMetadata = useCallback(
		(
			task: KanbanBoardCardWorkUnitQualifiedReference,
			metadata: Pick<DirectlyRelatedTaskPreviewEntry, "title" | "lastKnownBoardColumnId">,
		) => {
			const identityKey = buildQualifiedTaskPreviewIdentityKey(task);
			setCurrentCardMetadataByIdentityKey((previous) => {
				const prior = previous.get(identityKey);
				if (prior?.title === metadata.title && prior?.lastKnownBoardColumnId === metadata.lastKnownBoardColumnId)
					return previous;
				const next = new Map(previous);
				next.delete(identityKey);
				next.set(identityKey, metadata);
				if (next.size > 100) {
					const oldest = next.keys().next().value;
					if (oldest !== undefined) next.delete(oldest);
				}
				return next;
			});
		},
		[],
	);
	const selectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const selectedKey = selectedTask ? buildQualifiedTaskPreviewIdentityKey(selectedTask.task) : null;
	const clearSelectTimer = () => {
		if (selectTimer.current !== null) clearTimeout(selectTimer.current);
		selectTimer.current = null;
	};
	useEffect(() => () => clearSelectTimer(), []);
	useEffect(() => {
		if (load.page) onTotalCount(load.page.totalTaskCount);
	}, [load.page?.totalTaskCount, onTotalCount]);
	useEffect(() => {
		if (!load.page || !selectedKey) return;
		const current = load.page.entries.find(
			(entry) => buildQualifiedTaskPreviewIdentityKey(entry.task) === selectedKey,
		);
		setSelectedTask(current ?? null);
	}, [load.page, selectedKey]);
	const unavailableReason = (entry: DirectlyRelatedTaskPreviewEntry) => {
		if (entry.permanentlyRemovedFromBoardAt !== null) return "已永久删除，保留历史关联，无法打开或操作";
		if (!entry.identityKnownToLedger) return "账本尚未取得该任务的身份资料";
		const project = host?.projects.find((candidate) => candidate.id === entry.task.workspaceId);
		if (!project) return "所属项目未注册或已移除，无法打开";
		if (project.availability?.status === "unavailable") return "所属项目当前不可用";
		if (!host?.onOpenTaskInProject) return "当前视图没有任务导航宿主";
		return null;
	};
	const select = (entry: DirectlyRelatedTaskPreviewEntry) => {
		clearSelectTimer();
		if (hasOpenModalDialogOutsideRelatedTaskPreview() || isEditingWithinRelatedPreview()) return;
		setSelectedTask(entry);
	};
	const renderRow = (recordedEntry: DirectlyRelatedTaskPreviewEntry) => {
		const entry = {
			...recordedEntry,
			...currentCardMetadataByIdentityKey.get(buildQualifiedTaskPreviewIdentityKey(recordedEntry.task)),
		};
		const key = buildQualifiedTaskPreviewIdentityKey(entry.task);
		const unavailable = unavailableReason(entry);
		const project = host?.projects.find((candidate) => candidate.id === entry.task.workspaceId);
		const descriptions = [...new Set(entry.relations.map(relationDescription))];
		return (
			<li
				key={key}
				className={cn(
					"flex min-w-0 gap-1 rounded-md border border-transparent p-1",
					key === selectedKey ? "border-border-bright bg-surface-3" : "hover:bg-surface-3",
				)}
				onPointerEnter={(event) => {
					if (event.pointerType === "touch") return;
					clearSelectTimer();
					selectTimer.current = setTimeout(() => select(entry), 200);
				}}
				onPointerLeave={clearSelectTimer}
				onFocus={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget)) select(entry);
				}}
			>
				<div className="min-w-0 flex-1">
					<button
						type="button"
						disabled={Boolean(unavailable)}
						data-related-task-open={entry.task.taskId}
						className="w-full cursor-pointer rounded px-1 py-1 text-left text-xs font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:text-text-secondary"
						onClick={() => onNavigate(entry)}
					>
						<span className="line-clamp-2 break-words">{entry.title ?? entry.task.taskId}</span>
						<span className="mt-1 block break-words text-[11px] font-normal text-text-tertiary">
							{project?.name ?? entry.task.workspaceId} · {entry.task.taskId} ·{" "}
							{COLUMN_LABELS[entry.lastKnownBoardColumnId ?? ""] ?? "所在列未知"}
						</span>
					</button>
					<p
						className="m-0 px-1 pb-1 text-[10px] leading-relaxed text-text-secondary"
						title={descriptions.join("\n")}
					>
						{descriptions.join("；")}
					</p>
					{unavailable ? <p className="m-0 px-1 pb-1 text-[11px] text-text-tertiary">{unavailable}</p> : null}
				</div>
				<button
					type="button"
					aria-label={`预览任务：${entry.title ?? entry.task.taskId}`}
					aria-pressed={key === selectedKey}
					data-related-task-preview={entry.task.taskId}
					className="self-start rounded p-2 text-text-secondary hover:bg-surface-1 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 max-md:min-w-11"
					onClick={() => {
						onKeepOpen();
						select(entry);
					}}
				>
					<Eye size={14} />
				</button>
			</li>
		);
	};
	const visibleEntries = load.page?.entries.filter((entry) => !entry.mutedOnly) ?? [];
	const mutedEntries = load.page?.entries.filter((entry) => entry.mutedOnly) ?? [];
	return (
		<div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-2">
			<div className="flex min-h-0 min-w-0 flex-col border-border p-2 md:border-r">
				<div className="mb-2 flex items-center justify-between px-1 text-xs text-text-secondary">
					<span>{load.page ? `直接关联 · ${load.page.totalTaskCount} 个任务` : "直接关联任务"}</span>
					<button
						type="button"
						onClick={load.retry}
						disabled={load.isLoading}
						className="rounded px-2 py-1 text-accent hover:bg-surface-3 disabled:opacity-50"
					>
						刷新
					</button>
				</div>
				<div className="min-h-0 max-h-[min(26rem,52dvh)] flex-1 overflow-y-auto overscroll-contain max-md:max-h-[32dvh]">
					{load.isLoading && !load.page ? (
						<p role="status" className="flex items-center gap-2 p-2 text-xs text-text-secondary">
							<Spinner size={12} />
							正在读取关联…
						</p>
					) : null}
					{load.error ? (
						<div role="status" className="p-2 text-xs text-text-secondary">
							<p className="break-words">
								{load.error === "RELATED_TASK_PREVIEW_PAGE_EXPIRED" ? "关联仍在变化，请稍后刷新。" : load.error}
							</p>
							<button type="button" onClick={load.retry} className="mt-2 text-accent hover:underline">
								重试
							</button>
						</div>
					) : null}
					{load.page?.totalTaskCount === 0 ? (
						<p className="p-2 text-xs text-text-secondary">尚无直接关联任务。</p>
					) : null}
					<ul className="m-0 list-none space-y-1 p-0">{visibleEntries.map(renderRow)}</ul>
					{load.page && load.page.mutedOnlyTaskCount > 0 ? (
						<details className="mt-2 text-xs text-text-tertiary">
							<summary className="cursor-pointer rounded px-1 py-2 focus-visible:outline-2 focus-visible:outline-accent">
								已静音关联 · {load.page.mutedOnlyTaskCount}
							</summary>
							<ul className="m-0 list-none space-y-1 p-0">{mutedEntries.map(renderRow)}</ul>
							{mutedEntries.length === 0 ? <p className="px-1 text-[11px]">继续加载可查看已静音任务。</p> : null}
						</details>
					) : null}
					{load.page?.nextCursor ? (
						<button
							type="button"
							onClick={load.loadMore}
							disabled={load.isLoading}
							className="mt-2 w-full rounded border border-border px-3 py-2 text-xs text-text-secondary hover:bg-surface-3 disabled:opacity-50"
						>
							{load.isLoading
								? "正在加载…"
								: `加载更多（已读取 ${load.page.entries.length} / ${load.page.totalTaskCount}）`}
						</button>
					) : null}
				</div>
				{load.page && load.page.standaloneSessionCount > 0 ? (
					<p className="mb-0 mt-2 px-1 text-[10px] text-text-tertiary">
						另有 {load.page.standaloneSessionCount} 个关联独立会话
					</p>
				) : null}
				<p className="mb-0 mt-2 px-1 text-[10px] text-text-tertiary">
					一跳关联；箭头由关系主语指向对端。点击标题打开，悬停或点眼睛预览。
				</p>
			</div>
			<div
				className="min-w-0 max-h-[min(32rem,65dvh)] overflow-y-auto overscroll-contain border-border max-md:max-h-[35dvh] max-md:border-t"
				onPointerDownCapture={onKeepOpen}
			>
				{selectedTask ? (
					unavailableReason(selectedTask) ? (
						<div className="p-4 text-xs text-text-secondary">
							<p className="mb-2 font-medium text-text-primary">
								{selectedTask.title ?? selectedTask.task.taskId}
							</p>
							{unavailableReason(selectedTask)}
						</div>
					) : (
						<RelatedTaskPreviewFullTaskCard
							key={selectedKey}
							entry={selectedTask}
							onCurrentMetadataChanged={rememberCurrentCardMetadata}
							onOpen={() => onNavigate(selectedTask)}
						/>
					)
				) : (
					<p className="p-4 text-xs leading-relaxed text-text-tertiary">
						悬停左侧任务，或用预览按钮查看完整卡片。
					</p>
				)}
			</div>
		</div>
	);
}

export function TaskRelatedTasksPreviewButton({
	workspaceId,
	taskId,
	taskIncarnationCreatedAtEpochMs,
}: {
	workspaceId: string | null;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
}) {
	const host = useCrossProjectRecentlyActiveTaskSwitcherHostContext();
	const effectiveWorkspaceId = workspaceId ?? host?.currentProjectId ?? null;
	const [isOpen, setIsOpen] = useState(false);
	const [knownCount, setKnownCount] = useState<number | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const rememberInteractionTarget = useRelatedTaskPreviewFocusReturnAfterModalDialog(isOpen, contentRef);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pinnedOpen = useRef(false);
	const requestedKeyboardFocus = useRef(false);
	const skipNextTriggerFocus = useRef(false);
	const dialogId = useId();
	const clearTimer = () => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
	};
	const close = () => {
		clearTimer();
		pinnedOpen.current = false;
		if (activeRelatedTaskPreview?.id === dialogId) activeRelatedTaskPreview = null;
		setIsOpen(false);
	};
	const openPreview = () => {
		if (activeRelatedTaskPreview?.id !== dialogId) {
			if (hasOpenModalDialogOutsideRelatedTaskPreview() || isEditingWithinRelatedPreview()) return;
			activeRelatedTaskPreview?.close();
		}
		activeRelatedTaskPreview = { id: dialogId, close };
		setIsOpen(true);
	};
	useEffect(() => {
		close();
		setKnownCount(null);
	}, [effectiveWorkspaceId, taskId, taskIncarnationCreatedAtEpochMs]);
	useEffect(
		() => () => {
			clearTimer();
			if (activeRelatedTaskPreview?.id === dialogId) activeRelatedTaskPreview = null;
		},
		[dialogId],
	);
	const restoreTriggerFocus = () => {
		skipNextTriggerFocus.current = true;
		triggerRef.current?.focus({ preventScroll: true });
		skipNextTriggerFocus.current = false;
	};
	const scheduleClose = () => {
		clearTimer();
		timer.current = setTimeout(() => {
			if (
				pinnedOpen.current ||
				hasOpenModalDialogOutsideRelatedTaskPreview() ||
				isEditingWithinRelatedPreview() ||
				contentRef.current?.contains(document.activeElement)
			)
				return;
			close();
		}, 300);
	};
	if (!effectiveWorkspaceId) return null;
	const task: KanbanBoardCardWorkUnitQualifiedReference = {
		workUnitType: "kanban_board_card",
		workspaceId: effectiveWorkspaceId,
		taskId,
		taskIncarnationCreatedAtEpochMs,
	};
	return (
		<span className="inline-flex font-sans" data-related-tasks-preview-entry="">
			<button
				ref={triggerRef}
				type="button"
				data-related-tasks-preview-trigger=""
				aria-label={`查看关联任务${knownCount === null ? "" : `，${knownCount} 个`}`}
				aria-haspopup="dialog"
				aria-expanded={isOpen}
				aria-controls={isOpen ? dialogId : undefined}
				className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 max-md:min-w-11"
				onPointerEnter={(event) => {
					if (event.pointerType === "touch") return;
					clearTimer();
					timer.current = setTimeout(() => openPreview(), 250);
				}}
				onPointerLeave={scheduleClose}
				onFocus={() => {
					if (skipNextTriggerFocus.current) return;
					clearTimer();
					openPreview();
				}}
				onBlur={scheduleClose}
				onMouseDown={(event) => event.stopPropagation()}
				onPointerDown={(event) => event.stopPropagation()}
				onClick={(event) => {
					event.stopPropagation();
					clearTimer();
					pinnedOpen.current = true;
					openPreview();
				}}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (["Enter", " ", "ArrowDown"].includes(event.key)) {
						event.preventDefault();
						pinnedOpen.current = true;
						requestedKeyboardFocus.current = true;
						openPreview();
						contentRef.current?.focus();
					}
					if (event.key === "Escape") close();
				}}
			>
				<Link2 size={11} aria-hidden="true" />
				<span>关联{knownCount === null ? "" : ` ${knownCount}`}</span>
			</button>
			{isOpen ? (
				<Popover.Root
					open
					onOpenChange={(open) => {
						if (!open && !hasOpenModalDialogOutsideRelatedTaskPreview()) close();
					}}
				>
					<Popover.Anchor virtualRef={triggerRef} />
					<Popover.Portal>
						<Popover.Content
							ref={contentRef}
							id={dialogId}
							tabIndex={-1}
							data-related-tasks-preview-dialog=""
							onFocusCapture={(event) => rememberInteractionTarget(event.target)}
							onPointerDownCapture={(event) => rememberInteractionTarget(event.target)}
							aria-label="关联任务预览"
							aria-describedby={undefined}
							side="bottom"
							align="start"
							sideOffset={6}
							collisionPadding={8}
							className="z-50 flex w-[min(52rem,calc(100vw-1rem))] max-h-[min(42rem,80dvh,var(--radix-popover-content-available-height))] flex-col overflow-hidden rounded-lg border border-border-bright bg-surface-2 font-sans text-text-primary shadow-xl focus:outline-none"
							onOpenAutoFocus={(event) => {
								if (!requestedKeyboardFocus.current) event.preventDefault();
								else contentRef.current?.focus();
								requestedKeyboardFocus.current = false;
							}}
							onCloseAutoFocus={(event) => event.preventDefault()}
							onEscapeKeyDown={(event) => {
								if (hasOpenModalDialogOutsideRelatedTaskPreview() || isEditingWithinRelatedPreview()) {
									event.preventDefault();
									return;
								}
								event.stopPropagation();
								event.preventDefault();
								close();
								restoreTriggerFocus();
							}}
							onInteractOutside={(event) => {
								if (
									hasOpenModalDialogOutsideRelatedTaskPreview() ||
									(event.target instanceof Node && triggerRef.current?.contains(event.target))
								)
									event.preventDefault();
							}}
							onPointerEnter={clearTimer}
							onPointerLeave={scheduleClose}
							onPointerDown={(event) => event.stopPropagation()}
							onClick={(event) => event.stopPropagation()}
							onKeyDown={(event) => event.stopPropagation()}
						>
							<div className="flex items-center justify-between border-b border-border px-3 py-2">
								<span className="text-xs font-medium">关联任务</span>
								<button
									type="button"
									aria-label="关闭关联任务预览"
									className="rounded p-1 text-text-tertiary hover:bg-surface-3 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-11 max-md:min-w-11"
									onClick={() => {
										close();
										restoreTriggerFocus();
									}}
								>
									<X size={14} />
								</button>
							</div>
							<RelatedTasksPreviewContents
								task={task}
								onTotalCount={setKnownCount}
								onKeepOpen={() => {
									pinnedOpen.current = true;
									clearTimer();
								}}
								onNavigate={(entry) => {
									host?.onOpenTaskInProject(
										entry.task.workspaceId,
										entry.task.taskId,
										entry.task.taskIncarnationCreatedAtEpochMs,
									);
									close();
								}}
							/>
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			) : null}
		</span>
	);
}
