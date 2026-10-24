import type {
	RuntimeStateStreamClientMessage,
	RuntimeStateStreamMessage,
	TaskVisualizationBrowserContextMessage,
	TaskVisualizationPreviewRequestedMessage,
} from "@/runtime/types";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

type TaskVisualizationStreamMessage = Extract<
	RuntimeStateStreamMessage,
	{ type: "task_visualization_artifacts_updated" | "task_visualization_preview_requested" }
>;
type TaskVisualizationBrowserEvent =
	| TaskVisualizationStreamMessage
	| { type: "stream_reconnected"; workspaceId: string }
	| { type: "stream_disconnected"; workspaceId: string };
const eventListeners = new Set<(event: TaskVisualizationBrowserEvent) => void>();
const outgoingListeners = new Set<(workspaceId: string, message: RuntimeStateStreamClientMessage) => void>();
let browserPageId: string | null = null;
let declaredContext: { workspaceId: string; message: TaskVisualizationBrowserContextMessage } | null = null;
let interactionSequence = 0;
const PAGE_ID_STORAGE_KEY = "kanban.task-visualization-browser-page-id";
const DISPLAYED_REQUESTS_STORAGE_KEY = "kanban.task-visualization-displayed-preview-request-ids";
const DISMISSED_REQUESTS_STORAGE_KEY = "kanban.task-visualization-dismissed-preview-request-ids";

export function readTaskVisualizationBrowserPageId(): string {
	if (browserPageId) return browserPageId;
	try {
		browserPageId = sessionStorage.getItem(PAGE_ID_STORAGE_KEY);
	} catch {
		/* 存储不可用时保持本页内身份。 */
	}
	if (!browserPageId || !/^[a-f0-9-]{36}$/u.test(browserPageId)) {
		browserPageId = createRandomUuidV4WithInsecureContextFallback();
		try {
			sessionStorage.setItem(PAGE_ID_STORAGE_KEY, browserPageId);
		} catch {
			/* 无需存储权限。 */
		}
	}
	return browserPageId;
}

export function declareTaskVisualizationBrowserContext(
	workspaceId: string,
	taskId: string | null,
	isForeground: boolean,
	hasInteraction = false,
): void {
	if (hasInteraction) interactionSequence += 1;
	const message: TaskVisualizationBrowserContextMessage = {
		type: "declare_task_visualization_browser_context",
		browserPageId: readTaskVisualizationBrowserPageId(),
		taskId,
		isForeground,
		interactionSequence,
		previewDeliveryProtocolVersion: "page-acceptance-and-content-confirmation/v1",
	};
	declaredContext = { workspaceId, message };
	for (const listener of outgoingListeners) listener(workspaceId, message);
}

export function attachTaskVisualizationRuntimeStreamSender(
	workspaceId: string | null,
	sender: (message: RuntimeStateStreamClientMessage) => void,
): () => void {
	const listener = (messageWorkspaceId: string, message: RuntimeStateStreamClientMessage) => {
		if (workspaceId === messageWorkspaceId) sender(message);
	};
	outgoingListeners.add(listener);
	if (declaredContext) listener(declaredContext.workspaceId, declaredContext.message);
	return () => {
		outgoingListeners.delete(listener);
	};
}

export function notifyTaskVisualizationStreamDisconnected(workspaceId: string | null): void {
	if (!workspaceId) return;
	for (const listener of eventListeners) listener({ type: "stream_disconnected", workspaceId });
}

export function notifyTaskVisualizationStreamReconnected(workspaceId: string | null): void {
	if (!workspaceId) return;
	if (declaredContext)
		for (const listener of outgoingListeners) listener(declaredContext.workspaceId, declaredContext.message);
	for (const listener of eventListeners) listener({ type: "stream_reconnected", workspaceId });
}

export function deliverTaskVisualizationStreamMessage(message: TaskVisualizationStreamMessage): void {
	for (const listener of eventListeners) listener(message);
}

export function subscribeToTaskVisualizationBrowserEvents(
	listener: (event: TaskVisualizationBrowserEvent) => void,
): () => void {
	eventListeners.add(listener);
	return () => {
		eventListeners.delete(listener);
	};
}

function readAcknowledgedPreviewRequestIds(storageKey: string): string[] {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "[]");
		return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}
const displayedInThisPage = new Set<string>();
const dismissedInThisPage = new Set<string>();

export function wasTaskVisualizationPreviewDisplayed(requestId: string): boolean {
	return (
		displayedInThisPage.has(requestId) ||
		readAcknowledgedPreviewRequestIds(DISPLAYED_REQUESTS_STORAGE_KEY).includes(requestId)
	);
}

export function wasTaskVisualizationPreviewDismissed(requestId: string): boolean {
	return (
		dismissedInThisPage.has(requestId) ||
		readAcknowledgedPreviewRequestIds(DISMISSED_REQUESTS_STORAGE_KEY).includes(requestId)
	);
}

export function acknowledgeTaskVisualizationPreview(
	message: TaskVisualizationPreviewRequestedMessage,
	outcome: "accepted" | "displayed" | "declined" | "dismissed" | "failed",
	failureReason?: string,
): void {
	if (outcome === "displayed" || outcome === "dismissed") {
		const storageKey = outcome === "displayed" ? DISPLAYED_REQUESTS_STORAGE_KEY : DISMISSED_REQUESTS_STORAGE_KEY;
		(outcome === "displayed" ? displayedInThisPage : dismissedInThisPage).add(
			message.previewRequest.previewRequestId,
		);
		try {
			sessionStorage.setItem(
				storageKey,
				JSON.stringify(
					[
						...new Set([
							...readAcknowledgedPreviewRequestIds(storageKey),
							message.previewRequest.previewRequestId,
						]),
					].slice(-100),
				),
			);
		} catch {
			/* 页内集合仍能去重。 */
		}
	}
	for (const listener of outgoingListeners)
		listener(message.workspaceId, {
			type: "acknowledge_task_visualization_preview",
			browserPageId: message.browserPageId,
			taskId: message.taskId,
			previewRequestId: message.previewRequest.previewRequestId,
			deliveryAttemptId: message.deliveryAttemptId,
			...(failureReason ? { failureReason: failureReason.slice(0, 500) } : {}),
			outcome,
		});
}
