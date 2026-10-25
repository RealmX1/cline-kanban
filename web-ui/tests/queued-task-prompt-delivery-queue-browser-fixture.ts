import type {
	QueuedTaskPromptDeliveryEntry,
	RuntimeQueuedTaskPromptDeliveryProjection,
	RuntimeTaskPromptDeliveryQueueResponse,
} from "../src/runtime/types";

export const QUEUE_BROWSER_WORKSPACE_ID = "queue-metadata-browser-project";
export const QUEUE_BROWSER_BOARD_TASK_ID = "owning-board-task";
export const QUEUE_BROWSER_CONVERSATION_SESSION_ID = "independent-conversation-session";
export const QUEUE_BROWSER_ENQUEUED_AT = Date.parse("2026-10-24T12:00:00Z");
const QUEUE_BROWSER_PROMPT_TEXT = "浏览器隔离测试 Prompt，不应出现在调试引用中。";

function createProjection(
	queueEntryId: string,
	overrides: Partial<RuntimeQueuedTaskPromptDeliveryProjection> = {},
): RuntimeQueuedTaskPromptDeliveryProjection {
	return {
		queueEntryId,
		taskId: QUEUE_BROWSER_CONVERSATION_SESSION_ID,
		deliveryState: "queued",
		textPreview: QUEUE_BROWSER_PROMPT_TEXT,
		textLength: QUEUE_BROWSER_PROMPT_TEXT.length,
		deliverTogetherWithNextQueuedEntry: false,
		dispatchBlockReason: "agent_still_generating",
		awaitsHumanReconfirmationAfterRuntimeRestart: false,
		deliveryAttemptCount: 0,
		lastAttemptedAt: null,
		lastDeliveryFailureNote: null,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextChangedSinceEnqueue: null,
		enqueuedAt: QUEUE_BROWSER_ENQUEUED_AT,
		expiresAt: QUEUE_BROWSER_ENQUEUED_AT + 86_400_000,
		settledAt: null,
		...overrides,
	};
}

export const queueBrowserProjections = [
	createProjection("pending-browser-entry"),
	createProjection("automated-browser-entry", {
		deliveryAttemptCount: 2,
		lastAttemptedAt: QUEUE_BROWSER_ENQUEUED_AT + 60_000,
		programmaticInjectionSource: "rvf_automatic_closeout",
	}),
	createProjection("expired-browser-entry", {
		deliveryState: "expired",
		expiresAt: QUEUE_BROWSER_ENQUEUED_AT + 3_600_000,
		settledAt: QUEUE_BROWSER_ENQUEUED_AT + 7_200_000,
		dispatchBlockReason: null,
	}),
];

export const immediateDeliveryBrowserProjections = [
	createProjection("immediate-browser-injection", {
		deliveryState: "handed_to_transport",
		dispatchBlockReason: null,
		managedDelivery: {
			messageType: "programmatic_injection",
			deliveryStrategy: "immediate",
			sourceLabel: "rvf_instant_injection_with_long_source_label",
			imageAttachmentCount: 1,
			terminalDeliveryReceipt: null,
		},
	}),
	createProjection("startup-browser-unconfirmed", {
		deliveryState: "settled_failed",
		dispatchBlockReason: null,
		settledAt: QUEUE_BROWSER_ENQUEUED_AT + 10_000,
		managedDelivery: {
			messageType: "session_startup",
			deliveryStrategy: "session_startup",
			sourceLabel: "ACP",
			imageAttachmentCount: 0,
			terminalDeliveryReceipt: { status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" },
		},
	}),
];

export function createQueueBrowserReadResponse(): RuntimeTaskPromptDeliveryQueueResponse {
	const entries = queueBrowserProjections.map(
		(projection): QueuedTaskPromptDeliveryEntry => ({
			...projection,
			text: projection.textPreview,
			lastAttemptedAt: projection.lastAttemptedAt ?? null,
			workspaceTaskId: QUEUE_BROWSER_BOARD_TASK_ID,
			sourcePromptLibraryEntryTextSha256: null,
			dispatchIdempotencyKey: projection.programmaticInjectionSource ? "browser-dispatch-key" : null,
			claimedForSessionIncarnationId: null,
			claimedAtTurnSequence: null,
			survivedRuntimeRestartAtEpochMs: null,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
			programmaticInjectionLedgerReceiptLink: projection.programmaticInjectionSource
				? {
						injectionLedgerIdempotencyKey: "browser-automation-key",
						injectionLedgerTaskId: "automation-origin-task",
						injectionSource: projection.programmaticInjectionSource,
						settledTerminalDeliveryReceipt: null,
					}
				: null,
		}),
	);
	return {
		ok: true,
		queue: { entriesByTaskId: { [QUEUE_BROWSER_CONVERSATION_SESSION_ID]: entries } },
		projectedEntriesByTaskId: { [QUEUE_BROWSER_CONVERSATION_SESSION_ID]: queueBrowserProjections },
		queuedTaskPromptDeliveryDebugReferenceContext: {
			workspaceId: QUEUE_BROWSER_WORKSPACE_ID,
			workspaceProjectPath: "/isolated-project/browser-test",
			queuedTaskPromptDeliveriesFilePath:
				"/isolated-runtime-home/workspaces/browser-test/queued-task-prompt-deliveries.json",
			taskMessageInjectionLedgerFilePath:
				"/isolated-runtime-home/workspaces/browser-test/task-message-injections.json",
		},
	};
}
