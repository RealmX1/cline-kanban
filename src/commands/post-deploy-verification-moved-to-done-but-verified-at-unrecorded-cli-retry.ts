import type {
	RuntimeBoardColumnId,
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationTask,
	RuntimePostDeployVerificationUncheckedChecklistItemClosureReason,
} from "../core/api-contract";
import {
	type KanbanCliCompletionAuthorizedBeforeMoveIntoDone,
	resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask,
} from "../deployment/post-deploy-verification-closure-application";
import { isPostDeployVerificationTaskClosed } from "../deployment/post-deploy-verification-deployment-group-task-assembly";
import { computeRequiredAcknowledgementsForColumn } from "../deployment/post-deploy-verification-state";

// 「CLI 已把任务移入 Done（trash）、但 runtime 写 verifiedAt 的 procedure 调用失败」滞留态的重试判定。
//
// 背景：verifiedAt 只能由 runtime 写（「PDV 通过」事件只能由 runtime 记进关系账本），CLI 只能先移列、再调
// procedure 补记；两次调用之间 runtime 重启 / 不可达，任务就停在「已在 trash、verifiedAt=null」。CLI 因此在移列前
// 先落一条「在途完成记录」（复用 pendingConfirmation 形状：来源列 + 已确认的 acks + 15min 过期），它同时让
// reconcile 跳过该任务（不误标 moved_out_manually），并作为重试时的授权证据——重跑「同一条命令」即可只补记 verifiedAt。
//
// 不变量（未经核对的任务不能被标为 verified）：调用方已确认 droppedReason===null；本判定再要求在途记录存在、未过期、
// 来源列是合法完成来源、checklist 全勾或在途记录里的原因覆盖全部未勾项（原因只认移列前写下的那份，重跑命令不必、
// 也无从再带 --closure-reason-*），并按入口重新校验与原完成路径同强度的授权：
//  - verification-complete（无 token）：只放行空 acks（validation 来源）记录——它本就无需任何确认；非空 acks
//    若无 token 放行，会伪造用户从未给出的 skip_validation / in_progress_active（与 Web 端
//    resolvePostDeployVerificationStuckDoneRecovery 同一安全边界）。
//  - verification-confirm --token：token 必须与在途记录一致，--ack 必须与记录的 acks 完全一致。
//  - verification-confirm --force：--ack 必须与记录的 acks 完全一致（force 开关由调用方另行校验）。
// 在途记录过期后 CLI 不再能补记，判定返回不放行；但它带「已在 CLI 侧授权」标记、不受过期回收：runtime 下次为该项目加载
// PDV 状态时（getPostDeployVerificationState，例如 Web UI 部署后验证面板轮询），在卡已入 Done 后自行补写 verifiedAt，
// 所属部署组已被新部署折叠也一样（见 post-deploy-verification-state.ts 的
// reconcileKanbanCliCompletionsAuthorizedButLeftInFlightAcrossWorkspaceDeploymentGroups）。CLI 的 verification-state 只读文件，不触发它。

export type KanbanCliPostDeployVerificationCompletionEntryPoint =
	| { kind: "verification_complete_without_confirmation_token" }
	| {
			kind: "verification_confirm_with_confirmation_token";
			presentedConfirmationToken: string;
			presentedAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
	  }
	| {
			kind: "verification_confirm_with_force_break_glass";
			presentedAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
	  };

export type KanbanCliRetryDecisionForTaskMovedToDoneButVerifiedAtUnrecorded =
	| {
			retryAllowed: true;
			sourceColumnIdBeforeMoveToDone: RuntimeBoardColumnId;
			inFlightCompletionRecordExpiresAtIso: string;
			confirmedAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
			confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: boolean;
			// CLI 移列前在在途记录里写下的逐项原因（带原因结案时）；全勾结案为空。
			uncheckedChecklistItemClosureReasons: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[];
	  }
	| {
			retryAllowed: false;
			error: string;
			requiredAcknowledgements?: RuntimePostDeployVerificationAcknowledgement[];
	  };

/**
 * CLI 完成动词移列前写进在途完成记录的「已授权」标记（本模块的重试判定与 runtime 对账都读它）。
 * 旧 binary 兼容：2026-10-11 之前的 schema 把 forcedCompletionWithoutAllVerificationsPassed 定为必填，只写新字段的记录
 * 一旦留在状态文件里（CLI 授权后中断即可留下），回滚后旧 binary 整文件解析失败、隔离成 .corrupt-*、降级为空组。
 * 过渡期两个字段同值双写；读取以新字段为准。
 */
