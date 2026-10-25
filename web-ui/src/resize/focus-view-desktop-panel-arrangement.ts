import { LocalStorageKey, readLocalStorageItem } from "@/storage/local-storage-store";

export type FocusViewDesktopPanelArrangement = "agent_left_workbench_right" | "agent_above_workbench_below";
export type FocusViewDesktopPanelArrangementPreference = "automatic" | FocusViewDesktopPanelArrangement;
export type TaskWorkbenchModule =
	| "task_sessions"
	| "cross_task_relations"
	| "exploration_map"
	| "prompt_tools"
	| "task_visualizations";
export type TaskWorkbenchModuleSlots = readonly [TaskWorkbenchModule, TaskWorkbenchModule];
export const TASK_WORKBENCH_MODULE_LABELS: Record<TaskWorkbenchModule, string> = {
	task_sessions: "Sessions",
	cross_task_relations: "Relations",
	exploration_map: "探索地图",
	prompt_tools: "Prompts",
	task_visualizations: "可视化",
};

export function loadFocusViewDesktopPanelArrangementPreference(): FocusViewDesktopPanelArrangementPreference {
	const stored = readLocalStorageItem(LocalStorageKey.FocusViewDesktopPanelArrangementPreference);
	return stored === "agent_left_workbench_right" || stored === "agent_above_workbench_below" ? stored : "automatic";
}

export function resolveFocusViewDesktopPanelArrangement(
	preference: FocusViewDesktopPanelArrangementPreference,
	width: number,
	height: number,
): FocusViewDesktopPanelArrangement {
	return preference === "automatic"
		? height > width
			? "agent_above_workbench_below"
			: "agent_left_workbench_right"
		: preference;
}

export function selectTaskWorkbenchModuleInSlot<Module extends string>(
	slots: readonly [Module, Module],
	slot: 0 | 1,
	module: Module,
): readonly [Module, Module] {
	const next: [Module, Module] = [...slots];
	const otherSlot = slot === 0 ? 1 : 0;
	if (next[otherSlot] === module) next[otherSlot] = next[slot];
	next[slot] = module;
	return next;
}
