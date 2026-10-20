import { describe, expect, it } from "vitest";

import type { AssertedInterWorkUnitReferenceRelationKind } from "../../../src/core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { UserRejectionSuppressionTombstone } from "../../../src/core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	buildRelationAssertionNaturalKey,
	findUserRejectionSuppressionTombstoneSuppressingAssertion,
	hashRelationAssertionEvidenceAnchorSet,
	type InterWorkUnitRelationAssertionProposer,
	readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection,
} from "../../../src/inter-work-unit-relation-ledger/inter-work-unit-relation-assertion-write-planning";
import {
	buildInterWorkUnitRelationWorkUnitKey,
	createEmptyKanbanBoardCardIdentityProjectionState,
	type KanbanBoardCardIdentityProjectionState,
} from "../../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";

// Y-CONF-9 墓碑匹配：对称 kind 的自然键对端点排序，A→B 与 B→A 是同一条关系；墓碑里的两端计划指纹必须按端点工作单元键
// 对齐比较，而不是按断言时的主语 / 锚点位置，否则另一端 agent 反向重断言就能绕过用户的「关系有误」撤销。

const cardAInRepositoryA: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "ws-repository-a",
	taskId: "a0001",
	taskIncarnationCreatedAtEpochMs: 1_000,
};
const cardBInRepositoryB: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "ws-repository-b",
	taskId: "b0002",
	taskIncarnationCreatedAtEpochMs: 2_000,
};

const PROMPT_FINGERPRINT_OF_CARD_A = "sha256-prompt-of-card-a";
const PROMPT_FINGERPRINT_OF_CARD_B = "sha256-prompt-of-card-b";
const REJECTED_EVIDENCE_ANCHORS = ["docs/counterpart-api.md", "notes/shared-schema.md"];

function buildIdentityProjectionStateWithCardPromptFingerprints(
	promptFingerprintByCard: ReadonlyArray<[KanbanBoardCardWorkUnitQualifiedReference, string]>,
): KanbanBoardCardIdentityProjectionState {
	const identityProjectionState = createEmptyKanbanBoardCardIdentityProjectionState();
	for (const [card, promptFingerprint] of promptFingerprintByCard) {
		identityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.set(buildInterWorkUnitRelationWorkUnitKey(card), {
			kanbanBoardCard: card,
			kanbanBoardCardFirstObservationRoute: "board_state_baseline_at_live_capture_activation",
			firstObservedAt: 0,
			creationActor: null,
			creationOnBehalfOfInitiatingWorkUnit: null,
			currentFieldValueSha256ByFieldName: { prompt: promptFingerprint },
			lastKnownBoardColumnId: "in_progress",
			movedToTrashColumnAt: null,
			permanentlyRemovedFromBoardAt: null,
		});
	}
	return identityProjectionState;
}

function agentProposerActingFromCard(
	actingCard: KanbanBoardCardWorkUnitQualifiedReference,
	nativeConversationSessionId: string,
): InterWorkUnitRelationAssertionProposer {
	return {
		proposerKind: "acting_work_unit_via_kanban_cli",
		actingWorkUnit: actingCard,
		resolvedActorWithEventEnvelopeContext: {
			resolvedKanbanActor: {
				kanbanActorKind: "kanban_board_card_work_unit",
				actingKanbanBoardCardWorkUnit: actingCard,
			},
			actorNativeConversationSessionIdentity: {
				conversationSessionHostKanbanAgentId: "claude",
				nativeConversationSessionId,
			},
			actorKanbanTaskConversationSessionId: actingCard.taskId,
			actorRepositoryIdentityAtEventTime: null,
			invokingKanbanCliCodeVersion: "test",
		},
	};
}

// 与写入 API 撤销分支同一读法：墓碑指纹取被撤销关系当时的主语 / 锚点，经同一个按端点键对齐的读助手。
function buildTombstoneOfUserRejectingRelationAsIncorrect(input: {
	relationKind: AssertedInterWorkUnitReferenceRelationKind;
	rejectedRelationSubject: KanbanBoardCardWorkUnitQualifiedReference;
	rejectedRelationAnchor: KanbanBoardCardWorkUnitQualifiedReference;
	identityProjectionStateAtRejection: KanbanBoardCardIdentityProjectionState;
}): UserRejectionSuppressionTombstone {
	return {
		relationAssertionNaturalKey: buildRelationAssertionNaturalKey({
			relationKind: input.relationKind,
			relationStatementSubjectWorkUnitRef: input.rejectedRelationSubject,
			relationStatementAnchorWorkUnitRef: input.rejectedRelationAnchor,
		}),
		rejectedEvidenceAnchors: REJECTED_EVIDENCE_ANCHORS,
		rejectedEvidenceAnchorSetHash: hashRelationAssertionEvidenceAnchorSet(REJECTED_EVIDENCE_ANCHORS),
		endpointPlanFingerprintsAtRejection:
			readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection(
				input.identityProjectionStateAtRejection,
				input.rejectedRelationSubject,
				input.rejectedRelationAnchor,
			),
		suppressionScope: "all_relation_proposers_except_web_ui_user_direct_assertions",
		suppressedRelationProposerPolicyIdentityKey: null,
	};
}

