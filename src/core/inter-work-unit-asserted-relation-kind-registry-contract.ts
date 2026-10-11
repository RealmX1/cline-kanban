import { z } from "zod";

import { isUserOrIndependentVerifierConfirmationDecisionSource } from "./inter-work-unit-relation-assertion-lifecycle-event-contract";
import {
	type InterWorkUnitRelationWorkUnitReference,
	interWorkUnitRelationWorkUnitReferenceSchema,
} from "./inter-work-unit-relation-ledger-event-contract";

// dd2db 阶段 2：断言型关系（义务 / 门 / 参照三轴，d-vocab §1.3：品种由轴前缀唯一决定）的 kind 注册表与读侧信封。
// 2.1 只注册参照轴 6 个 kind（d-vocab §3.5，写入动词 `kanban work-unit assert-reference-relation`，R3.4）；
// 义务轴、门轴随 2.4、阶段 3 注册。方向的规范来源是注册表里的读法短语（d-vocab §1.1），由单测锁定。
// 本文件同时被 web-ui 引用（Relations 面板的「添加关系」对话框列 kind），只放 schema、纯数据与纯判定函数，不放 node 依赖。

export const ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS = [
	"reference_concerns_behavior_or_state_of",
	"reference_verifies_claims_of",
	"reference_reuses_produced_outputs_of",
	"reference_requirement_originates_from",
	"reference_is_cross_repository_counterpart_with",
	"reference_is_generally_related_with",
] as const;
export type AssertedInterWorkUnitReferenceRelationKind =
	(typeof ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS)[number];

export type AssertedInterWorkUnitRelationAxis = "reference";

export type InterWorkUnitRelationWorkUnitType =
	| "kanban_board_card"
	| "kanban_unmanaged_standalone_agent_conversation_session";

// d-vocab §3.5 `concernNature` 的取值。
export const REFERENCE_CONCERN_NATURES = [
	"diagnoses_failure_of",
	"analyzes_behavior_of",
	"extends_design_of",
	"checks_scope_overlap_with",
	"other",
] as const;
export type ReferenceConcernNature = (typeof REFERENCE_CONCERN_NATURES)[number];

export const REFERENCE_CLAIM_VERIFICATION_VERDICTS = ["pending", "confirmed", "refuted", "inconclusive"] as const;
export type ReferenceClaimVerificationVerdict = (typeof REFERENCE_CLAIM_VERIFICATION_VERDICTS)[number];

// 各 kind 的专有属性（d-vocab §3.5「专有必填属性」列）。写入时按 kind 校验，读侧按开放 record 保留未知字段。
export const assertedReferenceRelationKindSpecificAttributesSchema = z
	.object({
		concernedAspectSummary: z.string().trim().min(1).optional(),
		concernNature: z.enum(REFERENCE_CONCERN_NATURES).optional(),
		claimsUnderVerification: z
			.array(
				z.object({
					claimSummary: z.string().trim().min(1),
					verificationVerdict: z.enum(REFERENCE_CLAIM_VERIFICATION_VERDICTS),
				}),
			)
			.optional(),
		reusedOutputPointers: z.array(z.string().trim().min(1)).optional(),
		reusedOutputSummary: z.string().trim().min(1).optional(),
		originatedRequirementPortionSummary: z.string().trim().min(1).optional(),
		sharedCrossRepositoryContractPointer: z.string().trim().min(1).optional(),
		relatednessRationaleOneSentence: z.string().trim().min(1).optional(),
	})
	.strict();
export type AssertedReferenceRelationKindSpecificAttributes = z.infer<
	typeof assertedReferenceRelationKindSpecificAttributesSchema
>;

