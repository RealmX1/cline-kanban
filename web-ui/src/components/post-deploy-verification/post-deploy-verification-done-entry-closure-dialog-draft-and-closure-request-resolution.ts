import type { PostDeployVerificationUncheckedChecklistItemRequiringClosureReason } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-gate-precheck";
import type {
	RuntimePostDeployVerificationAcknowledgement,
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode,
	RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonWithoutItem,
} from "@/runtime/types";
import type { BoardColumnId } from "@/types";

// 「带原因移入 Done」对话框的纯逻辑：原因码文案、对话框草稿、草稿校验、把草稿解析成 moveIntoDone 的结案请求。
// 对话框组件（post-deploy-verification-unchecked-items-closure-reason-dialog.tsx）只渲染与转发事件，判定全在这里，便于单测。

// ---- 原因码的中文文案 ----

export const POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODES_IN_DIALOG_ORDER: readonly RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode[] =
	[
		"manual_reproduction_cost_exceeds_verification_value",
		"trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation",
		"assertion_already_covered_by_other_verification_evidence",
		"assertion_obsolete_because_verified_behavior_changed_or_removed",
		"custom_reason_described_in_reason_text",
	];

export const POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODE_PRESENTATION: Record<
	RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode,
	{ closureReasonOptionLabel: string; closureReasonOptionExplanation: string }
> = {
	manual_reproduction_cost_exceeds_verification_value: {
		closureReasonOptionLabel: "手工复现成本过高",
		closureReasonOptionExplanation: "手工复现过于繁琐，成本与核对收益不相称。",
	},
	trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation: {
		closureReasonOptionLabel: "触发时机随机 / 罕见，转为在自然使用中观察",
		closureReasonOptionExplanation:
			"结案时会生成一条持久的「待在自然使用中观察」记录，该项的验证资产保留、不被自动清理。",
	},
	assertion_already_covered_by_other_verification_evidence: {
		closureReasonOptionLabel: "已由其他途径覆盖",
		closureReasonOptionExplanation: "部署前测试、其他任务的验证或日常使用已经观察到。",
	},
	assertion_obsolete_because_verified_behavior_changed_or_removed: {
		closureReasonOptionLabel: "断言已过时",
		closureReasonOptionExplanation: "后续改动替代或移除了该行为。",
	},
	custom_reason_described_in_reason_text: {
		closureReasonOptionLabel: "自定义原因",
		closureReasonOptionExplanation: "必须填写原因文本。",
	},
};

export function isClosureReasonCodeDeferringChecklistItemToNaturalUsageObservation(
	closureReasonCode: RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode | null,
): boolean {
	return closureReasonCode === "trigger_condition_random_or_rare_so_deferred_to_natural_usage_observation";
}

// ---- 对话框里的一个任务 ----

export interface PostDeployVerificationDoneEntryClosureDialogTaskEntry {
	taskId: string;
	taskTitle: string;
	// 移入 Done 前卡片所在列：决定要哪些确认项（跳过 Validation / 会话可能仍在跑）。
	boardColumnIdOfTaskCardBeforeMoveIntoDone: BoardColumnId;
	uncheckedChecklistItemsRequiringClosureReason: PostDeployVerificationUncheckedChecklistItemRequiringClosureReason[];
	// 服务端拒绝说仍有未勾项，本地读模型却一项都看不到（预检数据过期）：只能靠「应用到全部未勾项」覆盖它们。
	runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel: boolean;
	// 仅 PDV 面板单任务完成流有（requestVerificationComplete 预置的最近一条 agent 回复）；看板入口没有，为 null。
	agentResponsePreviewShownWithSkipValidationAcknowledgement: string | null;
}

// 与 requestVerificationComplete 按来源列发放的 requiredAcknowledgements 同一套规则：
// review / in_progress 进 Done 都跳过了 Validation；in_progress 另需确认「会话可能仍在跑」。
export function resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn(
	boardColumnIdOfTaskCardBeforeMoveIntoDone: BoardColumnId,
): RuntimePostDeployVerificationAcknowledgement[] {
	if (boardColumnIdOfTaskCardBeforeMoveIntoDone === "in_progress") {
		return ["skip_validation", "in_progress_active"];
	}
	if (boardColumnIdOfTaskCardBeforeMoveIntoDone === "review") {
		return ["skip_validation"];
	}
	return [];
}

