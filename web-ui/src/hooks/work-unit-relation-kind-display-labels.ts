import {
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitReferenceRelationKind,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";

// 关系图与卡片预览共用的简体中文品种标签；关系方向由各呈现面显式表达。
export const REFERENCE_RELATION_LABELS: Record<string, string> = {
	reference_fixes_defects_in_produced_outputs_of: "修复交付物",
	reference_diagnoses_agent_execution_trajectory_of: "Trajectory 诊断",
	reference_concerns_behavior_or_state_of: "关注行为或状态（旧关系）",
	reference_verifies_claims_of: "核验主张（旧关系）",
	reference_reuses_produced_outputs_of: "复用产物",
	reference_requirement_originates_from: "需求源自",
	reference_is_cross_repository_counterpart_with: "跨 project 对应",
	reference_is_generally_related_with: "普通关联",
};

export const MANUALLY_SELECTABLE_TASK_REFERENCE_RELATION_KINDS = [
	"reference_is_generally_related_with",
	"reference_fixes_defects_in_produced_outputs_of",
	"reference_diagnoses_agent_execution_trajectory_of",
	"reference_reuses_produced_outputs_of",
	"reference_requirement_originates_from",
	"reference_is_cross_repository_counterpart_with",
] as const satisfies readonly AssertedInterWorkUnitReferenceRelationKind[];

const REFERENCE_RELATION_DIRECTION_LABELS: Record<
	AssertedInterWorkUnitReferenceRelationKind,
	readonly [string, string]
> = {
	reference_fixes_defects_in_produced_outputs_of: ["修复其交付物 →", "← 交付物由其修复"],
	reference_diagnoses_agent_execution_trajectory_of: ["诊断其 Trajectory →", "← Trajectory 由其诊断"],
	reference_reuses_produced_outputs_of: ["复用其产物 →", "← 产物被其复用"],
	reference_requirement_originates_from: ["需求源自 →", "← 其需求源自本 Task"],
	reference_is_cross_repository_counterpart_with: ["跨 project 对应（无方向）", "跨 project 对应（无方向）"],
	reference_is_generally_related_with: ["普通关联（无方向，默认）", "普通关联（无方向，默认）"],
	reference_concerns_behavior_or_state_of: ["关注其行为或状态（旧关系）→", "← 行为或状态由其关注（旧关系）"],
	reference_verifies_claims_of: ["核验其主张（旧关系）→", "← 主张由其核验（旧关系）"],
};

export function isReferenceRelationUndirected(relationKind: string): boolean {
	return (
		ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind as AssertedInterWorkUnitReferenceRelationKind]
			?.relationEndpointSymmetry === "symmetric_unordered_endpoint_pair"
	);
}

export function getReferenceRelationDisplayLabel(
	relationKind: string,
	assertedRelationKindSpecificAttributes?: Record<string, unknown>,
): string {
	if (
		relationKind === "reference_concerns_behavior_or_state_of" &&
		assertedRelationKindSpecificAttributes?.concernNature === "checks_scope_overlap_with"
	)
		return "工作范围重叠";
	return RELATION_GRAPH_LABELS[relationKind] ?? relationKind;
}

export function getReferenceRelationDirectionLabel(
	relationKind: AssertedInterWorkUnitReferenceRelationKind,
	currentTaskIsStatementSubject: boolean,
	assertedRelationKindSpecificAttributes?: Record<string, unknown>,
): string {
	if (
		relationKind === "reference_concerns_behavior_or_state_of" &&
		assertedRelationKindSpecificAttributes?.concernNature === "checks_scope_overlap_with"
	)
		return currentTaskIsStatementSubject ? "工作范围重叠 →" : "← 工作范围重叠";
	return REFERENCE_RELATION_DIRECTION_LABELS[relationKind][currentTaskIsStatementSubject ? 0 : 1];
}

export function getReferenceRelationDirectionSelectionValue(
	relationKind: string,
	currentTaskIsStatementSubject: boolean,
): string {
	return currentTaskIsStatementSubject || isReferenceRelationUndirected(relationKind)
		? relationKind
		: `${relationKind}:inverse`;
}
export const RELATION_GRAPH_LABELS: Record<string, string> = {
	...REFERENCE_RELATION_LABELS,
	provenance_created_by: "创建来源",
	provenance_split_from_side_conversation_of: "侧会话分出来源",
	provenance_resumed_and_adopted_conversation_session_of: "续用会话来源",
	provenance_forked_conversation_session_of: "派生会话来源",
	interaction_agent_session_dispatched_or_controlled_by: "会话受其调度",
	interaction_requirements_amended_by: "需求由其修订",
	interaction_execution_configuration_changed_by: "配置由其修改",
	interaction_board_lifecycle_transitioned_by: "状态由其迁移",
};