export interface AssertedInterWorkUnitRelationKindRegistryEntry {
	relationAxis: AssertedInterWorkUnitRelationAxis;
	// 有向 kind：S 是回头指向 A 的一方；对称 kind（名字形如 `…_is_…_with`）两端互换读法相同，去重键按无序对。
	relationEndpointSymmetry: "directed_subject_points_back_at_anchor" | "symmetric_unordered_endpoint_pair";
	forwardReadingPhraseFromSubject: string;
	inverseReadingPhraseFromAnchor: string;
	// `kanban work-unit assert-reference-relation` 的对端角色 flag（d-vocab §1.4：flag 按对端角色命名，主语由环境变量解析）。
	assertReferenceRelationCounterpartRoleCommandLineFlagName: string;
	allowedSubjectWorkUnitTypes: readonly InterWorkUnitRelationWorkUnitType[];
	allowedAnchorWorkUnitTypes: readonly InterWorkUnitRelationWorkUnitType[];
	// 同仓写入直接拒绝（d-vocab §3.5 跨仓配对），提示改用泛相关，不在事后改写 kind。
	rejectsEndpointsInSameKanbanWorkspace: boolean;
	// 至少要填其中一组：外层数组是「或」，内层数组是「与」。空数组 = 没有专有必填属性。
	requiredKindSpecificAttributeKeyAlternatives: readonly (readonly (keyof AssertedReferenceRelationKindSpecificAttributes)[])[];
	// 允许出现的专有属性（其余专有属性写入时拒绝，免得 agent 把属性写错 kind 而不自知）。
	allowedKindSpecificAttributeKeys: readonly (keyof AssertedReferenceRelationKindSpecificAttributes)[];
	// Y-CONF-10：身份相同、这些属性变了就是 M27 修订变更；参照轴没有风险相关属性，重断言一律合并。
	riskRelevantAttributeKeys: readonly string[];
	// d-vocab §10 的邻域摘要分区：8 = 参照；9 = 默认折叠、只给计数（泛相关与派发控制、配置、生命周期同组）。
	neighborhoodSummarySectionPriority: number;
	defaultVisibleInNeighborhoodSummary: boolean;
	// Web UI「添加关系」对话框里的选项文案（以面板主语为 S 成句）。
	webUiAddRelationOptionLabel: string;
}

const KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES = [
	"kanban_board_card",
	"kanban_unmanaged_standalone_agent_conversation_session",
] as const;

export const ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY: Record<
	AssertedInterWorkUnitReferenceRelationKind,
	AssertedInterWorkUnitRelationKindRegistryEntry
