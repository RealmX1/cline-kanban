import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherEntryInProject,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { notifyError } from "@/components/app-toaster";
import type { CrossProjectTaskSwitcherFullTaskCardInListExpansionState } from "@/components/detail-panels/cross-project-recently-active-task-switcher-full-task-card-in-list-expansion-toggle-button";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import type { CrossProjectTaskSwitcherSectionBlockPresentation } from "@/components/detail-panels/cross-project-recently-active-task-switcher-section-blocks";
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
import type { CrossProjectRecentlyActiveTaskSwitcherSectionsModel } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import {
	isSameCrossProjectTaskSwitcherRow,
	type useCrossProjectTaskSwitcherRowHoverExpansionInPlace,
} from "@/hooks/use-cross-project-task-switcher-row-hover-expansion-in-place";
import {
	collectEntriesShownInCrossProjectTaskSwitcherSections,
	useCrossProjectTaskWorktreeGitMetadataPolling,
} from "@/hooks/use-cross-project-task-worktree-git-metadata-polling";
import { useRevealCanonicalTaskCard } from "@/hooks/use-reveal-canonical-task-card";
import { useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "@/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import type { RuntimeAgentId } from "@/runtime/types";
import { setTaskPinboardPinStateOfTaskCardThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import {
	readCrossProjectTaskSwitcherPanelViewContinuity,
	writeCrossProjectTaskSwitcherPanelViewContinuity,
} from "@/stores/cross-project-task-switcher-panel-view-continuity-store";
import type { BoardCard } from "@/types";

/**
 * 一个滚动容器自己的那份 hover 原地展开（每个滚动容器一个 hook 实例：Focus View 左栏面板整个是一个，
 * All projects 首页每列一个）。行的激活、固定展开 / 收起都要作用在这一行所在的那个容器上。
 */
export type CrossProjectTaskSwitcherRowHoverExpansionOfHostingScrollContainer = ReturnType<
	typeof useCrossProjectTaskSwitcherRowHoverExpansionInPlace
>;

export interface CrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers {
	sectionsModel: CrossProjectRecentlyActiveTaskSwitcherSectionsModel;
	renderCrossProjectTaskSwitcherSectionRow: (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
		rowHoverExpansionOfHostingScrollContainer: CrossProjectTaskSwitcherRowHoverExpansionOfHostingScrollContainer,
		focusedTaskScrollAnchorKey?: string,
	) => ReactElement;
	pinReasonDialogAndOtherProjectConfirmationDialogs: ReactNode;
}

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
// Focus View 左栏面板与 All projects 首页读写同一个记忆：首页固定展开的卡，进了 Focus View 左栏同样展开。
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

/**
 * 跨项目切换面板的区数据与「一行怎么画、点了做什么」，每个呈现面（Focus View 左栏面板 / All projects 首页列看板）
 * 只建一份：区归属、置顶、固定展开集合、其他项目卡的动作与确认对话框、git 元数据轮询都在这里。
 *
 * 滚动容器与 hover 原地展开不在这里：一个呈现面可以有多个滚动容器（首页每列一个），每个容器各持一个
 * `useCrossProjectTaskSwitcherRowHoverExpansionInPlace`，渲染行时把所在容器的那份传进来。
 */
export function useCrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers({
	host,
	currentProjectTaskCards,
	defaultAgentId,
	sectionBlockPresentation,
}: {
	host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue;
	// Focus View 左栏挂载时由 ColumnContextPanel 给出、首页由 App 给出（当前项目的展开行与 This project 同数据、
	// 同动作）；过渡外壳里没有，当前项目的展开行改读服务端。
	currentProjectTaskCards: CurrentProjectTaskCardsForCrossProjectTaskSwitcherRowExpansion | null;
	defaultAgentId: RuntimeAgentId | null;
	sectionBlockPresentation: CrossProjectTaskSwitcherSectionBlockPresentation;
}): CrossProjectTaskSwitcherSectionRowRenderingSharedAcrossScrollContainers {
	const sectionsModel = host.crossProjectTaskSwitcherSectionsModel;
	if (!sectionsModel) throw new Error("跨项目任务切换面板缺少共享分区模型");
	const { sections, nowMs, unreadHandoffEntryKeys, setIsRunningSectionExpanded } = sectionsModel;
	const {
		togglePinnedToTaskPinboard,
		editTaskPinboardPinReason,
		requestPinTaskCardInOtherProjectToTaskPinboard,
		unpinTaskCardInOtherProjectFromTaskPinboard,
		otherProjectPinReasonDialog,
	} = useCrossProjectTaskPinboardPinning(host);
	const { entryKeysKeptExpandedInListAsFullTaskCardByUser, setEntryKeptExpandedInListAsFullTaskCardByUser } =
		useCrossProjectTaskSwitcherRowsKeptExpandedInListAsFullTaskCardByUser();
	// 点 backlog 行 = 原地打开编辑对话框（不切项目、不离开当前页面），与 This project 点 backlog 卡同语义。
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
	const localOtherProjectTaskCardActionHandlers =
		useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
			onRequestPinTaskCardInOtherProjectToTaskPinboard: requestPinTaskCardInOtherProjectFromExpandedTaskCard,
			onUnpinTaskCardInOtherProjectFromTaskPinboard: unpinTaskCardInOtherProjectFromTaskPinboard,
			onRequestEditBacklogTaskCardInOtherProject: requestEditBacklogTaskCardInOtherProjectFromExpandedTaskCard,
			onOpenTaskInProject: host.onOpenTaskInProject,
		});
	const otherProjectTaskCardActionConfirmationDialogs = host.otherProjectTaskCardActionHandlers
		? null
		: localOtherProjectTaskCardActionHandlers.otherProjectTaskCardActionConfirmationDialogs;
	const buildTaskCardActionHandlerBundleForOtherProjectTaskCard: typeof localOtherProjectTaskCardActionHandlers.buildTaskCardActionHandlerBundleForOtherProjectTaskCard =
		(input) => {
			const localHandlers =
				localOtherProjectTaskCardActionHandlers.buildTaskCardActionHandlerBundleForOtherProjectTaskCard(input);
			if (!host.otherProjectTaskCardActionHandlers) return localHandlers;
			return {
				...host.otherProjectTaskCardActionHandlers.buildTaskCardActionHandlerBundleForOtherProjectTaskCard(input),
				onEditTask: localHandlers.onEditTask,
				onRequestPinToTaskPinboard: localHandlers.onRequestPinToTaskPinboard,
				onUnpinFromTaskPinboard: localHandlers.onUnpinFromTaskPinboard,
				onSetTaskShelvingState: localHandlers.onSetTaskShelvingState,
			};
		};
	const projectPathByWorkspaceId = useMemo(
		() => new Map(host.projects.map((project) => [project.id, project.path])),
		[host.projects],
	);
	// 其他项目行的 git 元数据（ahead/behind、未提交改动）只在呈现面挂载且页面可见时轮询；当前项目的行读推流 store。
	const entriesNeedingWorktreeGitMetadataPolling = useMemo(
		() =>
			collectEntriesShownInCrossProjectTaskSwitcherSections(sectionsModel.sectionsBeforeRecentWorktreeChangesFilter),
		[sectionsModel.sectionsBeforeRecentWorktreeChangesFilter],
	);
	useCrossProjectTaskWorktreeGitMetadataPolling({
		entriesInProjects: entriesNeedingWorktreeGitMetadataPolling,
		currentProjectId: host.currentProjectId,
	});

	// Pinned 点击：打开任务，并把它在下方区里的那一行滚进视野、脉冲高亮（同 Focus View 置顶板「跳回本体卡」）。
	// 目标在折叠的 Running 区里时先展开。只在 Focus View 左栏面板里做：首页点行就进了 Focus View，首页随即卸载，
	// 而且首页的 Running 列不折叠——在那里展开会顺手改掉左栏 Running 区的收起偏好。
	const revealsSectionRowWhenPinnedRowActivated =
		sectionBlockPresentation === "stacked_section_in_focus_view_left_column_panel";
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
		rowHoverExpansionOfHostingScrollContainer: CrossProjectTaskSwitcherRowHoverExpansionOfHostingScrollContainer,
	) => {
		const { workspaceId, entry } = entryInProject;
		// 已经点了：待发的 hover 意图作废。已经 hover 展开的行保留，让卡体及其打开的弹窗继续交互。
		rowHoverExpansionOfHostingScrollContainer.cancelPendingHoverIntent();
		if (entry.columnId === "backlog" && !entry.taskShelvingState?.isShelved && onOpenBacklogTaskEditorInProject) {
			onOpenBacklogTaskEditorInProject(workspaceId, entry.taskId);
			return;
		}
		host.onOpenTaskInProject(workspaceId, entry.taskId);
		if (section === "pinned" && revealsSectionRowWhenPinnedRowActivated) {
			requestRevealSectionRow(buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId));
		}
	};
	const keepEntryExpandedInListAsFullTaskCard = (
		entryKey: string,
		rowHoverExpansionOfHostingScrollContainer: CrossProjectTaskSwitcherRowHoverExpansionOfHostingScrollContainer,
	) => {
		rowHoverExpansionOfHostingScrollContainer.cancelPendingHoverIntent();
		// 正是 hover 展开的那一行：转成完整高度占位，hover 记录清掉，免得之后收起时又落回 hover 展开。
		// 其他行的 hover 展开仍按指针离开与焦点保留规则收起。
		if (rowHoverExpansionOfHostingScrollContainer.rowExpandedInPlaceByHover?.rowIdentity.entryKey === entryKey) {
			rowHoverExpansionOfHostingScrollContainer.forgetHoverExpansionOfRowNowKeptExpandedInList();
		}
		setEntryKeptExpandedInListAsFullTaskCardByUser(entryKey, true);
	};
	const collapseEntryBackToCompactRow = (
		entryKey: string,
		rowHoverExpansionOfHostingScrollContainer: CrossProjectTaskSwitcherRowHoverExpansionOfHostingScrollContainer,
	) => {
		// 收起后指针还停在这一行上：不能一动又原地展开。
		rowHoverExpansionOfHostingScrollContainer.suppressHoverExpansionUntilPointerLeavesRow(entryKey);
		setEntryKeptExpandedInListAsFullTaskCardByUser(entryKey, false);
	};
	// hover 展开与固定展开同一张完整卡片，带上这一行的行级信息、激活与展开开关。
	const renderFullTaskCard = (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
		inListExpansionState: CrossProjectTaskSwitcherFullTaskCardInListExpansionState,
		isPresentedAsHoveredFromFirstFrame: boolean,
		rowHoverExpansionOfHostingScrollContainer: CrossProjectTaskSwitcherRowHoverExpansionOfHostingScrollContainer,
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
					projectName: showsProjectName ? entryInProject.projectName : null,
					promptCacheWarmthEstimate: findPromptCacheWarmthEstimateShownOnRow(entryKey, section),
					nowMs,
					inListExpansionState,
					onToggleInListExpansion: () =>
						inListExpansionState === "kept_expanded_in_list"
							? collapseEntryBackToCompactRow(entryKey, rowHoverExpansionOfHostingScrollContainer)
							: keepEntryExpandedInListAsFullTaskCard(entryKey, rowHoverExpansionOfHostingScrollContainer),
					onActivateRow: () => activateRow(entryInProject, section, rowHoverExpansionOfHostingScrollContainer),
					isPresentedAsHoveredFromFirstFrame,
				}}
			/>
		);
	};
	const renderCrossProjectTaskSwitcherSectionRow = (
		entryInProject: CrossProjectTaskSwitcherEntryInProject,
		section: CrossProjectTaskSwitcherTaskRowSection,
		rowHoverExpansionOfHostingScrollContainer: CrossProjectTaskSwitcherRowHoverExpansionOfHostingScrollContainer,
		focusedTaskScrollAnchorKey?: string,
	): ReactElement => {
		const { rowExpandedInPlaceByHover, rowWithPendingHoverIntent, buildRowHoverExpansionTriggerProps } =
			rowHoverExpansionOfHostingScrollContainer;
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
				focusedTaskScrollAnchorKey={focusedTaskScrollAnchorKey}
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
								rowHoverExpansionOfHostingScrollContainer,
							)
						: undefined
				}
				onKeepExpandedInListAsFullTaskCard={() =>
					keepEntryExpandedInListAsFullTaskCard(entryKey, rowHoverExpansionOfHostingScrollContainer)
				}
				rowHoverExpansionTriggerProps={buildRowHoverExpansionTriggerProps(
					rowIdentity,
					isKeptExpandedInListAsFullTaskCardByUser ? "kept_expanded_in_list" : "compact_row",
				)}
				hoverExpansionScrollContainerRef={rowHoverExpansionOfHostingScrollContainer.panelScrollContainerRef}
				onOpen={() => activateRow(entryInProject, section, rowHoverExpansionOfHostingScrollContainer)}
				onTogglePinnedToTaskPinboard={() => togglePinnedToTaskPinboard(entryInProject)}
				onEditTaskPinboardPinReason={
					section === "pinned" ? () => editTaskPinboardPinReason(entryInProject) : undefined
				}
			/>
		);
	};

	return {
		sectionsModel,
		renderCrossProjectTaskSwitcherSectionRow,
		pinReasonDialogAndOtherProjectConfirmationDialogs: (
			<>
				{otherProjectPinReasonDialog}
				{otherProjectTaskCardActionConfirmationDialogs}
			</>
		),
	};
}
