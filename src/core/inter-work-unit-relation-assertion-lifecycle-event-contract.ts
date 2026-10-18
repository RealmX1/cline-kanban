// dd2db 阶段 2：族 4 `inter_work_unit_relation_assertion_lifecycle_event` 的事件契约，以及可确认变更（d-confirm §1）
// 的取值集合。权威设计：§R3 Y-CONF-1/6/8/9/10/13（矩阵、撤销权、墓碑、重断言）与 d-confirm §2.1（策略）、§4.1（状态）、
// §4.2（决策来源）、§8（创建事件必填字段）。读盘一律容忍未知取值（同 inter-work-unit-relation-ledger-event-contract.ts 的纪律）。

// 每条族 4 事件都记这个版本：将来改矩阵或规则时，重放据此知道当初按哪套规则路由（d-confirm §4.8：已发生的迁移不重判）。
export const RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_POLICY_VERSION = 1;

// 自然键的推导规则版本（kind + 有序限定端点 + 影响语义的关键属性，d-confirm §4.7）。改推导规则必须升版本，
// 否则新旧事件的自然键对不上，去重与墓碑抑制会悄悄失效。
export const RELATION_ASSERTION_NATURAL_KEY_DERIVATION_VERSION = 1;

export const INTER_WORK_UNIT_RELATION_ASSERTION_LIFECYCLE_EVENT_KINDS = [
	"reference_relation_modeling_changes_applied_by_web_ui_user",
	// 变更创建并完成路由（d-confirm §8 的判定依据全部记在这条上）。
	"relation_affecting_confirmable_change_created_and_routed",
	// 变更生效：创建类 → 关系生效；撤销类 → 被撤销关系失效（撤销理由与墓碑四字段写在同一条事件里，Y-CONF-9）。
	"relation_affecting_confirmable_change_applied_and_effective",
	// 同自然键的关系已生效时的重断言：证据并集、标量属性替换，不新建关系（d-vocab §2.4；参照轴无风险相关属性，不走 M27）。
	"inter_work_unit_relation_reassertion_merged_into_already_effective_assertion",
	// 注入回执（d-confirm §3.5）：断言型关系随会话启动注入进某个会话；关系被撤销时据此知道该通知谁（修订通知在 2.3）。
	// 只在会话成功启动、且注入段确实进了本次启动之后记；按条记（每条关系一条事件），幂等键 = workspace + Kanban 会话 id
	// + relationId + 关系版本，同一会话重启不重复记。
	"effective_inter_work_unit_relation_assertions_injected_into_conversation_session",
] as const;
export type InterWorkUnitRelationAssertionLifecycleEventKind =
	(typeof INTER_WORK_UNIT_RELATION_ASSERTION_LIFECYCLE_EVENT_KINDS)[number];

// Y-CONF-6 的 9 种变更。2.1 只产出前一种的「断言创建」与第三种「撤销」。
export const RELATION_AFFECTING_CONFIRMABLE_CHANGE_KINDS = [
	"asserted_relation_or_work_unit_gate_creation",
	"effective_assertion_risk_relevant_attribute_amendment",
	"applied_asserted_relation_or_work_unit_gate_revocation",
	"relation_triggered_side_effect_execution_requiring_confirmation",
	"unary_requirement_obligation_outcome_declaration",
	"requirement_obligation_reopening",
	"requirement_items_dropped_without_any_holder_declaration",
	"extraction_run_activation_into_effect_after_sampled_preview",
	"extracted_historical_fact_record_acceptance_into_effect",
] as const;
export type RelationAffectingConfirmableChangeKind = (typeof RELATION_AFFECTING_CONFIRMABLE_CHANGE_KINDS)[number];

// d-confirm §2.1 的 6 种策略；数组顺序就是 R-upgrade 用的全序 S1 < S2 < S3 < S4 < S5 ≡ S6（§2.2）。
export const RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES = [
	"applied_immediately_without_user_review",
	"applied_immediately_with_time_boxed_user_veto_window",
	"applied_after_independent_automated_verification_passes_else_fallback",
	"pending_user_decision_then_applied_as_proposed_after_deadline",
	"pending_user_decision_then_lapsed_and_returned_to_proposer_after_deadline",
	"pending_until_explicit_user_decision_without_deadline",
] as const;
export type RelationAffectingConfirmableChangeConfirmationStrategy =
	(typeof RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES)[number];

