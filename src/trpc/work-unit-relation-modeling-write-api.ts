import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type { UserRejectionSuppressionTombstone } from "../core/inter-work-unit-relation-assertion-lifecycle-event-contract";
import type {
	ApplyReferenceRelationModelingChangesRequest,
	ApplyReferenceRelationModelingChangesResponse,
} from "../core/work-unit-relation-modeling-api-contract";
import {
	buildInterWorkUnitRelationAssertionLifecycleEventDraft,
	hashRelationAssertionEvidenceAnchorSet,
	normalizeRelationAssertionEvidenceAnchors,
	readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection,
} from "../inter-work-unit-relation-ledger/inter-work-unit-relation-assertion-write-planning";
import {
	buildInterWorkUnitRelationWorkUnitKey,
	resolveCanonicalWorkUnitReferenceAfterProjectTransfer,
} from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { planReferenceRelationModelingChanges } from "../inter-work-unit-relation-ledger/reference-relation-modeling-change-planning";
import type { CreateWorkUnitRelationAssertionWriteApiDependencies } from "./work-unit-relation-assertion-write-api";
import { resolveWorkUnitSelectorAgainstRecordedRelationProjection } from "./work-unit-relation-read-api";

export async function applyReferenceRelationModelingChanges(
	deps: CreateWorkUnitRelationAssertionWriteApiDependencies,
	input: ApplyReferenceRelationModelingChangesRequest,
): Promise<ApplyReferenceRelationModelingChangesResponse> {
	return deps.readRecordedInterWorkUnitRelationProjection(async (reader) => {
		const state = reader.projectionState;
		input = {
			...input,
			referenceRelationDrafts: input.referenceRelationDrafts.map((draft) => ({
				...draft,
				counterpartWorkUnit: resolveCanonicalWorkUnitReferenceAfterProjectTransfer(
					state.kanbanBoardCardIdentityProjectionState,
					draft.counterpartWorkUnit,
				),
			})),
		};
		const root = resolveWorkUnitSelectorAgainstRecordedRelationProjection(state, input.workUnit);
		const rootKey = buildInterWorkUnitRelationWorkUnitKey(root);
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({ rootKey, drafts: input.referenceRelationDrafts, revocations: input.relationRevocations }),
			)
			.digest("hex");
		const idempotencyKey = `reference-relation-modeling:${rootKey}:${input.modelingSubmissionId}`;
		return deps.runInterWorkUnitRelationLedgerClientOperation(async (ledger, capturingKanbanRuntimeInstance) => {
			if (
				!ledger.commitReferenceRelationModelingChanges ||
				!ledger.readReferenceRelationModelingSubmissionFingerprint
			)
				throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "关系编辑服务尚未就绪。" });
			const previousFingerprint = await ledger.readReferenceRelationModelingSubmissionFingerprint(idempotencyKey);
			if (previousFingerprint !== null) {
				if (previousFingerprint !== fingerprint)
					throw new TRPCError({ code: "CONFLICT", message: "这次提交的内容已改变，请重新提交。" });
				return { modelingSubmissionId: input.modelingSubmissionId, alreadyApplied: true };
			}
			for (const endpoint of [root, ...input.referenceRelationDrafts.map((draft) => draft.counterpartWorkUnit)]) {
				if (endpoint.workUnitType !== "kanban_board_card") continue;
				const identity = state.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.get(
					buildInterWorkUnitRelationWorkUnitKey(endpoint),
				);
				if (!identity || identity.permanentlyRemovedFromBoardAt !== null)
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: "关联任务已删除或身份已变化，请重新选择。",
					});
			}
			const occurredAt = Date.now();
			const plan = planReferenceRelationModelingChanges(
				root,
				input.referenceRelationDrafts,
				input.relationRevocations,
				[...state.assertedInterWorkUnitRelationProjectionState.assertedRelationsByRelationId.values()],
				occurredAt,
			);
			const tombstones: UserRejectionSuppressionTombstone[] = plan.relationsAfterChange
				.filter((relation) => relation.relationAssertionRevocationReason === "relation_was_incorrect")
				.map((relation) => {
					const anchors = normalizeRelationAssertionEvidenceAnchors(relation.relationAssertionEvidencePointers);
					return {
						relationAssertionNaturalKey: relation.relationAssertionNaturalKey,
						rejectedEvidenceAnchors: anchors,
						rejectedEvidenceAnchorSetHash: hashRelationAssertionEvidenceAnchorSet(anchors),
						endpointPlanFingerprintsAtRejection:
							readRelationEndpointPlanFingerprintsWithEndpointWorkUnitKeysFromKanbanBoardCardIdentityProjection(
								state.kanbanBoardCardIdentityProjectionState,
								relation.relationStatementSubjectWorkUnitRef,
								relation.relationStatementAnchorWorkUnitRef,
							),
						suppressionScope: "all_relation_proposers_except_web_ui_user_direct_assertions",
						suppressedRelationProposerPolicyIdentityKey: null,
					};
				});
			const eventDraft = buildInterWorkUnitRelationAssertionLifecycleEventDraft({
				proposer: {
					proposerKind: "web_ui_user_with_verified_page_load_nonce",
					webUiUserDecisionClientCharacteristics: input.webUiUserDecisionClientCharacteristics,
				},
				eventKind: "reference_relation_modeling_changes_applied_by_web_ui_user",
				occurredAt,
				capturingKanbanRuntimeInstance,
				relationEndpoints: [root],
				eventPayload: {
					modelingSubmissionId: input.modelingSubmissionId,
					modelingSubmissionFingerprint: fingerprint,
					relationsAfterChange: plan.relationsAfterChange,
					userRejectionSuppressionTombstones: tombstones,
				},
			});
			eventDraft.idempotencyKey = idempotencyKey;
			const result = await ledger.commitReferenceRelationModelingChanges({ ...plan, eventDraft });
			if (result === "conflict")
				throw new TRPCError({ code: "CONFLICT", message: "关系已被其他操作修改，本批未保存。请刷新后核对草稿。" });
			return { modelingSubmissionId: input.modelingSubmissionId, alreadyApplied: result === "already_applied" };
		});
	});
}
