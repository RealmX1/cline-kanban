// 应用内通知点击「SW 中转跨 tab 聚焦」的页面侧发起端。
// 协议对端在 public/sw.js 的 focus-workspace-tab-request message handler（sw.js 是 public/
// 下的普通 JS，无法 import 本模块，消息类型 / outcome 字面量在两侧手工同步；漂移由
// workspace-tab-focus-via-service-worker.test.ts 的防漂移测试锁定）。

export const WORKSPACE_TAB_FOCUS_REQUEST_MESSAGE_TYPE = "focus-workspace-tab-request";
export const WORKSPACE_TAB_FOCUS_RESPONSE_MESSAGE_TYPE = "focus-workspace-tab-response";

// 覆盖 SW 冷启动 + matchAll + focus 尝试的往返；旧 SW（尚未更新、不识别新消息类型，
// 永不回信）由此超时兜底。上限同时保证超时后调用方若仍需 window.open，动作落在点击的
// transient activation 窗口（Chrome ~5s）之内。
export const WORKSPACE_TAB_FOCUS_RESPONSE_TIMEOUT_MS = 1500;

export interface WorkspaceTabFocusRequestMessage {
	source: "cline-kanban";
	type: typeof WORKSPACE_TAB_FOCUS_REQUEST_MESSAGE_TYPE;
	workspaceId: string;
	taskId: string;
	workspacePathname: string;
}

// SW 经 MessageChannel 专用 port 回报的 outcome 字面量。
const SERVICE_WORKER_OUTCOME_FOCUSED = "focused";
const SERVICE_WORKER_OUTCOME_TASK_SELECTED_IN_BACKGROUND_TAB = "task-selected-in-background-tab";
const SERVICE_WORKER_OUTCOME_NO_TAB_FOUND = "no-tab-found";

export type WorkspaceTabFocusViaServiceWorkerResult =
	// SW 已聚焦既有目标项目 tab 并送达任务选中消息（当前 Chromium 拒绝 message 上下文的
	// client.focus()，此结果留给未来平台放宽后自动升级；见 sw.js 内注释）。
	| "focused-existing-tab"
	// 任务选中消息已送达既有目标项目 tab（后台就位），但浏览器拒绝跨 tab 聚焦——当前
	// Chromium 的常态结果；调用方应以 toast 引导用户手动切换标签页。
	| "task-selected-in-background-tab"
	// 不存在目标项目的 tab：调用方应在用户手势窗口内 window.open 新开深链 tab。
	| "no-existing-tab"
	// 无 SW / 无 controller（硬刷新后）、旧 SW 超时、SW 侧异常、响应形状非法：
	// 调用方降级为现状的 in-tab 切项目行为。
	| "mechanism-unavailable";

function mapServiceWorkerResponseToResult(data: unknown): WorkspaceTabFocusViaServiceWorkerResult {
	if (!data || typeof data !== "object") {
		return "mechanism-unavailable";
	}
	const message = data as { source?: unknown; type?: unknown; outcome?: unknown };
	if (message.source !== "cline-kanban" || message.type !== WORKSPACE_TAB_FOCUS_RESPONSE_MESSAGE_TYPE) {
		return "mechanism-unavailable";
	}
	if (message.outcome === SERVICE_WORKER_OUTCOME_FOCUSED) {
		return "focused-existing-tab";
	}
	if (message.outcome === SERVICE_WORKER_OUTCOME_TASK_SELECTED_IN_BACKGROUND_TAB) {
		return "task-selected-in-background-tab";
	}
	if (message.outcome === SERVICE_WORKER_OUTCOME_NO_TAB_FOUND) {
		return "no-existing-tab";
	}
	// "focus-failed"（SW 侧校验失败/异常）或未知 outcome：一律按机制不可用降级。
	return "mechanism-unavailable";
}

export function requestWorkspaceTabFocusViaServiceWorker(input: {
	workspaceId: string;
	taskId: string;
	workspacePathname: string;
}): Promise<WorkspaceTabFocusViaServiceWorkerResult> {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return Promise.resolve("mechanism-unavailable");
	}
	// 硬刷新（Shift+Reload）后的页面不受 SW 控制，controller 为 null → 立即降级。
	const controller = navigator.serviceWorker.controller;
	if (!controller) {
		return Promise.resolve("mechanism-unavailable");
	}
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const settle = (result: WorkspaceTabFocusViaServiceWorkerResult) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId !== null) {
				clearTimeout(timeoutId);
			}
			channel.port1.close();
			resolve(result);
		};
		timeoutId = setTimeout(() => settle("mechanism-unavailable"), WORKSPACE_TAB_FOCUS_RESPONSE_TIMEOUT_MS);
		// onmessage 赋值即隐式 start()，无需显式调用。
		channel.port1.onmessage = (event: MessageEvent) => {
			settle(mapServiceWorkerResponseToResult(event.data));
		};
		const requestMessage: WorkspaceTabFocusRequestMessage = {
			source: "cline-kanban",
			type: WORKSPACE_TAB_FOCUS_REQUEST_MESSAGE_TYPE,
			workspaceId: input.workspaceId,
			taskId: input.taskId,
			workspacePathname: input.workspacePathname,
		};
		try {
			// 关键纪律：从调用方的点击 handler 到此处必须全程同步（无任何 await / 微任务让渡），
			// 保证 postMessage 以及后续 window.open 都落在点击的 transient activation 窗口内。
			controller.postMessage(requestMessage, [channel.port2]);
		} catch {
			settle("mechanism-unavailable");
		}
	});
}