function findTombstoneSuppressingReassertion(input: {
	tombstone: UserRejectionSuppressionTombstone;
	proposer: InterWorkUnitRelationAssertionProposer;
	reassertionSubject: KanbanBoardCardWorkUnitQualifiedReference;
	reassertionAnchor: KanbanBoardCardWorkUnitQualifiedReference;
	identityProjectionStateAtReassertion: KanbanBoardCardIdentityProjectionState;
	reassertionEvidenceAnchors?: string[];
}): UserRejectionSuppressionTombstone | null {
	return findUserRejectionSuppressionTombstoneSuppressingAssertion({
		userRejectionSuppressionTombstonesOfNaturalKey: [input.tombstone],
		proposer: input.proposer,
		normalizedProposedEvidenceAnchors: input.reassertionEvidenceAnchors ?? ["docs/counterpart-api.md"],
		proposedAssertionEndpointPlanFingerprints:
			readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection(
				input.identityProjectionStateAtReassertion,
				input.reassertionSubject,
				input.reassertionAnchor,
			),
	});
}

const identityProjectionStateWithUnchangedPrompts = buildIdentityProjectionStateWithCardPromptFingerprints([
	[cardAInRepositoryA, PROMPT_FINGERPRINT_OF_CARD_A],
	[cardBInRepositoryB, PROMPT_FINGERPRINT_OF_CARD_B],
]);

