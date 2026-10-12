import type {
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationClosureOutcome,
	RuntimePostDeployVerificationCompletionPath,
	RuntimePostDeployVerificationDeferredNaturalUsageObservationRecord,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimePostDeployVerificationPendingConfirmation,
	RuntimePostDeployVerificationTask,
	RuntimePostDeployVerificationUncheckedChecklistItemClosureReason,
} from "../core/api-contract";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import { recordPostDeployVerificationClosedIntoDoneWithUncheckedItemsReasonedObservationWithoutBlocking } from "../inter-work-unit-relation-ledger/post-deploy-verification-closed-into-done-with-unchecked-items-reasoned-observation-recording";
import {
	type PostDeployVerificationCompletionEvidence,
	recordPostDeployVerificationPassedObservationWithoutBlocking,
} from "../inter-work-unit-relation-ledger/post-deploy-verification-passed-observation-recording";
import {
	AUTHORED_VERIFICATION_ITEM_ID_PREFIX,
	removeAuthoredVerificationDefinition,
} from "./authored-verification-definitions";
import {
	appendPostDeployVerificationDeferredNaturalUsageObservationRecords,
	buildDeferredNaturalUsageObservationRecordId,
	listPostDeployVerificationDeferredNaturalUsageObservationRecords,
} from "./post-deploy-verification-deferred-natural-usage-observation-records";
import { cleanupVerificationAssets, getVerificationAssetsDir } from "./verification-assets";

// Post-Deploy Verification「结案」的唯一写法：Web 面板确认、CLI 完成动词、taskCardAction 移入 Done 的门禁、runtime 对账补完
// 都经这里写 postDeployVerificationClosure，再在状态锁外做副作用（账本、待观察记录、资产清理）。
// 两种结局：全部勾选 = 「PDV 通过」（写 verifiedAt）；有未勾项但每项都带了原因 = 带原因结案（verifiedAt 保持 null）。

const DEFERRED_TO_NATURAL_USAGE_OBSERVATION_REASON_CODE =
	"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation";

// 「没有未勾项」即全勾（结局 = 通过）。空 checklist 按全勾处理：组装时保证至少一项、也不允许删掉最后一项，
// 空清单只可能来自更早的历史数据——那时它没有任何待核对的断言，不该卡在「既无法全勾、也没有可给原因的项」。
export function isChecklistOfPostDeployVerificationTaskFullyChecked(
	task: Pick<RuntimePostDeployVerificationTask, "checklist">,
): boolean {
	return task.checklist.every((item) => item.checked);
}

export function listUncheckedChecklistItemsOfPostDeployVerificationTask(
	task: Pick<RuntimePostDeployVerificationTask, "checklist">,
): RuntimePostDeployVerificationChecklistItem[] {
	return task.checklist.filter((item) => !item.checked);
}

export type UncheckedChecklistItemClosureReasonsResolution =
	| {
			uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems: true;
			resolvedReasons: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[];
	  }
	| {
			uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems: false;
			uncheckedChecklistItemsMissingClosureReason: RuntimePostDeployVerificationChecklistItem[];
	  };

/**
 * 把请求里的原因落到每个**当前**未勾项上：逐项原因优先，没逐项给的套用「应用到其余未勾项」的原因。
 * 已勾项上的原因被忽略（客户端数据过期时可能带了）。有未勾项拿不到原因 → 不覆盖，返回缺原因的项。
 */
export function resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask(
	task: Pick<RuntimePostDeployVerificationTask, "checklist">,
	closureRequest: RuntimePostDeployVerificationDoneEntryClosureRequest | undefined,
): UncheckedChecklistItemClosureReasonsResolution {
	const perItemReasonByChecklistItemId = new Map(
		(closureRequest?.uncheckedChecklistItemClosureReasons ?? []).map((reason) => [reason.checklistItemId, reason]),
	);
	const reasonAppliedToRemaining = closureRequest?.closureReasonAppliedToRemainingUncheckedChecklistItems;
	const resolvedReasons: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[] = [];
	const uncheckedChecklistItemsMissingClosureReason: RuntimePostDeployVerificationChecklistItem[] = [];
	for (const item of listUncheckedChecklistItemsOfPostDeployVerificationTask(task)) {
		const perItemReason = perItemReasonByChecklistItemId.get(item.id);
		if (perItemReason) {
			resolvedReasons.push(perItemReason);
			continue;
		}
		if (reasonAppliedToRemaining) {
			resolvedReasons.push({ checklistItemId: item.id, ...reasonAppliedToRemaining });
			continue;
		}
		uncheckedChecklistItemsMissingClosureReason.push(item);
	}
	return uncheckedChecklistItemsMissingClosureReason.length === 0
		? { uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems: true, resolvedReasons }
		: {
				uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems: false,
				uncheckedChecklistItemsMissingClosureReason,
			};
}

