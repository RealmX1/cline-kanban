import type { ResizeBooleanPreference } from "@/resize/resize-preferences";
import { LocalStorageKey } from "@/storage/local-storage-store";

export const HOME_PROJECT_SIDEBAR_HIDDEN_PREFERENCE: ResizeBooleanPreference = {
	key: LocalStorageKey.HomeProjectSidebarHidden,
	defaultValue: false,
};
export const FOCUS_VIEW_TASK_LIST_SIDEBAR_HIDDEN_PREFERENCE: ResizeBooleanPreference = {
	key: LocalStorageKey.FocusViewTaskListSidebarHidden,
	defaultValue: false,
};
export const FOCUS_VIEW_WORKBENCH_SIDEBAR_HIDDEN_PREFERENCE: ResizeBooleanPreference = {
	key: LocalStorageKey.FocusViewWorkbenchSidebarHidden,
	defaultValue: false,
};
