import { RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_POLICY_VERSION } from "../core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import type { RelationAffectingConfirmableChangeConfirmationRoutingDecision } from "./relation-affecting-confirmable-change-confirmation-matrix-routing";

/** 用户批准的 support 专用授权；没有修改通用 M2，也不声称已获用户确认。仅由 runtime 内部参照写入口调用。 */
export function buildTaskIndexingSupportUnverifiedReferenceRoutingDecision(): RelationAffectingConfirmableChangeConfirmationRoutingDecision {
	return {
		confirmationRoutingKind: "routed_through_confirmation_authority_rows",
		confirmationPolicyVersion: RELATION_AFFECTING_CONFIRMABLE_CHANGE_CONFIRMATION_POLICY_VERSION,
		matchedConfirmationAuthorityRowIds: ["M2_TASK_INDEXING_SUPPORT_UNVERIFIED_REFERENCE_ONLY"],
		appliedConfirmationPolicyModifierRuleIds: ["task_indexing_support_reference_only_no_obligation_side_effects"],
		allowedConfirmationStrategiesOfMatchedRows: ["applied_immediately_without_user_review"],
		defaultConfirmationStrategyOfMatchedRows: "applied_immediately_without_user_review",
		agentSelectedConfirmationStrategy: null,
		strategySelectionRationale: null,
		effectiveConfirmationStrategy: "applied_immediately_without_user_review",
		confirmationStrategyUpgradedByPolicyFloor: false,
		automaticallyDerivedRiskLabels: ["unverified_support_agent_reference_claim"],
		deadlineClockStartRule: null,
		confirmationDecisionDeadlineAt: null,
		userFacingPresentationChannels: ["relations_panel_passive_display_only"],
		proposingAgentWaitBehavior: "proposing_agent_continues_without_waiting",
		proposerRelativeCounterpartClassification: "counterpart_is_independent_of_proposer",
	};
}
