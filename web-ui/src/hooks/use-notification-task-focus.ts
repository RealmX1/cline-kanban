import type { Dispatch, SetStateAction } from "react";
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
// 标签页；没有时会把消息转给最近用过的任一 Kanban 标签页（public/sw.js），这里对跨项目的消息原地跳转
// （与跨项目切换面板同一条 openTaskInProjectInPlace），不再丢弃。
export function useNotificationTaskFocus(input: {
	currentProjectId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	openTaskInProjectInPlace: (workspaceId: string, taskId: string) => void;
}): void {
	const { currentProjectId, setSelectedTaskId, openTaskInProjectInPlace } = input;

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
			if (data.workspaceId === currentProjectId) {
				setSelectedTaskId(data.taskId);
			} else {
				openTaskInProjectInPlace(data.workspaceId, data.taskId);
			}
			if (typeof window !== "undefined") {
				window.focus();
			}
		};

		serviceWorker.addEventListener("message", handleMessage);
		return () => {
			serviceWorker.removeEventListener("message", handleMessage);
		};
	}, [currentProjectId, openTaskInProjectInPlace, setSelectedTaskId]);
}