export function isRelationAffectingConfirmableChangeConfirmationStrategy(
	value: string,
): value is RelationAffectingConfirmableChangeConfirmationStrategy {
	return (RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_STRATEGIES as readonly string[]).includes(value);
}

// 决策来源（d-confirm §4.2 + Y-CONF-7 新增的校准样本来源）。与「谁提的」（relationAsserter）是正交的两个字段。
export const RELATION_AFFECTING_CONFIRMABLE_CHANGE_DECISION_SOURCES = [
	"strategy_requires_no_user_review",
	"asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
	"user_decided_in_web_ui_with_verified_user_decision_nonce",
	"user_veto_window_elapsed_after_positive_presentation",
	"user_veto_window_elapsed_without_positive_presentation",
	"user_decision_deadline_elapsed_applied_as_proposed",
	"user_decision_deadline_elapsed_lapsed_and_returned_to_proposer",
	"independent_automated_verification_passed",
	"independent_automated_verification_passed_after_user_accepted_calibration_sample",
	"independent_automated_verification_rejected",
	"independent_automated_verification_inconclusive_escalated",
	"independent_verification_unavailable_degraded_to_explicit_user_decision",
	"revalidation_failed_at_application_time",
	"proposer_withdrew_before_decision",
	"policy_floor_tightened_while_pending",
	"displaced_by_higher_priority_pending_change",
] as const;
export type RelationAffectingConfirmableChangeDecisionSource =
	(typeof RELATION_AFFECTING_CONFIRMABLE_CHANGE_DECISION_SOURCES)[number];

// d-confirm §4.3：首版「用户显式同意」只有这两个取值；撤销权（Y-CONF-8 第一行）据此判定。
const USER_EXPLICIT_CONSENT_DECISION_SOURCES = new Set<string>([
	"asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
	"user_decided_in_web_ui_with_verified_user_decision_nonce",
]);

export function isUserExplicitConsentDecisionSource(decisionSource: string): boolean {
	return USER_EXPLICIT_CONSENT_DECISION_SOURCES.has(decisionSource);
}

// 生效之后被撤销也算「经用户或核验确认」：单方面声明区块（d-confirm §3.5）只收两类都不含的关系。
const USER_OR_VERIFIER_CONFIRMATION_DECISION_SOURCES = new Set<string>([
	...USER_EXPLICIT_CONSENT_DECISION_SOURCES,
	"independent_automated_verification_passed",
	"independent_automated_verification_passed_after_user_accepted_calibration_sample",
]);

export function isUserOrIndependentVerifierConfirmationDecisionSource(decisionSource: string): boolean {
	return USER_OR_VERIFIER_CONFIRMATION_DECISION_SOURCES.has(decisionSource);
}

// Y-CONF-8：撤销必须带理由。「自然结束」不留墓碑；「关系有误」按撤销方留墓碑（Y-CONF-9）。
export const RELATION_ASSERTION_REVOCATION_REASONS = ["relation_ended_naturally", "relation_was_incorrect"] as const;
export type RelationAssertionRevocationReason = (typeof RELATION_ASSERTION_REVOCATION_REASONS)[number];

// Y-CONF-9 墓碑的抑制范围：用户以「有误」撤销 → 所有提议方（Web UI 用户的直接断言永远不受抑制）；
// agent 以「有误」撤销自己的断言 → 只抑制抽取 / 建议类组件与同一提议方策略身份。
export const USER_REJECTION_SUPPRESSION_TOMBSTONE_SCOPES = [
	"all_relation_proposers_except_web_ui_user_direct_assertions",
	"extraction_or_suggestion_origin_proposers_and_same_proposer_policy_identity_only",
] as const;
export type UserRejectionSuppressionTombstoneScope = (typeof USER_REJECTION_SUPPRESSION_TOMBSTONE_SCOPES)[number];

