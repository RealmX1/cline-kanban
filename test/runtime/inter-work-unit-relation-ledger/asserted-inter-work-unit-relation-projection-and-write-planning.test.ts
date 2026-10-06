import { describe, expect, it } from "vitest";

import type { UserRejectionSuppressionTombstone } from "../../../src/core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import type {
	CommittedInterWorkUnitRelationLedgerEvent,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	applyInterWorkUnitRelationAssertionLifecycleEvent,
	createEmptyAssertedInterWorkUnitRelationProjectionState,
	listAssertedInterWorkUnitRelationsTouchingWorkUnit,
	listInjectionReceiptsOfAssertedInterWorkUnitRelation,
} from "../../../src/inter-work-unit-relation-ledger/asserted-inter-work-unit-relation-projection-from-ledger-events";
import {
	buildRelationAssertionNaturalKey,
	findUserRejectionSuppressionTombstoneSuppressingAssertion,
	type InterWorkUnitRelationAssertionProposer,
	validateAndCompleteAssertedReferenceRelationKindSpecificAttributes,
	validateAssertedReferenceRelationEndpoints,
} from "../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-assertion-write-planning";

const cardA: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "ws-a",
	taskId: "a0001",
	taskIncarnationCreatedAtEpochMs: 1_000,
};
const cardB: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "ws-a",
	taskId: "b0002",
	taskIncarnationCreatedAtEpochMs: 2_000,
};

function agentProposer(nativeConversationSessionId: string): InterWorkUnitRelationAssertionProposer {
	return {
		proposerKind: "acting_work_unit_via_kanban_cli",
		actingWorkUnit: cardA,
		resolvedActorWithEventEnvelopeContext: {
			resolvedKanbanActor: { kanbanActorKind: "kanban_board_card_work_unit", actingKanbanBoardCardWorkUnit: cardA },
			actorNativeConversationSessionIdentity: {
				conversationSessionHostKanbanAgentId: "claude",
				nativeConversationSessionId,
			},
			actorKanbanTaskConversationSessionId: "a0001",
			actorRepositoryIdentityAtEventTime: null,
			invokingKanbanCliCodeVersion: "test",
		},
	};
}

let nextGlobalCommittedEventSequence = 1;
function committedLifecycleEvent(
	eventKind: string,
	eventPayload: Record<string, unknown>,
	occurredAt: number,
): CommittedInterWorkUnitRelationLedgerEvent {
	const globalCommittedEventSequence = nextGlobalCommittedEventSequence++;
	return {
		eventId: `event-${globalCommittedEventSequence}`,
		globalCommittedEventSequence,
		recordedInSourceOfTruthEventLogAt: occurredAt,
		eventFamily: "inter_work_unit_relation_assertion_lifecycle_event",
		eventKind,
		occurredAt,
		actor: { kanbanActorKind: "kanban_board_card_work_unit", actingKanbanBoardCardWorkUnit: cardA },
		recordCaptureChannel: "live_runtime_capture",
		subjectWorkspaceId: "ws-a",
		subjectTaskId: "a0001",
		eventPayload,
	};
}

