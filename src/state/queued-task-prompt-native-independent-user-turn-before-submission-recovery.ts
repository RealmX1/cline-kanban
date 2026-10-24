import type { QueuedTaskPromptDeliveryEntry } from "../core/api-contract";
import {
	buildNativeIndependentUserTurnQueryRecovery,
	isNativeIndependentUserTurnSubmissionKnownNotStarted,
} from "../core/queued-task-prompt-native-independent-user-turn-query-recovery";
import {
	updateWorkspaceQueuedTaskPromptDeliveriesUnderLock,
	withTaskEntries,
} from "./queued-task-prompt-delivery-store";

// 与取消、接管和最终提交共用队列锁；零写入证明只能由本次仍持有托管权的尝试推进。
export async function updateNativeIndependentUserTurnBeforeSubmissionRecovery(input: {
	workspaceId: string;
	expectedEntry: QueuedTaskPromptDeliveryEntry;
	action:
		| { kind: "query_failed"; failureNote: string }
		| { kind: "query_recovered" }
		| { kind: "submission_may_start" };
	nowEpochMs: number;
}) {
	return updateWorkspaceQueuedTaskPromptDeliveriesUnderLock(
		input.workspaceId,
		(current) => {
			const entries = current.entriesByTaskId[input.expectedEntry.taskId] ?? [];
			const entry = entries.find((candidate) => candidate.queueEntryId === input.expectedEntry.queueEntryId);
			if (
				!entry ||
				entry.deliveryState !== "handed_to_transport" ||
				entry.dispatchIdempotencyKey !== input.expectedEntry.dispatchIdempotencyKey ||
				entry.custodianRuntimeProcessInstanceId !== input.expectedEntry.custodianRuntimeProcessInstanceId ||
				entry.claimedForSessionIncarnationId !== input.expectedEntry.claimedForSessionIncarnationId ||
				entry.requiredNativeIndependentUserTurnSessionId !==
					input.expectedEntry.requiredNativeIndependentUserTurnSessionId ||
				entry.requiredNativeIndependentUserTurnSessionIncarnationId !==
					input.expectedEntry.requiredNativeIndependentUserTurnSessionIncarnationId ||
				entry.expiresAt <= input.nowEpochMs ||
				!isNativeIndependentUserTurnSubmissionKnownNotStarted(entry)
			)
				return { next: current, result: null };
			const previous = entry.nativeIndependentUserTurnBeforeSubmissionQueryRecovery;
			if (input.action.kind === "query_recovered" && (!previous || previous.recoveredAtEpochMs !== null))
				return { next: current, result: entry };
			const updated: QueuedTaskPromptDeliveryEntry =
				input.action.kind === "submission_may_start"
					? {
							...entry,
							nativeIndependentUserTurnSubmissionProgress: {
								predecessorNativeTurnId:
									entry.nativeIndependentUserTurnSubmissionProgress?.predecessorNativeTurnId ?? "",
								submissionMayHaveStartedAtEpochMs: input.nowEpochMs,
							},
						}
					: {
							...entry,
							...(previous || input.action.kind === "query_failed"
								? {
										nativeIndependentUserTurnBeforeSubmissionQueryRecovery:
											buildNativeIndependentUserTurnQueryRecovery({
												previous,
												failureReason:
													input.action.kind === "query_failed" ? input.action.failureNote : null,
												nowEpochMs: input.nowEpochMs,
												expiresAtEpochMs: entry.expiresAt,
											}),
									}
								: {}),
						};
			return {
				next: withTaskEntries(
					current,
					entry.taskId,
					entries.map((candidate) => (candidate === entry ? updated : candidate)),
				),
				result: updated,
			};
		},
		input.nowEpochMs,
		"native-independent-user-turn-before-submission-recovery",
	);
}
