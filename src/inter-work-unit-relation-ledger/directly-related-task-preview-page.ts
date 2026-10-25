import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitReferenceRelationKind,
} from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import type {
	InterWorkUnitRelationWorkUnitReference,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import type {
	DirectlyRelatedTaskRelationSummary,
	GetDirectlyRelatedTaskPreviewPageRequest,
	GetDirectlyRelatedTaskPreviewPageResponse,
} from "../core/work-unit-relation-read-api-contract";
import { buildInterWorkUnitRelationWorkUnitKey } from "./kanban-board-card-identity-projection-from-ledger-events";
import type { RecordedInterWorkUnitRelationProjectionReader } from "./recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
import type { WorkspaceRepositoryPathLookupByWorkspaceId } from "./work-unit-relation-neighborhood-summary-assembly";

const previewCursorSchema = z.object({
	subjectKey: z.string(),
	revision: z.string(),
	offset: z.number().int().nonnegative(),
});

export async function assembleDirectlyRelatedTaskPreviewPage(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	input: GetDirectlyRelatedTaskPreviewPageRequest,
	getWorkspacePathById: WorkspaceRepositoryPathLookupByWorkspaceId,
): Promise<GetDirectlyRelatedTaskPreviewPageResponse> {
	const state = reader.projectionState;
	const identities = state.kanbanBoardCardIdentityProjectionState;
	const subjectKey = buildInterWorkUnitRelationWorkUnitKey(input.task);
	if (!identities.projectionsByKanbanBoardCardWorkUnitKey.has(subjectKey)) {
		throw new TRPCError({ code: "NOT_FOUND", message: "账本尚未记录这张任务卡的身份，暂时无法查询关联。" });
	}
	const neighbors = new Map<
		string,
		{ task: KanbanBoardCardWorkUnitQualifiedReference; relations: DirectlyRelatedTaskRelationSummary[] }
	>();
	const standaloneSessionKeys = new Set<string>();
	const addRelation = (
		subject: InterWorkUnitRelationWorkUnitReference,
		anchor: InterWorkUnitRelationWorkUnitReference,
		summary: DirectlyRelatedTaskRelationSummary,
	) => {
		const neighbor = buildInterWorkUnitRelationWorkUnitKey(subject) === subjectKey ? anchor : subject;
		const key = buildInterWorkUnitRelationWorkUnitKey(neighbor);
		if (key === subjectKey) return;
		if (neighbor.workUnitType !== "kanban_board_card") {
			standaloneSessionKeys.add(key);
			return;
		}
		const entry = neighbors.get(key) ?? { task: neighbor, relations: [] };
		entry.relations.push(summary);
		neighbors.set(key, entry);
	};
	// 只走主体邻接索引，不克隆整条关系的 rationale / evidence，也不扫描无关工作单元。
	for (const id of state.recordedRelationIdsByWorkUnitKey.get(subjectKey) ?? []) {
		const relation = state.recordedRelationsByRelationId.get(id);
		if (!relation) continue;
		addRelation(relation.relationStatementSubjectWorkUnitRef, relation.relationStatementAnchorWorkUnitRef, {
			relationId: id,
			relationKind: relation.relationKind,
			relationClass: "recorded",
			directionFromPreviewSubject:
				buildInterWorkUnitRelationWorkUnitKey(relation.relationStatementSubjectWorkUnitRef) === subjectKey
					? "outgoing"
					: "incoming",
			mutedInPresentation: state.presentationMuteStateByRelationId.get(id)?.mutedInPresentationAt != null,
			assertionActorKind: null,
			assertionAsserterWorkUnitRef: null,
			assertionDecisionSources: [],
		});
	}
	const assertedState = state.assertedInterWorkUnitRelationProjectionState;
	for (const id of assertedState.assertedRelationIdsByWorkUnitKey.get(subjectKey) ?? []) {
		const relation = assertedState.assertedRelationsByRelationId.get(id);
		if (!relation || relation.assertionEffectivenessState !== "applied_and_effective") continue;
		const registryEntry =
			ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[
				relation.relationKind as AssertedInterWorkUnitReferenceRelationKind
			];
		addRelation(relation.relationStatementSubjectWorkUnitRef, relation.relationStatementAnchorWorkUnitRef, {
			relationId: id,
			relationKind: relation.relationKind,
			relationClass: "asserted",
			directionFromPreviewSubject:
				registryEntry?.relationEndpointSymmetry === "symmetric_unordered_endpoint_pair"
					? "symmetric"
					: buildInterWorkUnitRelationWorkUnitKey(relation.relationStatementSubjectWorkUnitRef) === subjectKey
						? "outgoing"
						: "incoming",
			mutedInPresentation: false,
			assertionActorKind: relation.relationAsserterActorKind,
			assertionAsserterWorkUnitRef: relation.relationAsserterWorkUnitRef,
			assertionDecisionSources: [...relation.decisionSourcesOfEffectiveAssertion],
		});
	}
	const entries = [...neighbors.entries()]
		.map(([key, neighbor]) => {
			const identity = identities.projectionsByKanbanBoardCardWorkUnitKey.get(key);
			return {
				key,
				...neighbor,
				identity,
				mutedOnly: neighbor.relations.every((relation) => relation.mutedInPresentation),
			};
		})
		.sort(
			(left, right) => Number(left.mutedOnly) - Number(right.mutedOnly) || left.key.localeCompare(right.key, "en"),
		);
	// 仅由这一跳的身份与可见摘要决定游标寿命，无关的全局账本事件不能让翻页失败。
	const neighborhoodRevision = createHash("sha256")
		.update(
			JSON.stringify([
				subjectKey,
				[...standaloneSessionKeys].sort(),
				entries.map((entry) => [
					entry.key,
					entry.relations.slice().sort((left, right) => left.relationId.localeCompare(right.relationId, "en")),
					entry.identity?.currentFieldValueSha256ByFieldName.title,
					entry.identity?.lastKnownBoardColumnId,
					entry.identity?.permanentlyRemovedFromBoardAt,
				]),
			]),
		)
		.digest("hex");
	let offset = 0;
	if (input.cursor) {
		let decoded: z.infer<typeof previewCursorSchema>;
		try {
			decoded = previewCursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
		} catch {
			throw new TRPCError({ code: "BAD_REQUEST", message: "关联任务分页游标无效。" });
		}
		if (
			decoded.subjectKey !== subjectKey ||
			decoded.revision !== neighborhoodRevision ||
			decoded.offset > entries.length
		) {
			throw new TRPCError({ code: "CONFLICT", message: "RELATED_TASK_PREVIEW_PAGE_EXPIRED" });
		}
		offset = decoded.offset;
	}
	const page = entries.slice(offset, offset + (input.pageSize ?? 20));
	const hashes = [
		...new Set(
			page
				.map((entry) => entry.identity?.currentFieldValueSha256ByFieldName.title)
				.filter((hash): hash is string => Boolean(hash)),
		),
	];
	const titleValues = hashes.length
		? await reader.readRetainedTaskCardFieldValuesBySha256(hashes)
		: new Map<string, unknown>();
	return {
		subjectTask: input.task,
		entries: page.map((entry) => {
			const titleHash = entry.identity?.currentFieldValueSha256ByFieldName.title;
			const title = titleHash ? titleValues.get(titleHash) : null;
			return {
				task: entry.task,
				title: typeof title === "string" ? title : null,
				workspaceRepositoryPath:
					getWorkspacePathById(entry.task.workspaceId) ??
					identities.workspaceRepositoryPathByWorkspaceIdObservedAtBaseline.get(entry.task.workspaceId) ??
					null,
				lastKnownBoardColumnId: entry.identity?.lastKnownBoardColumnId ?? null,
				permanentlyRemovedFromBoardAt: entry.identity?.permanentlyRemovedFromBoardAt ?? null,
				identityKnownToLedger: Boolean(entry.identity),
				mutedOnly: entry.mutedOnly,
				relations: entry.relations,
			};
		}),
		totalTaskCount: entries.length,
		mutedOnlyTaskCount: entries.filter((entry) => entry.mutedOnly).length,
		standaloneSessionCount: standaloneSessionKeys.size,
		neighborhoodRevision,
		nextCursor:
			offset + page.length < entries.length
				? Buffer.from(
						JSON.stringify({ subjectKey, revision: neighborhoodRevision, offset: offset + page.length }),
					).toString("base64url")
				: null,
	};
}
