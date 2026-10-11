import { isDeepStrictEqual } from "node:util";

import type {
	RuntimeBoardColumnId,
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationInclusionReason,
	RuntimePostDeployVerificationTask,
} from "../core/api-contract";
import {
	isPostDeployVerificationTaskAwaitingVerification,
	isPostDeployVerificationTaskClosed,
} from "../core/post-deploy-verification-task-closed-and-awaiting-verification-predicates";
import { AUTHORED_VERIFICATION_ITEM_ID_PREFIX } from "./authored-verification-definitions";
import type { TaskDeploymentAttributionComputation } from "./task-deployment-attribution-from-commit-integration-provenance";

// 部署组里一个任务条目的装配规则（record 建组与 runtime 对账加入新任务共用，保证两边口径一致）：
//  - 勾选进度跨部署延续：上一活跃组里未结案的同一任务，连同 checklist（含勾选、脚本运行结果）原样带进新组；
//  - authored 验证定义按 item id 合并：已有的项刷新定义字段（label / guidance / script / cleanup，支持 reconcile 重注册），
//    旧勾选与运行结果仍能证明新定义时保留 checked / run，否则清回未核对（见 doesAuthoredRedefinitionInvalidatePriorCheckEvidence）；
//    新注册的项追加；
//  - 通用「在已部署 build 上手工验证」只在任务没有任何具体验证项时作兜底：一旦有 authored 项，未勾的兜底项就去掉。
//  - record 无锁组装的延续副本，在建组的 state 锁内按旧副本的当前状态重新落定（见 reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock）。

// 无具体验证项时 seed 的通用手工验证项 id（稳定值，勾选状态跨 reconcile / 跨部署保留）。
// 历史数据里它的 source 是 "commit"（不是真的由提交生成）：不改 source 枚举（旧 binary 回滚时会把未知枚举判成损坏），
// 改为按这个 id 识别，允许移除。
export const GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID = "manual-smoke-test-on-deployed-build";
const GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_LABEL = "在已部署 build 上手工验证";

export function isGenericManualSmokeTestOnDeployedBuildChecklistItem(
	item: Pick<RuntimePostDeployVerificationChecklistItem, "id">,
): boolean {
	return item.id === GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID;
}

function buildGenericManualSmokeTestOnDeployedBuildChecklistItem(): RuntimePostDeployVerificationChecklistItem {
	return {
		id: GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_ID,
		label: GENERIC_MANUAL_SMOKE_TEST_ON_DEPLOYED_BUILD_CHECKLIST_ITEM_LABEL,
		checked: false,
		source: "commit",
		kind: "guided_manual",
		guidance: null,
		script: null,
		run: null,
		cleanup: null,
	};
}

/** 2026-10-11 起任务条目新增字段的默认值（旧数据解析出的也是这些值）。测试夹具与各构造点共用。 */
export function buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(): Pick<
	RuntimePostDeployVerificationTask,
	| "taskDeploymentAttribution"
	| "firstDeployedInDeploymentId"
	| "firstDeployedAtIso"
	| "firstDeploymentPredatesRetainedDeploymentRecords"
	| "deploymentIdsRecordedWhileTaskAwaitingVerification"
	| "carriedForwardIntoDeploymentId"
	| "includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded"
	| "doneEntryClosureAuthorizationInFlight"
	| "postDeployVerificationClosure"
> {
	return {
		taskDeploymentAttribution: null,
		firstDeployedInDeploymentId: null,
		firstDeployedAtIso: null,
		firstDeploymentPredatesRetainedDeploymentRecords: false,
		deploymentIdsRecordedWhileTaskAwaitingVerification: [],
		carriedForwardIntoDeploymentId: null,
		includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: false,
		doneEntryClosureAuthorizationInFlight: null,
		postDeployVerificationClosure: null,
	};
}

// 「已结案 / 待核对」判据与 web-ui 共用一份，定义在 src/core（纯函数，web-ui 可直接引用）；这里原样 re-export，
// 服务端既有调用方不用改 import。本文件的延续协调也用它们，所以先 import 再 re-export。
export { isPostDeployVerificationTaskAwaitingVerification, isPostDeployVerificationTaskClosed };