// 两端的计划指纹（卡 = 当时 prompt 正文的 sha256，指纹不含标题；独立会话没有计划，为 null），每个指纹旁记下它属于
// 哪个端点工作单元键。比较一律按端点工作单元键对齐、不按主语 / 锚点位置：对称 kind 的自然键对端点排序，A→B 与 B→A
// 是同一条关系，按位置比会把 A 的指纹拿去和 B 的比。
export interface RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys {
	subjectEndpointWorkUnitKey: string;
	subjectEndpointPlanFingerprint: string | null;
	anchorEndpointWorkUnitKey: string;
	anchorEndpointPlanFingerprint: string | null;
}

// 墓碑四字段（Y-CONF-9）加两个用于判定的伴随字段；四字段写进撤销生效事件，关系库的墓碑表只是可重建的缓存。
export interface UserRejectionSuppressionTombstone {
	relationAssertionNaturalKey: string;
	// 被拒那一刻的证据锚点集合（规范化、去重、排序）及其哈希；新断言的锚点是它的子集 = 没有新证据。
	rejectedEvidenceAnchors: string[];
	rejectedEvidenceAnchorSetHash: string;
	// 被拒那一刻两端的计划指纹，按端点工作单元键对齐（见 RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys）。
	endpointPlanFingerprintsAtRejection: RelationEndpointPlanFingerprintsWithEndpointWorkUnitKeys;
	suppressionScope: UserRejectionSuppressionTombstoneScope;
	// 只对 agent 撤销自己断言的墓碑有意义：被抑制的「同一提议方策略身份」。
	suppressedRelationProposerPolicyIdentityKey: string | null;
}

// d-confirm §2.4 的呈现通道与提议方等待方式。2.1 只有 S1，结果只在 Relations 面板被动可见，提议方不等待。
export const RELATION_AFFECTING_CONFIRMABLE_CHANGE_USER_FACING_PRESENTATION_CHANNELS = [
	"card_detail_pending_relation_affecting_confirmable_change_banner",
	"global_pending_relation_affecting_confirmable_change_review_list",
	"batched_low_urgency_pending_change_digest",
	"notification_center_relation_decision_countdown_entry",
	"carried_with_next_user_message_to_affected_work_unit",
	"relations_panel_passive_display_only",
] as const;
export type RelationAffectingConfirmableChangeUserFacingPresentationChannel =
	(typeof RELATION_AFFECTING_CONFIRMABLE_CHANGE_USER_FACING_PRESENTATION_CHANNELS)[number];

export const PROPOSING_AGENT_WAIT_BEHAVIORS = [
	"proposing_agent_continues_without_waiting",
	"proposing_agent_yields_turn_until_decision_delivered",
] as const;
export type ProposingAgentWaitBehavior = (typeof PROPOSING_AGENT_WAIT_BEHAVIORS)[number];

// Y-CONF-2：提议方与对端的关系分类（4 个值）。2.1 开放的行（M1、R-revoke）不依赖它，记「未评估」及原因。
export const PROPOSER_RELATIVE_COUNTERPART_CLASSIFICATIONS = [
	"counterpart_is_proposer_itself",
	"counterpart_is_self_derived_from_proposer_pure_delegation_subtree",
	"counterpart_is_independent_of_proposer",
	"counterpart_classification_not_evaluated_because_matched_rows_do_not_depend_on_it",
] as const;
export type ProposerRelativeCounterpartClassification = (typeof PROPOSER_RELATIVE_COUNTERPART_CLASSIFICATIONS)[number];

// 2.1 之前写入面还没有的策略：选了就明确拒绝，绝不悄悄降成 S1（阶段 2 切片评估的硬约束）。
export const CONFIRMATION_STRATEGY_NOT_YET_AVAILABLE_IN_THIS_RUNTIME_ERROR_CODE =
	"confirmation_strategy_not_yet_available_in_this_runtime";
// 同自然键、证据锚点没有新增、两端计划指纹未变：被墓碑抑制（Y-CONF-9）。
export const RELATION_ASSERTION_SUPPRESSED_BY_USER_REJECTION_TOMBSTONE_ERROR_CODE =
	"relation_assertion_suppressed_by_user_rejection_tombstone";