export type PostDeployVerificationClosureProvableFromCurrentChecklistResolution =
	| {
			postDeployVerificationClosureProvableFromCurrentChecklist: true;
			postDeployVerificationClosureOutcome: RuntimePostDeployVerificationClosureOutcome;
			uncheckedChecklistItemClosureReasons: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[];
	  }
	| {
			postDeployVerificationClosureProvableFromCurrentChecklist: false;
			uncheckedChecklistItemsMissingClosureReason: RuntimePostDeployVerificationChecklistItem[];
	  };

/**
 * 按在途授权结案时（门禁 finalize、runtime 对账补完）在状态锁内重新核验：授权写下后 checklist 仍可能被勾选、取消勾选、
 * 增删项或被自动脚本重跑改写，结局只按**当前** checklist 能证明的事实定——全勾 ⇒ 通过；否则授权里的逐项原因覆盖全部
 * 当前未勾项 ⇒ 带原因结案（只带当前未勾项的原因）；都不成立 ⇒ 不可证明，绝不冒充通过。
 */
export function resolvePostDeployVerificationClosureProvableFromCurrentChecklist(
	task: Pick<RuntimePostDeployVerificationTask, "checklist">,
	uncheckedChecklistItemClosureReasonsRecordedInAuthorization: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[],
): PostDeployVerificationClosureProvableFromCurrentChecklistResolution {
	if (isChecklistOfPostDeployVerificationTaskFullyChecked(task)) {
		return {
			postDeployVerificationClosureProvableFromCurrentChecklist: true,
			postDeployVerificationClosureOutcome: "all_checklist_items_checked",
			uncheckedChecklistItemClosureReasons: [],
		};
	}
	const resolution = resolveUncheckedChecklistItemClosureReasonsForPostDeployVerificationTask(task, {
		uncheckedChecklistItemClosureReasons: uncheckedChecklistItemClosureReasonsRecordedInAuthorization,
	});
	if (!resolution.uncheckedChecklistItemClosureReasonsCoverAllUncheckedItems) {
		return {
			postDeployVerificationClosureProvableFromCurrentChecklist: false,
			uncheckedChecklistItemsMissingClosureReason: resolution.uncheckedChecklistItemsMissingClosureReason,
		};
	}
	return {
		postDeployVerificationClosureProvableFromCurrentChecklist: true,
		postDeployVerificationClosureOutcome: "closed_into_done_with_unchecked_items_reasoned",
		uncheckedChecklistItemClosureReasons: resolution.resolvedReasons,
	};
}

/**
 * 卡已进 Done，在途授权（门禁的或 CLI 的）却证明不了任何结局：授权后出现了没有原因的未勾项。不能冒充通过，也不替用户编原因；
 * 与「门禁之外绕进 Done」同一处置——标 moved_out_manually 并告警，同时清掉在途授权与 CLI 在途完成记录。否则记录留在
 * 已在 Done 的任务上永远清不掉（只有卡不在 Done 时才按过期清），任务一直卡在待核对。
 */
export function markPostDeployVerificationTaskEnteredDoneWithoutProvableClosureWithinStateLock(
	task: RuntimePostDeployVerificationTask,
	context: {
		workspaceId: string;
		uncheckedChecklistItemsMissingClosureReason: RuntimePostDeployVerificationChecklistItem[];
		inFlightAuthorizationKindForDiagnostics: string;
	},
): void {
	task.doneEntryClosureAuthorizationInFlight = null;
	task.pendingConfirmation = null;
	task.droppedReason = "moved_out_manually";
	logDeploymentDiagnosticWarning(
		`[post-deploy-verification-closure] 任务 ${task.taskId}（workspaceId=${context.workspaceId}）已进 Done，但在途授权（${context.inFlightAuthorizationKindForDiagnostics}）写下后 checklist 出现了没有结案原因的未勾项（${context.uncheckedChecklistItemsMissingClosureReason
			.map((item) => item.id)
			.join(", ")}），不能按授权结案，已标记 moved_out_manually`,
	);
}

export type KanbanCliCompletionAuthorizedBeforeMoveIntoDone = NonNullable<
	RuntimePostDeployVerificationPendingConfirmation["kanbanCliCompletionAuthorizedBeforeMoveIntoDone"]
