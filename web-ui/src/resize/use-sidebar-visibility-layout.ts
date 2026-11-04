import { useCallback, useState } from "react";
import { loadBooleanResizePreference, persistBooleanResizePreference } from "@/resize/resize-preferences";
import {
	FOCUS_VIEW_TASK_LIST_SIDEBAR_HIDDEN_PREFERENCE,
	FOCUS_VIEW_WORKBENCH_SIDEBAR_HIDDEN_PREFERENCE,
	HOME_PROJECT_SIDEBAR_HIDDEN_PREFERENCE,
} from "@/resize/sidebar-visibility-preferences";

export function useSidebarVisibilityLayout() {
	const [isHomeProjectSidebarHidden, setHomeProjectSidebarHiddenState] = useState(() =>
		loadBooleanResizePreference(HOME_PROJECT_SIDEBAR_HIDDEN_PREFERENCE),
	);
	const [isFocusViewTaskListSidebarHidden, setFocusViewTaskListSidebarHiddenState] = useState(() =>
		loadBooleanResizePreference(FOCUS_VIEW_TASK_LIST_SIDEBAR_HIDDEN_PREFERENCE),
	);
	const [isFocusViewWorkbenchSidebarHidden, setFocusViewWorkbenchSidebarHiddenState] = useState(() =>
		loadBooleanResizePreference(FOCUS_VIEW_WORKBENCH_SIDEBAR_HIDDEN_PREFERENCE),
	);
	const setHomeProjectSidebarHidden = useCallback((hidden: boolean) => {
		setHomeProjectSidebarHiddenState(persistBooleanResizePreference(HOME_PROJECT_SIDEBAR_HIDDEN_PREFERENCE, hidden));
	}, []);
	const setFocusViewTaskListSidebarHidden = useCallback((hidden: boolean) => {
		setFocusViewTaskListSidebarHiddenState(
			persistBooleanResizePreference(FOCUS_VIEW_TASK_LIST_SIDEBAR_HIDDEN_PREFERENCE, hidden),
		);
	}, []);
	const setFocusViewWorkbenchSidebarHidden = useCallback((hidden: boolean) => {
		setFocusViewWorkbenchSidebarHiddenState(
			persistBooleanResizePreference(FOCUS_VIEW_WORKBENCH_SIDEBAR_HIDDEN_PREFERENCE, hidden),
		);
	}, []);
	const resetSidebarVisibilityLayoutCustomizations = useCallback(() => {
		setHomeProjectSidebarHiddenState(false);
		setFocusViewTaskListSidebarHiddenState(false);
		setFocusViewWorkbenchSidebarHiddenState(false);
	}, []);
	return {
		isHomeProjectSidebarHidden,
		setHomeProjectSidebarHidden,
		isFocusViewTaskListSidebarHidden,
		setFocusViewTaskListSidebarHidden,
		isFocusViewWorkbenchSidebarHidden,
		setFocusViewWorkbenchSidebarHidden,
		resetSidebarVisibilityLayoutCustomizations,
	};
}
