import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrossProjectRecentlyActiveTaskSwitcherHostContextValue } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import {
	CrossProjectTaskSwitcherPinnedSectionBlock,
	CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock,
	CrossProjectTaskSwitcherRemainingRecentSectionBlock,
	CrossProjectTaskSwitcherRunningSectionBlock,
	type CrossProjectTaskSwitcherSectionBlockProps,
} from "@/components/detail-panels/cross-project-recently-active-task-switcher-section-blocks";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAllProjectsFocusViewAdjacentTaskKeyboardNavigation } from "@/hooks/use-all-projects-focus-view-adjacent-task-keyboard-navigation";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "@/hooks/use-cross-project-recently-active-task-switcher-sections";
import type { RuntimeCrossProjectTaskSwitcherEntry, RuntimeProjectSummary } from "@/runtime/types";
import { findCrossProjectTaskSwitcherFocusedTaskSourceSection } from "@/state/cross-project-task-switcher-focus-view-visible-task-rows";
import { resetCrossProjectTaskSwitcherPanelViewContinuity } from "@/stores/cross-project-task-switcher-panel-view-continuity-store";

const now = Date.now();
function entry(
	taskId: string,
	overrides: Partial<RuntimeCrossProjectTaskSwitcherEntry> = {},
): RuntimeCrossProjectTaskSwitcherEntry {
	return {
		taskId,
		title: taskId,
		agentId: "claude",
		columnId: "review",
		createdAt: 1,
		turnOwner: null,
		liveness: "none",
		userTurnKind: null,
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
		taskDescriptionLastUpdatedAt: now - 60_000,
		lastOpenedByUserAt: null,
		pinnedToTaskPinboardAt: null,
		taskPinboardPinReason: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
		...overrides,
	};
}
function project(id: string, entries: RuntimeCrossProjectTaskSwitcherEntry[]): RuntimeProjectSummary {
	return {
		id,
		name: id,
		path: `/isolated/${id}`,
		availability: { status: "available" },
		taskCounts: { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0 },
		inProgressTaskDetails: [],
		crossProjectTaskSwitcherEntries: entries,
	};
}