>;

// CLI 在途完成记录里「是否用了 `--force`」：新字段优先，缺失时回退历史字段（旧 CLI 只写它）。
export function readConfirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlagOfKanbanCliCompletionAuthorization(
	kanbanCliCompletionAuthorization: KanbanCliCompletionAuthorizedBeforeMoveIntoDone,
): boolean {
	return (
		kanbanCliCompletionAuthorization.confirmationTokenHandshakeSkippedByKanbanCliBreakGlassForceFlag ??
		kanbanCliCompletionAuthorization.forcedCompletionWithoutAllVerificationsPassed ??
		false
	);
}

export interface PostDeployVerificationClosureToApply {
	postDeployVerificationClosureOutcome: RuntimePostDeployVerificationClosureOutcome;
	uncheckedChecklistItemClosureReasons: RuntimePostDeployVerificationUncheckedChecklistItemClosureReason[];
	confirmedAcknowledgements: RuntimePostDeployVerificationAcknowledgement[];
	postDeployVerificationCompletionPath: RuntimePostDeployVerificationCompletionPath;
}

/** 状态锁内就地写结案（调用方已确认任务未结案）。 */
export function applyPostDeployVerificationClosureToTaskWithinStateLock(
	task: RuntimePostDeployVerificationTask,
	closure: PostDeployVerificationClosureToApply,
	context: { workspaceId: string; nowIso: string },
): void {
	const deferredNaturalUsageObservationRecordIds = closure.uncheckedChecklistItemClosureReasons
		.filter(
			(reason) =>
				reason.uncheckedChecklistItemClosureReasonCode === DEFERRED_TO_NATURAL_USAGE_OBSERVATION_REASON_CODE,
		)
		.map((reason) =>
			buildDeferredNaturalUsageObservationRecordId({
				workspaceId: context.workspaceId,
				taskId: task.taskId,
				closedAtIso: context.nowIso,
				sourceChecklistItemId: reason.checklistItemId,
			}),
		);
	task.postDeployVerificationClosure = {
		postDeployVerificationClosureOutcome: closure.postDeployVerificationClosureOutcome,
		closedAtIso: context.nowIso,
		postDeployVerificationCompletionPath: closure.postDeployVerificationCompletionPath,
		uncheckedChecklistItemClosureReasons: closure.uncheckedChecklistItemClosureReasons,
		confirmedAcknowledgements: closure.confirmedAcknowledgements,
		taskDeploymentAttributionZoneAtClosure: task.taskDeploymentAttribution?.taskDeploymentAttributionZone ?? null,
		deferredNaturalUsageObservationRecordIds,
	};
	if (closure.postDeployVerificationClosureOutcome === "all_checklist_items_checked") {
		task.verifiedAt = context.nowIso;
	}
	task.boardMovedToDoneAt = context.nowIso;
	task.pendingConfirmation = null;
	task.doneEntryClosureAuthorizationInFlight = null;
	// 结案即宽容清除 droppedReason（finding #3）：「先移入 Done 后结案」的时间窗里对账可能已误标 moved_out_manually；
	// 已结案的任务绝不应再带 droppedReason，否则会被 liveTasks(droppedReason===null) 过滤器排除出 done 计数。
	task.droppedReason = null;
}

export interface PostDeployVerificationTaskClosedWithinStateLock {
	workspaceId: string;
	deploymentId: string;
	deployedSourceCommit: string;
	// 锁内结案后的 structuredClone：锁外副作用读它，不再碰可变状态。
	closedTask: RuntimePostDeployVerificationTask;
	completionEvidence: PostDeployVerificationCompletionEvidence;
}

// 重建待观察记录只需要结案任务与所在部署组的信息：结案当下的副作用与之后的对账补写共用。
type ClosedPostDeployVerificationTaskWithDeploymentGroupContext = Pick<
	PostDeployVerificationTaskClosedWithinStateLock,
	"workspaceId" | "deploymentId" | "deployedSourceCommit" | "closedTask"
>;

