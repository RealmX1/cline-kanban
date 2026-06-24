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

export function useNotificationTaskFocus(input: {
	currentProjectId: string | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
}): void {
	const { currentProjectId, setSelectedTaskId } = input;

	useEffect(() => {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
			return;
		}
		const serviceWorker = navigator.serviceWorker;
		const handleMessage = (event: MessageEvent) => {
			const data: unknown = event.data;
			if (!isNotificationTaskFocusMessage(data) || data.workspaceId !== currentProjectId) {
				return;
			}
			setSelectedTaskId(data.taskId);
			if (typeof window !== "undefined") {
				window.focus();
			}
		};

		serviceWorker.addEventListener("message", handleMessage);
		return () => {
			serviceWorker.removeEventListener("message", handleMessage);
		};
	}, [currentProjectId, setSelectedTaskId]);
}
