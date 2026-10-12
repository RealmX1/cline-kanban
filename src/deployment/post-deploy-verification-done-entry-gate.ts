import type {
	RuntimeBoardColumnId,
	RuntimePostDeployVerificationClosureOutcome,
	RuntimePostDeployVerificationCompletionPath,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimePostDeployVerificationState,
	RuntimePostDeployVerificationTask,
} from "../core/api-contract";
import {
	applyPostDeployVerificationClosureToTaskWithinStateLock,
	isChecklistOfPostDeployVerificationTaskFullyChecked,
	type KanbanCliCompletionAuthorizedBeforeMoveIntoDone,
	markPostDeployVerificationTaskEnteredDoneWithoutProvableClosureWithinStateLock,
	type PostDeployVerificationTaskClosedWithinStateLock,
	readConfirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlagOfKanbanCliCompletionAuthorization,
	resolvePostDeployVerificationClosureProvableFromCurrentChecklist,
	resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask,
	runPostDeployVerificationClosureSideEffectsOutsideStateLock,
} from "./post-deploy-verification-closure-application";
import {
	isPostDeployVerificationTaskAwaitingVerification,
	isPostDeployVerificationTaskClosed,
} from "./post-deploy-verification-deployment-group-task-assembly";
import {
	findActiveDeploymentGroupOfWorkspace,
	mutatePostDeployVerificationState,
	readPostDeployVerificationStateCorruptionTolerant,
} from "./post-deploy-verification-state";

// 「移入 Done」的 Post-Deploy Verification 门禁（2026-10-11 用户选定：所有进 Done 的入口统一拦截，服务端是唯一判据）。
// 受门禁 = 任务在**该 workspace** 的活跃部署组里、仍在等核对（未结案、未移除、不是只读展示、没被延续走）。
// 判据键必须带 workspaceId：taskId 只在 workspace 内唯一，跨项目会撞号。目前只有 cline-kanban 记录部署，所以实际只影响它。
//
// 时序（taskCardAction.moveTaskCardIntoDone…）：授权（写在途授权）→ 移列 → 结案（写 closure、记账、待观察记录、清理）。
// 移列失败撤销授权；结案写盘失败由 runtime 对账按在途授权补完（reconcileKanbanCliCompletionsAuthorizedButLeftInFlight…）。
// 授权写下后 checklist 仍可被改，结案（含对账补完）一律在锁内按当时的 checklist 重新核验结局，见
// resolvePostDeployVerificationClosureProvableFromCurrentChecklist。

// 在途授权的有效期：移列一般在毫秒级完成，过期只用于清理「授权写下、移列却从没成功」的残留。
const DONE_ENTRY_CLOSURE_AUTHORIZATION_IN_FLIGHT_TTL_MS = 15 * 60 * 1000;

const KANBAN_CLI_POST_DEPLOY_VERIFICATION_COMPLETION_VERB_COMPLETION_PATH: RuntimePostDeployVerificationCompletionPath =
	"kanban_cli_post_deploy_verification_completion_verb";

// 授权类记录的有效期判定一律 fail closed：时间解析不出就当已过期，宁可不放行。
function isInFlightAuthorizationUnexpiredAt(expiresAtIso: string, nowMs: number): boolean {
	const expiresAtMs = Date.parse(expiresAtIso);
	return Number.isFinite(expiresAtMs) && Number.isFinite(nowMs) && expiresAtMs > nowMs;
}

// CLI 完成动词在移列前写下的在途完成记录（pendingConfirmation 带「已授权」标记），且仍在有效期；没有或已过期返回 null。
function findUnexpiredKanbanCliCompletionAuthorizedBeforeMoveIntoDone(
	task: RuntimePostDeployVerificationTask,
	nowMs: number,
): KanbanCliCompletionAuthorizedBeforeMoveIntoDone | null {
	const inFlightCompletionRecord = task.pendingConfirmation;
	const kanbanCliCompletionAuthorization = inFlightCompletionRecord?.kanbanCliCompletionAuthorizedBeforeMoveIntoDone;
	if (
		!inFlightCompletionRecord ||
		!kanbanCliCompletionAuthorization ||
		!isInFlightAuthorizationUnexpiredAt(inFlightCompletionRecord.expiresAtIso, nowMs)
	) {
		return null;
	}
	return kanbanCliCompletionAuthorization;
}