function buildDeferredNaturalUsageObservationRecordsForClosedTask(
	closed: ClosedPostDeployVerificationTaskWithDeploymentGroupContext,
): RuntimePostDeployVerificationDeferredNaturalUsageObservationRecord[] {
	const closure = closed.closedTask.postDeployVerificationClosure;
	if (!closure) {
		return [];
	}
	const checklistItemById = new Map(closed.closedTask.checklist.map((item) => [item.id, item]));
	return closure.uncheckedChecklistItemClosureReasons.flatMap((reason) => {
		if (reason.uncheckedChecklistItemClosureReasonCode !== DEFERRED_TO_NATURAL_USAGE_OBSERVATION_REASON_CODE) {
			return [];
		}
		const item = checklistItemById.get(reason.checklistItemId);
		if (!item) {
			return [];
		}
		const sourceAuthoredVerificationId = item.id.startsWith(AUTHORED_VERIFICATION_ITEM_ID_PREFIX)
			? item.id.slice(AUTHORED_VERIFICATION_ITEM_ID_PREFIX.length)
			: null;
		return [
			{
				deferredNaturalUsageObservationRecordId: buildDeferredNaturalUsageObservationRecordId({
					workspaceId: closed.workspaceId,
					taskId: closed.closedTask.taskId,
					closedAtIso: closure.closedAtIso,
					sourceChecklistItemId: item.id,
				}),
				workspaceId: closed.workspaceId,
				taskId: closed.closedTask.taskId,
				sourceDeploymentId: closed.deploymentId,
				sourceDeployedSourceCommit: closed.deployedSourceCommit,
				sourceChecklistItemId: item.id,
				sourceAuthoredVerificationId,
				assertionLabel: item.label,
				checklistItemKind: item.kind,
				guidanceSnapshot: item.guidance,
				automatedScriptSnapshot: item.script,
				retainedVerificationAssetsDirectory:
					item.cleanup?.assetsDir ??
					(sourceAuthoredVerificationId !== null ? getVerificationAssetsDir(sourceAuthoredVerificationId) : null),
				deferralReasonText: reason.uncheckedChecklistItemClosureReasonText ?? null,
				deferredAtIso: closure.closedAtIso,
				naturalUsageObservationStatus: "awaiting_natural_usage_observation",
			},
		];
	});
}

