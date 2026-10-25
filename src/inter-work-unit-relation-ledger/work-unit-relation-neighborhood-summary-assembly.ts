import type { InterWorkUnitRelationWorkUnitReference } from "../core/inter-work-unit-relation-ledger-event-contract";
import type {
	GetRelationNeighborhoodSummaryResponse,
	KanbanBoardCardIdentityResolutionCandidate,
	WorkUnitDisplayEntry,
} from "../core/work-unit-relation-read-api-contract";
import { listAssertedInterWorkUnitRelationsTouchingWorkUnit } from "./asserted-inter-work-unit-relation-projection-from-ledger-events";
import { listConversationSessionOwnershipConflictDiagnosticsTouchingWorkUnit } from "./conversation-session-ownership-period-projection-from-ledger-events";
import {
	buildInterWorkUnitRelationWorkUnitKey,
	type KanbanBoardCardIdentityProjection,
} from "./kanban-board-card-identity-projection-from-ledger-events";
import {
	listRecordedInterWorkUnitRelationsTouchingWorkUnit,
	RECORDED_INTER_WORK_UNIT_RELATION_PROJECTION_TABLE_VERSION,
} from "./recorded-inter-work-unit-relation-projection-from-ledger-events";
import type { RecordedInterWorkUnitRelationProjectionReader } from "./recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
import { renderWorkUnitRelationNeighborhoodSummaryText } from "./work-unit-relation-neighborhood-summary-text-rendering";

// dd2db 1b：从记录型关系投影组装「一个工作单元的一度邻域」与工作单元的展示条目。
// tRPC 读 API（`workUnit.*`）与会话启动注入共用这一份组装，两边看到的邻域逐字相同。

const DISPLAY_LABEL_TITLE_MAX_LENGTH = 80;
const PROMPT_FIRST_PARAGRAPH_MAX_LENGTH = 600;

export type WorkspaceRepositoryPathLookupByWorkspaceId = (workspaceId: string) => string | null;

