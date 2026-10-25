// 关系图与卡片预览共用的简体中文品种标签；关系方向由各呈现面显式表达。
export const REFERENCE_RELATION_LABELS: Record<string, string> = {
	reference_concerns_behavior_or_state_of: "研究／诊断",
	reference_verifies_claims_of: "核验主张",
	reference_reuses_produced_outputs_of: "复用产物",
	reference_requirement_originates_from: "需求源自",
	reference_is_cross_repository_counterpart_with: "跨仓对应",
	reference_is_generally_related_with: "一般相关",
};
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
