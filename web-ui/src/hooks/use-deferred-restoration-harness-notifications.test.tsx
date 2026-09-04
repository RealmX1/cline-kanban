// 钉住「切任务后旧任务的在途响应不得污染新任务状态」：详情视图不按 taskId 重新挂载，本 hook 实例
// 在 A→B 切卡时是复用的，所以旧任务的 fetch / release 回调必须整条丢弃——否则横幅会拿旧任务的条数与
// 失败信息示人，而放行按钮闭包已指向新任务，用户会照着旧横幅对当前任务误点放行。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeDeferredRestorationHarnessNotification,
	RuntimeReleaseDeferredRestorationHarnessNotificationsResponse,
} from "@/runtime/types";

const fetchDeferredRestorationHarnessNotificationsMock = vi.fn();
const releaseDeferredRestorationHarnessNotificationsMock = vi.fn();

vi.mock("@/runtime/deferred-restoration-harness-notifications-query", () => ({
	fetchDeferredRestorationHarnessNotifications: (...args: unknown[]) =>
		fetchDeferredRestorationHarnessNotificationsMock(...args),
	releaseDeferredRestorationHarnessNotifications: (...args: unknown[]) =>
		releaseDeferredRestorationHarnessNotificationsMock(...args),
}));

const { useDeferredRestorationHarnessNotifications } = await import(
	"@/hooks/use-deferred-restoration-harness-notifications"
);

type HookResult = ReturnType<typeof useDeferredRestorationHarnessNotifications>;

const WORKSPACE_ID = "workspace-alpha";
const PREVIOUS_TASK_ID = "task-previous";
const NEXT_TASK_ID = "task-next";

function createNotification(sourceHarness: string): RuntimeDeferredRestorationHarnessNotification {
	return { sourceHarness, receivedAt: 1, promptTextPreview: `${sourceHarness} 的预览` };
}

// 手动兑付的 promise：让「旧任务的请求在切卡之后才落地」这个时序可以被精确复现。
function createManuallySettledPromise<T>(): { promise: Promise<T>; settle: (value: T) => void } {
	let settle: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

describe("useDeferredRestorationHarnessNotifications 的切任务隔离", () => {
	let container: HTMLDivElement;
	let root: Root | null;
	let previousActEnvironment: boolean | undefined;
	let latestHookResult: HookResult | null;

	function HookHarness({ taskId }: { taskId: string }): null {
		latestHookResult = useDeferredRestorationHarnessNotifications({
			workspaceId: WORKSPACE_ID,
			taskId,
			isEnabled: true,
		});
		return null;
	}

	async function renderHarnessForTask(taskId: string): Promise<void> {
		await act(async () => {
			root?.render(createElement(HookHarness, { taskId }));
		});
	}

	function requireHookResult(): HookResult {
		if (!latestHookResult) {
			throw new Error("Hook harness has not rendered yet.");
		}
		return latestHookResult;
	}

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		fetchDeferredRestorationHarnessNotificationsMock.mockReset();
		releaseDeferredRestorationHarnessNotificationsMock.mockReset();
		latestHookResult = null;
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("旧任务的列表请求在切卡之后落地时，不把旧任务的条数写进新任务", async () => {
		const previousTaskFetch = createManuallySettledPromise<RuntimeDeferredRestorationHarnessNotification[]>();
		const nextTaskFetch = createManuallySettledPromise<RuntimeDeferredRestorationHarnessNotification[]>();
		fetchDeferredRestorationHarnessNotificationsMock
			.mockReturnValueOnce(previousTaskFetch.promise)
			.mockReturnValueOnce(nextTaskFetch.promise);
		const nextTaskNotifications = [createNotification("notification")];

		await renderHarnessForTask(PREVIOUS_TASK_ID);
		await renderHarnessForTask(NEXT_TASK_ID);

		// 新任务的响应先到位，随后旧任务那笔迟到的响应才落地——若它还能写状态，横幅就会对新任务报「2 条」。
		await act(async () => {
			nextTaskFetch.settle(nextTaskNotifications);
		});
		await act(async () => {
			previousTaskFetch.settle([createNotification("subagent-stop"), createNotification("notification")]);
		});

		expect(requireHookResult().deferredNotifications).toEqual(nextTaskNotifications);
	});

	it("旧任务的列表请求先失败再落地时，不清掉新任务已经拉到的条目", async () => {
		let rejectPreviousTaskFetch: (reason: unknown) => void = () => {};
		const previousTaskFailure = new Promise<RuntimeDeferredRestorationHarnessNotification[]>((_resolve, reject) => {
			rejectPreviousTaskFetch = reject;
		});
		const nextTaskNotifications = [createNotification("notification")];
		fetchDeferredRestorationHarnessNotificationsMock
			.mockReturnValueOnce(previousTaskFailure)
			.mockReturnValueOnce(Promise.resolve(nextTaskNotifications));

		await renderHarnessForTask(PREVIOUS_TASK_ID);
		await renderHarnessForTask(NEXT_TASK_ID);
		await act(async () => {
			rejectPreviousTaskFetch(new Error("旧任务的读请求失败了"));
		});

		expect(requireHookResult().deferredNotifications).toEqual(nextTaskNotifications);
	});

	it("旧任务的放行失败在切卡之后落地时，不把失败信息挂到新任务的横幅上", async () => {
		const previousTaskRelease =
			createManuallySettledPromise<RuntimeReleaseDeferredRestorationHarnessNotificationsResponse>();
		fetchDeferredRestorationHarnessNotificationsMock.mockResolvedValue([createNotification("notification")]);
		releaseDeferredRestorationHarnessNotificationsMock.mockReturnValueOnce(previousTaskRelease.promise);

		await renderHarnessForTask(PREVIOUS_TASK_ID);
		await act(async () => {
			requireHookResult().releaseDeferredNotifications();
		});
		expect(releaseDeferredRestorationHarnessNotificationsMock).toHaveBeenCalledWith(WORKSPACE_ID, PREVIOUS_TASK_ID);
		expect(requireHookResult().isReleaseInFlight).toBe(true);

		await renderHarnessForTask(NEXT_TASK_ID);
		// 切卡那一帧就该复位：新任务没有任何放行在途，按钮也不该显示为「放行中…」。
		expect(requireHookResult().isReleaseInFlight).toBe(false);
		expect(requireHookResult().releaseFailureMessage).toBeNull();

		await act(async () => {
			previousTaskRelease.settle({ ok: false, releasedNotificationCount: 0, error: "旧任务的放行失败了" });
		});

		expect(requireHookResult().releaseFailureMessage).toBeNull();
	});

	it("放行按钮始终打给当前任务", async () => {
		fetchDeferredRestorationHarnessNotificationsMock.mockResolvedValue([createNotification("notification")]);
		releaseDeferredRestorationHarnessNotificationsMock.mockResolvedValue({ ok: true, releasedNotificationCount: 1 });

		await renderHarnessForTask(PREVIOUS_TASK_ID);
		await renderHarnessForTask(NEXT_TASK_ID);
		await act(async () => {
			requireHookResult().releaseDeferredNotifications();
		});

		expect(releaseDeferredRestorationHarnessNotificationsMock).toHaveBeenCalledTimes(1);
		expect(releaseDeferredRestorationHarnessNotificationsMock).toHaveBeenCalledWith(WORKSPACE_ID, NEXT_TASK_ID);
	});
});
