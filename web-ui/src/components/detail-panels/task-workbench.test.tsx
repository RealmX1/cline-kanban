import { act, type ReactNode, useState } from "react";
import { createRoot as createReactRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
	FocusViewDesktopPanelArrangementPreference,
	TaskWorkbenchModule,
} from "@/resize/focus-view-desktop-panel-arrangement";
import { TaskWorkbench } from "./task-workbench";

function createRoot(container: HTMLElement) {
	const root = createReactRoot(container);
	return {
		render: (children: ReactNode) => root.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => root.unmount(),
	};
}

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
		const select = async (label: string, value: string) => {
			if (label === "任务专注视图布局") {
				await act(async () =>
					container
						.querySelector<HTMLButtonElement>('[aria-label="工作台布局"]')!
						.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })),
				);
				const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
				expect(options.map((option) => option.textContent)).toEqual(["自动", "左右", "上下"]);
				await act(async () => options[1]!.click());
				return;
			}
			return act(async () => {
				const element = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
				element.value = value;
				element.dispatchEvent(new Event("change", { bubbles: true }));
			});
		};
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

it("区域选择进入内容标题行，布局变化保留模块和 iframe 身份", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const renderWorkbench = (isMobile: boolean) => (
		<TaskWorkbench<TaskWorkbenchModule>
			isBelowAgent={!isMobile}
			arrangementPreference="automatic"
			onArrangementPreferenceChange={() => {}}
			slotRatio={0.5}
			onSlotRatioChange={() => {}}
			mobileModuleLayout={
				isMobile ? { visibleModules: ["task_sessions"], heightFillingModule: "task_sessions" } : undefined
			}
			firstModuleHeaderEndActions={<button type="button" aria-label="隐藏任务工作台" />}
			modules={{
				task_sessions: (headerNavigationContent, headerEndActions) => (
					<>
						<header>
							{headerNavigationContent}
							<button type="button">新建会话</button>
							{headerEndActions}
						</header>
						<input defaultValue="草稿" />
						<iframe title="持续预览" />
					</>
				),
				cross_task_relations: null,
				exploration_map: null,
				prompt_tools: null,
				task_visualizations: () => null,
				task_files: null,
			}}
		/>
	);
	try {
		await act(async () => root.render(renderWorkbench(false)));
		const module = container.querySelector('[data-task-workbench-module="task_sessions"]')!;
		expect(module.querySelectorAll("header")).toHaveLength(1);
		expect(module.querySelector('header [aria-label="工作台格位 1"]')).not.toBeNull();
		expect(
			module.querySelector("header")?.lastElementChild?.querySelector("button")?.getAttribute("aria-label"),
		).toBe("隐藏任务工作台");
		const input = module.querySelector("input");
		const frame = module.querySelector("iframe");
		await act(async () => root.render(renderWorkbench(true)));
		expect(container.querySelector('[aria-label="隐藏任务工作台"]')).toBeNull();
		await act(async () => root.render(renderWorkbench(false)));
		expect(module.querySelector("input")).toBe(input);
		expect(module.querySelector("iframe")).toBe(frame);
		await act(async () => {
			const selector = module.querySelector<HTMLSelectElement>('[aria-label="工作台格位 1"]')!;
			selector.value = "task_visualizations";
			selector.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(container.querySelector('[data-task-workbench-module="task_visualizations"] select')).not.toBeNull();
		expect(
			container.querySelector('[data-task-workbench-module="task_visualizations"] [aria-label="隐藏任务工作台"]'),
		).not.toBeNull();
		expect(module.querySelector('[aria-label="隐藏任务工作台"]')).toBeNull();
	} finally {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
