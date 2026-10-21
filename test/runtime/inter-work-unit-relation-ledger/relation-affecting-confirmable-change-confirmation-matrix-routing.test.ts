import { describe, expect, it } from "vitest";

import {
	ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS,
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
} from "../../../src/core/inter-work-unit-asserted-relation-kind-registry-contract";
import { CONFIRMATION_STRATEGY_NOT_YET_AVAILABLE_IN_THIS_RUNTIME_ERROR_CODE } from "../../../src/core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import {
	CONFIRMATION_MATRIX_ROWS_BY_ROW_ID,
	classifyReferenceRelationAssertionIntoConfirmationMatrixRows,
	classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows,
	routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows,
} from "../../../src/inter-work-unit-relation-ledger/relation-affecting-confirmable-change-confirmation-matrix-routing";

describe("relation-affecting confirmable change routing through the confirmation authority rows", () => {
	it("routes an agent's own reference assertion through M1 with the row default S1 and records the decision basis", () => {
		const routing = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: classifyReferenceRelationAssertionIntoConfirmationMatrixRows({
				proposerIsOneOfTheRelationEndpoints: true,
			}),
			agentSelectedConfirmationStrategy: null,
			strategySelectionRationale: null,
		});
		expect(routing).toMatchObject({
			routingSucceeded: true,
			routingDecision: {
				matchedConfirmationAuthorityRowIds: ["M1"],
				effectiveConfirmationStrategy: "applied_immediately_without_user_review",
				defaultConfirmationStrategyOfMatchedRows: "applied_immediately_without_user_review",
				confirmationStrategyUpgradedByPolicyFloor: false,
				userFacingPresentationChannels: ["relations_panel_passive_display_only"],
				proposingAgentWaitBehavior: "proposing_agent_continues_without_waiting",
				confirmationPolicyVersion: 2,
			},
		});
	});

	it("never silently weakens a strategy this runtime does not offer yet, and asks for a rationale when deviating from the default", () => {
		const withoutRationale = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: ["M1"],
			agentSelectedConfirmationStrategy: "applied_immediately_with_time_boxed_user_veto_window",
			strategySelectionRationale: null,
		});
		expect(withoutRationale).toMatchObject({
			routingSucceeded: false,
			routingRefusalErrorCode: "strategy_selection_rationale_required_when_deviating_from_row_default",
		});
		const withRationale = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: ["M1"],
			agentSelectedConfirmationStrategy: "applied_immediately_with_time_boxed_user_veto_window",
			strategySelectionRationale: "The user should be able to veto this.",
		});
		expect(withRationale).toMatchObject({
			routingSucceeded: false,
			routingRefusalErrorCode: CONFIRMATION_STRATEGY_NOT_YET_AVAILABLE_IN_THIS_RUNTIME_ERROR_CODE,
		});
		// 提议方不是端点（M2）默认就是 S2：本 runtime 没有 S2，拒绝而不是退成 S1。
		const notAnEndpoint = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: classifyReferenceRelationAssertionIntoConfirmationMatrixRows({
				proposerIsOneOfTheRelationEndpoints: false,
			}),
			agentSelectedConfirmationStrategy: "applied_immediately_without_user_review",
			strategySelectionRationale: "try to bypass",
		});
		expect(notAnEndpoint).toMatchObject({ routingSucceeded: false });
		if (!notAnEndpoint.routingSucceeded) {
			expect(notAnEndpoint.partialRoutingDecision.matchedConfirmationAuthorityRowIds).toEqual(["M2"]);
			expect(notAnEndpoint.partialRoutingDecision.allowedConfirmationStrategiesOfMatchedRows).not.toContain(
				"applied_immediately_without_user_review",
			);
		}
	});

	it("upgrades a strategy outside the allowed set to the lowest allowed strategy ranked at or above it (R-upgrade)", () => {
		// 两行交集只剩 S6：选 S2 被上调到 S6（行默认也是 S6，不需要理由），本 runtime 没有 S6，于是如实拒绝并说出需要 S6。
		const routing = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows({
				revokedAssertionIncludesUserExplicitConsent: true,
				revokerIsOriginalAsserter: true,
			}),
			agentSelectedConfirmationStrategy: "applied_immediately_with_time_boxed_user_veto_window",
			strategySelectionRationale: null,
		});
		expect(routing).toMatchObject({
			routingSucceeded: false,
			routingRefusalErrorCode: CONFIRMATION_STRATEGY_NOT_YET_AVAILABLE_IN_THIS_RUNTIME_ERROR_CODE,
		});
		if (!routing.routingSucceeded) {
			expect(routing.routingRefusalMessage).toContain("pending_until_explicit_user_decision_without_deadline");
		}
		// 行还没开放（M4 属于 2.4a）时同样明确拒绝，不落到别的行。
		expect(
			routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
				matchedConfirmationAuthorityRowIds: ["M4"],
				agentSelectedConfirmationStrategy: null,
				strategySelectionRationale: null,
			}),
		).toMatchObject({
			routingSucceeded: false,
			routingRefusalErrorCode: "confirmation_authority_row_not_yet_opened_for_writes_in_this_runtime",
		});
	});

	it("intersects the allowed sets of every matched revocation row: revoking what the user agreed to needs the user", () => {
		const ownRevocation = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows({
				revokedAssertionIncludesUserExplicitConsent: false,
				revokerIsOriginalAsserter: true,
			}),
			agentSelectedConfirmationStrategy: null,
			strategySelectionRationale: null,
		});
		expect(ownRevocation).toMatchObject({
			routingSucceeded: true,
			routingDecision: { effectiveConfirmationStrategy: "applied_immediately_without_user_review" },
		});
		const revokingUserAgreedAssertion = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows({
				revokedAssertionIncludesUserExplicitConsent: true,
				revokerIsOriginalAsserter: true,
			}),
			agentSelectedConfirmationStrategy: null,
			strategySelectionRationale: null,
		});
		expect(revokingUserAgreedAssertion).toMatchObject({ routingSucceeded: false });
		if (!revokingUserAgreedAssertion.routingSucceeded) {
			expect(revokingUserAgreedAssertion.partialRoutingDecision.allowedConfirmationStrategiesOfMatchedRows).toEqual([
				"pending_until_explicit_user_decision_without_deadline",
			]);
		}
		const revokingSomeoneElsesAssertion = routeRelationAffectingConfirmableChangeThroughConfirmationAuthorityRows({
			matchedConfirmationAuthorityRowIds: classifyReferenceRelationAssertionRevocationIntoRevocationAuthorityRows({
				revokedAssertionIncludesUserExplicitConsent: false,
				revokerIsOriginalAsserter: false,
			}),
			agentSelectedConfirmationStrategy: null,
			strategySelectionRationale: null,
		});
		expect(revokingSomeoneElsesAssertion).toMatchObject({
			routingSucceeded: false,
			routingRefusalErrorCode: CONFIRMATION_STRATEGY_NOT_YET_AVAILABLE_IN_THIS_RUNTIME_ERROR_CODE,
		});
	});

	it("keeps S6 in every matrix row's allowed set (R-S6-always-allowed)", () => {
		for (const row of Object.values(CONFIRMATION_MATRIX_ROWS_BY_ROW_ID)) {
			expect(row.allowedConfirmationStrategies, row.confirmationAuthorityRowId).toContain(
				"pending_until_explicit_user_decision_without_deadline",
			);
			expect(row.allowedConfirmationStrategies, row.confirmationAuthorityRowId).toContain(
				row.defaultConfirmationStrategy,
			);
		}
	});
});