// 「授权已核验、仍在有效期」的在途授权：门禁写下的在途授权，或 CLI 完成动词在移列前写下的在途完成记录（token / --ack /
// --force 已在 CLI 侧核对，原因已覆盖未勾项）。普通待确认 token（requestVerificationComplete 在用户确认之前就发放，
// 用户取消原因对话框也会留下）不是授权。
function isPostDeployVerificationTaskCarryingVerifiedUnexpiredDoneEntryAuthorization(
	task: RuntimePostDeployVerificationTask,
	nowMs: number,
): boolean {
	const doneEntryAuthorization = task.doneEntryClosureAuthorizationInFlight;
	if (doneEntryAuthorization && isInFlightAuthorizationUnexpiredAt(doneEntryAuthorization.expiresAtIso, nowMs)) {
		return true;
	}
	return findUnexpiredKanbanCliCompletionAuthorizedBeforeMoveIntoDone(task, nowMs) !== null;
}

export type PostDeployVerificationDoneEntryGateOutcome =
	| "task_not_subject_to_post_deploy_verification_done_entry_gate"
	| "all_checklist_items_checked_so_move_into_done_closes_as_passed"
	| "unchecked_checklist_items_require_per_item_closure_reasons";

interface PostDeployVerificationTaskSubjectToDoneEntryGate {
	group: RuntimePostDeployVerificationDeploymentGroup;
	task: RuntimePostDeployVerificationTask;
}

export function findPostDeployVerificationTaskSubjectToDoneEntryGate(
	state: RuntimePostDeployVerificationState,
	workspaceId: string,
	taskId: string,
): PostDeployVerificationTaskSubjectToDoneEntryGate | null {
	const group = findActiveDeploymentGroupOfWorkspace(state, workspaceId);
	const task = group?.tasks.find((candidate) => candidate.taskId === taskId) ?? null;
	if (!group || !task || !isPostDeployVerificationTaskAwaitingVerification(task)) {
		return null;
	}
	return { group, task };
}

export function evaluatePostDeployVerificationDoneEntryGateForTask(
	task: RuntimePostDeployVerificationTask | null,
): PostDeployVerificationDoneEntryGateOutcome {
	if (!task || !isPostDeployVerificationTaskAwaitingVerification(task)) {
		return "task_not_subject_to_post_deploy_verification_done_entry_gate";
	}
	return isChecklistOfPostDeployVerificationTaskFullyChecked(task)
		? "all_checklist_items_checked_so_move_into_done_closes_as_passed"
		: "unchecked_checklist_items_require_per_item_closure_reasons";
}

export type AuthorizePostDeployVerificationDoneEntryResult =
	| { postDeployVerificationDoneEntryGateDecision: "task_not_subject_to_post_deploy_verification_done_entry_gate" }
	| {
			postDeployVerificationDoneEntryGateDecision: "move_into_done_authorized_with_closure_authorization_in_flight";
			anticipatedPostDeployVerificationClosureOutcome: RuntimePostDeployVerificationClosureOutcome;
	  }
	| {
			postDeployVerificationDoneEntryGateDecision: "move_into_done_rejected_because_unchecked_items_lack_closure_reasons";
			uncheckedChecklistItemsMissingClosureReason: Array<{ checklistItemId: string; checklistItemLabel: string }>;
	  };

/**
 * 移列前的门禁：受门禁的任务要么全勾（结局 = 通过），要么请求里的原因覆盖全部未勾项（结局 = 带原因结案），否则拒绝。
 * 放行时写下在途授权（结局、逐项原因、确认项），之后的结案只认它。卡已经在 Done 时不受门禁（不会再移列）。
 */
