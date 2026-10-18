import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
	type AssertedInterWorkUnitRelation,
	isAssertedInterWorkUnitReferenceRelationKind,
} from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { InterWorkUnitRelationWorkUnitReference } from "../core/inter-work-unit-relation-ledger-event-contract";
import type {
	ApplyReferenceRelationModelingChangesRequest,
	ReferenceRelationModelingDraft,
} from "../core/work-unit-relation-modeling-api-contract";
import {
	buildRelationAssertionNaturalKey,
	normalizeRelationAssertionEvidenceAnchors,
	validateAndCompleteAssertedReferenceRelationKindSpecificAttributes,
	validateAssertedReferenceRelationEndpoints,
} from "./inter-work-unit-relation-assertion-write-planning";
import { buildInterWorkUnitRelationWorkUnitKey } from "./kanban-board-card-identity-projection-from-ledger-events";

export function planReferenceRelationModelingChanges(
	root: InterWorkUnitRelationWorkUnitReference,
	drafts: ReferenceRelationModelingDraft[],
	revocations: ApplyReferenceRelationModelingChangesRequest["relationRevocations"],
	existingRelations: AssertedInterWorkUnitRelation[],
	occurredAt: number,
) {
	const rootKey = buildInterWorkUnitRelationWorkUnitKey(root);
	const byId = new Map(existingRelations.map((relation) => [relation.relationId, relation]));
	const expectations: { relationId: string; assertedRelationStateVersion: number }[] = [];
	const relationsAfterChange: AssertedInterWorkUnitRelation[] = [];
	const consumedIds = new Set<string>();
	function revoke(relationId: string, version: number | null, reason: string) {
		const old = byId.get(relationId);
		if (
			!old ||
			old.assertionEffectivenessState !== "applied_and_effective" ||
			old.assertedRelationStateVersion !== version
		) {
			throw new TRPCError({ code: "CONFLICT", message: "关系已变化，请刷新后重新核对修改。" });
		}
		if (
			!isAssertedInterWorkUnitReferenceRelationKind(old.relationKind) ||
			![old.relationStatementSubjectWorkUnitRef, old.relationStatementAnchorWorkUnitRef].some(
				(ref) => buildInterWorkUnitRelationWorkUnitKey(ref) === rootKey,
			)
		) {
			throw new TRPCError({ code: "BAD_REQUEST", message: "只能修改与当前任务直接关联的参照关系。" });
		}
		if (consumedIds.has(relationId))
			throw new TRPCError({ code: "BAD_REQUEST", message: "同一关系不能在一批变更中修改两次。" });
		consumedIds.add(relationId);
		expectations.push({ relationId, assertedRelationStateVersion: old.assertedRelationStateVersion });
		relationsAfterChange.push({
			...old,
			assertionEffectivenessState: "revoked",
			assertedRelationStateVersion: old.assertedRelationStateVersion + 1,
			revokedAt: occurredAt,
			relationLastUpdatedAt: occurredAt,
			relationAssertionRevocationReason: reason,
			revokedByActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce",
		});
	}
	for (const revocation of revocations)
		revoke(
			revocation.relationId,
			revocation.expectedAssertedRelationStateVersion,
			revocation.relationAssertionRevocationReason,
		);
	for (const draft of drafts)
		if (draft.replacesRelationId)
			revoke(draft.replacesRelationId, draft.expectedAssertedRelationStateVersion, "superseded_by_user_revision");
	const naturalKeys = new Set(
		existingRelations
			.filter(
				(relation) =>
					relation.assertionEffectivenessState === "applied_and_effective" &&
					!consumedIds.has(relation.relationId),
			)
			.map((relation) => relation.relationAssertionNaturalKey),
	);
	for (const draft of drafts) {
		const endpoints = {
			relationKind: draft.relationKind,
			relationStatementSubjectWorkUnitRef: draft.currentTaskIsStatementSubject ? root : draft.counterpartWorkUnit,
			relationStatementAnchorWorkUnitRef: draft.currentTaskIsStatementSubject ? draft.counterpartWorkUnit : root,
		};
		const endpointValidation = validateAssertedReferenceRelationEndpoints(endpoints);
		const attributeValidation = validateAndCompleteAssertedReferenceRelationKindSpecificAttributes(draft);
		if (!endpointValidation.validationPassed || !attributeValidation.validationPassed)
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: !endpointValidation.validationPassed
					? endpointValidation.validationFailureMessage
					: !attributeValidation.validationPassed
						? attributeValidation.validationFailureMessage
						: "关系无效",
			});
		const naturalKey = buildRelationAssertionNaturalKey(endpoints);
		if (naturalKeys.has(naturalKey))
			throw new TRPCError({ code: "CONFLICT", message: "相同类型与方向的关系已存在，请编辑已有关系。" });
		naturalKeys.add(naturalKey);
		const decisionSource = "asserted_directly_by_user_in_web_ui_with_verified_user_decision_nonce";
		relationsAfterChange.push({
			...endpoints,
			relationId: `asserted-reference-relation-${randomUUID()}`,
			relationAssertionNaturalKey: naturalKey,
			assertionEffectivenessState: "applied_and_effective",
			assertedRelationStateVersion: 1,
			relationFirstEstablishedAt: occurredAt,
			relationLastUpdatedAt: occurredAt,
			relationAsserterActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce",
			relationAsserterWorkUnitRef: null,
			relationAsserterPolicyIdentityKey: "kanban_web_ui_user_with_verified_page_load_nonce",
			relationContributingAgentWorkUnitRefs: [],
			relationAssertionRationaleOneSentence: draft.relationAssertionRationaleOneSentence,
			relationAssertionEvidencePointers: normalizeRelationAssertionEvidenceAnchors(
				draft.relationAssertionEvidencePointers,
			),
			assertedRelationKindSpecificAttributes: attributeValidation.validatedValue,
			effectiveConfirmableChangeIdForCurrentAssertionState: `relation-modeling-change-${randomUUID()}`,
			effectiveConfirmableChangeDecisionSource: decisionSource,
			effectiveConfirmableChangeAppliedAt: occurredAt,
			decisionSourcesOfEffectiveAssertion: [decisionSource],
			reassertingActorKinds: [],
			revokedAt: null,
			relationAssertionRevocationReason: null,
			revokedByActorKind: null,
		});
	}
	return { expectations, relationsAfterChange };
}
