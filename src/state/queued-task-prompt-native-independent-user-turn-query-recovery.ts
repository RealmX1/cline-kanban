import type { QueuedTaskPromptDeliveryEntry } from "../core/api-contract";
import { isQueuedTaskPromptDeliveryAwaitingDispatch } from "../core/queued-task-prompt-delivery-dispatch-eligibility";
import {
	buildNativeIndependentUserTurnQueryRecovery,
	isNativeIndependentUserTurnSubmissionKnownNotStarted,
} from "../core/queued-task-prompt-native-independent-user-turn-query-recovery";
import {
	updateWorkspaceQueuedTaskPromptDeliveriesUnderLock,
	withTaskEntries,
} from "./queued-task-prompt-delivery-store";

export async function updateQueuedTaskPromptNativeIndependentUserTurnQueryRecovery(input: {
	workspaceId: string;
	expectedEntry: QueuedTaskPromptDeliveryEntry;
	failureReason: string | null;
	nowEpochMs: number;
}) {
	const { snapshot } = await updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => {
			const entries = current.entriesByTaskId[input.expectedEntry.taskId] ?? [];
			const head = entries.find((entry) => isQueuedTaskPromptDeliveryAwaitingDispatch(entry, input.nowEpochMs));
			if (
				!head ||
				head.queueEntryId !== input.expectedEntry.queueEntryId ||
				head.deliveryState !== "queued" ||
				(head.deliveryAttemptCount !== 0 && !isNativeIndependentUserTurnSubmissionKnownNotStarted(head)) ||
				!head.requiredNativeIndependentUserTurnSessionId ||
				head.custodianRuntimeProcessInstanceId !== input.expectedEntry.custodianRuntimeProcessInstanceId ||
				head.requiredNativeIndependentUserTurnSessionIncarnationId !==
					input.expectedEntry.requiredNativeIndependentUserTurnSessionIncarnationId ||
				head.requiredNativeIndependentUserTurnSessionId !==
					input.expectedEntry.requiredNativeIndependentUserTurnSessionId
			) {
				return { next: current, result: null };
			}
			const previous = head.nativeIndependentUserTurnPreflightQueryRecovery;
			if (input.failureReason === null && (!previous || previous.recoveredAtEpochMs !== null))
				return { next: current, result: null };
			const recovery = buildNativeIndependentUserTurnQueryRecovery({
				previous,
				failureReason: input.failureReason,
				nowEpochMs: input.nowEpochMs,
				expiresAtEpochMs: head.expiresAt,
			});
			return {
				next: withTaskEntries(
					current,
					head.taskId,
					entries.map((entry) =>
						entry === head
							? {
									...entry,
									nativeIndependentUserTurnPreflightQueryRecovery: recovery,
								}
							: entry,
					),
				),
				result: null,
			};
		},
		input.nowEpochMs,
		"native-independent-user-turn-query-recovery",
	);
	return snapshot;
}