describe("symmetric relation user rejection suppression tombstone matching aligned by endpoint work unit key", () => {
	it("support 建议方同时受用户全局墓碑与 agent 的建议方抑制范围约束", () => {
		const tombstone = buildTombstoneOfUserRejectingRelationAsIncorrect({
			relationKind: "reference_is_generally_related_with",
			rejectedRelationSubject: cardAInRepositoryA,
			rejectedRelationAnchor: cardBInRepositoryB,
			identityProjectionStateAtRejection: identityProjectionStateWithUnchangedPrompts,
		});
		for (const scope of [
			"all_relation_proposers_except_web_ui_user_direct_assertions",
			"extraction_or_suggestion_origin_proposers_and_same_proposer_policy_identity_only",
		] as const) {
			const scoped = {
				...tombstone,
				suppressionScope: scope,
				suppressedRelationProposerPolicyIdentityKey: "original-agent",
			};
			expect(
				findTombstoneSuppressingReassertion({
					tombstone: scoped,
					proposer: { proposerKind: "runtime_task_indexing_support_unverified_reference" },
					reassertionSubject: cardAInRepositoryA,
					reassertionAnchor: cardBInRepositoryB,
					identityProjectionStateAtReassertion: identityProjectionStateWithUnchangedPrompts,
				}),
			).toBe(scoped);
		}
	});
	for (const symmetricRelationKind of [
		"reference_is_cross_repository_counterpart_with",
		"reference_is_generally_related_with",
	] as const) {
		describe(symmetricRelationKind, () => {
			const tombstoneOfUserRejectingAAssertingB = buildTombstoneOfUserRejectingRelationAsIncorrect({
				relationKind: symmetricRelationKind,
				rejectedRelationSubject: cardAInRepositoryA,
				rejectedRelationAnchor: cardBInRepositoryB,
				identityProjectionStateAtRejection: identityProjectionStateWithUnchangedPrompts,
			});

			it("treats the reversed assertion as the same natural key, so the caller fetches this tombstone for it", () => {
				expect(
					buildRelationAssertionNaturalKey({
						relationKind: symmetricRelationKind,
						relationStatementSubjectWorkUnitRef: cardBInRepositoryB,
						relationStatementAnchorWorkUnitRef: cardAInRepositoryA,
					}),
				).toBe(tombstoneOfUserRejectingAAssertingB.relationAssertionNaturalKey);
			});

			it("suppresses the other endpoint's reversed reassertion when there is no new evidence and neither prompt changed", () => {
				expect(
					findTombstoneSuppressingReassertion({
						tombstone: tombstoneOfUserRejectingAAssertingB,
						proposer: agentProposerActingFromCard(cardBInRepositoryB, "session-of-card-b"),
						reassertionSubject: cardBInRepositoryB,
						reassertionAnchor: cardAInRepositoryA,
						identityProjectionStateAtReassertion: identityProjectionStateWithUnchangedPrompts,
					}),
				).toBe(tombstoneOfUserRejectingAAssertingB);
			});

			it("still suppresses the original direction (unchanged behavior)", () => {
				expect(
					findTombstoneSuppressingReassertion({
						tombstone: tombstoneOfUserRejectingAAssertingB,
						proposer: agentProposerActingFromCard(cardAInRepositoryA, "session-of-card-a"),
						reassertionSubject: cardAInRepositoryA,
						reassertionAnchor: cardBInRepositoryB,
						identityProjectionStateAtReassertion: identityProjectionStateWithUnchangedPrompts,
					}),
				).toBe(tombstoneOfUserRejectingAAssertingB);
			});

			it("does not suppress the reversed reassertion once either endpoint's prompt was amended", () => {
				for (const [amendedCard, untouchedCard, untouchedPromptFingerprint] of [
					[cardAInRepositoryA, cardBInRepositoryB, PROMPT_FINGERPRINT_OF_CARD_B],
					[cardBInRepositoryB, cardAInRepositoryA, PROMPT_FINGERPRINT_OF_CARD_A],
				] as const) {
					const identityProjectionStateWithOnePromptAmended =
						buildIdentityProjectionStateWithCardPromptFingerprints([
							[amendedCard, "sha256-prompt-amended-after-rejection"],
							[untouchedCard, untouchedPromptFingerprint],
						]);
					expect(
						findTombstoneSuppressingReassertion({
							tombstone: tombstoneOfUserRejectingAAssertingB,
							proposer: agentProposerActingFromCard(cardBInRepositoryB, "session-of-card-b"),
							reassertionSubject: cardBInRepositoryB,
							reassertionAnchor: cardAInRepositoryA,
							identityProjectionStateAtReassertion: identityProjectionStateWithOnePromptAmended,
						}),
					).toBeNull();
				}
			});

			it("does not suppress the reversed reassertion when it brings new evidence", () => {
				expect(
					findTombstoneSuppressingReassertion({
						tombstone: tombstoneOfUserRejectingAAssertingB,
						proposer: agentProposerActingFromCard(cardBInRepositoryB, "session-of-card-b"),
						reassertionSubject: cardBInRepositoryB,
						reassertionAnchor: cardAInRepositoryA,
						identityProjectionStateAtReassertion: identityProjectionStateWithUnchangedPrompts,
						reassertionEvidenceAnchors: ["docs/counterpart-api.md", "notes/new-finding-after-rejection.md"],
					}),
				).toBeNull();
			});

			// 不能退化成「两端指纹无序比较」：两张卡的 prompt 各自改成了对方原来的正文，指纹集合不变，但每个端点都变了。
			it("does not mix endpoints up when the two prompts were swapped between the cards", () => {
				const identityProjectionStateWithPromptsSwappedBetweenCards =
					buildIdentityProjectionStateWithCardPromptFingerprints([
						[cardAInRepositoryA, PROMPT_FINGERPRINT_OF_CARD_B],
						[cardBInRepositoryB, PROMPT_FINGERPRINT_OF_CARD_A],
					]);
				for (const [reassertionSubject, reassertionAnchor] of [
					[cardAInRepositoryA, cardBInRepositoryB],
					[cardBInRepositoryB, cardAInRepositoryA],
				] as const) {
					expect(
						findTombstoneSuppressingReassertion({
							tombstone: tombstoneOfUserRejectingAAssertingB,
							proposer: agentProposerActingFromCard(reassertionSubject, "session-of-reasserting-card"),
							reassertionSubject,
							reassertionAnchor,
							identityProjectionStateAtReassertion: identityProjectionStateWithPromptsSwappedBetweenCards,
						}),
					).toBeNull();
				}
			});
		});
	}

	it("keeps directed kinds direction-sensitive: the reversed assertion is a different natural key, the same direction still matches", () => {
		const directedRelationKind = "reference_concerns_behavior_or_state_of" as const;
		const tombstoneOfDirectedRelation = buildTombstoneOfUserRejectingRelationAsIncorrect({
			relationKind: directedRelationKind,
			rejectedRelationSubject: cardAInRepositoryA,
			rejectedRelationAnchor: cardBInRepositoryB,
			identityProjectionStateAtRejection: identityProjectionStateWithUnchangedPrompts,
		});
		// 反向是另一条关系：调用方按自然键取墓碑，这块墓碑根本不会被拿来匹配反向断言。
		expect(
			buildRelationAssertionNaturalKey({
				relationKind: directedRelationKind,
				relationStatementSubjectWorkUnitRef: cardBInRepositoryB,
				relationStatementAnchorWorkUnitRef: cardAInRepositoryA,
			}),
		).not.toBe(tombstoneOfDirectedRelation.relationAssertionNaturalKey);
		expect(
			findTombstoneSuppressingReassertion({
				tombstone: tombstoneOfDirectedRelation,
				proposer: agentProposerActingFromCard(cardAInRepositoryA, "session-of-card-a"),
				reassertionSubject: cardAInRepositoryA,
				reassertionAnchor: cardBInRepositoryB,
				identityProjectionStateAtReassertion: identityProjectionStateWithUnchangedPrompts,
			}),
		).toBe(tombstoneOfDirectedRelation);
		expect(
			findTombstoneSuppressingReassertion({
				tombstone: tombstoneOfDirectedRelation,
				proposer: agentProposerActingFromCard(cardAInRepositoryA, "session-of-card-a"),
				reassertionSubject: cardAInRepositoryA,
				reassertionAnchor: cardBInRepositoryB,
				identityProjectionStateAtReassertion: buildIdentityProjectionStateWithCardPromptFingerprints([
					[cardAInRepositoryA, PROMPT_FINGERPRINT_OF_CARD_A],
					[cardBInRepositoryB, "sha256-prompt-amended-after-rejection"],
				]),
			}),
		).toBeNull();
	});
});
