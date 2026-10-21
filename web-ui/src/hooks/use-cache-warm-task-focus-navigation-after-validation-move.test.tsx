import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCacheWarmTaskFocusNavigationAfterValidationMove } from "@/hooks/use-cache-warm-task-focus-navigation-after-validation-move";

type NavigationInputs = Parameters<typeof useCacheWarmTaskFocusNavigationAfterValidationMove>[0];

function warmEntry(
	workspaceId: string,
	taskId: string,
): NavigationInputs["promptCacheWarmAwaitingUserEntries"][number] {
	return {
		workspaceId,
		projectName: workspaceId,
		entry: {
			taskId,
			title: taskId,
			agentId: "codex",
			createdAt: 1,
			columnId: "review",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			lastOutputAt: null,
			lastSubstantiveOutputAt: null,
			agentResponseGenerationStopped: null,
			lastConversationProgressObservation: null,
			taskDescriptionLastUpdatedAt: 1,
			lastOpenedByUserAt: null,
			pinnedToTaskPinboardAt: null,
			taskPinboardPinReason: null,
			isParkedAwaitingDispatchedBackgroundWork: false,
		},
	};
}

describe("Cache warm 移入 Validation 后的焦点接续", () => {
	let root: Root;
	let container: HTMLDivElement;
	let inputs: NavigationInputs;
	let capture: ReturnType<typeof useCacheWarmTaskFocusNavigationAfterValidationMove>;
	const onOpenTaskInProject = vi.fn();
	function Harness() {
		capture = useCacheWarmTaskFocusNavigationAfterValidationMove(inputs);
		return null;
	}
	function render(changes: Partial<NavigationInputs> = {}) {
		inputs = { ...inputs, ...changes };
		act(() => root.render(<Harness />));
	}
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		onOpenTaskInProject.mockReset();
		container = document.createElement("div");
		root = createRoot(container);
		inputs = {
			isBoardScopeAllProjectsSelected: true,
			currentProjectId: "project-a",
			selectedTaskId: "current",
			isCrossProjectTaskOpenPending: false,
			onOpenTaskInProject,
			promptCacheWarmAwaitingUserEntries: [
				warmEntry("project-a", "previous"),
				warmEntry("project-a", "current"),
				warmEntry("project-b", "next"),
			],
		};
		render();
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.unstubAllGlobals();
	});

	it("选择操作前显示的跨项目下一项，允许广播先把原任务移出分组", () => {
		const complete = capture("current");
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
		render({
			promptCacheWarmAwaitingUserEntries: [warmEntry("project-b", "next"), warmEntry("project-a", "previous")],
		});
		complete?.();
		expect(onOpenTaskInProject).toHaveBeenCalledWith("project-b", "next");
	});

	it("末尾选同组上一项", () => {
		render({ promptCacheWarmAwaitingUserEntries: inputs.promptCacheWarmAwaitingUserEntries.slice(0, 2) });
		capture("current")?.();
		expect(onOpenTaskInProject).toHaveBeenCalledWith("project-a", "previous");
	});

	it("同组仅剩当前项时返回已处理的空操作，阻止回退到 Review 列", () => {
		render({ promptCacheWarmAwaitingUserEntries: [warmEntry("project-a", "current")] });
		const complete = capture("current");
		expect(complete).toBeTypeOf("function");
		complete?.();
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
	});

	it("跨项目同号任务按 workspaceId 与 taskId 共同定位", () => {
		render({
			promptCacheWarmAwaitingUserEntries: [
				warmEntry("project-b", "current"),
				warmEntry("project-a", "current"),
				warmEntry("project-c", "current"),
			],
		});
		capture("current")?.();
		expect(onOpenTaskInProject).toHaveBeenCalledWith("project-c", "current");
	});

	it.each([
		{ isBoardScopeAllProjectsSelected: false },
		{ selectedTaskId: "another" },
		{ currentProjectId: "project-c" },
		{ isCrossProjectTaskOpenPending: true },
		{ promptCacheWarmAwaitingUserEntries: [] },
	])("不适用的上下文交还普通导航：%j", (changes) => {
		render(changes);
		expect(capture("current")).toBeNull();
	});

	it("操作非聚焦任务不接管导航", () => {
		expect(capture("previous")).toBeNull();
	});

	it.each([
		{ selectedTaskId: "another" },
		{ currentProjectId: "project-b" },
		{ isBoardScopeAllProjectsSelected: false },
		{ isCrossProjectTaskOpenPending: true },
	])("请求期间焦点上下文改变时不抢焦点：%j", (changes) => {
		const complete = capture("current");
		render(changes);
		complete?.();
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
	});

	it("用户切走后又返回原任务，旧请求仍不再自动导航", () => {
		const complete = capture("current");
		render({ selectedTaskId: "another" });
		render({ selectedTaskId: "current" });
		complete?.();
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
	});

	it("候选退出 Cache warm 后保持当前焦点", () => {
		const complete = capture("current");
		render({ promptCacheWarmAwaitingUserEntries: inputs.promptCacheWarmAwaitingUserEntries.slice(0, 2) });
		complete?.();
		expect(onOpenTaskInProject).not.toHaveBeenCalled();
	});
});