/**
 * 同 id 重注册（reconcile 模式）后，已有项的勾选与运行结果还能不能当新定义的核对依据。
 *  - kind 变了：旧依据是另一种核对方式得来的（例如人工勾的 guided 项改成 automated 后，就成了「从未运行却已勾选」的自动项），
 *    一律作废；
 *  - automated_script：script 定义（entrypoint / interpreter / timeoutMs）变了，旧的 passed 运行证明不了新脚本；
 *  - guided_manual：人工勾选证明的是「按 steps 操作后看到了 expectedObservation」，这两项变了就是断言变了，勾选作废；
 *    只改 label、failureSignature、anchor、cleanup 这类说明与定位信息时保留勾选。
 * 已知缺口：脚本入口文件内容在资产目录里原地改写、定义不变时，这里看不出来（定义不带内容指纹）。
 */
function doesAuthoredRedefinitionInvalidatePriorCheckEvidence(
	existing: RuntimePostDeployVerificationChecklistItem,
	redefined: RuntimePostDeployVerificationChecklistItem,
): boolean {
	if (existing.kind !== redefined.kind) {
		return true;
	}
	if (redefined.kind === "automated_script") {
		return !isDeepStrictEqual(existing.script, redefined.script);
	}
	return (
		!isDeepStrictEqual(existing.guidance?.steps ?? null, redefined.guidance?.steps ?? null) ||
		(existing.guidance?.expectedObservation ?? null) !== (redefined.guidance?.expectedObservation ?? null)
	);
}

/**
 * 把 authored 项合并进 checklist（就地修改）：同 id 刷新定义字段；旧勾选与运行结果仍能证明新定义时保留，
 * 否则清回未核对（checked=false、run=null），保住「自动项 checked ⇔ 最近一次运行 passed」与「勾选对应当前断言」；新 id 追加。
 * 有 authored 项后去掉未勾的通用兜底项；checklist 为空时补回兜底项。返回新追加的 authored 项数。
 */
export function mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem(
	checklist: RuntimePostDeployVerificationChecklistItem[],
	authoredChecklistItems: readonly RuntimePostDeployVerificationChecklistItem[],
): number {
	let appendedAuthoredItemCount = 0;
	for (const authoredItem of authoredChecklistItems) {
		const existing = checklist.find((item) => item.id === authoredItem.id);
		if (existing) {
			if (doesAuthoredRedefinitionInvalidatePriorCheckEvidence(existing, authoredItem)) {
				existing.checked = false;
				existing.run = null;
			}
			existing.label = authoredItem.label;
			existing.kind = authoredItem.kind;
			existing.guidance = authoredItem.guidance;
			existing.script = authoredItem.script;
			existing.cleanup = authoredItem.cleanup;
			continue;
		}
		checklist.push(structuredClone(authoredItem));
		appendedAuthoredItemCount += 1;
	}
	const hasAuthoredItem = checklist.some((item) => item.id.startsWith(AUTHORED_VERIFICATION_ITEM_ID_PREFIX));
	if (hasAuthoredItem) {
		const genericSmokeItemIndex = checklist.findIndex(
			(item) => isGenericManualSmokeTestOnDeployedBuildChecklistItem(item) && !item.checked,
		);
		if (genericSmokeItemIndex >= 0) {
			checklist.splice(genericSmokeItemIndex, 1);
		}
	}
	if (checklist.length === 0) {
		checklist.push(buildGenericManualSmokeTestOnDeployedBuildChecklistItem());
	}
	return appendedAuthoredItemCount;
}

export interface AssemblePostDeployVerificationTaskForDeploymentGroupInput {
	taskId: string;
	columnIdAtMatch: RuntimeBoardColumnId;
	inclusionReason: RuntimePostDeployVerificationInclusionReason;
	deploymentId: string;
	// 上一活跃组里同一任务的未结案条目（延续勾选进度）；没有则新建。
	unclosedTaskCarriedForwardFromPreviousActiveGroup: RuntimePostDeployVerificationTask | null;
	authoredChecklistItems: readonly RuntimePostDeployVerificationChecklistItem[];
	// null = 本次没算出归属（git 不可用等），由 runtime 对账补算。
	taskDeploymentAttributionComputation: TaskDeploymentAttributionComputation | null;
	includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: boolean;
}

