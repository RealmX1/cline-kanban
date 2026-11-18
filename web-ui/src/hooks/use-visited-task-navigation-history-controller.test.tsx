import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrossProjectTaskOpenResult } from "@/hooks/use-cross-project-task-open-in-project";
import { useVisitedTaskNavigationHistoryController } from "@/hooks/use-visited-task-navigation-history-controller";
import { VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY } from "@/state/visited-task-navigation-history";
import { notifyTaskVisualizationStreamReconnected } from "@/stores/task-visualization-browser-bridge";

const resolveTarget = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/visited-task-navigation-query", () => ({ resolveVisitedTaskNavigationTarget: resolveTarget }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

type Controller = ReturnType<typeof useVisitedTaskNavigationHistoryController>;
type Input = Parameters<typeof useVisitedTaskNavigationHistoryController>[0];
let controller: Controller;
let root: Root;
let container: HTMLDivElement;
const openTask = vi.fn<Input["openTaskInProjectWithResult"]>();
function displayed(taskId: string, workspaceId = "one") {
	return {
		workspaceId,
		taskId,
		taskIncarnationCreatedAtEpochMs: 100,
		titleSnapshot: taskId,
		projectNameSnapshot: workspaceId,
		lastVisitedAtEpochMs: 1,
		unavailable: false,
	};
}
function Harness(props: Partial<Input>) {
	controller = useVisitedTaskNavigationHistoryController({
		displayedTask: null,
		projects: [],
		isRuntimeConnected: true,
		openTaskInProjectWithResult: openTask,
		...props,
	});
	return null;
}
async function render(props: Partial<Input> = {}) {
	await act(async () => root.render(createElement(Harness, props)));
}
beforeEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
	resolveTarget.mockImplementation(async (entry) => ({
		outcome: "available",
		entry,
		currentWorkspaceId: entry.workspaceId,
	}));
	openTask.mockResolvedValue({ outcome: "opened" });
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

