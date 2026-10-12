// dd2db 2.1「添加关系」对话框（T12 ②）的草稿 → 断言请求（纯函数）。
//
// 客户端校验只是镜像 kind 注册表（requiredKindSpecificAttributeKeyAlternatives / allowedKindSpecificAttributeKeys）与
// 写入契约的长度上限，让用户在提交前就看到缺了什么；**runtime 仍是唯一权威**（端点校验、同项目跨仓配对拒绝等都以 runtime
// 的回复为准，界面原样转述）。主语恒为面板所在的卡（只有卡能作主语，面板主体恒为卡，满足「需求来源」的主语限制）。

import {
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitReferenceRelationKind,
	type AssertedReferenceRelationKindSpecificAttributes,
	type ReferenceConcernNature,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import type { AssertReferenceRelationDirectlyAsWebUiUserRequest } from "@runtime-work-unit-relation-assertion-write-api-contract";

// 与写入契约（work-unit-relation-assertion-write-api-contract.ts）的上限一致。
const RELATION_ASSERTION_RATIONALE_MAXIMUM_LENGTH = 600;
const RELATION_ASSERTION_EVIDENCE_POINTER_MAXIMUM_LENGTH = 1000;
const RELATION_ASSERTION_EVIDENCE_POINTER_MAXIMUM_COUNT = 50;

export interface SelectedCounterpartKanbanBoardCardForAddReferenceRelation {
	counterpartKanbanBoardCardWorkspaceId: string;
	counterpartKanbanBoardCardTaskId: string;
	counterpartKanbanBoardCardTitle: string;
	counterpartKanbanProjectDisplayName: string;
}

export interface AddReferenceRelationDialogDraft {
	selectedCounterpartKanbanBoardCard: SelectedCounterpartKanbanBoardCardForAddReferenceRelation | null;
	// "" = 还没选。
	selectedReferenceRelationKind: AssertedInterWorkUnitReferenceRelationKind | "";
	relationAssertionRationaleOneSentenceText: string;
	relationAssertionEvidencePointersOnePerLineText: string;
	concernedAspectSummaryText: string;
	// "" = 不指定。
	selectedConcernNature: ReferenceConcernNature | "";
	claimsUnderVerificationOnePerLineText: string;
	reusedOutputSummaryText: string;
	reusedOutputPointersOnePerLineText: string;
	originatedRequirementPortionSummaryText: string;
	sharedCrossRepositoryContractPointerText: string;
}

export const EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT: AddReferenceRelationDialogDraft = {
	selectedCounterpartKanbanBoardCard: null,
	selectedReferenceRelationKind: "",
	relationAssertionRationaleOneSentenceText: "",
	relationAssertionEvidencePointersOnePerLineText: "",
	concernedAspectSummaryText: "",
	selectedConcernNature: "",
	claimsUnderVerificationOnePerLineText: "",
	reusedOutputSummaryText: "",
	reusedOutputPointersOnePerLineText: "",
	originatedRequirementPortionSummaryText: "",
	sharedCrossRepositoryContractPointerText: "",
};

type ReferenceRelationKindSpecificAttributeKey = keyof AssertedReferenceRelationKindSpecificAttributes;

export const REFERENCE_RELATION_KIND_SPECIFIC_ATTRIBUTE_FORM_FIELD_LABEL_BY_ATTRIBUTE_KEY: Record<
	ReferenceRelationKindSpecificAttributeKey,
	string
> = {
	concernedAspectSummary: "Concerned aspect",
	concernNature: "Nature of the concern",
	claimsUnderVerification: "Claims to verify",
	reusedOutputSummary: "Reused output summary",
	reusedOutputPointers: "Reused output pointers",
	originatedRequirementPortionSummary: "Originated requirement portion",
	sharedCrossRepositoryContractPointer: "Shared contract pointer",
	relatednessRationaleOneSentence: "Relatedness rationale",
};

// 对话框要为某个 kind 显示哪些专有输入：注册表允许的属性里，去掉写入时由断言理由自动填的泛相关理由。
export function listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs(
	relationKind: AssertedInterWorkUnitReferenceRelationKind,
): ReferenceRelationKindSpecificAttributeKey[] {
	return ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind].allowedKindSpecificAttributeKeys.filter(
		(attributeKey) => attributeKey !== "relatednessRationaleOneSentence",
	);
}

