import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherRemainingSectionOrderingMode,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { ChevronDown, ChevronRight, ChevronUp, Flame, History, Pin } from "lucide-react";
import { type ReactElement, type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { notifyError } from "@/components/app-toaster";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import {
	CrossProjectRecentlyActiveTaskSwitcherTaskRow,
	type CrossProjectTaskSwitcherTaskRowSection,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import { crossProjectTaskSwitcherSectionRowAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import {
	TaskPinboardPinReasonDialog,
	type TaskPinboardPinReasonDialogRequest,
} from "@/components/task-pinboard-pin-reason-dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import { useRevealCanonicalTaskCard } from "@/hooks/use-reveal-canonical-task-card";
import { setTaskPinboardPinStateOfTaskCardInProject } from "@/runtime/cross-project-recently-active-task-switcher-query";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

/** Pinned 区默认露出的条数；超出部分由区底的按钮展开（同 Focus View 置顶板分段）。 */
const DEFAULT_VISIBLE_PINNED_ENTRY_COUNT_IN_CROSS_PROJECT_TASK_SWITCHER = 5;

const REMAINING_SECTION_ORDERING_MODE_LABELS: Record<CrossProjectTaskSwitcherRemainingSectionOrderingMode, string> = {
	most_recently_touched_by_conversation_progress_or_user_open_or_description_edit: "Last touched",
	unread_handoffs_then_recently_opened_by_user: "Unread + opened",
	most_recent_conversation_progress_only: "Conversation progress",
};

function splitCrossProjectTaskSwitcherEntryKey(entryKey: string): { workspaceId: string; taskId: string } {
	const separatorIndex = entryKey.indexOf(":");
	return { workspaceId: entryKey.slice(0, separatorIndex), taskId: entryKey.slice(separatorIndex + 1) };
}

// 跨项目置顶：当前项目的卡沿用浏览器链路（宿主给的三个回调）；其他项目的卡在这里弹同一个原因对话框，
// 确认后经 runtime 在目标项目的 board 锁内改写。结果随 projects_updated 广播回来，不在本地乐观改。
function useCrossProjectTaskPinboardPinning(host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue) {
	const [otherProjectPinReasonDialogRequest, setOtherProjectPinReasonDialogRequest] = useState<
		(TaskPinboardPinReasonDialogRequest & { workspaceId: string }) | null
	>(null);

	const submitOtherProjectPinStateChange = useCallback(
		(workspaceId: string, request: Parameters<typeof setTaskPinboardPinStateOfTaskCardInProject>[1]) => {
			void setTaskPinboardPinStateOfTaskCardInProject(workspaceId, request).catch((error: unknown) => {
				notifyError(`Could not update Pinboard: ${error instanceof Error ? error.message : String(error)}`);
			});
		},
		[],
	);

	const togglePinnedToTaskPinboard = useCallback(
		({ workspaceId, entry }: CrossProjectTaskSwitcherEntryInProject) => {
			const isPinned = entry.pinnedToTaskPinboardAt !== null;
			if (workspaceId === host.currentProjectId) {
				if (isPinned) {
					host.onUnpinCurrentProjectTaskFromTaskPinboard(entry.taskId);
				} else {
					host.onRequestPinCurrentProjectTaskToTaskPinboard(entry.taskId);
				}
				return;
			}
			if (isPinned) {
				submitOtherProjectPinStateChange(workspaceId, {
					taskPinboardPinAction: "unpin_task_card",
					taskId: entry.taskId,
				});
				return;
			}
			setOtherProjectPinReasonDialogRequest({
				workspaceId,
				taskId: entry.taskId,
				taskTitle: entry.title,
				isEditingExistingPin: false,
				initialPinReason: "",
			});
		},
		[host, submitOtherProjectPinStateChange],
	);

	const editTaskPinboardPinReason = useCallback(
		({ workspaceId, entry }: CrossProjectTaskSwitcherEntryInProject) => {
			if (workspaceId === host.currentProjectId) {
				host.onEditCurrentProjectTaskPinboardPinReason(entry.taskId);
				return;
			}
			setOtherProjectPinReasonDialogRequest({
				workspaceId,
				taskId: entry.taskId,
				taskTitle: entry.title,
				isEditingExistingPin: true,
				initialPinReason: entry.taskPinboardPinReason ?? "",
			});
		},
		[host],
	);

	const otherProjectPinReasonDialog = (
		<TaskPinboardPinReasonDialog
			request={otherProjectPinReasonDialogRequest}
			onCancel={() => setOtherProjectPinReasonDialogRequest(null)}
			onConfirm={(taskId, pinReason) => {
				const workspaceId = otherProjectPinReasonDialogRequest?.workspaceId;
				setOtherProjectPinReasonDialogRequest(null);
				if (!workspaceId) {
					return;
				}
				submitOtherProjectPinStateChange(workspaceId, {
					taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
					taskId,
					taskPinboardPinReason: pinReason,
				});
			}}
		/>
	);

	return { togglePinnedToTaskPinboard, editTaskPinboardPinReason, otherProjectPinReasonDialog };
}

function CrossProjectTaskSwitcherSectionFrame({
	header,
	children,
	testIdSuffix,
}: {
	header: ReactNode;
	children?: ReactNode;
	testIdSuffix: string;
}): ReactElement {
	return (
		<section
			className="flex shrink-0 flex-col rounded-lg border border-border bg-surface-1"
			data-testid={`cross-project-task-switcher-section-${testIdSuffix}`}
		>
			<div className="flex h-9 shrink-0 items-center gap-2 px-2">{header}</div>
			{children ? <div className="flex flex-col gap-0.5 px-1 pb-1.5">{children}</div> : null}
		</section>
	);
}

function CrossProjectTaskSwitcherSectionTitle({ title, count }: { title: string; count: number }): ReactElement {
	return (
		<>
			<span className="truncate text-[13px] font-semibold text-text-primary">{title}</span>
			<span className="text-xs text-text-tertiary">{count}</span>
		</>
	);
}

/**
 * Focus View 左栏的 All projects 模式：跨项目「最近活跃任务」切换面板（docs/context-cross-project-recently-active-task-switcher.md）。
 * 自上而下四个区：Pinned（可与下面重复）→ Running（默认收起）→ Cache warm · your turn（按失效时刻升序）→ 剩余区（三种排序）。
 * 区归属全在 src/core/cross-project-recently-active-task-switcher-section-assignment.ts，这里只渲染。
 */
export function CrossProjectRecentlyActiveTaskSwitcherPanel({
	host,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
}): ReactElement {
	const {
		sections,
		nowMs,
		unreadHandoffEntryKeys,
		remainingSectionOrderingMode,
		setRemainingSectionOrderingMode,
		isRunningSectionExpanded,
		setIsRunningSectionExpanded,
		extendedActivityHorizonLoadState,
		requestEntriesWithinExtendedActivityHorizon,
	} = useCrossProjectRecentlyActiveTaskSwitcherSections({
		projects: host.projects,
		notificationLogByWorkspaceId: host.notificationLogByWorkspaceId,
		currentProjectId: host.currentProjectId,
	});
	const { togglePinnedToTaskPinboard, editTaskPinboardPinReason, otherProjectPinReasonDialog } =
		useCrossProjectTaskPinboardPinning(host);
	// 跨重挂载保留（Focus View 左栏 ↔ 过渡外壳），见 cross-project-task-switcher-panel-view-continuity-store。
	const [showsAllPinnedEntries, setShowsAllPinnedEntriesState] = useState(
		() => readCrossProjectTaskSwitcherPanelViewContinuity().showsAllPinnedEntries,
	);
	const setShowsAllPinnedEntries = (nextShowsAllPinnedEntries: boolean) => {
		writeCrossProjectTaskSwitcherPanelViewContinuity({ showsAllPinnedEntries: nextShowsAllPinnedEntries });
		setShowsAllPinnedEntriesState(nextShowsAllPinnedEntries);
	};
	const panelScrollContainerRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		if (panelScrollContainerRef.current) {
			panelScrollContainerRef.current.scrollTop = readCrossProjectTaskSwitcherPanelViewContinuity().panelScrollTopPx;
		}
	}, []);
	const [isPinnedSectionCollapsed, setIsPinnedSectionCollapsed] = useBooleanLocalStorageValue(
		LocalStorageKey.CrossProjectTaskSwitcherPinnedSectionCollapsed,
		false,
	);

	// Pinned 点击：打开任务，并把它在下方区里的那一行滚进视野、脉冲高亮（同 Focus View 置顶板「跳回本体卡」）。
	// 目标在折叠的 Running 区里时先展开。
	const runningEntryKeys = new Set(
		sections.runningEntries.map(({ workspaceId, entry }) =>
			buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId),
		),
	);
	const { requestRevealCanonicalTaskCard: requestRevealSectionRow } = useRevealCanonicalTaskCard({
		prepareRevealTarget: (entryKey) => {
			if (runningEntryKeys.has(entryKey)) {
				setIsRunningSectionExpanded(true);
			}
		},
		resolveRevealTargetAnchorKey: (entryKey) => {
			const { workspaceId, taskId } = splitCrossProjectTaskSwitcherEntryKey(entryKey);
			return crossProjectTaskSwitcherSectionRowAnchorKey(workspaceId, taskId);
		},
	});

	const showsProjectName = new Set(host.projects.map((project) => project.id)).size > 1;
	const renderRow = (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
		extra: Partial<Parameters<typeof CrossProjectRecentlyActiveTaskSwitcherTaskRow>[0]> = {},
	): ReactElement => {
		const { workspaceId, entry } = entryInProject;
		const entryKey = buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId);
		return (
			<CrossProjectRecentlyActiveTaskSwitcherTaskRow
				key={`${section}:${entryKey}`}
				entryInProject={entryInProject}
				section={section}
				isFocused={
					host.focusedTaskInProject?.workspaceId === workspaceId &&
					host.focusedTaskInProject.taskId === entry.taskId
				}
				isUnreadHandoff={unreadHandoffEntryKeys.has(entryKey)}
				nowMs={nowMs}
				showsProjectName={showsProjectName}
				onOpen={() => {
					host.onOpenTaskInProject(workspaceId, entry.taskId);
					if (section === "pinned") {
						requestRevealSectionRow(entryKey);
					}
				}}
				onTogglePinnedToTaskPinboard={() => togglePinnedToTaskPinboard(entryInProject)}
				onEditTaskPinboardPinReason={
					section === "pinned" ? () => editTaskPinboardPinReason(entryInProject) : undefined
				}
				{...extra}
			/>
		);
	};

	const visiblePinnedEntries = showsAllPinnedEntries
		? sections.pinnedEntries
		: sections.pinnedEntries.slice(0, DEFAULT_VISIBLE_PINNED_ENTRY_COUNT_IN_CROSS_PROJECT_TASK_SWITCHER);
	const hiddenPinnedEntryCount = sections.pinnedEntries.length - visiblePinnedEntries.length;
	const remainingSection = sections.remainingSection;
	const remainingEntryCount =
		remainingSection.orderingMode === "unread_handoffs_then_recently_opened_by_user"
			? remainingSection.unreadHandoffEntries.length + remainingSection.recentlyOpenedByUserEntries.length
			: remainingSection.entries.length;

	return (
		<div
			ref={panelScrollContainerRef}
			onScroll={(event) =>
				writeCrossProjectTaskSwitcherPanelViewContinuity({ panelScrollTopPx: event.currentTarget.scrollTop })
			}
			className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2"
			data-testid="cross-project-recently-active-task-switcher-panel"
		>
			{sections.pinnedEntries.length > 0 ? (
				<CrossProjectTaskSwitcherSectionFrame
					testIdSuffix="pinned"
					header={
						<button
							type="button"
							onClick={() => setIsPinnedSectionCollapsed((previous) => !previous)}
							aria-expanded={!isPinnedSectionCollapsed}
							className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-none bg-transparent text-left text-inherit"
						>
							{isPinnedSectionCollapsed ? (
								<ChevronRight size={14} className="shrink-0 text-text-secondary" />
							) : (
								<ChevronDown size={14} className="shrink-0 text-text-secondary" />
							)}
							<Pin size={13} className="shrink-0 text-accent" />
							<CrossProjectTaskSwitcherSectionTitle title="Pinned" count={sections.pinnedEntries.length} />
						</button>
					}
				>
					{isPinnedSectionCollapsed ? null : (
						<>
							{visiblePinnedEntries.map((entryInProject) => renderRow(entryInProject, "pinned"))}
							{hiddenPinnedEntryCount > 0 || showsAllPinnedEntries ? (
								<button
									type="button"
									onClick={() => setShowsAllPinnedEntries(!showsAllPinnedEntries)}
									className="flex cursor-pointer items-center justify-center gap-1 rounded-md border-none bg-transparent py-1 text-xs text-text-tertiary hover:bg-surface-3 hover:text-text-secondary"
								>
									{showsAllPinnedEntries ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
									{showsAllPinnedEntries ? "Show less" : `Show ${hiddenPinnedEntryCount} more`}
								</button>
							) : null}
						</>
					)}
				</CrossProjectTaskSwitcherSectionFrame>
			) : null}

			<CrossProjectTaskSwitcherSectionFrame
				testIdSuffix="running"
				header={
					<button
						type="button"
						onClick={() => setIsRunningSectionExpanded(!isRunningSectionExpanded)}
						aria-expanded={isRunningSectionExpanded}
						disabled={sections.runningEntries.length === 0}
						className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-none bg-transparent text-left text-inherit disabled:cursor-default"
					>
						{isRunningSectionExpanded ? (
							<ChevronDown size={14} className="shrink-0 text-text-secondary" />
						) : (
							<ChevronRight size={14} className="shrink-0 text-text-secondary" />
						)}
						<CrossProjectTaskSwitcherSectionTitle title="Running" count={sections.runningEntries.length} />
					</button>
				}
			>
				{isRunningSectionExpanded && sections.runningEntries.length > 0
					? sections.runningEntries.map((entryInProject) => renderRow(entryInProject, "running"))
					: null}
			</CrossProjectTaskSwitcherSectionFrame>

			<CrossProjectTaskSwitcherSectionFrame
				testIdSuffix="prompt-cache-warm"
				header={
					<>
						<Flame size={13} className="shrink-0 text-status-orange" />
						<CrossProjectTaskSwitcherSectionTitle
							title="Cache warm · your turn"
							count={sections.promptCacheWarmAwaitingUserEntries.length}
						/>
					</>
				}
			>
				{sections.promptCacheWarmAwaitingUserEntries.length > 0 ? (
					sections.promptCacheWarmAwaitingUserEntries.map((entryInProject) =>
						renderRow(entryInProject, "prompt_cache_warm", {
							promptCacheWarmthEstimate: entryInProject.promptCacheWarmthEstimate,
						}),
					)
				) : (
					<div className="px-2 py-1.5 text-xs text-text-tertiary">No warm prompt caches waiting on you.</div>
				)}
			</CrossProjectTaskSwitcherSectionFrame>

			<CrossProjectTaskSwitcherSectionFrame
				testIdSuffix="remaining"
				header={
					<>
						<History size={13} className="shrink-0 text-text-secondary" />
						<CrossProjectTaskSwitcherSectionTitle title="Recent" count={remainingEntryCount} />
						<NativeSelect
							size="sm"
							aria-label="Order recent tasks by"
							containerClassName="ml-auto min-w-0"
							className="h-6 max-w-[150px] text-[11px]"
							value={remainingSectionOrderingMode}
							onChange={(event) =>
								setRemainingSectionOrderingMode(
									event.target.value as CrossProjectTaskSwitcherRemainingSectionOrderingMode,
								)
							}
						>
							{Object.entries(REMAINING_SECTION_ORDERING_MODE_LABELS).map(([mode, label]) => (
								<option key={mode} value={mode}>
									{label}
								</option>
							))}
						</NativeSelect>
					</>
				}
			>
				{remainingSection.orderingMode === "unread_handoffs_then_recently_opened_by_user" ? (
					<>
						<div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
							Unread
						</div>
						{remainingSection.unreadHandoffEntries.length > 0 ? (
							remainingSection.unreadHandoffEntries.map((entryInProject) =>
								renderRow(entryInProject, "remaining"),
							)
						) : (
							<div className="px-2 py-1 text-xs text-text-tertiary">No unread handoffs.</div>
						)}
						<div className="px-2 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
							Recently opened
						</div>
						{remainingSection.recentlyOpenedByUserEntries.length > 0 ? (
							remainingSection.recentlyOpenedByUserEntries.map((entryInProject) =>
								renderRow(entryInProject, "remaining"),
							)
						) : (
							<div className="px-2 py-1 text-xs text-text-tertiary">Nothing opened recently.</div>
						)}
					</>
				) : remainingSection.entries.length > 0 ? (
					remainingSection.entries.map((entryInProject) => renderRow(entryInProject, "remaining"))
				) : (
					<div className="px-2 py-1.5 text-xs text-text-tertiary">No other recent tasks.</div>
				)}
				{extendedActivityHorizonLoadState === "loaded" ? null : (
					<button
						type="button"
						onClick={requestEntriesWithinExtendedActivityHorizon}
						disabled={extendedActivityHorizonLoadState === "loading"}
						className="mt-1 flex cursor-pointer items-center justify-center gap-1.5 rounded-md border-none bg-transparent py-1 text-xs text-text-tertiary hover:bg-surface-3 hover:text-text-secondary disabled:cursor-default"
					>
						{extendedActivityHorizonLoadState === "loading" ? <Spinner size={12} /> : null}
						{extendedActivityHorizonLoadState === "failed"
							? "Could not load older tasks · Retry"
							: "Show older (last 30 days)"}
					</button>
				)}
			</CrossProjectTaskSwitcherSectionFrame>
			{otherProjectPinReasonDialog}
		</div>
	);
}