export async function authorizePostDeployVerificationDoneEntryBeforeMovingTaskCardIntoDone(input: {
	workspaceId: string;
	taskId: string;
	boardColumnIdOfTaskCardBeforeMove: RuntimeBoardColumnId;
	postDeployVerificationDoneEntryClosure: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined;
	postDeployVerificationCompletionPath: RuntimePostDeployVerificationCompletionPath;
	nowIso: string;
}): Promise<AuthorizePostDeployVerificationDoneEntryResult> {
	if (input.boardColumnIdOfTaskCardBeforeMove === "trash") {
		return {
			postDeployVerificationDoneEntryGateDecision: "task_not_subject_to_post_deploy_verification_done_entry_gate",
		};
	}
	// 不受门禁的任务（绝大多数移列）不进状态锁、不写盘：先无锁读一眼。
	const preReadState = await readPostDeployVerificationStateCorruptionTolerant(input.nowIso);
	if (!findPostDeployVerificationTaskSubjectToDoneEntryGate(preReadState, input.workspaceId, input.taskId)) {
		return {
			postDeployVerificationDoneEntryGateDecision: "task_not_subject_to_post_deploy_verification_done_entry_gate",
		};
	}
	return await mutatePostDeployVerificationState(
		input.nowIso,
		(state): AuthorizePostDeployVerificationDoneEntryResult => {
			const subject = findPostDeployVerificationTaskSubjectToDoneEntryGate(state, input.workspaceId, input.taskId);
			if (!subject) {
				return {
					postDeployVerificationDoneEntryGateDecision:
						"task_not_subject_to_post_deploy_verification_done_entry_gate",
				};
			}
			const { task } = subject;
			const fullyChecked = isChecklistOfPostDeployVerificationTaskFullyChecked(task);
			const resolution = resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask(
				task,
				input.postDeployVerificationDoneEntryClosure,
			);
			if (!fullyChecked && !resolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems) {
				return {
					postDeployVerificationDoneEntryGateDecision:
						"move_into_done_rejected_because_unchecked_items_lack_closure_reasons",
					uncheckedChecklistItemsMissingClosureReason: resolution.uncheckedChecklistItemsMissingClosureReason.map(
						(item) => ({ checklistItemId: item.id, checklistItemLabel: item.label }),
					),
				};
			}
			const anticipatedPostDeployVerificationClosureOutcome: RuntimePostDeployVerificationClosureOutcome =
				fullyChecked ? "all_checklist_items_checked" : "closed_into_done_with_unchecked_items_reasoned";
			// CLI 完成动词（`kanban deployment verification-complete / verification-confirm`）在调本 procedure 之前先落了
			// 在途完成记录：完成路径与是否 `--force` 据它推导，「PDV 通过」/ 带原因结案事件才能认出是 CLI 完成、用没用 --force。
			// 不加请求字段让客户端自报。
			const kanbanCliCompletionAuthorization = findUnexpiredKanbanCliCompletionAuthorizedBeforeMoveIntoDone(
				task,
				Date.parse(input.nowIso),
			);
			task.doneEntryClosureAuthorizationInFlight = {
				authorizedAtIso: input.nowIso,
				expiresAtIso: new Date(
					Date.parse(input.nowIso) + DONE_ENTRY_CLOSURE_AUTHORIZATION_IN_FLIGHT_TTL_MS,
				).toISOString(),
				anticipatedPostDeployVerificationClosureOutcome,
				uncheckedChecklistItemClosureReasons:
					!fullyChecked && resolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems
						? resolution.resolvedReasons
						: [],
				confirmedAcknowledgements: input.postDeployVerificationDoneEntryClosure?.confirmedAcknowledgements ?? [],
				postDeployVerificationCompletionPath: kanbanCliCompletionAuthorization
					? KANBAN_CLI_POST_DEPLOY_VERIFICATION_COMPLETION_VERB_COMPLETION_PATH
					: input.postDeployVerificationCompletionPath,
				confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag: kanbanCliCompletionAuthorization
					? readConfirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlagOfKanbanCliCompletionAuthorization(
							kanbanCliCompletionAuthorization,
						)
					: false,
			};
			return {
				postDeployVerificationDoneEntryGateDecision:
					"move_into_done_authorized_with_closure_authorization_in_flight",
				anticipatedPostDeployVerificationClosureOutcome,
			};
		},
	);
}

/** 移列失败（卡没进 Done）时撤销在途授权，免得它在过期前被当成「已授权」。 */
export async function revokePostDeployVerificationDoneEntryAuthorizationAfterMoveIntoDoneFailed(input: {
	workspaceId: string;
	taskId: string;
	nowIso: string;
}): Promise<void> {
	await mutatePostDeployVerificationState(input.nowIso, (state) => {
		const subject = findPostDeployVerificationTaskSubjectToDoneEntryGate(state, input.workspaceId, input.taskId);
		if (subject) {
			subject.task.doneEntryClosureAuthorizationInFlight = null;
		}
	});
}

/**
 * 移列成功后按在途授权结案。授权已被消费（并发的重复请求、对账已补完）时返回 null，不重复记账。
 * 结局在锁内按当前 checklist 重新核验（授权后 checklist 仍可被改）；证明不了任何结局时按「未经结案进 Done」收尾并返回 null。
 * 返回本次结案的结局。
 */
