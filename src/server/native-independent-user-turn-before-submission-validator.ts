import { setTimeout as waitMilliseconds } from "node:timers/promises";
import type { QueuedTaskPromptDeliveryEntry, WorkspaceQueuedTaskPromptDeliverySnapshot } from "../core/api-contract";
import { isNativeIndependentUserTurnSubmissionKnownNotStarted } from "../core/queued-task-prompt-native-independent-user-turn-query-recovery";
import type { TaskChatDeliveryWriteValidator } from "../core/task-chat-delivery-write-validation";
import type { CodexNativeConversationTurn } from "../rvf-automatic-closeout/codex-native-conversation-prefix";
import {
	assertIndependentUserTurnImmediatelyBeforeTerminalWrite,
	NativeIndependentUserTurnDeliveryCancelledBeforeSubmission,
	NativeIndependentUserTurnDeliveryError,
	NativeIndependentUserTurnMessageAlreadyAccepted,
	NativeIndependentUserTurnSubmissionRecoverySuspended,
} from "../rvf-automatic-closeout/native-independent-user-turn-delivery-gate";
import {
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	settleExpiredQueuedTaskPromptDeliveries,
} from "../state/queued-task-prompt-delivery-store";
import { updateNativeIndependentUserTurnBeforeSubmissionRecovery } from "../state/queued-task-prompt-native-independent-user-turn-before-submission-recovery";

export function createNativeIndependentUserTurnBeforeSubmissionValidator(input: {
	workspaceId: string;
	entry: QueuedTaskPromptDeliveryEntry;
	predecessorNativeTurnId: string;
	text: string;
	now: () => number;
	isStopped: () => boolean;
	whenStopped: Promise<void>;
	readNativeConversationTurns: () => Promise<CodexNativeConversationTurn[]>;
	onSnapshotChanged: (snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot) => Promise<void>;
}): TaskChatDeliveryWriteValidator {
	const publishSnapshot = async (snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot) => {
		try {
			await input.onSnapshotChanged(snapshot);
		} catch {
			/* 持久状态已保存，后续读与 sweep 会补齐投影。 */
		}
	};
	const readCurrentOwnedEntry = async () => {
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(input.workspaceId);
		const current = snapshot.entriesByTaskId[input.entry.taskId]?.find(
			(entry) => entry.queueEntryId === input.entry.queueEntryId,
		);
		if (
			input.isStopped() ||
			(current && current.custodianRuntimeProcessInstanceId !== input.entry.custodianRuntimeProcessInstanceId)
		)
			throw new NativeIndependentUserTurnSubmissionRecoverySuspended(
				"原 runtime 已停止或托管权已转移，保留原投递等待。",
			);
		if (current?.deliveryState === "expired")
			throw new NativeIndependentUserTurnDeliveryError(
				"native_independent_user_turn_capability_unavailable",
				current.lastDeliveryFailureNote ?? "原生查询等待超过原截止时间。",
			);
		if (!current || current.deliveryState === "cancelled")
			throw new NativeIndependentUserTurnDeliveryCancelledBeforeSubmission("独立原生回合投递已取消或已随任务移除。");
		if (
			current.deliveryState !== "handed_to_transport" ||
			current.dispatchIdempotencyKey !== input.entry.dispatchIdempotencyKey ||
			current.custodianRuntimeProcessInstanceId !== input.entry.custodianRuntimeProcessInstanceId
		)
			throw new NativeIndependentUserTurnSubmissionRecoverySuspended("原投递尝试已失去当前归属，停止旧校验。");
		if (input.now() >= current.expiresAt) {
			if (isNativeIndependentUserTurnSubmissionKnownNotStarted(current)) {
				const expired = await settleExpiredQueuedTaskPromptDeliveries({
					workspaceId: input.workspaceId,
					nowEpochMs: input.now(),
				});
				await publishSnapshot(expired);
			}
			throw new NativeIndependentUserTurnDeliveryError(
				"native_independent_user_turn_capability_unavailable",
				current.nativeIndependentUserTurnBeforeSubmissionQueryRecovery?.lastQueryFailureReason ??
					"独立原生回合投递超过原截止时间，未继续提交。",
			);
		}
		return current;
	};
	return async (phase = "before_transport_acceptance") => {
		try {
			for (;;) {
				const current = await readCurrentOwnedEntry();
				const mayRetryReadOnlyQuery =
					phase !== "after_transport_write" && isNativeIndependentUserTurnSubmissionKnownNotStarted(current);
				const retryAt = current.nativeIndependentUserTurnBeforeSubmissionQueryRecovery?.nextQueryRetryAtEpochMs;
				if (mayRetryReadOnlyQuery && retryAt != null && retryAt > input.now()) {
					// 短等待让取消、停止与 TTL 及时生效；完整退避期限持久保存在队列，不因重启重置。
					await Promise.race([
						waitMilliseconds(Math.min(250, retryAt - input.now(), current.expiresAt - input.now())),
						input.whenStopped,
					]);
					continue;
				}
				try {
					assertIndependentUserTurnImmediatelyBeforeTerminalWrite({
						turns: await input.readNativeConversationTurns(),
						predecessorTurnId: input.predecessorNativeTurnId,
						text: input.text,
					});
				} catch (error) {
					if (
						!(error instanceof NativeIndependentUserTurnDeliveryError) ||
						!error.recovery.retryableQueryFailure ||
						!mayRetryReadOnlyQuery
					)
						throw error;
					const waiting = await updateNativeIndependentUserTurnBeforeSubmissionRecovery({
						workspaceId: input.workspaceId,
						expectedEntry: input.entry,
						action: { kind: "query_failed", failureNote: error.message },
						nowEpochMs: input.now(),
					});
					await publishSnapshot(waiting.snapshot);
					if (!waiting.result) {
						await readCurrentOwnedEntry();
						throw error;
					}
					continue;
				}
				await readCurrentOwnedEntry();
				if (mayRetryReadOnlyQuery) {
					const recovered = await updateNativeIndependentUserTurnBeforeSubmissionRecovery({
						workspaceId: input.workspaceId,
						expectedEntry: input.entry,
						action: { kind: "query_recovered" },
						nowEpochMs: input.now(),
					});
					await publishSnapshot(recovered.snapshot);
					if (!recovered.result) throw new Error("独立原生回合提交前校验的归属已失效。");
					if (phase === "before_first_transport_write") {
						const marked = await updateNativeIndependentUserTurnBeforeSubmissionRecovery({
							workspaceId: input.workspaceId,
							expectedEntry: input.entry,
							action: { kind: "submission_may_start" },
							nowEpochMs: input.now(),
						});
						await publishSnapshot(marked.snapshot);
						if (!marked.result) throw new Error("独立原生回合提交前的持久标记未获准写入。");
					}
				}
				return;
			}
		} catch (error) {
			if (
				error instanceof NativeIndependentUserTurnDeliveryError ||
				error instanceof NativeIndependentUserTurnMessageAlreadyAccepted ||
				error instanceof NativeIndependentUserTurnSubmissionRecoverySuspended ||
				error instanceof NativeIndependentUserTurnDeliveryCancelledBeforeSubmission
			)
				throw error;
			throw new NativeIndependentUserTurnDeliveryError(
				"native_independent_user_turn_capability_unavailable",
				`独立原生回合提交前核验未完成：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
}