export function assemblePostDeployVerificationTaskForDeploymentGroup(
	input: AssemblePostDeployVerificationTaskForDeploymentGroupInput,
): { task: RuntimePostDeployVerificationTask; appendedAuthoredItemCount: number } {
	const carried = input.unclosedTaskCarriedForwardFromPreviousActiveGroup;
	const checklist = carried ? structuredClone(carried.checklist) : [];
	const appendedAuthoredItemCount = mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem(
		checklist,
		input.authoredChecklistItems,
	);
	const attribution = input.taskDeploymentAttributionComputation;
	// 首次上线一旦确定就沿用（跨部署延续）；还没确定时取本次算出的。
	const carriedFirstDeployment =
		carried &&
		(carried.firstDeployedInDeploymentId !== null || carried.firstDeploymentPredatesRetainedDeploymentRecords)
			? {
					firstDeployedInDeploymentId: carried.firstDeployedInDeploymentId,
					firstDeployedAtIso: carried.firstDeployedAtIso,
					firstDeploymentPredatesRetainedDeploymentRecords:
						carried.firstDeploymentPredatesRetainedDeploymentRecords,
				}
			: null;
	const deploymentIdsRecordedWhileTaskAwaitingVerification = [
		...new Set([...(carried?.deploymentIdsRecordedWhileTaskAwaitingVerification ?? []), input.deploymentId]),
	];
	return {
		appendedAuthoredItemCount,
		task: {
			taskId: input.taskId,
			columnIdAtMatch: input.columnIdAtMatch,
			matchedCommits:
				attribution?.taskDeploymentAttribution.matchedDeployedCommitsInThisDeploymentDelta.map(
					(match) => match.deployedCommitSha,
				) ?? [],
			inclusionReason: input.inclusionReason,
			checklist,
			verifiedAt: null,
			boardMovedToDoneAt: null,
			pendingConfirmation: null,
			droppedReason: null,
			...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
			taskDeploymentAttribution: attribution?.taskDeploymentAttribution ?? null,
			firstDeployedInDeploymentId:
				carriedFirstDeployment?.firstDeployedInDeploymentId ?? attribution?.firstDeployedInDeploymentId ?? null,
			firstDeployedAtIso: carriedFirstDeployment?.firstDeployedAtIso ?? attribution?.firstDeployedAtIso ?? null,
			firstDeploymentPredatesRetainedDeploymentRecords:
				carriedFirstDeployment?.firstDeploymentPredatesRetainedDeploymentRecords ??
				attribution?.firstDeploymentPredatesRetainedDeploymentRecords ??
				false,
			deploymentIdsRecordedWhileTaskAwaitingVerification,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded:
				input.includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded,
		},
	};
}

export type CarriedForwardDeploymentGroupTaskReconciledWithinStateLock =
	| {
			carriedForwardTaskReconciliationOutcome: "carried_forward_with_previous_copy_current_progress_and_in_flight_closure";
			task: RuntimePostDeployVerificationTask;
	  }
	| {
			carriedForwardTaskReconciliationOutcome: "included_as_read_only_because_previous_copy_closed_into_done_before_deployment_group_written";
			task: RuntimePostDeployVerificationTask;
	  }
	| {
			carriedForwardTaskReconciliationOutcome: "excluded_because_previous_copy_no_longer_awaiting_verification_before_deployment_group_written";
	  };

/**
 * record 建组的锁内协调（RVF-002）：record 先无锁读 state、组装好延续副本，再进 state 锁写新组；两次之间门禁 / CLI / 面板
 * 可能已经改了上一活跃组里的旧副本。这里按旧副本在锁内的**当前**状态重新落定新组里的那一份（纯函数，不改旧副本）：
 *  - 旧副本仍在等核对 → 延续。勾选进度以旧副本当前值为准；在途授权、待确认 token / CLI 在途完成记录随副本搬到新组
 *    （调用方负责从旧副本清掉），让门禁 finalize、对账、整板保存兜底都在活跃组命中。结案在途时 checklist 原样冻结、
 *    不合并新注册的 authored 项（与 reconcileGroup 同一规则：授权里的原因必须继续覆盖全部未勾项）。
 *  - 旧副本已结案 → 不再以「等核对」延续。提交命中本次部署区间的，按 record 对 Done 卡的规则改成只读展示；否则不纳入。
 *    结案留在旧组（账本已按旧组记下），新组不冒充在本次部署上核对过。
 *  - 旧副本已被移除（删除 / 手动移出）→ 不纳入。
 */