describe("asserted inter-work-unit relation kind registry", () => {
	it("follows the naming grammar: axis prefix, trailing preposition or _with for symmetric kinds, no thread-graph edge tokens", () => {
		for (const relationKind of ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS) {
			const registryEntry = ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind];
			expect(relationKind.startsWith(`${registryEntry.relationAxis}_`)).toBe(true);
			if (registryEntry.relationEndpointSymmetry === "symmetric_unordered_endpoint_pair") {
				expect(relationKind).toMatch(/_is_.+_with$/u);
				expect(registryEntry.forwardReadingPhraseFromSubject).toBe(registryEntry.inverseReadingPhraseFromAnchor);
			} else {
				expect(relationKind).toMatch(/_(by|of|on|from)$/u);
			}
			for (const forbiddenThreadGraphEdgeToken of [
				"continues",
				"forks_from",
				"returns_to",
				"draws_from",
				"concludes",
			]) {
				expect(`_${relationKind}_`).not.toContain(`_${forbiddenThreadGraphEdgeToken}_`);
			}
		}
	});

	it("locks the reading phrases that define relation direction", () => {
		expect(
			Object.fromEntries(
				ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS.map((relationKind) => [
					relationKind,
					[
						ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind].forwardReadingPhraseFromSubject,
						ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind].inverseReadingPhraseFromAnchor,
					],
				]),
			),
		).toEqual({
			reference_concerns_behavior_or_state_of: [
				"concerns the behavior or state of",
				"has its behavior or state concerned by",
			],
			reference_verifies_claims_of: ["verifies claims of", "has its claims verified by"],
			reference_reuses_produced_outputs_of: ["reuses produced outputs of", "has its produced outputs reused by"],
			reference_requirement_originates_from: ["has requirements that originate from", "originated requirements of"],
			reference_is_cross_repository_counterpart_with: [
				"is the cross-repository counterpart of",
				"is the cross-repository counterpart of",
			],
			reference_is_generally_related_with: ["is generally related with", "is generally related with"],
		});
	});
});
