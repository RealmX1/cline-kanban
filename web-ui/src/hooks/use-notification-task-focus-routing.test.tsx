import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotificationTaskFocusRouting } from "@/hooks/use-notification-task-focus-routing";
import type { WorkspaceTabFocusViaServiceWorkerResult } from "@/utils/workspace-tab-focus-via-service-worker";

const requestWorkspaceTabFocusViaServiceWorkerMock =
	vi.fn<
		(input: {
			workspaceId: string;
			taskId: string;
			workspacePathname: string;
		}) => Promise<WorkspaceTabFocusViaServiceWorkerResult>
	>();

vi.mock("@/utils/workspace-tab-focus-via-service-worker", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/utils/workspace-tab-focus-via-service-worker")>();
	return {
		...original,
		requestWorkspaceTabFocusViaServiceWorker: (input: {
			workspaceId: string;
			taskId: string;
			workspacePathname: string;
		}) => requestWorkspaceTabFocusViaServiceWorkerMock(input),
	};
});

const showAppToastMock = vi.fn();
vi.mock("@/components/app-toaster", () => ({
	showAppToast: (...args: unknown[]) => showAppToastMock(...args),
}));

interface HarnessInput {
	currentProjectId: string | null;
	isProjectSwitching: boolean;
	navigationCurrentProjectId: string | null;
	openTaskInProjectInPlace: (workspaceId: string, taskId: string) => void;
}

let latestFocusNotificationTask: ((workspaceId: string, taskId: string) => void) | null = null;

function HookHarness(props: HarnessInput): null {
	const { focusNotificationTask } = useNotificationTaskFocusRouting(props);
	latestFocusNotificationTask = focusNotificationTask;
	return null;
}

describe("useNotificationTaskFocusRouting", () => {
	let container: HTMLDivElement;
	let root: Root | null;
	let previousActEnvironment: boolean | undefined;
	let windowOpenSpy: ReturnType<typeof vi.spyOn>;
	let openTaskInProjectInPlace: ReturnType<typeof vi.fn<(workspaceId: string, taskId: string) => void>>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		requestWorkspaceTabFocusViaServiceWorkerMock.mockReset();
		showAppToastMock.mockReset();
		windowOpenSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
		openTaskInProjectInPlace = vi.fn<(workspaceId: string, taskId: string) => void>();
		latestFocusNotificationTask = null;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		if (root) {
			act(() => {
				root?.unmount();
			});
		}
		root = null;
		container.remove();
		windowOpenSpy.mockRestore();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderHook(input: Partial<HarnessInput> = {}): void {
		act(() => {
			root?.render(
				createElement(HookHarness, {
					currentProjectId: "project-a",
					isProjectSwitching: false,
					navigationCurrentProjectId: "project-a",
					openTaskInProjectInPlace,
					...input,
				}),
			);
		});
	}

	async function invokeFocusNotificationTask(workspaceId: string, taskId: string): Promise<void> {
		await act(async () => {
			latestFocusNotificationTask?.(workspaceId, taskId);
		});
	}

	it("分支①：目标项目已在本 tab 落地 → 交给统一入口的同项目分支选中（找不到卡时提示、不关 Focus），不发 SW 请求", async () => {
		renderHook();
		await invokeFocusNotificationTask("project-a", "task-1");

		expect(openTaskInProjectInPlace).toHaveBeenCalledWith("project-a", "task-1");
		expect(requestWorkspaceTabFocusViaServiceWorkerMock).not.toHaveBeenCalled();
	});

	it("分支②：本 tab 正切向目标项目途中 → 交给原地跳转挂 pending，不发 SW 请求", async () => {
		renderHook({ currentProjectId: "project-a", navigationCurrentProjectId: "project-b", isProjectSwitching: true });
		await invokeFocusNotificationTask("project-b", "task-2");

		expect(openTaskInProjectInPlace).toHaveBeenCalledWith("project-b", "task-2");
		expect(requestWorkspaceTabFocusViaServiceWorkerMock).not.toHaveBeenCalled();
	});

	it("分支③ focused-existing-tab：目标 tab 已被聚焦 → 本 tab 零副作用", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("focused-existing-tab");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-3");

		expect(requestWorkspaceTabFocusViaServiceWorkerMock).toHaveBeenCalledWith({
			workspaceId: "project-b",
			taskId: "task-3",
			workspacePathname: "/project-b",
		});
		expect(openTaskInProjectInPlace).not.toHaveBeenCalled();
		expect(windowOpenSpy).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("分支③ task-selected-in-background-tab：目标 tab 后台就位 → 仅 toast 引导手动切换", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("task-selected-in-background-tab");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-4");

		expect(showAppToastMock).toHaveBeenCalledTimes(1);
		expect(openTaskInProjectInPlace).not.toHaveBeenCalled();
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	it("分支③ no-existing-tab：本 tab 原地跳转（与跨项目切换面板同一条路径），不再新开深链标签页", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("no-existing-tab");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-5");

		expect(openTaskInProjectInPlace).toHaveBeenCalledWith("project-b", "task-5");
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	it("分支③ mechanism-unavailable（无 controller / 旧 SW 超时）→ 本 tab 原地跳转", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("mechanism-unavailable");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-7");

		expect(openTaskInProjectInPlace).toHaveBeenCalledWith("project-b", "task-7");
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	it("分支③ 迟到守卫（token 锁）：SW 超时窗口内又点击了新通知 → 迟到的原地跳转被否决", async () => {
		// 第一次点击（project-b）的 SW 往返挂起（模拟 ~1.5s 超时窗口），第二次点击
		//（project-c）立即以 focused-existing-tab 结束（零副作用）。
		let resolveStaleRequest: (result: WorkspaceTabFocusViaServiceWorkerResult) => void = () => {};
		requestWorkspaceTabFocusViaServiceWorkerMock
			.mockImplementationOnce(
				() =>
					new Promise<WorkspaceTabFocusViaServiceWorkerResult>((resolve) => {
						resolveStaleRequest = resolve;
					}),
			)
			.mockResolvedValueOnce("focused-existing-tab");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-stale-b");
		await invokeFocusNotificationTask("project-c", "task-newer-c");

		// 迟到的 project-b 结果 resolve：必须被最新点击否决，no-existing-tab 与 mechanism-unavailable 同理。
		await act(async () => {
			resolveStaleRequest("no-existing-tab");
		});
		expect(openTaskInProjectInPlace).not.toHaveBeenCalled();
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	it("分支③ 迟到守卫（导航意图锁）：SW 超时窗口内用户显式切了项目 → 迟到的原地跳转被否决", async () => {
		let resolveStaleRequest: (result: WorkspaceTabFocusViaServiceWorkerResult) => void = () => {};
		requestWorkspaceTabFocusViaServiceWorkerMock.mockImplementationOnce(
			() =>
				new Promise<WorkspaceTabFocusViaServiceWorkerResult>((resolve) => {
					resolveStaleRequest = resolve;
				}),
		);
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-stale-b");

		// 用户经项目切换器（不经过本 hook，token 不变）显式切向 project-c：导航意图更新。
		renderHook({ currentProjectId: "project-a", navigationCurrentProjectId: "project-c", isProjectSwitching: true });

		await act(async () => {
			resolveStaleRequest("mechanism-unavailable");
		});
		expect(openTaskInProjectInPlace).not.toHaveBeenCalled();
	});
});