export function reconcileCarriedForwardDeploymentGroupTaskAgainstPreviousCopyWithinStateLock(input: {
	deploymentId: string;
	taskAssembledFromUnlockedPreRead: RuntimePostDeployVerificationTask;
	previousCopyCurrentWithinStateLock: RuntimePostDeployVerificationTask;
}): CarriedForwardDeploymentGroupTaskReconciledWithinStateLock {
	const assembled = input.taskAssembledFromUnlockedPreRead;
	const previous = input.previousCopyCurrentWithinStateLock;
	if (!isPostDeployVerificationTaskAwaitingVerification(previous)) {
		const assembledCommitsIncludedInThisDeploymentDelta =
			assembled.taskDeploymentAttribution?.taskDeploymentAttributionZone ===
			"task_commits_included_in_this_deployment_delta";
		if (!isPostDeployVerificationTaskClosed(previous) || !assembledCommitsIncludedInThisDeploymentDelta) {
			return {
				carriedForwardTaskReconciliationOutcome:
					"excluded_because_previous_copy_no_longer_awaiting_verification_before_deployment_group_written",
			};
		}
		// 与 record 对「记录部署时已在 Done、提交命中本次区间」的卡同形：不 seed authored 项（只读展示不再核对）。
		const readOnly = assemblePostDeployVerificationTaskForDeploymentGroup({
			taskId: assembled.taskId,
			columnIdAtMatch: "trash",
			inclusionReason: "commit_correlation",
			deploymentId: input.deploymentId,
			unclosedTaskCarriedForwardFromPreviousActiveGroup: null,
			authoredChecklistItems: [],
			taskDeploymentAttributionComputation: assembled.taskDeploymentAttribution
				? {
						taskDeploymentAttribution: assembled.taskDeploymentAttribution,
						firstDeployedInDeploymentId: assembled.firstDeployedInDeploymentId,
						firstDeployedAtIso: assembled.firstDeployedAtIso,
						firstDeploymentPredatesRetainedDeploymentRecords:
							assembled.firstDeploymentPredatesRetainedDeploymentRecords,
					}
				: null,
			includedAsReadOnlyBecauseTaskAlreadyInDoneColumnWhenDeploymentRecorded: true,
		});
		return {
			carriedForwardTaskReconciliationOutcome:
				"included_as_read_only_because_previous_copy_closed_into_done_before_deployment_group_written",
			task: readOnly.task,
		};
	}

	const closureInFlight =
		previous.pendingConfirmation !== null || previous.doneEntryClosureAuthorizationInFlight !== null;
	const checklist = structuredClone(previous.checklist);
	if (!closureInFlight) {
		// 组装时已按最新注册刷新过定义字段的 authored 项：同 id 只刷新定义、保留旧副本当前的勾选与运行结果；新 id 追加。
		mergeAuthoredChecklistItemsAndReconcileGenericManualSmokeTestItem(
			checklist,
			assembled.checklist.filter((item) => item.id.startsWith(AUTHORED_VERIFICATION_ITEM_ID_PREFIX)),
		);
	}
	const previousFirstDeploymentDetermined =
		previous.firstDeployedInDeploymentId !== null || previous.firstDeploymentPredatesRetainedDeploymentRecords;
	return {
		carriedForwardTaskReconciliationOutcome:
			"carried_forward_with_previous_copy_current_progress_and_in_flight_closure",
		task: {
			...assembled,
			checklist,
			pendingConfirmation: structuredClone(previous.pendingConfirmation),
			doneEntryClosureAuthorizationInFlight: structuredClone(previous.doneEntryClosureAuthorizationInFlight),
			...(previousFirstDeploymentDetermined
				? {
						firstDeployedInDeploymentId: previous.firstDeployedInDeploymentId,
						firstDeployedAtIso: previous.firstDeployedAtIso,
						firstDeploymentPredatesRetainedDeploymentRecords:
							previous.firstDeploymentPredatesRetainedDeploymentRecords,
					}
				: {}),
			deploymentIdsRecordedWhileTaskAwaitingVerification: [
				...new Set([...previous.deploymentIdsRecordedWhileTaskAwaitingVerification, input.deploymentId]),
			],
		},
	};
}
