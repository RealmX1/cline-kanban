import { describe, expect, it } from "vitest";

import {
	decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded,
	formatKanbanCliPostDeployVerificationCompletionRetryCommand,
	type KanbanCliPostDeployVerificationCompletionEntryPoint,
} from "../../../src/commands/post-deploy-verification-moved-to-done-but-verified-at-unrecorded-cli-retry";
import type {
	RuntimeBoardColumnId,
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationTask,
} from "../../../src/core/api-contract";

const NOW_ISO = "2026-10-01T12:00:00.000Z";
const IN_FLIGHT_RECORD_EXPIRES_AT_ISO = "2026-10-01T12:15:00.000Z";
const IN_FLIGHT_CONFIRMATION_TOKEN = "in-flight-confirmation-token";

// 构造「CLI 已移入 Done、runtime 补记 verifiedAt 失败」时盘上的任务：verifiedAt=null、checklist 全勾、留有在途完成记录。
function buildTaskMovedToDoneWithInFlightCompletionRecord(input: {
	columnIdAtIssuance: RuntimeBoardColumnId;
	recordedAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
	expiresAtIso?: string;
}): RuntimePostDeployVerificationTask {
	return {
		taskId: "task-moved-to-done",
		columnIdAtMatch: input.columnIdAtIssuance,
		matchedCommits: [],
		inclusionReason: "validation_column",
		checklist: [],
		verifiedAt: null,
		boardMovedToDoneAt: null,
		pendingConfirmation: {
			token: IN_FLIGHT_CONFIRMATION_TOKEN,
			expiresAtIso: input.expiresAtIso ?? IN_FLIGHT_RECORD_EXPIRES_AT_ISO,
			requiredAcknowledgements: input.recordedAcknowledgements,
			columnIdAtIssuance: input.columnIdAtIssuance,
		},
		droppedReason: null,
	};
}

const verificationCompleteEntryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint = {
	kind: "verification_complete_without_confirmation_token",
};

describe("移入 Done 成功、verifiedAt 未记：CLI 原样重跑的补记判定", () => {
	it("validation 来源（空 acks）：重跑 verification-complete 放行补记，不算 forced", () => {
		const decision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
			}),
			entryPoint: verificationCompleteEntryPoint,
			nowIso: NOW_ISO,
		});
		expect(decision).toEqual({
			retryAllowed: true,
			sourceColumnIdBeforeMoveToDone: "validation",
			inFlightCompletionRecordExpiresAtIso: IN_FLIGHT_RECORD_EXPIRES_AT_ISO,
			confirmedAcknowledgements: [],
			forcedCompletionWithoutAllVerificationsPassed: false,
		});
	});

	it("review 来源（非空 acks）：无 token 的 verification-complete 不放行，避免伪造 skip_validation 确认", () => {
		const decision = decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
			task: buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "review",
				recordedAcknowledgements: ["skip_validation"],
			}),
			entryPoint: verificationCompleteEntryPoint,
			nowIso: NOW_ISO,
		});
		expect(decision.retryAllowed).toBe(false);
		expect(decision).toMatchObject({ requiredAcknowledgements: ["skip_validation"] });
	});

	it("token 路径：同 token + 同 acks 放行；token 或 acks 不符一律拒绝", () => {
		const task = buildTaskMovedToDoneWithInFlightCompletionRecord({
			columnIdAtIssuance: "in_progress",
			recordedAcknowledgements: ["skip_validation", "in_progress_active"],
		});
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: IN_FLIGHT_CONFIRMATION_TOKEN,
					presentedAcknowledgements: ["in_progress_active", "skip_validation"],
				},
				nowIso: NOW_ISO,
			}),
		).toMatchObject({
			retryAllowed: true,
			sourceColumnIdBeforeMoveToDone: "in_progress",
			forcedCompletionWithoutAllVerificationsPassed: false,
		});
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: "some-other-token",
					presentedAcknowledgements: ["skip_validation", "in_progress_active"],
				},
				nowIso: NOW_ISO,
			}),
		).toEqual({ retryAllowed: false, error: "Confirmation token mismatch." });
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: IN_FLIGHT_CONFIRMATION_TOKEN,
					presentedAcknowledgements: ["skip_validation"],
				},
				nowIso: NOW_ISO,
			}).retryAllowed,
		).toBe(false);
	});

	it("--force 路径：acks 与在途记录完全一致才放行，并保留 forced 证据", () => {
		const task = buildTaskMovedToDoneWithInFlightCompletionRecord({
			columnIdAtIssuance: "review",
			recordedAcknowledgements: ["skip_validation"],
		});
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: {
					kind: "verification_confirm_with_force_break_glass",
					presentedAcknowledgements: ["skip_validation"],
				},
				nowIso: NOW_ISO,
			}),
		).toMatchObject({ retryAllowed: true, forcedCompletionWithoutAllVerificationsPassed: true });
		expect(
			decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
				task,
				entryPoint: { kind: "verification_confirm_with_force_break_glass", presentedAcknowledgements: [] },
				nowIso: NOW_ISO,
			}),
		).toMatchObject({ retryAllowed: false, requiredAcknowledgements: ["skip_validation"] });
	});

	it("无在途记录（手动拖入 Done）、记录已过期、时间不可解析、来源列非法、已 verified：一律不放行", () => {
		const validationTask = buildTaskMovedToDoneWithInFlightCompletionRecord({
			columnIdAtIssuance: "validation",
			recordedAcknowledgements: [],
		});
		const rejectedTasks: RuntimePostDeployVerificationTask[] = [
			{ ...validationTask, pendingConfirmation: null },
			buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
				expiresAtIso: NOW_ISO,
			}),
			buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "validation",
				recordedAcknowledgements: [],
				expiresAtIso: "not-an-iso-timestamp",
			}),
			buildTaskMovedToDoneWithInFlightCompletionRecord({
				columnIdAtIssuance: "backlog",
				recordedAcknowledgements: [],
			}),
			{ ...validationTask, verifiedAt: "2026-10-01T11:59:00.000Z" },
		];
		for (const task of rejectedTasks) {
			expect(
				decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded({
					task,
					entryPoint: verificationCompleteEntryPoint,
					nowIso: NOW_ISO,
				}).retryAllowed,
			).toBe(false);
		}
	});
});

describe("补记失败时回给调用者的原样重跑命令", () => {
	it("三种入口各自还原成同一条可重跑的 kanban 命令", () => {
		const target = { deploymentId: "deploy-1", taskId: "task-1" };
		expect(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				...target,
				entryPoint: verificationCompleteEntryPoint,
			}),
		).toBe("kanban deployment verification-complete --deployment-id deploy-1 --task-id task-1");
		expect(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				...target,
				entryPoint: {
					kind: "verification_confirm_with_confirmation_token",
					presentedConfirmationToken: "token-1",
					presentedAcknowledgements: ["skip_validation", "in_progress_active"],
				},
			}),
		).toBe(
			"kanban deployment verification-confirm --deployment-id deploy-1 --task-id task-1 --token token-1 --ack skip_validation,in_progress_active",
		);
		expect(
			formatKanbanCliPostDeployVerificationCompletionRetryCommand({
				...target,
				entryPoint: { kind: "verification_confirm_with_force_break_glass", presentedAcknowledgements: [] },
			}),
		).toBe("kanban deployment verification-confirm --deployment-id deploy-1 --task-id task-1 --force");
	});
});
