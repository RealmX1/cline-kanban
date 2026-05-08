import { useCallback, useState } from "react";

import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { clampBetween } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { APPROX_TERMINAL_CELL_WIDTH_PX, TASK_SESSION_TERMINAL_COLS } from "@/runtime/task-session-geometry";
import { LocalStorageKey } from "@/storage/local-storage-store";

export const DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX = TASK_SESSION_TERMINAL_COLS * APPROX_TERMINAL_CELL_WIDTH_PX + 40;
export const MIN_DETAIL_TERMINAL_PANEL_WIDTH_PX = 320;
export const MAX_DETAIL_TERMINAL_PANEL_WIDTH_PX = 1400;
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

const DETAIL_TERMINAL_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DetailTerminalPanelWidth,
	defaultValue: DEFAULT_DETAIL_TERMINAL_PANEL_WIDTH_PX,
	normalize: (value) =>
		clampBetween(value, MIN_DETAIL_TERMINAL_PANEL_WIDTH_PX, MAX_DETAIL_TERMINAL_PANEL_WIDTH_PX, true),
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

export function useCardDetailLayout({ isDiffExpanded }: { isDiffExpanded: boolean }): {
	agentPanelRatio: number;
	detailDiffFileTreeRatio: number;
	detailTerminalPanelWidth: number;
	setAgentPanelRatio: (ratio: number) => void;
	setDetailDiffFileTreeRatio: (ratio: number) => void;
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

	const setTaskCardsPanelRatio = useCallback((ratio: number) => {
		setTaskCardsPanelRatioState(persistResizePreference(TASK_CARDS_RATIO_PREFERENCE, ratio));
	}, []);

	const setAgentPanelRatio = useCallback((ratio: number) => {
		setAgentPanelRatioState(persistResizePreference(AGENT_RATIO_PREFERENCE, ratio));
	}, []);

	const setDetailTerminalPanelWidth = useCallback((width: number) => {
		setDetailTerminalPanelWidthState(persistResizePreference(DETAIL_TERMINAL_WIDTH_PREFERENCE, width));
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
	};
}