// ---- 草稿 ----

export interface UncheckedChecklistItemClosureReasonDraft {
	closureReasonCode: RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode | null;
	closureReasonText: string;
}

export const EMPTY_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_DRAFT: UncheckedChecklistItemClosureReasonDraft = {
	closureReasonCode: null,
	closureReasonText: "",
};

export interface PostDeployVerificationDoneEntryClosureDialogDraft {
	closureReasonDraftsByTaskIdThenChecklistItemId: Record<
		string,
		Record<string, UncheckedChecklistItemClosureReasonDraft>
	>;
	// 最近一次「应用到全部未勾项」的原因：已填进每一项；另外作为 closureReasonAppliedToRemaining... 发给服务端，
	// 覆盖本地读模型还看不到的未勾项（「全部」的字面语义）。null = 用户没用过它。
	closureReasonAppliedToAllUncheckedChecklistItems: UncheckedChecklistItemClosureReasonDraft | null;
	// in_progress 任务的第二道确认（会话可能仍在运行）：原先是第二个对话框，现在是同一对话框里的显式勾选。
	inProgressAgentSessionMayStillBeRunningAcknowledged: boolean;
	// 批量模式下勾选纳入本次结案的任务；单任务模式恒为那一个任务。
	taskIdsSelectedForClosure: string[];
}

export function createInitialPostDeployVerificationDoneEntryClosureDialogDraft(
	taskEntries: readonly PostDeployVerificationDoneEntryClosureDialogTaskEntry[],
	options: { selectEveryTaskEntryInitially: boolean },
): PostDeployVerificationDoneEntryClosureDialogDraft {
	return {
		closureReasonDraftsByTaskIdThenChecklistItemId: {},
		closureReasonAppliedToAllUncheckedChecklistItems: null,
		inProgressAgentSessionMayStillBeRunningAcknowledged: false,
		taskIdsSelectedForClosure: options.selectEveryTaskEntryInitially ? taskEntries.map((entry) => entry.taskId) : [],
	};
}

export function readClosureReasonDraftOfChecklistItem(
	draft: PostDeployVerificationDoneEntryClosureDialogDraft,
	taskId: string,
	checklistItemId: string,
): UncheckedChecklistItemClosureReasonDraft {
	return (
		draft.closureReasonDraftsByTaskIdThenChecklistItemId[taskId]?.[checklistItemId] ??
		EMPTY_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_DRAFT
	);
}

export function updateClosureReasonDraftOfChecklistItem(
	draft: PostDeployVerificationDoneEntryClosureDialogDraft,
	taskId: string,
	checklistItemId: string,
	patch: Partial<UncheckedChecklistItemClosureReasonDraft>,
): PostDeployVerificationDoneEntryClosureDialogDraft {
	const previousItemDraft = readClosureReasonDraftOfChecklistItem(draft, taskId, checklistItemId);
	return {
		...draft,
		closureReasonDraftsByTaskIdThenChecklistItemId: {
			...draft.closureReasonDraftsByTaskIdThenChecklistItemId,
			[taskId]: {
				...draft.closureReasonDraftsByTaskIdThenChecklistItemId[taskId],
				[checklistItemId]: { ...previousItemDraft, ...patch },
			},
		},
	};
}

