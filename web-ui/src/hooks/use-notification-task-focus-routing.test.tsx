import type { Dispatch, SetStateAction } from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProjectTaskDeepLinkUrl } from "@/hooks/app-utils";
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
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	handleSelectProject: (projectId: string) => void;
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
	let setSelectedTaskId: ReturnType<typeof vi.fn<Dispatch<SetStateAction<string | null>>>>;
	let handleSelectProject: ReturnType<typeof vi.fn<(projectId: string) => void>>;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		requestWorkspaceTabFocusViaServiceWorkerMock.mockReset();
		showAppToastMock.mockReset();
		windowOpenSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
		setSelectedTaskId = vi.fn<Dispatch<SetStateAction<string | null>>>();
		handleSelectProject = vi.fn<(projectId: string) => void>();
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
					setSelectedTaskId,
					handleSelectProject,
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

	it("分支①：目标项目已在本 tab 落地 → 直接选中，不发 SW 请求", async () => {
		renderHook();
		await invokeFocusNotificationTask("project-a", "task-1");

		expect(setSelectedTaskId).toHaveBeenCalledWith("task-1");
		expect(requestWorkspaceTabFocusViaServiceWorkerMock).not.toHaveBeenCalled();
		expect(handleSelectProject).not.toHaveBeenCalled();
	});

	it("分支②：本 tab 正切向目标项目途中 → 挂 pending 不重复切项目，落地后由 effect 选中", async () => {
		renderHook({ currentProjectId: "project-a", navigationCurrentProjectId: "project-b", isProjectSwitching: true });
		await invokeFocusNotificationTask("project-b", "task-2");

		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(requestWorkspaceTabFocusViaServiceWorkerMock).not.toHaveBeenCalled();
		expect(handleSelectProject).not.toHaveBeenCalled();

		// 目标项目落地（currentProjectId 到位、非切换中）→ pending 收尾选中。
		renderHook({ currentProjectId: "project-b", navigationCurrentProjectId: "project-b", isProjectSwitching: false });
		expect(setSelectedTaskId).toHaveBeenCalledWith("task-2");
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
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(handleSelectProject).not.toHaveBeenCalled();
		expect(windowOpenSpy).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("分支③ task-selected-in-background-tab：目标 tab 后台就位 → 仅 toast 引导手动切换", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("task-selected-in-background-tab");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-4");

		expect(showAppToastMock).toHaveBeenCalledTimes(1);
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(handleSelectProject).not.toHaveBeenCalled();
		expect(windowOpenSpy).not.toHaveBeenCalled();
	});

	it("分支③ no-existing-tab：window.open 深链新开标签页，且恰好两参（features 会开成弹窗）", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("no-existing-tab");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-5");

		expect(windowOpenSpy).toHaveBeenCalledTimes(1);
		expect(windowOpenSpy).toHaveBeenCalledWith(buildProjectTaskDeepLinkUrl("project-b", "task-5"), "_blank");
		expect(windowOpenSpy.mock.calls[0]).toHaveLength(2);
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(handleSelectProject).not.toHaveBeenCalled();
	});

	it("分支③ no-existing-tab 但 window.open 被拦（返回 null）→ 降级 in-tab 切项目并待落地选中", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("no-existing-tab");
		windowOpenSpy.mockReturnValue(null);
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-6");

		expect(handleSelectProject).toHaveBeenCalledWith("project-b");
		expect(setSelectedTaskId).not.toHaveBeenCalled();

		renderHook({ currentProjectId: "project-b", navigationCurrentProjectId: "project-b", isProjectSwitching: false });
		expect(setSelectedTaskId).toHaveBeenCalledWith("task-6");
	});

	it("分支③ mechanism-unavailable（无 controller / 旧 SW 超时）→ 降级 in-tab 切项目并待落地选中", async () => {
		requestWorkspaceTabFocusViaServiceWorkerMock.mockResolvedValue("mechanism-unavailable");
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-7");

		expect(handleSelectProject).toHaveBeenCalledWith("project-b");
		expect(windowOpenSpy).not.toHaveBeenCalled();
		expect(setSelectedTaskId).not.toHaveBeenCalled();

		renderHook({ currentProjectId: "project-b", navigationCurrentProjectId: "project-b", isProjectSwitching: false });
		expect(setSelectedTaskId).toHaveBeenCalledWith("task-7");
	});

	it("分支③ 迟到守卫（token 锁）：SW 超时窗口内又点击了新通知 → 迟到的降级被否决，不劫持、不覆盖 pending", async () => {
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

		// 迟到的 project-b 降级 resolve：必须被最新点击否决。
		await act(async () => {
			resolveStaleRequest("mechanism-unavailable");
		});
		expect(handleSelectProject).not.toHaveBeenCalled();

		// pending 未被迟到降级写入：即便随后本 tab 落地 project-b，也不会选中陈旧任务。
		renderHook({ currentProjectId: "project-b", navigationCurrentProjectId: "project-b", isProjectSwitching: false });
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("分支③ 迟到守卫（导航意图锁）：SW 超时窗口内用户显式切了项目 → 迟到的降级被否决", async () => {
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
		expect(handleSelectProject).not.toHaveBeenCalled();

		// pending 未被迟到降级写入：project-b 即便随后落地也不选中陈旧任务。
		renderHook({ currentProjectId: "project-b", navigationCurrentProjectId: "project-b", isProjectSwitching: false });
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("分支③ 迟到守卫：no-existing-tab 的 window.open 不受守卫（新开 tab 不劫持），但 open 被拦后的降级仍被否决", async () => {
		let resolveStaleRequest: (result: WorkspaceTabFocusViaServiceWorkerResult) => void = () => {};
		requestWorkspaceTabFocusViaServiceWorkerMock
			.mockImplementationOnce(
				() =>
					new Promise<WorkspaceTabFocusViaServiceWorkerResult>((resolve) => {
						resolveStaleRequest = resolve;
					}),
			)
			.mockResolvedValueOnce("focused-existing-tab");
		windowOpenSpy.mockReturnValue(null);
		renderHook();
		await invokeFocusNotificationTask("project-b", "task-stale-b");
		await invokeFocusNotificationTask("project-c", "task-newer-c");

		await act(async () => {
			resolveStaleRequest("no-existing-tab");
		});
		// window.open 仍执行（每次点击独立值得开出自己的深链 tab，且不动本 tab 导航）……
		expect(windowOpenSpy).toHaveBeenCalledWith(buildProjectTaskDeepLinkUrl("project-b", "task-stale-b"), "_blank");
		// ……但被弹窗拦截后的 in-tab 降级已被最新点击否决。
		expect(handleSelectProject).not.toHaveBeenCalled();

		renderHook({ currentProjectId: "project-b", navigationCurrentProjectId: "project-b", isProjectSwitching: false });
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});
});
