import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherRemainingSectionOrderingMode,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { ChevronDown, ChevronRight, ChevronUp, Flame, History, Pin } from "lucide-react";
import {
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { notifyError } from "@/components/app-toaster";
import type { CrossProjectTaskSwitcherFullTaskCardInListExpansionState } from "@/components/detail-panels/cross-project-recently-active-task-switcher-full-task-card-in-list-expansion-toggle-button";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import {
	CrossProjectRecentlyActiveTaskSwitcherTaskRow,
	type CrossProjectTaskSwitcherTaskRowSection,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";
import {
	CrossProjectRecentlyActiveTaskSwitcherTaskRowExpandedTaskCard,
	type CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row-expanded-task-card";
import { crossProjectTaskSwitcherSectionRowAnchorKey } from "@/components/post-deploy-verification/verification-anchor-registry";
import {
	TaskPinboardPinReasonDialog,
	type TaskPinboardPinReasonDialogRequest,
} from "@/components/task-pinboard-pin-reason-dialog";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import {
	isSameCrossProjectTaskSwitcherRow,
	useCrossProjectTaskSwitcherRowHoverExpansionInPlace,
} from "@/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import {
	collectEntriesShownInCrossProjectTaskSwitcherSections,
	useCrossProjectTaskWorktreeGitMetadataPolling,
} from "@/hooks/use-cross-project-task-worktree-git-metadata-polling";
import { useRevealCanonicalTaskCard } from "@/hooks/use-reveal-canonical-task-card";
import { useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "@/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import type { RuntimeAgentId } from "@/runtime/types";
import { setTaskPinboardPinStateOfTaskCardThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import type { BoardCard } from "@/types";
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

// 跨项目置顶：当前项目的卡走宿主给的三个回调（原因对话框由宿主弹，命令带 overlay）；其他项目的卡在这里弹同一个
// 原因对话框，确认后调同一个 taskCardAction 命令（不带 overlay，结果随 projects_updated 广播回来）。
function useCrossProjectTaskPinboardPinning(host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue) {
	const [otherProjectPinReasonDialogRequest, setOtherProjectPinReasonDialogRequest] = useState<
		(TaskPinboardPinReasonDialogRequest & { workspaceId: string }) | null
	>(null);

	const submitOtherProjectPinStateChange = useCallback(
		(
			workspaceId: string,
			taskId: string,
			taskPinboardPinChange: Parameters<
				typeof setTaskPinboardPinStateOfTaskCardThroughRuntime
			>[0]["taskPinboardPinChange"],
		) => {
			void setTaskPinboardPinStateOfTaskCardThroughRuntime({ workspaceId, taskId, taskPinboardPinChange }).then(
				(result) => {
					if (result.taskCardActionCommandExecutionOutcome === "command_failed") {
						notifyError(`Could not update Pinboard: ${result.commandFailureMessage}`);
					}
				},
			);
		},
		[],
	);

	const requestPinTaskCardInOtherProjectToTaskPinboard = useCallback(
		(workspaceId: string, taskId: string, taskTitle: string) => {
			setOtherProjectPinReasonDialogRequest({
				workspaceId,
				taskId,
				taskTitle,
				isEditingExistingPin: false,
				initialPinReason: "",
			});
		},
		[],
	);

	const unpinTaskCardInOtherProjectFromTaskPinboard = useCallback(
		(workspaceId: string, taskId: string) => {
			submitOtherProjectPinStateChange(workspaceId, taskId, { taskPinboardPinAction: "unpin_task_card" });
		},
		[submitOtherProjectPinStateChange],
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
				unpinTaskCardInOtherProjectFromTaskPinboard(workspaceId, entry.taskId);
				return;
			}
			requestPinTaskCardInOtherProjectToTaskPinboard(workspaceId, entry.taskId, entry.title);
		},
		[host, requestPinTaskCardInOtherProjectToTaskPinboard, unpinTaskCardInOtherProjectFromTaskPinboard],
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
				submitOtherProjectPinStateChange(workspaceId, taskId, {
					taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
					taskPinboardPinReason: pinReason,
				});
			}}
		/>
	);

	return {
		togglePinnedToTaskPinboard,
		editTaskPinboardPinReason,
		requestPinTaskCardInOtherProjectToTaskPinboard,
		unpinTaskCardInOtherProjectFromTaskPinboard,
		otherProjectPinReasonDialog,
	};
}