// 结案后对该任务下 cleanup.mode==="automatic" 的 authored 项做 per-verification 清理（plan Stage 5）：删资产目录（护栏限于
// verifications 根下）+ 注销 pending 定义。manual/retain 一律跳过；「转为在自然使用中观察」的项刻意保留资产与定义，
// 留给将来的自然使用观察 pipeline。在 state 锁外调用，清理失败只 warn，绝不回滚已完成的结案。
async function runAutomaticVerificationAssetCleanupForClosedTask(
	closedTask: RuntimePostDeployVerificationTask,
	nowIso: string,
): Promise<void> {
	const checklistItemIdsDeferredToNaturalUsageObservation = new Set(
		(closedTask.postDeployVerificationClosure?.uncheckedChecklistItemClosureReasons ?? [])
			.filter(
				(reason) =>
					reason.uncheckedChecklistItemClosureReasonCode === DEFERRED_TO_NATURAL_USAGE_OBSERVATION_REASON_CODE,
			)
			.map((reason) => reason.checklistItemId),
	);
	for (const item of closedTask.checklist) {
		if (
			item.cleanup?.mode !== "automatic" ||
			!item.id.startsWith(AUTHORED_VERIFICATION_ITEM_ID_PREFIX) ||
			checklistItemIdsDeferredToNaturalUsageObservation.has(item.id)
		) {
			continue;
		}
		const verificationId = item.id.slice(AUTHORED_VERIFICATION_ITEM_ID_PREFIX.length);
		try {
			const cleanupResult = await cleanupVerificationAssets(verificationId);
			// 越界护栏拒删（symlink 逃逸等）时资产仍在场：保留 pending 定义不注销，避免「资产残留却已注销定义」
			// 且前端凭 taskVerified 假报已自动清理。already-absent / assets-root-missing / removed 均视为资产已不在场，正常注销。
			if (cleanupResult.skippedReason === "out-of-bounds") {
				logDeploymentDiagnosticWarning(
					`[post-deploy-verification-closure] 自动清理被越界护栏拒删，保留 pending 定义不注销 verificationId=${verificationId}`,
				);
				continue;
			}
			await removeAuthoredVerificationDefinition(verificationId, nowIso);
		} catch (error) {
			logDeploymentDiagnosticWarning(
				`[post-deploy-verification-closure] 自动清理验证资产失败 verificationId=${verificationId}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

/**
 * 状态锁外的结案副作用：先落待观察记录（账本事件要引用它们的 id），再记账本，最后清理资产。
 * 账本只在 runtime 进程（已激活 live capture）里真正记账；CLI 进程调用时是空操作。
 */
export async function runPostDeployVerificationClosureSideEffectsOutsideStateLock(
	closed: PostDeployVerificationTaskClosedWithinStateLock,
	nowIso: string,
): Promise<void> {
	const closure = closed.closedTask.postDeployVerificationClosure;
	if (!closure) {
		return;
	}
	if (closure.postDeployVerificationClosureOutcome === "all_checklist_items_checked") {
		recordPostDeployVerificationPassedObservationWithoutBlocking({
			workspaceId: closed.workspaceId,
			deploymentId: closed.deploymentId,
			deployedSourceCommit: closed.deployedSourceCommit,
			verifiedPostDeployVerificationTask: closed.closedTask,
			completionEvidence: closed.completionEvidence,
		});
	} else {
		try {
			await appendPostDeployVerificationDeferredNaturalUsageObservationRecords(
				buildDeferredNaturalUsageObservationRecordsForClosedTask(closed),
				nowIso,
			);
		} catch (error) {
			// 结案已在锁内持久化并引用了这些记录 id：这里失败不回滚，由 runtime 对账的补写补上
			// （见 backfillDeferredNaturalUsageObservationRecordsMissingForClosedPostDeployVerificationTasks）。
			logDeploymentDiagnosticWarning(
				`[post-deploy-verification-closure] 写待观察记录失败，留待 runtime 对账补写 taskId=${closed.closedTask.taskId}：${error instanceof Error ? error.message : String(error)}`,
			);
		}
		recordPostDeployVerificationClosedIntoDoneWithUncheckedItemsReasonedObservationWithoutBlocking({
			workspaceId: closed.workspaceId,
			deploymentId: closed.deploymentId,
			deployedSourceCommit: closed.deployedSourceCommit,
			closedPostDeployVerificationTask: closed.closedTask,
			completionEvidence: closed.completionEvidence,
		});
	}
	await runAutomaticVerificationAssetCleanupForClosedTask(closed.closedTask, nowIso);
}

/**
 * 补写缺失的待观察记录。结案在状态锁内持久化、引用了待观察记录 id，锁外 append 却可能失败（只告警）；之后 finalize、
 * markTaskVerified、跨组对账都跳过已结案任务，记录就永久缺失，而它是「转为在自然使用中观察」项唯一的持久入口。
 * runtime 每轮 PDV 状态对账拿刚读到的部署组快照调用：已结案、closure 引用了待观察记录 id、记录文件里却没有的，按结案快照
 * 重建并补 append。append 按 id 幂等，与结案当下的 append 并发也无害。没有任何结案引用记录时不读记录文件。
 * 失败只告警，下一轮对账再补。前提：记录不做物理删除（终态用 naturalUsageObservationStatus 表达），否则这里会把删掉的补回来。
 */
export async function backfillDeferredNaturalUsageObservationRecordsMissingForClosedPostDeployVerificationTasks(
	deploymentGroups: readonly RuntimePostDeployVerificationDeploymentGroup[],
	nowIso: string,
): Promise<void> {
	const closedTasksReferencingDeferredRecords: ClosedPostDeployVerificationTaskWithDeploymentGroupContext[] =
		deploymentGroups.flatMap((group) =>
			group.tasks
				.filter(
					(task) => (task.postDeployVerificationClosure?.deferredNaturalUsageObservationRecordIds.length ?? 0) > 0,
				)
				.map((task) => ({
					workspaceId: group.workspaceId,
					deploymentId: group.deploymentId,
					deployedSourceCommit: group.deployedSourceCommit,
					closedTask: task,
				})),
		);
	if (closedTasksReferencingDeferredRecords.length === 0) {
		return;
	}
	try {
		const existingRecordIds = new Set(
			(await listPostDeployVerificationDeferredNaturalUsageObservationRecords({}, nowIso)).map(
				(record) => record.deferredNaturalUsageObservationRecordId,
			),
		);
		const missingRecords = closedTasksReferencingDeferredRecords
			.flatMap(buildDeferredNaturalUsageObservationRecordsForClosedTask)
			.filter((record) => !existingRecordIds.has(record.deferredNaturalUsageObservationRecordId));
		if (missingRecords.length === 0) {
			return;
		}
		await appendPostDeployVerificationDeferredNaturalUsageObservationRecords(missingRecords, nowIso);
		logDeploymentDiagnosticWarning(
			`[post-deploy-verification-closure] 已补写 ${missingRecords.length} 条缺失的待观察记录 taskIds=${[
				...new Set(missingRecords.map((record) => record.taskId)),
			].join(",")}`,
		);
	} catch (error) {
		logDeploymentDiagnosticWarning(
			`[post-deploy-verification-closure] 补写待观察记录失败，下一轮对账再试：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
