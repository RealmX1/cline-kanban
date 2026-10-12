import { useEffect } from "react";

export interface NotificationTaskFocusMessage {
	source: "cline-kanban";
	type: "focus-task-from-notification";
	taskId: string;
	workspaceId: string;
}

function isNotificationTaskFocusMessage(value: unknown): value is NotificationTaskFocusMessage {
	if (!value || typeof value !== "object") {
		return false;
	}
	const message = value as {
		source?: unknown;
		type?: unknown;
		taskId?: unknown;
		workspaceId?: unknown;
	};
	return (
		message.source === "cline-kanban" &&
		message.type === "focus-task-from-notification" &&
		typeof message.taskId === "string" &&
		typeof message.workspaceId === "string"
	);
}

// 接收 SW 转发的「打开这个任务」：OS 通知点击、或别的标签页的应用内通知点击。SW 优先找开着目标项目的
// 标签页；没有时会把消息转给最近用过的任一 Kanban 标签页（public/sw.js）。同项目与跨项目一律交给
// openTaskInProjectInPlace（与跨项目切换面板、铃铛同一入口）：它在切项目途中挂 pending、等目标 board 落定再选中，
// 找不到卡时提示而不是清掉当前 Focus View（cf427：此前同项目直接 setSelectedTaskId，切项目途中会被吞掉）。
export function useNotificationTaskFocus(input: {
	openTaskInProjectInPlace: (workspaceId: string, taskId: string) => void;
}): void {
	const { openTaskInProjectInPlace } = input;

	useEffect(() => {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
			return;
		}
		const serviceWorker = navigator.serviceWorker;
		const handleMessage = (event: MessageEvent) => {
			const data: unknown = event.data;
			if (!isNotificationTaskFocusMessage(data)) {
				return;
			}
			openTaskInProjectInPlace(data.workspaceId, data.taskId);
			if (typeof window !== "undefined") {
				window.focus();
			}
		};

		serviceWorker.addEventListener("message", handleMessage);
		return () => {
			serviceWorker.removeEventListener("message", handleMessage);
		};
	}, [openTaskInProjectInPlace]);
}