// 「应用到全部未勾项」：一次性填进**所有**任务条目（不论是否选中）的每个未勾项，之后仍可逐项改。
export function applyClosureReasonToAllUncheckedChecklistItemsInDialogDraft(
	draft: PostDeployVerificationDoneEntryClosureDialogDraft,
	taskEntries: readonly PostDeployVerificationDoneEntryClosureDialogTaskEntry[],
	closureReasonAppliedToAll: UncheckedChecklistItemClosureReasonDraft,
): PostDeployVerificationDoneEntryClosureDialogDraft {
	const closureReasonDraftsByTaskIdThenChecklistItemId = { ...draft.closureReasonDraftsByTaskIdThenChecklistItemId };
	for (const taskEntry of taskEntries) {
		const itemDrafts: Record<string, UncheckedChecklistItemClosureReasonDraft> = {};
		for (const item of taskEntry.uncheckedChecklistItemsRequiringClosureReason) {
			itemDrafts[item.checklistItemId] = { ...closureReasonAppliedToAll };
		}
		closureReasonDraftsByTaskIdThenChecklistItemId[taskEntry.taskId] = itemDrafts;
	}
	return {
		...draft,
		closureReasonDraftsByTaskIdThenChecklistItemId,
		closureReasonAppliedToAllUncheckedChecklistItems: { ...closureReasonAppliedToAll },
	};
}

export function toggleTaskEntrySelectedForClosureInDialogDraft(
	draft: PostDeployVerificationDoneEntryClosureDialogDraft,
	taskId: string,
	selected: boolean,
): PostDeployVerificationDoneEntryClosureDialogDraft {
	const withoutTask = draft.taskIdsSelectedForClosure.filter((selectedTaskId) => selectedTaskId !== taskId);
	return { ...draft, taskIdsSelectedForClosure: selected ? [...withoutTask, taskId] : withoutTask };
}

// ---- 校验 ----

export function isUncheckedChecklistItemClosureReasonDraftComplete(
	closureReasonDraft: UncheckedChecklistItemClosureReasonDraft | null,
): boolean {
	if (!closureReasonDraft || closureReasonDraft.closureReasonCode === null) {
		return false;
	}
	return (
		closureReasonDraft.closureReasonCode !== "custom_reason_described_in_reason_text" ||
		closureReasonDraft.closureReasonText.trim().length > 0
	);
}

export function listTaskEntriesSelectedForClosure(
	taskEntries: readonly PostDeployVerificationDoneEntryClosureDialogTaskEntry[],
	draft: PostDeployVerificationDoneEntryClosureDialogDraft,
): PostDeployVerificationDoneEntryClosureDialogTaskEntry[] {
	const selectedTaskIds = new Set(draft.taskIdsSelectedForClosure);
	return taskEntries.filter((entry) => selectedTaskIds.has(entry.taskId));
}

export interface PostDeployVerificationDoneEntryClosureDialogDraftValidation {
	isReadyToConfirmClosure: boolean;
	// 给人看的未就绪原因（中文，逐条）；就绪时为空。
	closureDraftProblemsForDisplay: string[];
}

export function validatePostDeployVerificationDoneEntryClosureDialogDraft(
	taskEntries: readonly PostDeployVerificationDoneEntryClosureDialogTaskEntry[],
	draft: PostDeployVerificationDoneEntryClosureDialogDraft,
): PostDeployVerificationDoneEntryClosureDialogDraftValidation {
	const closureDraftProblemsForDisplay: string[] = [];
	const selectedTaskEntries = listTaskEntriesSelectedForClosure(taskEntries, draft);
	if (selectedTaskEntries.length === 0) {
		closureDraftProblemsForDisplay.push("至少选择一个任务。");
	}
	let uncheckedItemsMissingReasonCount = 0;
	let customReasonsMissingTextCount = 0;
	for (const taskEntry of selectedTaskEntries) {
		for (const item of taskEntry.uncheckedChecklistItemsRequiringClosureReason) {
			const itemDraft = readClosureReasonDraftOfChecklistItem(draft, taskEntry.taskId, item.checklistItemId);
			if (itemDraft.closureReasonCode === null) {
				uncheckedItemsMissingReasonCount += 1;
			} else if (!isUncheckedChecklistItemClosureReasonDraftComplete(itemDraft)) {
				customReasonsMissingTextCount += 1;
			}
		}
	}
	if (uncheckedItemsMissingReasonCount > 0) {
		closureDraftProblemsForDisplay.push(`还有 ${uncheckedItemsMissingReasonCount} 个未勾项没有选择原因。`);
	}
	if (customReasonsMissingTextCount > 0) {
		closureDraftProblemsForDisplay.push(`有 ${customReasonsMissingTextCount} 个「自定义原因」没有填写原因文本。`);
	}
	const hasSelectedTaskEntryWithUncheckedItemsInvisibleToLocalReadModel = selectedTaskEntries.some(
		(entry) => entry.runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel,
	);
	if (
		hasSelectedTaskEntryWithUncheckedItemsInvisibleToLocalReadModel &&
		!isUncheckedChecklistItemClosureReasonDraftComplete(draft.closureReasonAppliedToAllUncheckedChecklistItems)
	) {
		closureDraftProblemsForDisplay.push("服务端报告还有本地尚未显示的未勾项：请用「应用到全部未勾项」给出原因。");
	}
	const hasSelectedTaskEntryLeavingInProgress = selectedTaskEntries.some(
		(entry) => entry.boardColumnIdOfTaskCardBeforeMoveIntoDone === "in_progress",
	);
	if (hasSelectedTaskEntryLeavingInProgress && !draft.inProgressAgentSessionMayStillBeRunningAcknowledged) {
		closureDraftProblemsForDisplay.push("需要确认已了解 In Progress 任务的会话可能仍在运行。");
	}
	return {
		isReadyToConfirmClosure: closureDraftProblemsForDisplay.length === 0,
		closureDraftProblemsForDisplay,
	};
}

