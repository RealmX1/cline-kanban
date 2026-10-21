import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { FocusViewDesktopPanelArrangementPreference } from "@/resize/focus-view-desktop-panel-arrangement";
import { TaskWorkbench } from "./task-workbench";

it("模块换格、隐藏再显示和布局切换保留同一输入节点及草稿", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	function Harness() {
		const [arrangement, setArrangement] =
			useState<FocusViewDesktopPanelArrangementPreference>("agent_above_workbench_below");
		return (
			<TaskWorkbench
				isBelowAgent={arrangement === "agent_above_workbench_below"}
				arrangementPreference={arrangement}
				onArrangementPreferenceChange={setArrangement}
				slotRatio={0.5}
				onSlotRatioChange={() => {}}
				modules={{
					task_sessions: <input aria-label="会话草稿" defaultValue="未发送内容" />,
					cross_task_relations: <span>关系内容</span>,
					exploration_map: <span>地图内容</span>,
					prompt_tools: <span>提示词内容</span>,
				}}
			/>
		);
	}
	try {
		await act(async () => root.render(<Harness />));
		const input = container.querySelector("input")!;
		const select = async (label: string, value: string) =>
			act(async () => {
				const element = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
				element.value = value;
				element.dispatchEvent(new Event("change", { bubbles: true }));
			});
		await select("工作台格位 1", "prompt_tools");
		expect(container.querySelector('[data-task-workbench-module="task_sessions"]')?.getAttribute("style")).toContain(
			"second",
		);
		await select("工作台格位 2", "cross_task_relations");
		expect(container.querySelector('[data-task-workbench-module="task_sessions"]')?.hasAttribute("hidden")).toBe(
			true,
		);
		await select("工作台格位 2", "task_sessions");
		await select("任务专注视图布局", "agent_left_workbench_right");
		expect(container.querySelector("input")).toBe(input);
		expect(input.value).toBe("未发送内容");
		expect(localStorage.getItem("kanban.task-workbench-module-slots.v1")).toContain("task_sessions");
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