describe("asserted inter-work-unit relation projection from family-4 lifecycle events", () => {
	it("applies a created change, merges a reassertion, records injection receipts and drops a revoked relation from the neighborhood", () => {
		const state = createEmptyAssertedInterWorkUnitRelationProjectionState();
		const naturalKey = buildRelationAssertionNaturalKey({
			relationKind: "reference_verifies_claims_of",
			relationStatementSubjectWorkUnitRef: cardA,
			relationStatementAnchorWorkUnitRef: cardB,
		});
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedLifecycleEvent(
				"relation_affecting_confirmable_change_created_and_routed",
				{
					relationAffectingConfirmableChangeId: "change-1",
					relationAffectingConfirmableChangeKind: "asserted_relation_or_work_unit_gate_creation",
					relationProposerPolicyIdentityKey: "native_conversation_session:claude:session-a",
					relationProposerWorkUnitRef: cardA,
					proposedInterWorkUnitRelationAssertion: {
						relationId: "asserted-relation-1",
						relationKind: "reference_verifies_claims_of",
						relationStatementSubjectWorkUnitRef: cardA,
						relationStatementAnchorWorkUnitRef: cardB,
						relationAssertionNaturalKey: naturalKey,
						relationAssertionRationaleOneSentence: "A re-checks B's root cause analysis.",
						relationAssertionEvidencePointers: ["notes/a.md"],
						assertedRelationKindSpecificAttributes: {
							claimsUnderVerification: [{ claimSummary: "root cause is X", verificationVerdict: "pending" }],
						},
					},
				},
				10_000,
			),
		);
		// 生效之前不是资产：创建了但还没生效的变更不出现在邻域里。
		expect(listAssertedInterWorkUnitRelationsTouchingWorkUnit(state, cardB)).toEqual([]);
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedLifecycleEvent(
				"relation_affecting_confirmable_change_applied_and_effective",
				{
					relationAffectingConfirmableChangeId: "change-1",
					relationAffectingConfirmableChangeKind: "asserted_relation_or_work_unit_gate_creation",
					relationAffectingConfirmableChangeDecisionSource: "strategy_requires_no_user_review",
					assertedRelationStateVersionAfterApplication: 1,
				},
				10_000,
			),
		);
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedLifecycleEvent(
				"inter_work_unit_relation_reassertion_merged_into_already_effective_assertion",
				{
					mergedIntoEffectiveRelationId: "asserted-relation-1",
					reassertionDecisionSource: "asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
					reassertionEvidencePointers: ["notes/a.md", "notes/b.md"],
					reassertionKindSpecificAttributes: {
						claimsUnderVerification: [
							{ claimSummary: "root cause is X", verificationVerdict: "refuted" },
							{ claimSummary: "fix covers Y", verificationVerdict: "pending" },
						],
					},
					assertedRelationStateVersionAfterMerge: 2,
				},
				11_000,
			),
		);
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedLifecycleEvent(
				"effective_inter_work_unit_relation_assertions_injected_into_conversation_session",
				{
					injectedIntoKanbanTaskConversationSession: {
						workspaceId: "ws-a",
						kanbanTaskConversationSessionId: "b0002",
					},
					injectedAssertedRelations: [{ relationId: "asserted-relation-1", assertedRelationStateVersion: 2 }],
				},
				12_000,
			),
		);
		const [relation] = listAssertedInterWorkUnitRelationsTouchingWorkUnit(state, cardB);
		expect(relation).toMatchObject({
			relationId: "asserted-relation-1",
			assertionEffectivenessState: "applied_and_effective",
			assertedRelationStateVersion: 2,
			relationAsserterWorkUnitRef: cardA,
			relationAsserterPolicyIdentityKey: "native_conversation_session:claude:session-a",
			relationAssertionEvidencePointers: ["notes/a.md", "notes/b.md"],
			decisionSourcesOfEffectiveAssertion: [
				"strategy_requires_no_user_review",
				"asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
			],
			assertedRelationKindSpecificAttributes: {
				claimsUnderVerification: [
					{ claimSummary: "root cause is X", verificationVerdict: "refuted" },
					{ claimSummary: "fix covers Y", verificationVerdict: "pending" },
				],
			},
		});
		expect(listInjectionReceiptsOfAssertedInterWorkUnitRelation(state, "asserted-relation-1")).toEqual([
			expect.objectContaining({
				injectedIntoKanbanTaskConversationSessionId: "b0002",
				injectedAssertedRelationStateVersion: 2,
			}),
		]);
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedLifecycleEvent(
				"relation_affecting_confirmable_change_applied_and_effective",
				{
					relationAffectingConfirmableChangeId: "change-2",
					relationAffectingConfirmableChangeKind: "applied_asserted_relation_or_work_unit_gate_revocation",
					relationAffectingConfirmableChangeDecisionSource:
						"asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce",
					revokedRelationId: "asserted-relation-1",
					relationAssertionRevocationReason: "relation_was_incorrect",
					assertedRelationStateVersionAfterApplication: 3,
				},
				13_000,
			),
		);
		expect(listAssertedInterWorkUnitRelationsTouchingWorkUnit(state, cardA)).toEqual([]);
		expect(
			listAssertedInterWorkUnitRelationsTouchingWorkUnit(state, cardA, { includeRevokedAssertions: true }),
		).toEqual([
			expect.objectContaining({
				assertionEffectivenessState: "revoked",
				relationAssertionRevocationReason: "relation_was_incorrect",
				revokedAt: 13_000,
				assertedRelationStateVersion: 3,
			}),
		]);
		// 读不懂的事件跳过不抛错（账本只追加，新旧形状都要能读）。
		expect(() =>
			applyInterWorkUnitRelationAssertionLifecycleEvent(
				state,
				committedLifecycleEvent(
					"relation_affecting_confirmable_change_applied_and_effective",
					{ unexpected: true },
					14_000,
				),
			),
		).not.toThrow();
	});
});