export function isKindSpecificAttributeKeyPartOfAnyRequiredAlternative(
	relationKind: AssertedInterWorkUnitReferenceRelationKind,
	attributeKey: ReferenceRelationKindSpecificAttributeKey,
): boolean {
	return ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[
		relationKind
	].requiredKindSpecificAttributeKeyAlternatives.some((requiredAttributeKeyGroup) =>
		requiredAttributeKeyGroup.includes(attributeKey),
	);
}

export function splitOnePerLineTextIntoTrimmedNonEmptyLines(onePerLineText: string): string[] {
	return onePerLineText
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

// 草稿里所有填了的专有属性（不分 kind）；提交时再按 kind 的允许集合裁剪，切换 kind 时已填的值不丢。
function buildAllFilledKindSpecificAttributesFromDraft(
	draft: AddReferenceRelationDialogDraft,
): AssertedReferenceRelationKindSpecificAttributes {
	const filledAttributes: AssertedReferenceRelationKindSpecificAttributes = {};
	const concernedAspectSummary = draft.concernedAspectSummaryText.trim();
	if (concernedAspectSummary) {
		filledAttributes.concernedAspectSummary = concernedAspectSummary;
	}
	if (draft.selectedConcernNature) {
		filledAttributes.concernNature = draft.selectedConcernNature;
	}
	const claimSummaries = splitOnePerLineTextIntoTrimmedNonEmptyLines(draft.claimsUnderVerificationOnePerLineText);
	if (claimSummaries.length > 0) {
		// 新声明的待核验主张一律从 pending 起步；核验结论由核验方之后改写。
		filledAttributes.claimsUnderVerification = claimSummaries.map((claimSummary) => ({
			claimSummary,
			verificationVerdict: "pending",
		}));
	}
	const reusedOutputSummary = draft.reusedOutputSummaryText.trim();
	if (reusedOutputSummary) {
		filledAttributes.reusedOutputSummary = reusedOutputSummary;
	}
	const reusedOutputPointers = splitOnePerLineTextIntoTrimmedNonEmptyLines(draft.reusedOutputPointersOnePerLineText);
	if (reusedOutputPointers.length > 0) {
		filledAttributes.reusedOutputPointers = reusedOutputPointers;
	}
	const originatedRequirementPortionSummary = draft.originatedRequirementPortionSummaryText.trim();
	if (originatedRequirementPortionSummary) {
		filledAttributes.originatedRequirementPortionSummary = originatedRequirementPortionSummary;
	}
	const sharedCrossRepositoryContractPointer = draft.sharedCrossRepositoryContractPointerText.trim();
	if (sharedCrossRepositoryContractPointer) {
		filledAttributes.sharedCrossRepositoryContractPointer = sharedCrossRepositoryContractPointer;
	}
	return filledAttributes;
}

export type ReferenceRelationAssertionRequestWithoutClientCharacteristics = Omit<
	AssertReferenceRelationDirectlyAsWebUiUserRequest,
	"webUiUserDecisionClientCharacteristics"
>;

export type AddReferenceRelationDialogDraftValidationOutcome =
	| {
			isDraftReadyForSubmission: true;
			referenceRelationAssertionRequestWithoutClientCharacteristics: ReferenceRelationAssertionRequestWithoutClientCharacteristics;
	  }
	| { isDraftReadyForSubmission: false; draftValidationProblemMessages: string[] };

export function validateAddReferenceRelationDialogDraftIntoAssertionRequest(input: {
	draft: AddReferenceRelationDialogDraft;
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
}): AddReferenceRelationDialogDraftValidationOutcome {
	const { draft } = input;
	const draftValidationProblemMessages: string[] = [];

	const counterpart = draft.selectedCounterpartKanbanBoardCard;
	if (!counterpart) {
		draftValidationProblemMessages.push("Choose the other task.");
	} else if (
		counterpart.counterpartKanbanBoardCardWorkspaceId === input.subjectKanbanBoardCardWorkspaceId &&
		counterpart.counterpartKanbanBoardCardTaskId === input.subjectKanbanBoardCardTaskId
	) {
		draftValidationProblemMessages.push("A task cannot have a relation with itself; choose another task.");
	}

	const relationKind = draft.selectedReferenceRelationKind;
	if (!relationKind) {
		draftValidationProblemMessages.push("Choose a relation kind.");
	}

	const relationAssertionRationaleOneSentence = draft.relationAssertionRationaleOneSentenceText.trim();
	if (!relationAssertionRationaleOneSentence) {
		draftValidationProblemMessages.push("Write a one-sentence rationale.");
	} else if (relationAssertionRationaleOneSentence.length > RELATION_ASSERTION_RATIONALE_MAXIMUM_LENGTH) {
		draftValidationProblemMessages.push(
			`The rationale is limited to ${RELATION_ASSERTION_RATIONALE_MAXIMUM_LENGTH} characters (one sentence).`,
		);
	}

	const relationAssertionEvidencePointers = splitOnePerLineTextIntoTrimmedNonEmptyLines(
		draft.relationAssertionEvidencePointersOnePerLineText,
	);
	if (relationAssertionEvidencePointers.length > RELATION_ASSERTION_EVIDENCE_POINTER_MAXIMUM_COUNT) {
		draftValidationProblemMessages.push(
			`At most ${RELATION_ASSERTION_EVIDENCE_POINTER_MAXIMUM_COUNT} evidence pointers are accepted.`,
		);
	}
	if (
		relationAssertionEvidencePointers.some(
			(evidencePointer) => evidencePointer.length > RELATION_ASSERTION_EVIDENCE_POINTER_MAXIMUM_LENGTH,
		)
	) {
		draftValidationProblemMessages.push(
			`Each evidence pointer is limited to ${RELATION_ASSERTION_EVIDENCE_POINTER_MAXIMUM_LENGTH} characters.`,
		);
	}

	let assertedRelationKindSpecificAttributes: AssertedReferenceRelationKindSpecificAttributes = {};
	if (relationKind) {
		const relationKindRegistryEntry = ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind];
		const allFilledKindSpecificAttributes = buildAllFilledKindSpecificAttributesFromDraft(draft);
		// 只带这个 kind 允许的属性：runtime 对不属于该 kind 的属性直接拒绝（免得属性写错 kind 而不自知）。
		assertedRelationKindSpecificAttributes = Object.fromEntries(
			Object.entries(allFilledKindSpecificAttributes).filter(([attributeKey]) =>
				(relationKindRegistryEntry.allowedKindSpecificAttributeKeys as readonly string[]).includes(attributeKey),
			),
		) as AssertedReferenceRelationKindSpecificAttributes;
		const requiredAlternatives = relationKindRegistryEntry.requiredKindSpecificAttributeKeyAlternatives;
		const isAnyRequiredAlternativeSatisfied =
			requiredAlternatives.length === 0 ||
			requiredAlternatives.some((requiredAttributeKeyGroup) =>
				requiredAttributeKeyGroup.every(
					(attributeKey) => assertedRelationKindSpecificAttributes[attributeKey] !== undefined,
				),
			);
		if (!isAnyRequiredAlternativeSatisfied) {
			const requiredAlternativeDescriptions = requiredAlternatives.map((requiredAttributeKeyGroup) =>
				requiredAttributeKeyGroup
					.map(
						(attributeKey) =>
							REFERENCE_RELATION_KIND_SPECIFIC_ATTRIBUTE_FORM_FIELD_LABEL_BY_ATTRIBUTE_KEY[attributeKey],
					)
					.join(" and "),
			);
			draftValidationProblemMessages.push(
				requiredAlternativeDescriptions.length > 1
					? `Fill in at least one of: ${requiredAlternativeDescriptions.join(" or ")}.`
					: `Fill in ${requiredAlternativeDescriptions[0]}.`,
			);
		}
	}

	if (draftValidationProblemMessages.length > 0 || !counterpart || !relationKind) {
		return { isDraftReadyForSubmission: false, draftValidationProblemMessages };
	}
	return {
		isDraftReadyForSubmission: true,
		referenceRelationAssertionRequestWithoutClientCharacteristics: {
			subjectWorkUnit: {
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
				bareTaskId: input.subjectKanbanBoardCardTaskId,
				// 显式带 workspaceId：裸 id 跨 project 会撞号。
				workspaceId: input.subjectKanbanBoardCardWorkspaceId,
			},
			relationKind,
			counterpartWorkUnit: {
				workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
				bareTaskId: counterpart.counterpartKanbanBoardCardTaskId,
				workspaceId: counterpart.counterpartKanbanBoardCardWorkspaceId,
			},
			relationAssertionRationaleOneSentence,
			relationAssertionEvidencePointers,
			assertedRelationKindSpecificAttributes,
		},
	};
}