> = {
	reference_concerns_behavior_or_state_of: {
		relationAxis: "reference",
		relationEndpointSymmetry: "directed_subject_points_back_at_anchor",
		forwardReadingPhraseFromSubject: "concerns the behavior or state of",
		inverseReadingPhraseFromAnchor: "has its behavior or state concerned by",
		assertReferenceRelationCounterpartRoleCommandLineFlagName: "--concerns-behavior-or-state-of",
		allowedSubjectWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		allowedAnchorWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		rejectsEndpointsInSameKanbanWorkspace: false,
		requiredKindSpecificAttributeKeyAlternatives: [["concernedAspectSummary"]],
		allowedKindSpecificAttributeKeys: ["concernedAspectSummary", "concernNature"],
		riskRelevantAttributeKeys: [],
		neighborhoodSummarySectionPriority: 8,
		defaultVisibleInNeighborhoodSummary: true,
		webUiAddRelationOptionLabel: "Concerns the behavior or state of (studies / diagnoses it)",
	},
	reference_verifies_claims_of: {
		relationAxis: "reference",
		relationEndpointSymmetry: "directed_subject_points_back_at_anchor",
		forwardReadingPhraseFromSubject: "verifies claims of",
		inverseReadingPhraseFromAnchor: "has its claims verified by",
		assertReferenceRelationCounterpartRoleCommandLineFlagName: "--verifies-claims-of",
		allowedSubjectWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		allowedAnchorWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		rejectsEndpointsInSameKanbanWorkspace: false,
		requiredKindSpecificAttributeKeyAlternatives: [["claimsUnderVerification"]],
		allowedKindSpecificAttributeKeys: ["claimsUnderVerification"],
		riskRelevantAttributeKeys: [],
		neighborhoodSummarySectionPriority: 8,
		defaultVisibleInNeighborhoodSummary: true,
		webUiAddRelationOptionLabel: "Independently verifies claims of",
	},
	reference_reuses_produced_outputs_of: {
		relationAxis: "reference",
		relationEndpointSymmetry: "directed_subject_points_back_at_anchor",
		forwardReadingPhraseFromSubject: "reuses produced outputs of",
		inverseReadingPhraseFromAnchor: "has its produced outputs reused by",
		assertReferenceRelationCounterpartRoleCommandLineFlagName: "--reuses-produced-outputs-of",
		allowedSubjectWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		allowedAnchorWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		rejectsEndpointsInSameKanbanWorkspace: false,
		requiredKindSpecificAttributeKeyAlternatives: [["reusedOutputPointers"], ["reusedOutputSummary"]],
		allowedKindSpecificAttributeKeys: ["reusedOutputPointers", "reusedOutputSummary"],
		riskRelevantAttributeKeys: [],
		neighborhoodSummarySectionPriority: 8,
		defaultVisibleInNeighborhoodSummary: true,
		webUiAddRelationOptionLabel: "Reuses produced outputs of (evidence, docs, commits — not its obligations)",
	},
	reference_requirement_originates_from: {
		relationAxis: "reference",
		relationEndpointSymmetry: "directed_subject_points_back_at_anchor",
		forwardReadingPhraseFromSubject: "has requirements that originate from",
		inverseReadingPhraseFromAnchor: "originated requirements of",
		assertReferenceRelationCounterpartRoleCommandLineFlagName: "--requirement-originates-from",
		// 卡 → 卡|独：看板外独立会话没有可承接的需求（d-vocab §11）。
		allowedSubjectWorkUnitTypes: ["kanban_board_card"],
		allowedAnchorWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		rejectsEndpointsInSameKanbanWorkspace: false,
		requiredKindSpecificAttributeKeyAlternatives: [],
		allowedKindSpecificAttributeKeys: ["originatedRequirementPortionSummary"],
		riskRelevantAttributeKeys: [],
		neighborhoodSummarySectionPriority: 8,
		defaultVisibleInNeighborhoodSummary: true,
		webUiAddRelationOptionLabel: "Has requirements that originate from",
	},
	reference_is_cross_repository_counterpart_with: {
		relationAxis: "reference",
		relationEndpointSymmetry: "symmetric_unordered_endpoint_pair",
		forwardReadingPhraseFromSubject: "is the cross-repository counterpart of",
		inverseReadingPhraseFromAnchor: "is the cross-repository counterpart of",
		assertReferenceRelationCounterpartRoleCommandLineFlagName: "--is-cross-repository-counterpart-with",
		allowedSubjectWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		allowedAnchorWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		rejectsEndpointsInSameKanbanWorkspace: true,
		requiredKindSpecificAttributeKeyAlternatives: [["sharedCrossRepositoryContractPointer"]],
		allowedKindSpecificAttributeKeys: ["sharedCrossRepositoryContractPointer"],
		riskRelevantAttributeKeys: [],
		neighborhoodSummarySectionPriority: 8,
		defaultVisibleInNeighborhoodSummary: true,
		webUiAddRelationOptionLabel: "Is the cross-repository counterpart of (shared contract)",
	},
	reference_is_generally_related_with: {
		relationAxis: "reference",
		relationEndpointSymmetry: "symmetric_unordered_endpoint_pair",
		forwardReadingPhraseFromSubject: "is generally related with",
		inverseReadingPhraseFromAnchor: "is generally related with",
		assertReferenceRelationCounterpartRoleCommandLineFlagName: "--is-generally-related-with",
		allowedSubjectWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		allowedAnchorWorkUnitTypes: KANBAN_BOARD_CARD_AND_STANDALONE_SESSION_WORK_UNIT_TYPES,
		rejectsEndpointsInSameKanbanWorkspace: false,
		// 一句话理由就是断言理由本身（写入时自动填入），不再单独要求。
		requiredKindSpecificAttributeKeyAlternatives: [],
		allowedKindSpecificAttributeKeys: ["relatednessRationaleOneSentence"],
		riskRelevantAttributeKeys: [],
		neighborhoodSummarySectionPriority: 9,
		defaultVisibleInNeighborhoodSummary: false,
		webUiAddRelationOptionLabel: "Is generally related with",
	},
};

export function isAssertedInterWorkUnitReferenceRelationKind(
	relationKind: string,
): relationKind is AssertedInterWorkUnitReferenceRelationKind {
	return (ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS as readonly string[]).includes(relationKind);
}

// ---------------------------------------------------------------------------------------------
// 断言型关系信封（读侧投影形状；Y-CONF-10：确认相关字段只是投影缓存）。读侧 schema 一律 passthrough。
// ---------------------------------------------------------------------------------------------

export const ASSERTED_INTER_WORK_UNIT_RELATION_EFFECTIVENESS_STATES = ["applied_and_effective", "revoked"] as const;
export type AssertedInterWorkUnitRelationEffectivenessState =
	(typeof ASSERTED_INTER_WORK_UNIT_RELATION_EFFECTIVENESS_STATES)[number];