// 用户点了「Keep expanded in list」、原地换成完整卡片的行（按任务记，Pinned 与下方区同一个任务一起换），跨重挂载保留。
function useCrossProjectTaskSwitcherRowsKeptExpandedInListAsFullTaskCardByUser(): {
	entryKeysKeptExpandedInListAsFullTaskCardByUser: ReadonlySet<string>;
	setEntryKeptExpandedInListAsFullTaskCardByUser: (entryKey: string, isKeptExpandedInList: boolean) => void;
} {
	const [entryKeysKeptExpandedInListAsFullTaskCardByUser, setEntryKeysKeptExpandedInListAsFullTaskCardByUser] =
		useState<ReadonlySet<string>>(
			() =>
				new Set(
					readCrossProjectTaskSwitcherPanelViewContinuity()
						.crossProjectTaskSwitcherEntryKeysKeptExpandedInListAsFullTaskCardByUser,
				),
		);
	const setEntryKeptExpandedInListAsFullTaskCardByUser = useCallback(
		(entryKey: string, isKeptExpandedInList: boolean) => {
			setEntryKeysKeptExpandedInListAsFullTaskCardByUser((previousEntryKeys) => {
				if (previousEntryKeys.has(entryKey) === isKeptExpandedInList) {
					return previousEntryKeys;
				}
				const nextEntryKeys = new Set(previousEntryKeys);
				if (isKeptExpandedInList) {
					nextEntryKeys.add(entryKey);
				} else {
					nextEntryKeys.delete(entryKey);
				}
				return nextEntryKeys;
			});
		},
		[],
	);
	// 写记忆放在提交之后，不在 updater 里做副作用。
	useEffect(() => {
		writeCrossProjectTaskSwitcherPanelViewContinuity({
			crossProjectTaskSwitcherEntryKeysKeptExpandedInListAsFullTaskCardByUser: [
				...entryKeysKeptExpandedInListAsFullTaskCardByUser,
			],
		});
	}, [entryKeysKeptExpandedInListAsFullTaskCardByUser]);
	return { entryKeysKeptExpandedInListAsFullTaskCardByUser, setEntryKeptExpandedInListAsFullTaskCardByUser };
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
	currentProjectTaskCards = null,
	defaultAgentId = null,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	// Focus View 左栏挂载时由 ColumnContextPanel 给出（当前项目的展开行与 This project 同数据、同动作）；
	// 过渡外壳里没有，当前项目的展开行改读服务端。
	currentProjectTaskCards?: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	defaultAgentId?: RuntimeAgentId | null;
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
	const {
		togglePinnedToTaskPinboard,
		editTaskPinboardPinReason,
		requestPinTaskCardInOtherProjectToTaskPinboard,
		unpinTaskCardInOtherProjectFromTaskPinboard,
		otherProjectPinReasonDialog,
	} = useCrossProjectTaskPinboardPinning(host);
	const { entryKeysKeptExpandedInListAsFullTaskCardByUser, setEntryKeptExpandedInListAsFullTaskCardByUser } =
		useCrossProjectTaskSwitcherRowsKeptExpandedInListAsFullTaskCardByUser();
	const panelScrollContainerRef = useRef<HTMLDivElement | null>(null);
	const {
		rowExpandedInPlaceByHover,
		rowWithPendingHoverIntent,
		buildRowHoverExpansionTriggerProps,
		panelPointerHandlers,
		cancelPendingHoverIntent,
		suppressHoverExpansionUntilPointerLeavesRow,
		forgetHoverExpansionOfRowNowKeptExpandedInList,
		panelTopSpacerKeepingHoverAnchorRowInPlacePx,
	} = useCrossProjectTaskSwitcherRowHoverExpansionInPlace({ panelScrollContainerRef });
	// 点 backlog 行 = 原地打开编辑对话框（不切项目、不离开 Focus View），与 This project 点 backlog 卡同语义。
	const { onOpenBacklogTaskEditorInProject } = host;
	const requestPinTaskCardInOtherProjectFromExpandedTaskCard = useCallback(
		(workspaceId: string, taskCard: BoardCard) =>
			requestPinTaskCardInOtherProjectToTaskPinboard(workspaceId, taskCard.id, taskCard.title),
		[requestPinTaskCardInOtherProjectToTaskPinboard],
	);
	const requestEditBacklogTaskCardInOtherProjectFromExpandedTaskCard = useMemo(
		() =>
			onOpenBacklogTaskEditorInProject
				? (workspaceId: string, taskCard: BoardCard) => onOpenBacklogTaskEditorInProject(workspaceId, taskCard.id)
				: undefined,
		[onOpenBacklogTaskEditorInProject],
	);
	const { buildTaskCardActionHandlerBundleForOtherProjectTaskCard, otherProjectTaskCardActionConfirmationDialogs } =
		useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
			onRequestPinTaskCardInOtherProjectToTaskPinboard: requestPinTaskCardInOtherProjectFromExpandedTaskCard,
			onUnpinTaskCardInOtherProjectFromTaskPinboard: unpinTaskCardInOtherProjectFromTaskPinboard,
			onRequestEditBacklogTaskCardInOtherProject: requestEditBacklogTaskCardInOtherProjectFromExpandedTaskCard,
		});
	const projectPathByWorkspaceId = useMemo(
		() => new Map(host.projects.map((project) => [project.id, project.path])),
		[host.projects],
	);
	// 其他项目行的 git 元数据（ahead/behind、未提交改动）只在面板挂载且页面可见时轮询；当前项目的行读推流 store。
	const entriesShownInSections = useMemo(
		() => collectEntriesShownInCrossProjectTaskSwitcherSections(sections),
		[sections],
	);
	useCrossProjectTaskWorktreeGitMetadataPolling({
		entriesInProjects: entriesShownInSections,
		currentProjectId: host.currentProjectId,
	});
	// 跨重挂载保留（Focus View 左栏 ↔ 过渡外壳），见 cross-project-task-switcher-panel-view-continuity-store。
	const [showsAllPinnedEntries, setShowsAllPinnedEntriesState] = useState(
		() => readCrossProjectTaskSwitcherPanelViewContinuity().showsAllPinnedEntries,
	);
	const setShowsAllPinnedEntries = (nextShowsAllPinnedEntries: boolean) => {
		writeCrossProjectTaskSwitcherPanelViewContinuity({ showsAllPinnedEntries: nextShowsAllPinnedEntries });
		setShowsAllPinnedEntriesState(nextShowsAllPinnedEntries);
	};
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
	// Cache warm 药丸只画在 Cache warm 区的行上（同一个任务在 Pinned / Running 的行不画），完整卡片跟着行走。
	const findPromptCacheWarmthEstimateShownOnRow = (
		entryKey: string,
		section: CrossProjectTaskSwitcherTaskRowSection,
	) =>
		section === "prompt_cache_warm"
			? sections.promptCacheWarmAwaitingUserEntries.find(
					({ workspaceId, entry }) =>
						buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId) === entryKey,
				)?.promptCacheWarmthEstimate
			: undefined;
	// 点一行 = 打开任务。精简行、hover 展开的完整卡片、固定展开的完整卡片三处都调它，结果必须一致。
	const activateRow = (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
	) => {
		const { workspaceId, entry } = entryInProject;
		// 已经点了：待发的 hover 意图作废。已经 hover 展开的行不收起——收起会让列表在指针下移动。
		cancelPendingHoverIntent();
		if (entry.columnId === "backlog" && onOpenBacklogTaskEditorInProject) {
			onOpenBacklogTaskEditorInProject(workspaceId, entry.taskId);
			return;
		}
		host.onOpenTaskInProject(workspaceId, entry.taskId);
		if (section === "pinned") {
			requestRevealSectionRow(buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId));
		}
	};
	const keepEntryExpandedInListAsFullTaskCard = (entryKey: string) => {
		cancelPendingHoverIntent();
		// 正是 hover 展开的那一行：转成固定展开，形态不变、不移动；hover 记录清掉，免得之后收起时又落回 hover 展开。
		// 别的行的 hover 展开留着（现在收它会让列表在指针下移动），等交接或指针离开面板时再收。
		if (rowExpandedInPlaceByHover?.rowIdentity.entryKey === entryKey) {
			forgetHoverExpansionOfRowNowKeptExpandedInList();
		}
		setEntryKeptExpandedInListAsFullTaskCardByUser(entryKey, true);
	};
	const collapseEntryBackToCompactRow = (entryKey: string) => {
		// 收起后指针还停在这一行上：不能一动又原地展开。
		suppressHoverExpansionUntilPointerLeavesRow(entryKey);
		setEntryKeptExpandedInListAsFullTaskCardByUser(entryKey, false);
	};
	// hover 展开与固定展开同一张完整卡片，带上这一行的行级信息、激活与展开开关。
	const renderFullTaskCard = (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
		inListExpansionState: CrossProjectTaskSwitcherFullTaskCardInListExpansionState,
		isPresentedAsHoveredFromFirstFrame: boolean,
	): ReactElement => {
		const entryKey = buildCrossProjectTaskSwitcherEntryKey(entryInProject.workspaceId, entryInProject.entry.taskId);
		return (
			<CrossProjectRecentlyActiveTaskSwitcherTaskRowExpandedTaskCard
				entryInProject={entryInProject}
				currentProjectId={host.currentProjectId}
				currentProjectTaskCards={currentProjectTaskCards}
				otherProjectWorkspacePath={projectPathByWorkspaceId.get(entryInProject.workspaceId) ?? null}
				defaultAgentId={defaultAgentId}
				buildTaskCardActionHandlerBundleForOtherProjectTaskCard={
					buildTaskCardActionHandlerBundleForOtherProjectTaskCard
				}
				rowContext={{
					section,
					isUnreadHandoff: unreadHandoffEntryKeys.has(entryKey),
					projectName: showsProjectName ? entryInProject.projectName : null,
					promptCacheWarmthEstimate: findPromptCacheWarmthEstimateShownOnRow(entryKey, section),
					nowMs,
					inListExpansionState,
					onToggleInListExpansion: () =>
						inListExpansionState === "kept_expanded_in_list"
							? collapseEntryBackToCompactRow(entryKey)
							: keepEntryExpandedInListAsFullTaskCard(entryKey),
					onActivateRow: () => activateRow(entryInProject, section),
					isPresentedAsHoveredFromFirstFrame,
				}}
			/>
		);
	};
	const renderRow = (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
	): ReactElement => {
		const { workspaceId, entry } = entryInProject;
		const entryKey = buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId);
		const rowIdentity = { entryKey, section };
		const isKeptExpandedInListAsFullTaskCardByUser = entryKeysKeptExpandedInListAsFullTaskCardByUser.has(entryKey);
		const isExpandedInPlaceByHover =
			!isKeptExpandedInListAsFullTaskCardByUser &&
			isSameCrossProjectTaskSwitcherRow(rowExpandedInPlaceByHover?.rowIdentity ?? null, rowIdentity);
		const hasPendingHoverIntent =
			!isKeptExpandedInListAsFullTaskCardByUser &&
			isSameCrossProjectTaskSwitcherRow(rowWithPendingHoverIntent, rowIdentity);
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
				promptCacheWarmthEstimate={findPromptCacheWarmthEstimateShownOnRow(entryKey, section)}
				showsProjectName={showsProjectName}
				currentProjectId={host.currentProjectId}
				inPlaceExpansionState={
					isKeptExpandedInListAsFullTaskCardByUser
						? "kept_expanded_in_list"
						: isExpandedInPlaceByHover
							? "expanded_in_place_by_hover"
							: "compact_row"
				}
				fullTaskCard={
					isKeptExpandedInListAsFullTaskCardByUser || isExpandedInPlaceByHover || hasPendingHoverIntent
						? renderFullTaskCard(
								entryInProject,
								section,
								isKeptExpandedInListAsFullTaskCardByUser ? "kept_expanded_in_list" : "collapsed_to_compact_row",
								isExpandedInPlaceByHover && rowExpandedInPlaceByHover?.isPointerOverRow === true,
							)
						: undefined
				}
				onKeepExpandedInListAsFullTaskCard={() => keepEntryExpandedInListAsFullTaskCard(entryKey)}
				rowHoverExpansionTriggerProps={buildRowHoverExpansionTriggerProps(
					rowIdentity,
					isKeptExpandedInListAsFullTaskCardByUser ? "kept_expanded_in_list" : "compact_row",
				)}
				onOpen={() => activateRow(entryInProject, section)}
				onTogglePinnedToTaskPinboard={() => togglePinnedToTaskPinboard(entryInProject)}
				onEditTaskPinboardPinReason={
					section === "pinned" ? () => editTaskPinboardPinReason(entryInProject) : undefined
				}
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
			onPointerEnter={panelPointerHandlers.onPointerEnter}
			onPointerLeave={panelPointerHandlers.onPointerLeave}
			// overflow-anchor: none —— hover 原地展开 / 交接时由 use-cross-project-task-switcher-row-hover-expansion-in-place
			// 自己补 scrollTop，浏览器自带的 scroll anchoring 再补一次就会叠加。
			className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain p-2 [overflow-anchor:none]"
			// 交接时 scrollTop 不够补的差额（见 hook）：p-2 之外再垫这么多。
			style={
				panelTopSpacerKeepingHoverAnchorRowInPlacePx > 0
					? { paddingTop: `calc(0.5rem + ${panelTopSpacerKeepingHoverAnchorRowInPlacePx}px)` }
					: undefined
			}
			data-testid="cross-project-recently-active-task-switcher-panel"
		>
			{/* 与 This project 左栏同一个入口样式；Board Scope 下打开带目标项目字段的建卡框（默认上下文项目）。 */}
			{host.onRequestCreateTaskInBoardScope ? (
				<Button
					icon={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
					aria-label="Create task"
					fill
					onClick={host.onRequestCreateTaskInBoardScope}
					className="shrink-0"
				>
					<span className="inline-flex items-center gap-1.5">
						<span>Create task</span>
						<span aria-hidden className="text-text-secondary">
							(c)
						</span>
					</span>
				</Button>
			) : null}
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
						renderRow(entryInProject, "prompt_cache_warm"),
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
			{otherProjectTaskCardActionConfirmationDialogs}
		</div>
	);
}