// ---- 草稿 → moveIntoDone 的结案请求 ----

function toClosureReasonWithoutItem(
	closureReasonDraft: UncheckedChecklistItemClosureReasonDraft,
): RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonWithoutItem | null {
	if (
		!isUncheckedChecklistItemClosureReasonDraftComplete(closureReasonDraft) ||
		!closureReasonDraft.closureReasonCode
	) {
		return null;
	}
	const trimmedClosureReasonText = closureReasonDraft.closureReasonText.trim();
	return {
		uncheckedChecklistItemClosureReasonCode: closureReasonDraft.closureReasonCode,
		...(trimmedClosureReasonText.length > 0
			? { uncheckedChecklistItemClosureReasonText: trimmedClosureReasonText }
			: {}),
	};
}

// 只为**选中**的任务出请求；调用方应先确认 validate 已就绪（未就绪项会被跳过，服务端会因原因不全而拒绝）。
export function buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId(
	taskEntries: readonly PostDeployVerificationDoneEntryClosureDialogTaskEntry[],
	draft: PostDeployVerificationDoneEntryClosureDialogDraft,
): Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest> {
	const closureReasonAppliedToRemaining = draft.closureReasonAppliedToAllUncheckedChecklistItems
		? toClosureReasonWithoutItem(draft.closureReasonAppliedToAllUncheckedChecklistItems)
		: null;
	const closureRequestsBySelectedTaskId: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest> = {};
	for (const taskEntry of listTaskEntriesSelectedForClosure(taskEntries, draft)) {
		const uncheckedChecklistItemClosureReasons = taskEntry.uncheckedChecklistItemsRequiringClosureReason.flatMap(
			(item) => {
				const closureReason = toClosureReasonWithoutItem(
					readClosureReasonDraftOfChecklistItem(draft, taskEntry.taskId, item.checklistItemId),
				);
				return closureReason ? [{ checklistItemId: item.checklistItemId, ...closureReason }] : [];
			},
		);
		const confirmedAcknowledgements =
			resolveRequiredPostDeployVerificationAcknowledgementsForMoveIntoDoneFromBoardColumn(
				taskEntry.boardColumnIdOfTaskCardBeforeMoveIntoDone,
			);
		closureRequestsBySelectedTaskId[taskEntry.taskId] = {
			...(uncheckedChecklistItemClosureReasons.length > 0 ? { uncheckedChecklistItemClosureReasons } : {}),
			...(closureReasonAppliedToRemaining
				? { closureReasonAppliedToRemainingUncheckedChecklistItems: closureReasonAppliedToRemaining }
				: {}),
			...(confirmedAcknowledgements.length > 0 ? { confirmedAcknowledgements } : {}),
		};
	}
	return closureRequestsBySelectedTaskId;
}
