import { useCallback, useState } from "react";

import { DETAIL_TERMINAL_WIDTH_PREFERENCE } from "@/resize/detail-terminal-panel-width";
import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { clampBetween } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey } from "@/storage/local-storage-store";

// The detail terminal panel width descriptor / bounds now live in their own
// leaf module so non-React call sites can read them; re-exported here to keep
// existing `@/resize/use-card-detail-layout` importers unbroken.
export {
	DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX,
	MAX_DETAIL_TERMINAL_PANEL_WIDTH_PX,
	MIN_DETAIL_TERMINAL_PANEL_WIDTH_PX,
} from "@/resize/detail-terminal-panel-width";
export const MIN_DETAIL_DIFF_PANEL_WIDTH_PX = 360;

const TASK_CARDS_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailTaskCardsPanelRatio,
	defaultValue: 0.2,
	normalize: (value) => clampBetween(value, 0.14, 0.4),
};

const AGENT_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailAgentPanelRatio,
	defaultValue: 0.4,
	normalize: (value) => clampBetween(value, 0.15, 0.75),
};

const COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailDiffFileTreePanelRatio,
	defaultValue: 0.3333,
	normalize: (value) => clampBetween(value, 0.12, 0.6),
};

const EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailExpandedDiffFileTreePanelRatio,
	defaultValue: 0.16,
	normalize: (value) => clampBetween(value, 0.12, 0.6),
};

// Vertical split of the right column: top = prompt library, bottom = diff. Default 50/50.
const RIGHT_PROMPT_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailRightPromptPanelRatio,
	defaultValue: 0.5,
	normalize: (value) => clampBetween(value, 0.15, 0.85),
};

export function useCardDetailLayout({ isDiffExpanded }: { isDiffExpanded: boolean }): {
	agentPanelRatio: number;
	detailDiffFileTreeRatio: number;
	detailRightPromptRatio: number;
	detailTerminalPanelWidth: number;
	setAgentPanelRatio: (ratio: number) => void;
	setDetailDiffFileTreeRatio: (ratio: number) => void;
	setDetailRightPromptRatio: (ratio: number) => void;
	setDetailTerminalPanelWidth: (width: number) => void;
	setTaskCardsPanelRatio: (ratio: number) => void;
	taskCardsPanelRatio: number;
} {
	const [taskCardsPanelRatio, setTaskCardsPanelRatioState] = useState(() =>
		loadResizePreference(TASK_CARDS_RATIO_PREFERENCE),
	);
	const [agentPanelRatio, setAgentPanelRatioState] = useState(() => loadResizePreference(AGENT_RATIO_PREFERENCE));
	const [detailTerminalPanelWidth, setDetailTerminalPanelWidthState] = useState(() =>
		loadResizePreference(DETAIL_TERMINAL_WIDTH_PREFERENCE),
	);
	const [collapsedDetailDiffFileTreeRatio, setCollapsedDetailDiffFileTreeRatioState] = useState(() =>
		loadResizePreference(COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE),
	);
	const [expandedDetailDiffFileTreeRatio, setExpandedDetailDiffFileTreeRatioState] = useState(() =>
		loadResizePreference(EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE),
	);
	const [detailRightPromptRatio, setDetailRightPromptRatioState] = useState(() =>
		loadResizePreference(RIGHT_PROMPT_RATIO_PREFERENCE),
	);

	const setTaskCardsPanelRatio = useCallback((ratio: number) => {
		setTaskCardsPanelRatioState(persistResizePreference(TASK_CARDS_RATIO_PREFERENCE, ratio));
	}, []);

	const setAgentPanelRatio = useCallback((ratio: number) => {
		setAgentPanelRatioState(persistResizePreference(AGENT_RATIO_PREFERENCE, ratio));
	}, []);

	const setDetailTerminalPanelWidth = useCallback((width: number) => {
		setDetailTerminalPanelWidthState(persistResizePreference(DETAIL_TERMINAL_WIDTH_PREFERENCE, width));
	}, []);

	const setDetailRightPromptRatio = useCallback((ratio: number) => {
		setDetailRightPromptRatioState(persistResizePreference(RIGHT_PROMPT_RATIO_PREFERENCE, ratio));
	}, []);

	const setDetailDiffFileTreeRatio = useCallback(
		(ratio: number) => {
			if (isDiffExpanded) {
				setExpandedDetailDiffFileTreeRatioState(
					persistResizePreference(EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE, ratio),
				);
				return;
			}
			setCollapsedDetailDiffFileTreeRatioState(
				persistResizePreference(COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE, ratio),
			);
		},
		[isDiffExpanded],
	);

	useLayoutResetEffect(() => {
		setTaskCardsPanelRatioState(getResizePreferenceDefaultValue(TASK_CARDS_RATIO_PREFERENCE));
		setAgentPanelRatioState(getResizePreferenceDefaultValue(AGENT_RATIO_PREFERENCE));
		setDetailTerminalPanelWidthState(getResizePreferenceDefaultValue(DETAIL_TERMINAL_WIDTH_PREFERENCE));
		setCollapsedDetailDiffFileTreeRatioState(
			getResizePreferenceDefaultValue(COLLAPSED_DIFF_FILE_TREE_RATIO_PREFERENCE),
		);
		setExpandedDetailDiffFileTreeRatioState(
			getResizePreferenceDefaultValue(EXPANDED_DIFF_FILE_TREE_RATIO_PREFERENCE),
		);
		setDetailRightPromptRatioState(getResizePreferenceDefaultValue(RIGHT_PROMPT_RATIO_PREFERENCE));
	});

	return {
		taskCardsPanelRatio,
		setTaskCardsPanelRatio,
		agentPanelRatio,
		setAgentPanelRatio,
		detailTerminalPanelWidth,
		setDetailTerminalPanelWidth,
		detailDiffFileTreeRatio: isDiffExpanded ? expandedDetailDiffFileTreeRatio : collapsedDetailDiffFileTreeRatio,
		setDetailDiffFileTreeRatio,
		detailRightPromptRatio,
		setDetailRightPromptRatio,
	};
}
