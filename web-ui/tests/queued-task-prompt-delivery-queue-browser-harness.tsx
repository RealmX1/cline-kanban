import { createRoot } from "react-dom/client";

import { QueuedTaskPromptDeliveryQueuePanel } from "../src/components/detail-panels/queued-task-prompt-delivery-queue-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useQueuedTaskPromptDeliveryQueueController } from "../src/hooks/use-queued-task-prompt-delivery-queue-controller";
import { replaceQueuedTaskPromptDeliveryProjections, resetQueuedTaskPromptDeliveryProjectionsForWorkspace } from "../src/stores/queued-task-prompt-delivery-projection-store";
import { QUEUE_BROWSER_BOARD_TASK_ID, QUEUE_BROWSER_CONVERSATION_SESSION_ID, QUEUE_BROWSER_ENQUEUED_AT, QUEUE_BROWSER_WORKSPACE_ID, queueBrowserProjections, immediateDeliveryBrowserProjections } from "./queued-task-prompt-delivery-queue-browser-fixture";
import "../src/styles/globals.css";

// 真实 controller 和投影 store；API 由 Playwright 拦截，绝不连接用户的运行实例。
resetQueuedTaskPromptDeliveryProjectionsForWorkspace(QUEUE_BROWSER_WORKSPACE_ID);
replaceQueuedTaskPromptDeliveryProjections(QUEUE_BROWSER_WORKSPACE_ID, { [QUEUE_BROWSER_CONVERSATION_SESSION_ID]: queueBrowserProjections, immediateDeliveryBrowserProjections });

function QueueMetadataBrowserHarness() {
	const controller = useQueuedTaskPromptDeliveryQueueController(QUEUE_BROWSER_WORKSPACE_ID, QUEUE_BROWSER_CONVERSATION_SESSION_ID, QUEUE_BROWSER_BOARD_TASK_ID);
	return (
		<TooltipProvider>
			<main className="flex h-dvh min-w-0 flex-col bg-surface-1 text-text-primary">
				<button type="button" className="shrink-0 p-2 text-xs" onClick={() => replaceQueuedTaskPromptDeliveryProjections(QUEUE_BROWSER_WORKSPACE_ID, {
					[QUEUE_BROWSER_CONVERSATION_SESSION_ID]: queueBrowserProjections.map((projection) => projection.queueEntryId === "pending-browser-entry" ? { ...projection, deliveryAttemptCount: 1, lastAttemptedAt: QUEUE_BROWSER_ENQUEUED_AT + 120_000 } : projection),
				})}>模拟队列推送更新</button>
				<button type="button" className="shrink-0 p-2 text-xs" onClick={() => replaceQueuedTaskPromptDeliveryProjections(QUEUE_BROWSER_WORKSPACE_ID, { [QUEUE_BROWSER_CONVERSATION_SESSION_ID]: [...queueBrowserProjections, ...immediateDeliveryBrowserProjections] })}>模拟即时投递</button>
				<div className="min-h-0 min-w-0 flex-1"><QueuedTaskPromptDeliveryQueuePanel controller={controller} /></div>
			</main>
		</TooltipProvider>
	);
}

const container = document.createElement("div");
document.body.append(container);
createRoot(container).render(<QueueMetadataBrowserHarness />);