describe("访问历史 controller 的显示确认与在途恢复", () => {
	it("重渲染不记录，回退只在目标真正打开后提交游标", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		await render({ displayedTask: displayed("c") });
		let finish!: (result: CrossProjectTaskOpenResult) => void;
		openTask.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await act(async () => controller.navigateBackward());
		expect(controller.history.cursor).toBe(2);
		await render({ displayedTask: displayed("b") });
		expect(controller.history.navigationPath).toHaveLength(3);
		await act(async () => finish({ outcome: "opened" }));
		expect(controller.history.cursor).toBe(1);
		expect(controller.history.recentTasks.map((task) => task.taskId)).toEqual(["b", "c", "a"]);
		await render({ displayedTask: displayed("d") });
		expect(controller.history.navigationPath.map((task) => task.taskId)).toEqual(["a", "b", "d"]);
	});

	it("连续导航以最新意图为准，取消旧请求并忽略迟到成功", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		await render({ displayedTask: displayed("c") });
		const completions: Array<(result: CrossProjectTaskOpenResult) => void> = [];
		openTask.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
		await act(async () => controller.navigateBackward());
		const firstSignal = openTask.mock.calls[0]?.[3];
		await act(async () => controller.navigateBackward());
		expect(firstSignal?.aborted).toBe(true);
		await act(async () => completions[1]?.({ outcome: "opened" }));
		await act(async () => completions[0]?.({ outcome: "opened" }));
		expect(controller.history.cursor).toBe(0);
	});

	it("失败或取消不移动游标，临时断连不删除历史，连接恢复自动重试一次", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		openTask.mockResolvedValueOnce({ outcome: "failed", message: "断连" });
		await act(async () => controller.navigateBackward());
		expect(controller.history.cursor).toBe(1);
		expect(controller.history.recentTasks.every((entry) => !entry.unavailable)).toBe(true);
		await render({ isRuntimeConnected: false });
		await render({ isRuntimeConnected: true });
		expect(openTask).toHaveBeenCalledTimes(2);
		expect(controller.history.cursor).toBe(0);
		openTask.mockResolvedValueOnce({ outcome: "cancelled" });
		await act(async () => controller.navigateForward());
		expect(controller.history.cursor).toBe(0);
	});

	it("确认失效的历史目标自动跳过，最近列表保留不可用标记", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		await render({ displayedTask: displayed("c") });
		resolveTarget.mockImplementation(async (entry) =>
			entry.taskId === "b"
				? { outcome: "unavailable" }
				: { outcome: "available", entry, currentWorkspaceId: entry.workspaceId },
		);
		await act(async () => controller.navigateBackward());
		expect(controller.history.cursor).toBe(0);
		expect(controller.history.recentTasks.find((entry) => entry.taskId === "b")?.unavailable).toBe(true);
		expect(openTask).toHaveBeenCalledExactlyOnceWith("one", "a", 100, expect.any(AbortSignal), ["one"]);
	});

	it("新页面恢复最后快照但不自动打开，各标签页运行中的路径不互相覆盖", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		const saved = localStorage.getItem(VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY);
		expect(saved).toContain('"cursor":1');
		window.dispatchEvent(
			new StorageEvent("storage", { key: VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY, newValue: null }),
		);
		expect(controller.history.navigationPath).toHaveLength(2);
		await render({ displayedTask: null });
		act(() => root.unmount());
		root = createRoot(container);
		await render();
		expect(controller.history.navigationPath).toHaveLength(2);
		expect(openTask).not.toHaveBeenCalled();
	});

	it("localStorage 不可写时继续页内导航，并暴露保存失败状态", async () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("存储被禁用");
		});
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		expect(controller.isHistoryPersistenceUnavailable).toBe(true);
		await act(async () => controller.navigateBackward());
		expect(controller.history.cursor).toBe(0);
	});

	it("后台身份补证不覆盖其他标签页最后保存的路径，页内历史继续独立", async () => {
		let finish!: (target: unknown) => void;
		resolveTarget.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await render({ displayedTask: displayed("a") });
		const otherPageSnapshot = JSON.stringify({
			...controller.history,
			recentTasks: [],
			navigationPath: [],
			cursor: -1,
		});
		localStorage.setItem(VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY, otherPageSnapshot);
		await act(async () =>
			finish({
				outcome: "available",
				entry: { ...displayed("a"), titleSnapshot: "新标题" },
				currentWorkspaceId: "one",
			}),
		);
		expect(controller.history.recentTasks[0]?.titleSnapshot).toBe("新标题");
		expect(localStorage.getItem(VISITED_TASK_NAVIGATION_HISTORY_STORAGE_KEY)).toBe(otherPageSnapshot);
	});

	it("在途失败只在重连时补试一次，新普通访问撤销旧意图与迟到身份读取", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		openTask.mockResolvedValue({ outcome: "failed", message: "网络失败" });
		await act(async () => controller.navigateBackward());
		await act(async () => notifyTaskVisualizationStreamReconnected("one"));
		await act(async () => notifyTaskVisualizationStreamReconnected("one"));
		expect(openTask).toHaveBeenCalledTimes(2);
		expect(controller.history.cursor).toBe(1);
		await act(async () => controller.navigateBackward());
		await render({ displayedTask: displayed("c") });
		await act(async () => notifyTaskVisualizationStreamReconnected("one"));
		expect(openTask).toHaveBeenCalledTimes(3);
		expect(controller.history.navigationPath.map((entry) => entry.taskId)).toEqual(["a", "b", "c"]);
	});

	it("原项目已注销时从仍注册的项目查询同一世迁移后的真实归属", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		await render({ projects: [{ id: "current-project", name: "当前项目" }] });
		await act(async () => controller.navigateBackward());
		expect(resolveTarget).toHaveBeenLastCalledWith(
			expect.objectContaining({ taskId: "a", workspaceId: "one" }),
			expect.any(AbortSignal),
			"current-project",
		);
	});

	it("打开阶段才确认删除时，同一次方向导航继续跳到下一个仍可用的任务", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		await render({ displayedTask: displayed("c") });
		openTask.mockImplementation(async (_workspaceId, taskId) =>
			taskId === "b" ? { outcome: "unavailable" } : { outcome: "opened" },
		);
		await act(async () => controller.navigateBackward());
		expect(openTask.mock.calls.map((call) => call[1])).toEqual(["b", "a"]);
		expect(controller.history.cursor).toBe(0);
		expect(controller.history.recentTasks.find((entry) => entry.taskId === "b")?.unavailable).toBe(true);
		expect(controller.isNavigationPending).toBe(false);
	});

	it("打开失败前已经恢复连接时，立即重试这一次，而不是继续等待下一次重连", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		let finish!: (result: CrossProjectTaskOpenResult) => void;
		openTask.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await act(async () => controller.navigateBackward());
		await act(async () => notifyTaskVisualizationStreamReconnected("one"));
		await act(async () => finish({ outcome: "failed", message: "旧请求超时" }));
		expect(openTask).toHaveBeenCalledTimes(2);
		expect(controller.history.cursor).toBe(0);
		expect(controller.isNavigationPending).toBe(false);
	});

	it("解析期间重新展开来源编辑窗会取消旧导航，迟到结果不再打开目标", async () => {
		let reveal:
			| ((ownership: {
					workspaceId: string;
					taskId: string;
					taskIncarnationCreatedAtEpochMs: number;
					taskTitleSnapshot: string;
			  }) => void)
			| undefined;
		await render({
			projects: [{ id: "one", name: "项目" }],
			floatingFormWindowHost: {
				hasOpenWindows: true,
				openWindow: () => Symbol(),
				closeWindow: () => undefined,
				collapseTaskEditorWindowsExcept: () => undefined,
				revealTaskEditorPreservingEarlierWorkspace: () => false,
				subscribeToRevealedTaskEditors: (listener) => {
					reveal = listener;
					return () => {
						reveal = undefined;
					};
				},
			},
		});
		const show = async (taskId: string) =>
			reveal?.({
				workspaceId: "one",
				taskId,
				taskIncarnationCreatedAtEpochMs: 100,
				taskTitleSnapshot: taskId,
			});
		await act(async () => show("a"));
		await act(async () => show("b"));
		let finish!: (target: unknown) => void;
		resolveTarget.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await act(async () => controller.navigateBackward());
		await act(async () => show("b"));
		await act(async () => finish({ outcome: "available", entry: displayed("a"), currentWorkspaceId: "one" }));
		expect(openTask).not.toHaveBeenCalled();
		expect(controller.history.cursor).toBe(1);
		expect(controller.isNavigationPending).toBe(false);
	});

	it("迁移后的历史打开把原项目别名交给收起和打开入口", async () => {
		await render({ displayedTask: displayed("a", "source") });
		await render({ displayedTask: displayed("b", "source") });
		const collapse = vi.fn();
		await render({
			floatingFormWindowHost: {
				hasOpenWindows: false,
				openWindow: () => Symbol(),
				closeWindow: () => undefined,
				collapseTaskEditorWindowsExcept: collapse,
				revealTaskEditorPreservingEarlierWorkspace: () => false,
				subscribeToRevealedTaskEditors: () => () => undefined,
			},
		});
		resolveTarget.mockResolvedValueOnce({
			outcome: "available",
			currentWorkspaceId: "destination",
			entry: { ...displayed("a", "source"), workspaceIdsUsedByTaskIncarnation: ["source", "destination"] },
		});
		await act(async () => controller.navigateBackward());
		expect(collapse).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "destination",
				taskId: "a",
				workspaceIdsUsedByTaskIncarnation: expect.arrayContaining(["source", "destination"]),
			}),
		);
		expect(openTask).toHaveBeenCalledWith(
			"destination",
			"a",
			100,
			expect.any(AbortSignal),
			expect.arrayContaining(["source", "destination"]),
		);
	});

	it("浏览器回退撤销仍在解析的旧导航，迟到结果不能打开任务", async () => {
		await render({ displayedTask: displayed("a") });
		await render({ displayedTask: displayed("b") });
		let finish!: (result: unknown) => void;
		resolveTarget.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		await act(async () => controller.navigateBackward());
		act(() => window.dispatchEvent(new PopStateEvent("popstate")));
		await act(async () => finish({ outcome: "available", entry: displayed("a"), currentWorkspaceId: "one" }));
		expect(openTask).not.toHaveBeenCalled();
		expect(controller.history.cursor).toBe(1);
	});
});