export function buildKanbanCliCompletionAuthorizedBeforeMoveIntoDone(input: {
	authorizedAtIso: string;
	confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: boolean;
	uncheckedChecklistItemClosureReasons: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[];
}): KanbanCliCompletionAuthorizedBeforeMoveIntoDone {
	return {
		authorizedAtIso: input.authorizedAtIso,
		forcedCompletionWithoutAllVerificationsPassed:
			input.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
		confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
			input.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag,
		uncheckedChecklistItemClosureReasons: input.uncheckedChecklistItemClosureReasons,
	};
}

export function acknowledgementSetsEqual(
	left: RuntimePostDeployVerificationAcknowledgement[],
	right: RuntimePostDeployVerificationAcknowledgement[],
): boolean {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	if (leftSet.size !== rightSet.size) {
		return false;
	}
	for (const value of leftSet) {
		if (!rightSet.has(value)) {
			return false;
		}
	}
	return true;
}

function isInFlightCompletionRecordExpired(expiresAtIso: string, nowIso: string): boolean {
	const expiresMs = Date.parse(expiresAtIso);
	const nowMs = Date.parse(nowIso);
	// 解析不出的时间按已过期处理（fail closed）：授权证据不可信时宁可不放行。
	return !Number.isFinite(expiresMs) || !Number.isFinite(nowMs) || expiresMs <= nowMs;
}

/**
 * 任务已在 Done（trash）时，判定 CLI 本次入口能否「只补记 verifiedAt、不再移列」。
 * 前置条件（调用方负责）：task.droppedReason===null。未勾项的原因由本判定从在途记录取回并校验覆盖。
 */