describe("inter-work-unit relation assertion write planning", () => {
	it("derives the same natural key for both orientations of a symmetric kind but not of a directed kind", () => {
		const symmetric = (subject: typeof cardA, anchor: typeof cardA) =>
			buildRelationAssertionNaturalKey({
				relationKind: "reference_is_generally_related_with",
				relationStatementSubjectWorkUnitRef: subject,
				relationStatementAnchorWorkUnitRef: anchor,
			});
		const directed = (subject: typeof cardA, anchor: typeof cardA) =>
			buildRelationAssertionNaturalKey({
				relationKind: "reference_concerns_behavior_or_state_of",
				relationStatementSubjectWorkUnitRef: subject,
				relationStatementAnchorWorkUnitRef: anchor,
			});
		expect(symmetric(cardA, cardB)).toBe(symmetric(cardB, cardA));
		expect(directed(cardA, cardB)).not.toBe(directed(cardB, cardA));
		// incarnation 戳是端点身份的一部分：复用了 id 的另一世卡不是同一条关系。
		expect(directed(cardA, cardB)).not.toBe(directed(cardA, { ...cardB, taskIncarnationCreatedAtEpochMs: 9_000 }));
	});

	it("suppresses a reassertion only when no new evidence was added and neither card's requirements changed", () => {
		const tombstoneRejectedByUser: UserRejectionSuppressionTombstone = {
			relationAssertionNaturalKey: "natural-key",
			rejectedEvidenceAnchors: ["notes/a.md", "notes/b.md"],
			rejectedEvidenceAnchorSetHash: "hash",
			endpointPlanFingerprintsAtRejection: {
				subjectEndpointWorkUnitKey: "card-a",
				subjectEndpointPlanFingerprint: "prompt-a",
				anchorEndpointWorkUnitKey: "card-b",
				anchorEndpointPlanFingerprint: "prompt-b",
			},
			suppressionScope: "all_relation_proposers_except_web_ui_user_direct_assertions",
			suppressedRelationProposerPolicyIdentityKey: null,
		};
		const suppressing = (input: {
			proposer: InterWorkUnitRelationAssertionProposer;
			evidence: string[];
			subjectFingerprint?: string;
			tombstone?: UserRejectionSuppressionTombstone;
		}) =>
			findUserRejectionSuppressionTombstoneSuppressingAssertion({
				userRejectionSuppressionTombstonesOfNaturalKey: [input.tombstone ?? tombstoneRejectedByUser],
				proposer: input.proposer,
				normalizedProposedEvidenceAnchors: input.evidence,
				proposedAssertionEndpointPlanFingerprints: {
					subjectEndpointWorkUnitKey: "card-a",
					subjectEndpointPlanFingerprint: input.subjectFingerprint ?? "prompt-a",
					anchorEndpointWorkUnitKey: "card-b",
					anchorEndpointPlanFingerprint: "prompt-b",
				},
			});
		expect(suppressing({ proposer: agentProposer("session-a"), evidence: ["notes/a.md"] })).not.toBeNull();
		expect(suppressing({ proposer: agentProposer("session-a"), evidence: ["notes/c.md"] })).toBeNull();
		expect(
			suppressing({ proposer: agentProposer("session-a"), evidence: [], subjectFingerprint: "prompt-a-amended" }),
		).toBeNull();
		expect(
			suppressing({
				proposer: {
					proposerKind: "web_ui_user_with_verified_page_load_nonce",
					webUiUserDecisionClientCharacteristics: {
						triggeringDomEventIsTrusted: true,
						navigatorWebdriver: false,
						navigatorUserAgent: "test",
					},
				},
				evidence: [],
			}),
		).toBeNull();
		// agent 以「有误」撤销自己的断言：只抑制同一提议方策略身份（同一个原生会话）。
		const tombstoneRejectedByAgentItself: UserRejectionSuppressionTombstone = {
			...tombstoneRejectedByUser,
			suppressionScope: "extraction_or_suggestion_origin_proposers_and_same_proposer_policy_identity_only",
			suppressedRelationProposerPolicyIdentityKey: "native_conversation_session:claude:session-a",
		};
		expect(
			suppressing({ proposer: agentProposer("session-a"), evidence: [], tombstone: tombstoneRejectedByAgentItself }),
		).not.toBeNull();
		expect(
			suppressing({ proposer: agentProposer("session-b"), evidence: [], tombstone: tombstoneRejectedByAgentItself }),
		).toBeNull();
	});

	it("validates kind-specific attributes and endpoints against the registry", () => {
		expect(
			validateAndCompleteAssertedReferenceRelationKindSpecificAttributes({
				relationKind: "reference_concerns_behavior_or_state_of",
				assertedRelationKindSpecificAttributes: {},
				relationAssertionRationaleOneSentence: "why",
			}),
		).toMatchObject({ validationPassed: false });
		expect(
			validateAndCompleteAssertedReferenceRelationKindSpecificAttributes({
				relationKind: "reference_concerns_behavior_or_state_of",
				assertedRelationKindSpecificAttributes: { concernedAspectSummary: "resume path", reusedOutputSummary: "x" },
				relationAssertionRationaleOneSentence: "why",
			}),
		).toMatchObject({ validationPassed: false });
		expect(
			validateAndCompleteAssertedReferenceRelationKindSpecificAttributes({
				relationKind: "reference_reuses_produced_outputs_of",
				assertedRelationKindSpecificAttributes: { reusedOutputPointers: ["docs/handoff.md"] },
				relationAssertionRationaleOneSentence: "why",
			}),
		).toMatchObject({ validationPassed: true });
		expect(
			validateAndCompleteAssertedReferenceRelationKindSpecificAttributes({
				relationKind: "reference_is_generally_related_with",
				assertedRelationKindSpecificAttributes: {},
				relationAssertionRationaleOneSentence: "Both touch the resume path.",
			}),
		).toEqual({
			validationPassed: true,
			validatedValue: { relatednessRationaleOneSentence: "Both touch the resume path." },
		});
		expect(
			validateAssertedReferenceRelationEndpoints({
				relationKind: "reference_concerns_behavior_or_state_of",
				relationStatementSubjectWorkUnitRef: cardA,
				relationStatementAnchorWorkUnitRef: cardA,
			}),
		).toMatchObject({ validationPassed: false });
		expect(
			validateAssertedReferenceRelationEndpoints({
				relationKind: "reference_is_cross_repository_counterpart_with",
				relationStatementSubjectWorkUnitRef: cardA,
				relationStatementAnchorWorkUnitRef: cardB,
			}),
		).toMatchObject({ validationPassed: false });
		expect(
			validateAssertedReferenceRelationEndpoints({
				relationKind: "reference_requirement_originates_from",
				relationStatementSubjectWorkUnitRef: {
					workUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
					conversationSessionHostKanbanAgentId: "claude",
					nativeConversationSessionId: "standalone-session",
				},
				relationStatementAnchorWorkUnitRef: cardB,
			}),
		).toMatchObject({ validationPassed: false });
	});
});