export const assertedInterWorkUnitRelationSchema = z
	.object({
		relationId: z.string(),
		relationKind: z.string(),
		relationStatementSubjectWorkUnitRef: interWorkUnitRelationWorkUnitReferenceSchema,
		relationStatementAnchorWorkUnitRef: interWorkUnitRelationWorkUnitReferenceSchema,
		relationAssertionNaturalKey: z.string(),
		assertionEffectivenessState: z.string(),
		// 每次生效、合并、撤销都 +1；注入回执按（relationId, 版本）记，修订通知据此判断谁拿到的是旧版本。
		assertedRelationStateVersion: z.number().int(),
		relationFirstEstablishedAt: z.number(),
		relationLastUpdatedAt: z.number(),
		// 首个断言方（Y-EVENT-6：「谁提的」只用 relationAsserter）；之后的重断言方记在 reassertingActorKinds，
		// 重断言方的 agent 工作单元记在 relationContributingAgentWorkUnitRefs。
		relationAsserterActorKind: z.string(),
		relationAsserterWorkUnitRef: interWorkUnitRelationWorkUnitReferenceSchema.nullable(),
		// d-confirm §5.2 提议方策略身份（原生会话优先）：agent 以「有误」撤销自己的断言时，墓碑只抑制这个身份。
		relationAsserterPolicyIdentityKey: z.string().nullable(),
		// 给这条关系贡献过内容（属性、证据）的全部 agent 工作单元：首个断言方 + 各次重断言方（去重、按首次贡献排序）。
		// 对称 kind 的自然键是无序对，另一端点的重断言会并进同一条关系，所以「谁写的」不能只看首个断言方（RVF-002）。
		// Web UI 用户不是 agent 工作单元，不在其中。
		relationContributingAgentWorkUnitRefs: z.array(interWorkUnitRelationWorkUnitReferenceSchema),
		relationAssertionRationaleOneSentence: z.string(),
		relationAssertionEvidencePointers: z.array(z.string()),
		assertedRelationKindSpecificAttributes: z.record(z.string(), z.unknown()),
		effectiveConfirmableChangeIdForCurrentAssertionState: z.string(),
		effectiveConfirmableChangeDecisionSource: z.string(),
		effectiveConfirmableChangeAppliedAt: z.number(),
		// 生效过程中出现过的全部决策来源（合并会追加）：撤销权（Y-CONF-8）看「是否含用户显式同意」。
		decisionSourcesOfEffectiveAssertion: z.array(z.string()),
		reassertingActorKinds: z.array(z.string()),
		revokedAt: z.number().nullable(),
		relationAssertionRevocationReason: z.string().nullable(),
		revokedByActorKind: z.string().nullable(),
	})
	.passthrough();
export type AssertedInterWorkUnitRelation = z.infer<typeof assertedInterWorkUnitRelationSchema>;

// 旧 runtime 的响应没有贡献方字段时退用首个断言方（那时只有首个断言方的内容可以确定归属）。
export function listRelationContributingAgentWorkUnitRefsOfAssertedRelation(
	relation: Pick<
		AssertedInterWorkUnitRelation,
		"relationContributingAgentWorkUnitRefs" | "relationAsserterWorkUnitRef"
	>,
): InterWorkUnitRelationWorkUnitReference[] {
	if (Array.isArray(relation.relationContributingAgentWorkUnitRefs)) {
		return relation.relationContributingAgentWorkUnitRefs;
	}
	return relation.relationAsserterWorkUnitRef ? [relation.relationAsserterWorkUnitRef] : [];
}

// d-confirm §3.5「当数据不当指令」边界的唯一判据（CLI 邻域文本、会话启动注入与 Web UI 面板分组共用）：
// 经用户或独立核验确认过的，或贡献过内容的 agent 工作单元全部是读者自己的，才按「本方断言或已确认」呈现；
// 否则——哪怕首个断言方是读者，只要别的 agent 也并入过内容——都按「由别的工作单元单方面声明」呈现，
// 他方写的属性 / 证据不能作为本方断言裸放进读者会话。
export function isAssertedRelationPresentedAsAssertedByReaderOrConfirmed(input: {
	relation: Pick<
		AssertedInterWorkUnitRelation,
		"relationContributingAgentWorkUnitRefs" | "relationAsserterWorkUnitRef" | "decisionSourcesOfEffectiveAssertion"
	>;
	isReaderWorkUnit: (workUnit: InterWorkUnitRelationWorkUnitReference) => boolean;
}): boolean {
	const decisionSourcesOfEffectiveAssertion = input.relation.decisionSourcesOfEffectiveAssertion ?? [];
	if (decisionSourcesOfEffectiveAssertion.some(isUserOrIndependentVerifierConfirmationDecisionSource)) {
		return true;
	}
	const contributingAgentWorkUnitRefs = listRelationContributingAgentWorkUnitRefsOfAssertedRelation(input.relation);
	return contributingAgentWorkUnitRefs.length > 0 && contributingAgentWorkUnitRefs.every(input.isReaderWorkUnit);
}