export async function finalizePostDeployVerificationClosureAfterTaskCardMovedIntoDone(input: {
	workspaceId: string;
	taskId: string;
	nowIso: string;
}): Promise<RuntimePostDeployVerificationClosureOutcome | null> {
	let closedWithinStateLock: PostDeployVerificationTaskClosedWithinStateLock | null = null;
	const outcome = await mutatePostDeployVerificationState(
		input.nowIso,
		(state): RuntimePostDeployVerificationClosureOutcome | null => {
			const group = findActiveDeploymentGroupOfWorkspace(state, input.workspaceId);
			const task = group?.tasks.find((candidate) => candidate.taskId === input.taskId) ?? null;
			const authorization = task?.doneEntryClosureAuthorizationInFlight ?? null;
			if (!group || !task || !authorization || isPostDeployVerificationTaskClosed(task)) {
				return null;
			}
			const provableClosure = resolvePostDeployVerificationClosureProvableFromCurrentChecklist(
				task,
				authorization.uncheckedChecklistItemClosureReasons,
			);
			if (!provableClosure.postDeployVerificationClosureProvableFromCurrentChecklist) {
				markPostDeployVerificationTaskEnteredDoneWithoutProvableClosureWithinStateLock(task, {
					workspaceId: group.workspaceId,
					uncheckedChecklistItemsMissingClosureReason: provableClosure.uncheckedChecklistItemsMissingClosureReason,
					inFlightAuthorizationKindForDiagnostics: "门禁写下的在途授权",
				});
				return null;
			}
			const postDeployVerificationCompletionPath =
				authorization.postDeployVerificationCompletionPath as RuntimePostDeployVerificationCompletionPath;
			applyPostDeployVerificationClosureToTaskWithinStateLock(
				task,
				{
					postDeployVerificationClosureOutcome: provableClosure.postDeployVerificationClosureOutcome,
					uncheckedChecklistItemClosureReasons: provableClosure.uncheckedChecklistItemClosureReasons,
					confirmedAcknowledgements: authorization.confirmedAcknowledgements,
					postDeployVerificationCompletionPath,
				},
				{ workspaceId: group.workspaceId, nowIso: input.nowIso },
			);
			closedWithinStateLock = {
				workspaceId: group.workspaceId,
				deploymentId: group.deploymentId,
				deployedSourceCommit: group.deployedSourceCommit,
				closedTask: structuredClone(task),
				completionEvidence: {
					postDeployVerificationCompletionPath,
					confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag:
						authorization.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag ?? false,
					confirmedAcknowledgements: [...authorization.confirmedAcknowledgements],
				},
			};
			return provableClosure.postDeployVerificationClosureOutcome;
		},
	);
	if (closedWithinStateLock) {
		await runPostDeployVerificationClosureSideEffectsOutsideStateLock(closedWithinStateLock, input.nowIso);
	}
	return outcome;
}

/**
 * 整板保存（浏览器 saveState，含没刷新的旧 bundle）里「这次新进 Done」的卡哪些必须被挡回去：受门禁、且没有**已核验且未过期**
 * 的在途授权的（见 isPostDeployVerificationTaskCarryingVerifiedUnexpiredDoneEntryAuthorization）。普通待确认 token 不算：
 * requestVerificationComplete 在清单未全勾、原因还没给时也会发放它，认它就等于放未给原因的卡进 Done。浏览器现有的所有
 * 移入 Done 路径（含 PDV 面板完成流）都走 taskCardAction 门禁，不依赖「token + 整板保存先移列」。
 * 只读快照、不加锁（在 board 锁内调用，不能再取 PDV 状态锁以免锁嵌套）；读不出时宁可不挡（返回空集），
 * 由对账把漏网的标成 moved_out_manually 并告警。
 */
export async function listTaskIdsBlockedFromEnteringDoneWithoutPostDeployVerificationClosure(input: {
	workspaceId: string;
	taskIdsNewlyEnteringDone: readonly string[];
	nowIso: string;
}): Promise<Set<string>> {
	const blockedTaskIds = new Set<string>();
	if (input.taskIdsNewlyEnteringDone.length === 0) {
		return blockedTaskIds;
	}
	let state: RuntimePostDeployVerificationState;
	try {
		state = await readPostDeployVerificationStateCorruptionTolerant(input.nowIso);
	} catch {
		return blockedTaskIds;
	}
	const nowMs = Date.parse(input.nowIso);
	for (const taskId of input.taskIdsNewlyEnteringDone) {
		const subject = findPostDeployVerificationTaskSubjectToDoneEntryGate(state, input.workspaceId, taskId);
		if (
			subject &&
			!isPostDeployVerificationTaskCarryingVerifiedUnexpiredDoneEntryAuthorization(subject.task, nowMs)
		) {
			blockedTaskIds.add(taskId);
		}
	}
	return blockedTaskIds;
}
