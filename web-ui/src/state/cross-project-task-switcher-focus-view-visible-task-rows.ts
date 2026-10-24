import {
	buildCrossProjectTaskSwitcherEntryKey,
	type CrossProjectTaskSwitcherEntryInProject,
	type CrossProjectTaskSwitcherSections,
} from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import type { CrossProjectTaskSwitcherTaskRowSection } from "@/components/detail-panels/cross-project-recently-active-task-switcher-task-row";

export interface CrossProjectTaskSwitcherFocusViewSectionVisibility {
	isPinnedSectionCollapsed: boolean;
	showsAllPinnedEntries: boolean;
	isRunningSectionExpanded: boolean;
	isPromptCacheWarmSectionExpanded: boolean;
	isRecentSectionExpanded: boolean;
}

export interface CrossProjectTaskSwitcherFocusedTaskRowToKeepMounted {
	entryKey: string;
	section: CrossProjectTaskSwitcherTaskRowSection;
}

const DEFAULT_VISIBLE_PINNED_ENTRY_COUNT_IN_FOCUS_VIEW = 5;

export function findCrossProjectTaskSwitcherFocusedTaskSourceSection(
	sections: CrossProjectTaskSwitcherSections,
	focusedTaskEntryKey: string | null,
): CrossProjectTaskSwitcherTaskRowSection | null {
	if (!focusedTaskEntryKey) return null;
	const matches = ({ workspaceId, entry }: CrossProjectTaskSwitcherEntryInProject) =>
		buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId) === focusedTaskEntryKey;
	// 主分组优先于 Pinned 副本，导航和焦点卡几何共用同一定位源。
	if (sections.runningEntries.some(matches)) return "running";
	if (sections.promptCacheWarmAwaitingUserEntries.some(matches)) return "prompt_cache_warm";
	if (sections.remainingSection.entries.some(matches)) return "remaining";
	if (sections.pinnedEntries.some(matches)) return "pinned";
	return null;
}

/** 渲染与键盘导航共用可见性判据；滚出视口的行仍然属于列表。 */
export function collectVisibleCrossProjectTaskSwitcherSectionEntries<T extends CrossProjectTaskSwitcherEntryInProject>(
	entries: readonly T[],
	section: CrossProjectTaskSwitcherTaskRowSection,
	visibility: CrossProjectTaskSwitcherFocusViewSectionVisibility,
	focusedTaskRowToKeepMounted: CrossProjectTaskSwitcherFocusedTaskRowToKeepMounted | null | undefined,
	isFocusViewLeftColumnPresentation: boolean,
): T[] {
	return entries.filter(({ workspaceId, entry }, index) => {
		const isFocusedRow =
			isFocusViewLeftColumnPresentation &&
			focusedTaskRowToKeepMounted?.section === section &&
			focusedTaskRowToKeepMounted.entryKey === buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId);
		switch (section) {
			case "pinned":
				return (
					!isFocusViewLeftColumnPresentation ||
					isFocusedRow ||
					(!visibility.isPinnedSectionCollapsed &&
						(visibility.showsAllPinnedEntries || index < DEFAULT_VISIBLE_PINNED_ENTRY_COUNT_IN_FOCUS_VIEW))
				);
			case "running":
				return !isFocusViewLeftColumnPresentation || visibility.isRunningSectionExpanded || isFocusedRow;
			case "prompt_cache_warm":
				return visibility.isPromptCacheWarmSectionExpanded || isFocusedRow;
			case "remaining":
				return visibility.isRecentSectionExpanded || isFocusedRow;
			default:
				return false;
		}
	});
}

export function collectAllProjectsFocusViewAdjacentTaskNavigationCandidates({
	sections,
	visibility,
	focusedTaskInProject,
}: {
	sections: CrossProjectTaskSwitcherSections;
	visibility: CrossProjectTaskSwitcherFocusViewSectionVisibility;
	focusedTaskInProject: { workspaceId: string; taskId: string };
}): CrossProjectTaskSwitcherEntryInProject[] {
	const focusedEntryKey = buildCrossProjectTaskSwitcherEntryKey(
		focusedTaskInProject.workspaceId,
		focusedTaskInProject.taskId,
	);
	const focusedSection = findCrossProjectTaskSwitcherFocusedTaskSourceSection(sections, focusedEntryKey);
	const focusedRow = focusedSection ? { entryKey: focusedEntryKey, section: focusedSection } : null;
	const visibleEntries = (
		entries: readonly CrossProjectTaskSwitcherEntryInProject[],
		section: CrossProjectTaskSwitcherTaskRowSection,
	) => collectVisibleCrossProjectTaskSwitcherSectionEntries(entries, section, visibility, focusedRow, true);
	const mainSectionEntries = [
		...visibleEntries(sections.runningEntries, "running"),
		...visibleEntries(sections.promptCacheWarmAwaitingUserEntries, "prompt_cache_warm"),
		...visibleEntries(sections.remainingSection.entries, "remaining"),
	];
	const mainSectionEntryKeys = new Set(
		mainSectionEntries.map(({ workspaceId, entry }) =>
			buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId),
		),
	);
	return [
		...visibleEntries(sections.pinnedEntries, "pinned").filter(
			({ workspaceId, entry }) =>
				!mainSectionEntryKeys.has(buildCrossProjectTaskSwitcherEntryKey(workspaceId, entry.taskId)),
		),
		...mainSectionEntries,
	].filter(({ entry }) => entry.columnId !== "backlog");
}