export function decideKanbanCliRetryForTaskMovedToDoneButVerifiedAtUnrecorded(input: {
	task: RuntimePostDeployVerificationTask;
	entryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint;
	nowIso: string;
}): KanbanCliRetryDecisionForTaskMovedToDoneButVerifiedAtUnrecorded {
	const { task, entryPoint, nowIso } = input;
	if (isPostDeployVerificationTaskClosed(task)) {
		return { retryAllowed: false, error: "Task is already in done." };
	}
	const inFlightCompletionRecord = task.pendingConfirmation;
	if (inFlightCompletionRecord === null) {
		return {
			retryAllowed: false,
			error: "Task is already in done and has no in-flight completion record, so its verification cannot be recorded.",
		};
	}
	if (isInFlightCompletionRecordExpired(inFlightCompletionRecord.expiresAtIso, nowIso)) {
		return {
			retryAllowed: false,
			error: `Task is already in done, but its in-flight completion record expired at ${inFlightCompletionRecord.expiresAtIso}; its verification can no longer be recorded from the CLI.${
				inFlightCompletionRecord.kanbanCliCompletionAuthorizedBeforeMoveIntoDone
					? " Because this completion was already authorized before the move, the Kanban runtime records it on its own the next time it loads post-deploy verification state for this project (for example, when the Web UI post-deploy verification panel polls it); `kanban deployment verification-state` only reads the state file and does not trigger that."
					: ""
			}`,
		};
	}
	if (computeRequiredAcknowledgementsForColumn(inFlightCompletionRecord.columnIdAtIssuance) === null) {
		return {
			retryAllowed: false,
			error: `Task is already in done, but its in-flight completion record came from column "${inFlightCompletionRecord.columnIdAtIssuance}", which is not a valid completion source.`,
		};
	}
	const recordedAcknowledgements = inFlightCompletionRecord.requiredAcknowledgements;
	const recordedUncheckedChecklistItemClosureReasons =
		inFlightCompletionRecord.kanbanCliCompletionAuthorizedBeforeMoveIntoDone?.uncheckedChecklistItemClosureReasons ??
		[];
	// 原因只认移列前写下的那份：调用方不再用命令行原因校验这条补记路径，否则带原因结案的任务照提示重跑必然报缺原因。
	// 移列后 checklist 又多出未勾项（如对账合并了晚注册的 authored 项）时，记录里的原因不再覆盖，fail closed。
	const recordedClosureReasonsResolution = resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask(
		task,
		{
			uncheckedChecklistItemClosureReasons: recordedUncheckedChecklistItemClosureReasons,
		},
	);
	if (!recordedClosureReasonsResolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems) {
		return {
			retryAllowed: false,
			error: `Task is already in done, but the closure reasons recorded before it was moved to done do not cover these unchecked checklist items, so its verification cannot be recorded from the CLI: ${recordedClosureReasonsResolution.uncheckedChecklistItemsMissingClosureReason
				.map((item) => `${item.id} (${item.label})`)
				.join("; ")}`,
		};
	}
	const acknowledgementMismatchError = `--ack must exactly match the acknowledgements confirmed before the task was moved to done: ${
		recordedAcknowledgements.length === 0 ? "(none)" : recordedAcknowledgements.join(", ")
	}.`;

	switch (entryPoint.kind) {
		case "verification_complete_without_confirmation_token": {
			if (recordedAcknowledgements.length > 0) {
				return {
					retryAllowed: false,
					error: `Task is already in done with an in-flight completion that requires acknowledgements (${recordedAcknowledgements.join(", ")}); record its verification with verification-confirm using the same --token (or --force) and --ack.`,
					requiredAcknowledgements: recordedAcknowledgements,
				};
			}
			return {
				retryAllowed: true,
				sourceColumnIdBeforeMoveToDone: inFlightCompletionRecord.columnIdAtIssuance,
				inFlightCompletionRecordExpiresAtIso: inFlightCompletionRecord.expiresAtIso,
				confirmedAcknowledgements: [],
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
				uncheckedChecklistItemClosureReasons: recordedUncheckedChecklistItemClosureReasons,
			};
		}
		case "verification_confirm_with_confirmation_token": {
			if (entryPoint.presentedConfirmationToken !== inFlightCompletionRecord.token) {
				return { retryAllowed: false, error: "Confirmation token mismatch." };
			}
			if (!acknowledgementSetsEqual(entryPoint.presentedAcknowledgements, recordedAcknowledgements)) {
				return {
					retryAllowed: false,
					error: acknowledgementMismatchError,
					requiredAcknowledgements: recordedAcknowledgements,
				};
			}
			return {
				retryAllowed: true,
				sourceColumnIdBeforeMoveToDone: inFlightCompletionRecord.columnIdAtIssuance,
				inFlightCompletionRecordExpiresAtIso: inFlightCompletionRecord.expiresAtIso,
				confirmedAcknowledgements: entryPoint.presentedAcknowledgements,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: false,
				uncheckedChecklistItemClosureReasons: recordedUncheckedChecklistItemClosureReasons,
			};
		}
		case "verification_confirm_with_force_break_glass": {
			if (!acknowledgementSetsEqual(entryPoint.presentedAcknowledgements, recordedAcknowledgements)) {
				return {
					retryAllowed: false,
					error: acknowledgementMismatchError,
					requiredAcknowledgements: recordedAcknowledgements,
				};
			}
			return {
				retryAllowed: true,
				sourceColumnIdBeforeMoveToDone: inFlightCompletionRecord.columnIdAtIssuance,
				inFlightCompletionRecordExpiresAtIso: inFlightCompletionRecord.expiresAtIso,
				confirmedAcknowledgements: entryPoint.presentedAcknowledgements,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: true,
				uncheckedChecklistItemClosureReasons: recordedUncheckedChecklistItemClosureReasons,
			};
		}
	}
}

// 移列成功但 verifiedAt 补记失败时回给调用者的「原样重跑」命令：在途记录未过期前重跑它即只补记 verifiedAt。
// 刻意不带 --closure-reason-*：补记路径只用在途记录里移列前写下的原因（见上方判定），重跑时给的原因参数不参与。
export function formatKanbanCliPostDeployVerificationCompletionRetryCommand(input: {
	deploymentId: string;
	taskId: string;
	entryPoint: KanbanCliPostDeployVerificationCompletionEntryPoint;
}): string {
	const target = `--deployment-id ${input.deploymentId} --task-id ${input.taskId}`;
	switch (input.entryPoint.kind) {
		case "verification_complete_without_confirmation_token":
			return `kanban deployment verification-complete ${target}`;
		case "verification_confirm_with_confirmation_token":
			return `kanban deployment verification-confirm ${target} --token ${input.entryPoint.presentedConfirmationToken}${formatAcknowledgementFlag(input.entryPoint.presentedAcknowledgements)}`;
		case "verification_confirm_with_force_break_glass":
			return `kanban deployment verification-confirm ${target} --force${formatAcknowledgementFlag(input.entryPoint.presentedAcknowledgements)}`;
	}
}

function formatAcknowledgementFlag(acknowledgements: RuntimePostDeployVerificationAcknowledgement[]): string {
	return acknowledgements.length === 0 ? "" : ` --ack ${acknowledgements.join(",")}`;
}
