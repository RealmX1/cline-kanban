import { describe, expect, it } from "vitest";
import {
	resolveFocusViewDesktopPanelArrangement,
	selectTaskWorkbenchModuleInSlot,
} from "./focus-view-desktop-panel-arrangement";

describe("桌面 Focus View 布局和工作台格位", () => {
	it("自动跟随窗口方向，手动选择覆盖方向", () => {
		expect(resolveFocusViewDesktopPanelArrangement("automatic", 1080, 1920)).toBe("agent_above_workbench_below");
		expect(resolveFocusViewDesktopPanelArrangement("automatic", 1920, 1080)).toBe("agent_left_workbench_right");
		expect(resolveFocusViewDesktopPanelArrangement("agent_left_workbench_right", 1080, 1920)).toBe(
			"agent_left_workbench_right",
		);
		expect(resolveFocusViewDesktopPanelArrangement("agent_above_workbench_below", 1920, 1080)).toBe(
			"agent_above_workbench_below",
		);
	});
	it("选择另一格的模块时交换，选择隐藏模块时只替换目标格", () => {
		expect(selectTaskWorkbenchModuleInSlot(["task_sessions", "prompt_tools"], 0, "prompt_tools")).toEqual([
			"prompt_tools",
			"task_sessions",
		]);
		expect(selectTaskWorkbenchModuleInSlot(["task_sessions", "prompt_tools"], 1, "cross_task_relations")).toEqual([
			"task_sessions",
			"cross_task_relations",
		]);
	});
});