describe("All Projects 左栏相邻任务键盘导航", () => {
	let root: Root;
	let container: HTMLDivElement;
	let model: ReturnType<typeof useCrossProjectRecentlyActiveTaskSwitcherSections>;
	let projects: RuntimeProjectSummary[];
	let focusedTask = { workspaceId: "a", taskId: "first" };
	let isFocusViewActive: boolean;
	let isBoardScopeAllProjectsSelected: boolean;
	const onOpenTaskInProject = vi.fn();
	function Harness() {
		model = useCrossProjectRecentlyActiveTaskSwitcherSections({
			projects,
			currentProjectId: "a",
			notificationLogByWorkspaceId: {},
		});
		const host: CrossProjectRecentlyActiveTaskSwitcherHostContextValue = {
			crossProjectTaskSwitcherSectionsModel: model,
			projects,
			currentProjectId: "a",
			notificationLogByWorkspaceId: {},
			isBoardScopeAllProjectsSelected,
			focusedTaskInProject: focusedTask,
			onOpenTaskInProject,
			onRequestPinCurrentProjectTaskToTaskPinboard: () => {},
			onUnpinCurrentProjectTaskFromTaskPinboard: () => {},
			onEditCurrentProjectTaskPinboardPinReason: () => {},
		};
		useAllProjectsFocusViewAdjacentTaskKeyboardNavigation({ host, isFocusViewActive });
		const entryKey = `${focusedTask.workspaceId}:${focusedTask.taskId}`;
		const section = findCrossProjectTaskSwitcherFocusedTaskSourceSection(model.sections, entryKey);
		const props: CrossProjectTaskSwitcherSectionBlockProps = {
			sectionsModel: model,
			sectionBlockPresentation: "stacked_section_in_focus_view_left_column_panel",
			focusedTaskRowToKeepMounted: section ? { entryKey, section } : null,
			renderRowInHostingScrollContainer: ({ workspaceId, entry: task }, rowSection) => (
				<span
					key={`${rowSection}:${workspaceId}:${task.taskId}`}
					data-navigation-test-row={`${rowSection}:${workspaceId}:${task.taskId}`}
				>
					{task.title}
				</span>
			),
		};
		return (
			<TooltipProvider>
				<textarea aria-label="导航输入框" />
				<CrossProjectTaskSwitcherPinnedSectionBlock {...props} />
				<CrossProjectTaskSwitcherRunningSectionBlock {...props} />
				<CrossProjectTaskSwitcherPromptCacheWarmAwaitingUserSectionBlock {...props} />
				<CrossProjectTaskSwitcherRemainingRecentSectionBlock {...props} />
			</TooltipProvider>
		);
	}
	function render() {
		act(() => root.render(<Harness />));
	}
	function press(key = "ArrowDown", modifiers: KeyboardEventInit = {}, target: EventTarget = document) {
		act(() =>
			target.dispatchEvent(
				new KeyboardEvent("keydown", {
					key,
					code: key,
					altKey: true,
					bubbles: true,
					cancelable: true,
					...modifiers,
				}),
			),
		);
	}
	function rows(section = "remaining") {
		return Array.from(container.querySelectorAll(`[data-navigation-test-row^="${section}:"]`), (node) =>
			node.getAttribute("data-navigation-test-row"),
		);
	}
	function touch(taskId: string) {
		projects = projects.map((p) => ({
			...p,
			crossProjectTaskSwitcherEntries: p.crossProjectTaskSwitcherEntries.map((task) =>
				task.taskId === taskId ? { ...task, lastOpenedByUserAt: now + 10_000 } : task,
			),
		}));
		render();
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		window.localStorage.clear();
		resetCrossProjectTaskSwitcherPanelViewContinuity();
		onOpenTaskInProject.mockReset();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		projects = [
			project("a", [
				entry("first", { taskDescriptionLastUpdatedAt: now }),
				entry("third", { taskDescriptionLastUpdatedAt: now - 2_000 }),
			]),
			project("b", [entry("second", { taskDescriptionLastUpdatedAt: now - 1_000 })]),
		];
		focusedTask = { workspaceId: "a", taskId: "first" };
		isFocusViewActive = true;
		isBoardScopeAllProjectsSelected = true;
		render();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("跨项目按实际显示顺序前进，加载在途目标不依赖当前项目", () => {
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("b", "second");
		focusedTask = { workspaceId: "b", taskId: "second" };
		render();
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "third");
	});
	it("同帧连续按键与跨项目同号任务分别推进一次", () => {
		projects = [
			project("a", [entry("same", { taskDescriptionLastUpdatedAt: now })]),
			project("b", [
				entry("same", { taskDescriptionLastUpdatedAt: now - 1 }),
				entry("last", { taskDescriptionLastUpdatedAt: now - 2 }),
			]),
		];
		focusedTask = { workspaceId: "a", taskId: "same" };
		render();
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", altKey: true, bubbles: true }),
			);
			document.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "ArrowDown",
					code: "ArrowDown",
					altKey: true,
					bubbles: true,
					repeat: true,
				}),
			);
		});
		expect(onOpenTaskInProject.mock.calls).toEqual([
			["b", "same"],
			["b", "last"],
		]);
	});
	it("跨 Running、Cache warm 与 Recent，置顶副本不额外占位", () => {
		projects = [
			project("a", [
				entry("running", { turnOwner: "agent", liveness: "live", lastOutputAt: now }),
				entry("first", { pinnedToTaskPinboardAt: now }),
			]),
			project("b", [
				entry("warm", {
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
					lastMainAgentConversationModelRequestDispatchObservation: {
						observedAtMs: now,
						evidenceKind: "post_tool_use_hook_event",
					},
				}),
			]),
		];
		focusedTask = { workspaceId: "a", taskId: "running" };
		render();
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("b", "warm");
		focusedTask = { workspaceId: "b", taskId: "warm" };
		render();
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "first");
	});
	it("Pinned 默认只露五条，显示更多与折叠立即改变候选", () => {
		projects = [
			project("a", [
				...Array.from({ length: 6 }, (_, i) =>
					entry(`pin-${i}`, { columnId: "validation", pinnedToTaskPinboardAt: now - i }),
				),
				entry("first"),
			]),
		];
		focusedTask = { workspaceId: "a", taskId: "pin-4" };
		render();
		expect(rows("pinned")).toHaveLength(5);
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "first");
		act(() => model.setShowsAllPinnedEntries(true));
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "pin-5");
		act(() => model.setIsPinnedSectionCollapsed(true));
		expect(rows("pinned")).toEqual(["pinned:a:pin-4"]);
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "first");
	});
	it("折叠只保留当前焦点行，隐藏项目、阶段和 Backlog 不进入导航", () => {
		projects = [
			project("a", [
				entry("first"),
				entry("backlog", { columnId: "backlog" }),
				entry("running", { turnOwner: "agent", liveness: "live", lastOutputAt: now }),
			]),
			project("b", [entry("second")]),
		];
		render();
		act(() => {
			model.setSelectedRecentTaskStageFilters([]);
			model.setSelectedRecentProjectWorkspaceIds(["a"]);
		});
		expect(rows("running")).toEqual([]);
		press();
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
		act(() => {
			model.setSelectedRecentProjectWorkspaceIds([]);
			model.setIsRecentSectionExpanded(false);
		});
		expect(rows()).toEqual(["remaining:a:first"]);
		press();
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
	});
	it("按住 Option 打开时间不重排显示或导航，松开后恢复实时顺序", () => {
		press();
		focusedTask = { workspaceId: "b", taskId: "second" };
		touch("second");
		expect(rows()).toEqual(["remaining:a:first", "remaining:b:second", "remaining:a:third"]);
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "third");
		act(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", altKey: false })));
		expect(rows()).toEqual(["remaining:b:second", "remaining:a:first", "remaining:a:third"]);
	});
	it("锁定期间更新内容、剔除失效项目，并把新任务追加到末尾", () => {
		press();
		projects = [
			project("a", [
				entry("first", { title: "更新后的任务名", taskDescriptionLastUpdatedAt: now + 1 }),
				entry("new-1", { taskDescriptionLastUpdatedAt: now + 3 }),
			]),
			{
				...project("b", [entry("second")]),
				availability: { status: "unavailable", reason: "project_path_missing" },
			},
		];
		render();
		expect(rows()).toEqual(["remaining:a:first", "remaining:a:new-1"]);
		expect(container.textContent).toContain("更新后的任务名");
		projects = [
			project("a", [
				entry("new-2", { taskDescriptionLastUpdatedAt: now + 10 }),
				entry("new-1", { taskDescriptionLastUpdatedAt: now + 8 }),
				entry("first"),
			]),
		];
		render();
		expect(rows()).toEqual(["remaining:a:first", "remaining:a:new-1", "remaining:a:new-2"]);
	});
	it.each(["blur", "hidden", "leave", "scope", "filter"])("%s 会解除顺序锁", (trigger) => {
		press();
		touch("second");
		act(() => {
			if (trigger === "blur") window.dispatchEvent(new Event("blur"));
			if (trigger === "hidden") {
				vi.spyOn(document, "hidden", "get").mockReturnValue(true);
				document.dispatchEvent(new Event("visibilitychange"));
			}
			if (trigger === "leave") {
				isFocusViewActive = false;
				root.render(<Harness />);
			}
			if (trigger === "scope") {
				isBoardScopeAllProjectsSelected = false;
				root.render(<Harness />);
			}
			if (trigger === "filter") model.setSelectedRecentTaskStageFilters([]);
		});
		expect(rows()[0]).toBe("remaining:b:second");
		vi.restoreAllMocks();
	});
	it("首尾循环，分组外当前任务向下进首项、向上进末项", () => {
		press("ArrowUp");
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "third");
		focusedTask = { workspaceId: "a", taskId: "outside" };
		render();
		press();
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "first");
		render();
		press("ArrowUp");
		expect(onOpenTaskInProject).toHaveBeenLastCalledWith("a", "third");
		projects = [];
		render();
		onOpenTaskInProject.mockClear();
		press();
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
	});
	it("输入框支持精确 Option 组合，弹窗、额外修饰键和已消费事件保持原处理", () => {
		const input = container.querySelector("textarea")!;
		input.focus();
		press("ArrowDown", {}, input);
		expect(onOpenTaskInProject).toHaveBeenCalledTimes(1);
		onOpenTaskInProject.mockClear();
		for (const modifiers of [{ altKey: false }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }])
			press("ArrowDown", modifiers, input);
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const dialogInput = document.createElement("textarea");
		dialog.append(dialogInput);
		document.body.append(dialog);
		press("ArrowDown", {}, dialogInput);
		const consumer = document.createElement("div");
		document.body.append(consumer);
		consumer.addEventListener("keydown", (event) => event.preventDefault());
		press("ArrowDown", {}, consumer);
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
		dialog.remove();
		consumer.remove();
	});
});
