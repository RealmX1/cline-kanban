import { assertedInterWorkUnitRelationSchema } from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { InterWorkUnitRelationWorkUnitReference } from "../core/inter-work-unit-relation-ledger-event-contract";
import type {
	RelationModelingPreviewRequest,
	RelationModelingPreviewResponse,
} from "../core/work-unit-relation-modeling-api-contract";
import { buildInterWorkUnitRelationWorkUnitKey } from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import type { RecordedInterWorkUnitRelationProjectionReader } from "../inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
import { collectBoundedRelationModelingNeighborhood } from "../inter-work-unit-relation-ledger/relation-modeling-multi-hop-preview";
import {
	buildWorkUnitDisplayEntries,
	type WorkspaceRepositoryPathLookupByWorkspaceId,
} from "../inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-assembly";

export async function buildRelationModelingPreview(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	root: InterWorkUnitRelationWorkUnitReference | null,
	input: RelationModelingPreviewRequest,
	getWorkspacePathById: WorkspaceRepositoryPathLookupByWorkspaceId,
): Promise<RelationModelingPreviewResponse> {
	const state = reader.projectionState;
	const rootWorkUnitKey = root ? buildInterWorkUnitRelationWorkUnitKey(root) : "pending-task-creation";
	const refsByKey = new Map<string, InterWorkUnitRelationWorkUnitReference>();
	if (root) refsByKey.set(rootWorkUnitKey, root);
	const revocations = new Set(input.relationRevocations.map((entry) => entry.relationId));
	const replacements = new Set(input.referenceRelationDrafts.map((entry) => entry.replacesRelationId));
	const relations: RelationModelingPreviewResponse["relations"] = [];
	for (const relation of [
		...state.recordedRelationsByRelationId.values(),
		...state.assertedInterWorkUnitRelationProjectionState.assertedRelationsByRelationId.values(),
	]) {
		const parsedAssertion = assertedInterWorkUnitRelationSchema.safeParse(relation);
		const asserted = parsedAssertion.success;
		if (asserted && relation.assertionEffectivenessState !== "applied_and_effective") continue;
		if (!asserted && "mutedInPresentationAt" in relation && relation.mutedInPresentationAt !== null) continue;
		const subjectKey = buildInterWorkUnitRelationWorkUnitKey(relation.relationStatementSubjectWorkUnitRef);
		const anchorKey = buildInterWorkUnitRelationWorkUnitKey(relation.relationStatementAnchorWorkUnitRef);
		refsByKey.set(subjectKey, relation.relationStatementSubjectWorkUnitRef);
		refsByKey.set(anchorKey, relation.relationStatementAnchorWorkUnitRef);
		relations.push({
			relationId: relation.relationId,
			subjectKey,
			anchorKey,
			relationKind: relation.relationKind,
			relationPresentationState:
				revocations.has(relation.relationId) || replacements.has(relation.relationId)
					? "pending_revocation"
					: "saved",
			assertedRelation: parsedAssertion.success ? parsedAssertion.data : null,
		});
	}
	for (const draft of input.referenceRelationDrafts) {
		const counterpartKey = buildInterWorkUnitRelationWorkUnitKey(draft.counterpartWorkUnit);
		refsByKey.set(counterpartKey, draft.counterpartWorkUnit);
		relations.push({
			relationId: `draft:${draft.draftId}`,
			subjectKey: draft.currentTaskIsStatementSubject ? rootWorkUnitKey : counterpartKey,
			anchorKey: draft.currentTaskIsStatementSubject ? counterpartKey : rootWorkUnitKey,
			relationKind: draft.relationKind,
			relationPresentationState: draft.replacesRelationId ? "pending_revision" : "pending_addition",
			assertedRelation: null,
		});
	}
	// EXPERIMENT_NODE: 根据真实项目关系密度评估 150 节点与 300 条关系的预览上限。
	const neighborhood = collectBoundedRelationModelingNeighborhood(
		rootWorkUnitKey,
		relations,
		input.relationNeighborhoodDepth,
	);
	const selectedIds = new Set(neighborhood.relationIds);
	const selectedRefs = neighborhood.workUnitKeys.flatMap((key) => {
		const ref = refsByKey.get(key);
		return ref ? [ref] : [];
	});
	return {
		rootWorkUnitKey,
		workUnits: await buildWorkUnitDisplayEntries(reader, selectedRefs, getWorkspacePathById),
		relations: relations.filter((relation) => selectedIds.has(relation.relationId)),
		truncated: neighborhood.truncated,
		projectedThroughGlobalCommittedEventSequence: state.lastAppliedGlobalCommittedEventSequence,
	};
}