function truncateWithEllipsis(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function extractPromptFirstParagraph(prompt: string): string | null {
	const firstParagraph = prompt
		.trim()
		.split(/\n\s*\n/u)[0]
		?.trim();
	return firstParagraph ? truncateWithEllipsis(firstParagraph, PROMPT_FIRST_PARAGRAPH_MAX_LENGTH) : null;
}

export async function buildKanbanBoardCardIdentityResolutionCandidates(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	projections: KanbanBoardCardIdentityProjection[],
	getWorkspacePathById: WorkspaceRepositoryPathLookupByWorkspaceId,
): Promise<KanbanBoardCardIdentityResolutionCandidate[]> {
	const fieldValueSha256s = projections.flatMap((projection) =>
		[
			projection.currentFieldValueSha256ByFieldName.title,
			projection.currentFieldValueSha256ByFieldName.prompt,
		].filter((sha256): sha256 is string => typeof sha256 === "string"),
	);
	const fieldValuesBySha256 = await reader.readRetainedTaskCardFieldValuesBySha256(fieldValueSha256s);
	const readTextField = (sha256: string | undefined): string | null => {
		const fieldValue = sha256 ? fieldValuesBySha256.get(sha256) : undefined;
		return typeof fieldValue === "string" ? fieldValue : null;
	};
	return projections.map((projection) => {
		const card = {
			...projection.kanbanBoardCard,
			workspaceId: projection.currentWorkspaceId ?? projection.kanbanBoardCard.workspaceId,
		};
		const prompt = readTextField(projection.currentFieldValueSha256ByFieldName.prompt);
		return {
			kanbanBoardCard: card,
			canonicalKanbanBoardCard: projection.kanbanBoardCard,
			previousWorkspaceRepositoryPaths: (projection.workspaceIdsUsedByCard ?? []).flatMap((workspaceId) => {
				const path =
					getWorkspacePathById(workspaceId) ??
					reader.projectionState.kanbanBoardCardIdentityProjectionState.workspaceRepositoryPathByWorkspaceIdObservedAtBaseline.get(
						workspaceId,
					);
				return path ? [path] : [];
			}),
			workspaceRepositoryPath:
				getWorkspacePathById(card.workspaceId) ??
				reader.projectionState.kanbanBoardCardIdentityProjectionState.workspaceRepositoryPathByWorkspaceIdObservedAtBaseline.get(
					card.workspaceId,
				) ??
				null,
			currentTitle: readTextField(projection.currentFieldValueSha256ByFieldName.title),
			promptFirstParagraph: prompt === null ? null : extractPromptFirstParagraph(prompt),
			lastKnownBoardColumnId: projection.lastKnownBoardColumnId,
			movedToTrashColumnAt: projection.movedToTrashColumnAt,
			permanentlyRemovedFromBoardAt: projection.permanentlyRemovedFromBoardAt,
			creationActorKind: projection.creationActor?.kanbanActorKind ?? null,
			kanbanBoardCardFirstObservationRoute: projection.kanbanBoardCardFirstObservationRoute,
		};
	});
}

function buildWorkUnitDisplayLabel(
	workUnit: InterWorkUnitRelationWorkUnitReference,
	kanbanBoardCardIdentity: KanbanBoardCardIdentityResolutionCandidate | null,
): string {
	if (workUnit.workUnitType === "kanban_unmanaged_standalone_agent_conversation_session") {
		return `standalone ${workUnit.conversationSessionHostKanbanAgentId} session ${workUnit.nativeConversationSessionId}`;
	}
	const title = kanbanBoardCardIdentity?.currentTitle
		? ` "${truncateWithEllipsis(kanbanBoardCardIdentity.currentTitle.replace(/\s+/gu, " "), DISPLAY_LABEL_TITLE_MAX_LENGTH)}"`
		: "";
	const statusSuffix =
		kanbanBoardCardIdentity?.permanentlyRemovedFromBoardAt != null
			? " (permanently removed)"
			: kanbanBoardCardIdentity?.lastKnownBoardColumnId === "trash"
				? " (in Done/trash)"
				: "";
	return `task ${workUnit.taskId}${title} [${kanbanBoardCardIdentity?.kanbanBoardCard.workspaceId ?? workUnit.workspaceId}]${statusSuffix}`;
}

export async function buildWorkUnitDisplayEntries(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	workUnits: InterWorkUnitRelationWorkUnitReference[],
	getWorkspacePathById: WorkspaceRepositoryPathLookupByWorkspaceId,
): Promise<WorkUnitDisplayEntry[]> {
	const cardProjections = workUnits
		.filter((workUnit) => workUnit.workUnitType === "kanban_board_card")
		.map((workUnit) =>
			reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.get(
				buildInterWorkUnitRelationWorkUnitKey(workUnit),
			),
		)
		.filter((projection): projection is KanbanBoardCardIdentityProjection => projection !== undefined);
	const identityByWorkUnitKey = new Map(
		(await buildKanbanBoardCardIdentityResolutionCandidates(reader, cardProjections, getWorkspacePathById)).map(
			(candidate) => [
				buildInterWorkUnitRelationWorkUnitKey(candidate.canonicalKanbanBoardCard ?? candidate.kanbanBoardCard),
				candidate,
			],
		),
	);
	return workUnits.map((workUnit) => {
		const workUnitKey = buildInterWorkUnitRelationWorkUnitKey(workUnit);
		const kanbanBoardCardIdentity = identityByWorkUnitKey.get(workUnitKey) ?? null;
		return {
			workUnitKey,
			workUnit,
			workUnitDisplayLabel: buildWorkUnitDisplayLabel(workUnit, kanbanBoardCardIdentity),
			kanbanBoardCardIdentity,
		};
	});
}

export async function assembleRecordedRelationNeighborhoodSummaryOfWorkUnit(
	reader: RecordedInterWorkUnitRelationProjectionReader,
	subjectWorkUnit: InterWorkUnitRelationWorkUnitReference,
	getWorkspacePathById: WorkspaceRepositoryPathLookupByWorkspaceId,
	relationNeighborhoodDepth: 1 | 2 = 1,
): Promise<GetRelationNeighborhoodSummaryResponse> {
	const projectionState = reader.projectionState;
	const subjectWorkUnitKey = buildInterWorkUnitRelationWorkUnitKey(subjectWorkUnit);
	const recordedRelations = listRecordedInterWorkUnitRelationsTouchingWorkUnit(projectionState, subjectWorkUnit);
	const assertedRelations = listAssertedInterWorkUnitRelationsTouchingWorkUnit(
		projectionState.assertedInterWorkUnitRelationProjectionState,
		subjectWorkUnit,
	);
	const collectCounterpartWorkUnits = (
		relations: readonly {
			relationStatementSubjectWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
			relationStatementAnchorWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
		}[],
		excludedWorkUnitKeys: Set<string>,
	): Map<string, InterWorkUnitRelationWorkUnitReference> => {
		const counterpartWorkUnitsByKey = new Map<string, InterWorkUnitRelationWorkUnitReference>();
		for (const relation of relations) {
			for (const endpoint of [
				relation.relationStatementSubjectWorkUnitRef,
				relation.relationStatementAnchorWorkUnitRef,
			]) {
				const endpointKey = buildInterWorkUnitRelationWorkUnitKey(endpoint);
				if (!excludedWorkUnitKeys.has(endpointKey)) {
					counterpartWorkUnitsByKey.set(endpointKey, endpoint);
				}
			}
		}
		return counterpartWorkUnitsByKey;
	};
	const neighborWorkUnitsByKey = collectCounterpartWorkUnits(
		[...recordedRelations, ...assertedRelations],
		new Set([subjectWorkUnitKey]),
	);
	// depth 2：一度邻居各自的关系里，不触及主体的那些（触及主体的已在一度里）；多出的端点就是二度邻居。
	// 二度只看记录型关系：断言型关系的二度展开等 2c 的邻域图一起做。
	const secondHopRecordedRelationsById = new Map<string, (typeof recordedRelations)[number]>();
	if (relationNeighborhoodDepth === 2) {
		for (const neighborWorkUnit of neighborWorkUnitsByKey.values()) {
			for (const relation of listRecordedInterWorkUnitRelationsTouchingWorkUnit(projectionState, neighborWorkUnit)) {
				const touchesSubject = [
					relation.relationStatementSubjectWorkUnitRef,
					relation.relationStatementAnchorWorkUnitRef,
				].some((endpoint) => buildInterWorkUnitRelationWorkUnitKey(endpoint) === subjectWorkUnitKey);
				if (!touchesSubject) {
					secondHopRecordedRelationsById.set(relation.relationId, relation);
				}
			}
		}
	}
	const secondHopRecordedRelations = [...secondHopRecordedRelationsById.values()];
	const secondHopNeighborWorkUnitsByKey = collectCounterpartWorkUnits(
		secondHopRecordedRelations,
		new Set([subjectWorkUnitKey, ...neighborWorkUnitsByKey.keys()]),
	);
	const neighborWorkUnitCount = neighborWorkUnitsByKey.size;
	const [subjectDisplayEntry, ...otherDisplayEntries] = await buildWorkUnitDisplayEntries(
		reader,
		[subjectWorkUnit, ...neighborWorkUnitsByKey.values(), ...secondHopNeighborWorkUnitsByKey.values()],
		getWorkspacePathById,
	);
	if (!subjectDisplayEntry) {
		throw new Error("Subject work unit display entry is missing.");
	}
	const neighborDisplayEntries = otherDisplayEntries.slice(0, neighborWorkUnitCount);
	const secondHopNeighborDisplayEntries = otherDisplayEntries.slice(neighborWorkUnitCount);
	const conversationSessionOwnershipConflictDiagnostics =
		listConversationSessionOwnershipConflictDiagnosticsTouchingWorkUnit(
			projectionState.conversationSessionOwnershipProjectionState,
			subjectWorkUnit,
		);
	const renderedSummary = renderWorkUnitRelationNeighborhoodSummaryText({
		subjectWorkUnit: subjectDisplayEntry,
		recordedRelations,
		assertedRelations,
		...(relationNeighborhoodDepth === 2 ? { secondHopRecordedRelations } : {}),
		workUnitDisplayLabelByWorkUnitKey: new Map(
			[subjectDisplayEntry, ...otherDisplayEntries].map((entry) => [entry.workUnitKey, entry.workUnitDisplayLabel]),
		),
		conversationSessionOwnershipConflictDiagnosticCount: conversationSessionOwnershipConflictDiagnostics.length,
	});
	return {
		subjectWorkUnit: subjectDisplayEntry,
		recordedRelations,
		assertedRelations,
		neighborWorkUnits: neighborDisplayEntries,
		secondHopRecordedRelations,
		secondHopNeighborWorkUnits: secondHopNeighborDisplayEntries,
		conversationSessionOwnershipConflictDiagnostics,
		renderedNeighborhoodSummaryText: renderedSummary.renderedNeighborhoodSummaryText,
		hasAnyRelationVisibleByDefault: renderedSummary.hasAnyRelationVisibleByDefault,
		recordedInterWorkUnitRelationProjectionTableVersion: RECORDED_INTER_WORK_UNIT_RELATION_PROJECTION_TABLE_VERSION,
		projectedThroughGlobalCommittedEventSequence: projectionState.lastAppliedGlobalCommittedEventSequence,
	};
}
