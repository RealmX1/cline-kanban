// 仅供测试：dd2db 1b Relations 面板三份测试（展示模型 / hook / 组件）共用的响应构造器与一份标准邻域。
// 生产代码不得 import 本文件。

import type { RecordedInterWorkUnitRelation } from "@runtime-inter-work-unit-recorded-relation-projection-contract";
import type {
	GetRelationNeighborhoodSummaryResponse,
	WorkUnitDisplayEntry,
} from "@runtime-work-unit-relation-read-api-contract";
import { TRPCClientError } from "@trpc/client";

type InterWorkUnitRelationWorkUnitReference = WorkUnitDisplayEntry["workUnit"];

export const CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST = "workspace-current-project";
export const OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST = "workspace-other-project";

export function buildKanbanBoardCardDisplayEntryForTest(input: {
	workspaceId: string;
	taskId: string;
	currentTitle: string | null;
	lastKnownBoardColumnId?: string | null;
	permanentlyRemovedFromBoardAt?: number | null;
	workspaceRepositoryPath?: string | null;
}): WorkUnitDisplayEntry {
	const kanbanBoardCard = {
		workUnitType: "kanban_board_card" as const,
		workspaceId: input.workspaceId,
		taskId: input.taskId,
		taskIncarnationCreatedAtEpochMs: 1_000,
	};
	return {
		workUnitKey: `kanban_board_card:${input.workspaceId}:${input.taskId}:1000`,
		workUnit: kanbanBoardCard,
		workUnitDisplayLabel: `task ${input.taskId} [${input.workspaceId}]`,
		kanbanBoardCardIdentity: {
			kanbanBoardCard,
			workspaceRepositoryPath: input.workspaceRepositoryPath ?? `/repos/${input.workspaceId}-repository-checkout`,
			currentTitle: input.currentTitle,
			promptFirstParagraph: null,
			lastKnownBoardColumnId: input.lastKnownBoardColumnId ?? "in_progress",
			movedToTrashColumnAt: input.lastKnownBoardColumnId === "trash" ? 2_000 : null,
			permanentlyRemovedFromBoardAt: input.permanentlyRemovedFromBoardAt ?? null,
			creationActorKind: null,
			kanbanBoardCardFirstObservationRoute: "task_card_created_on_board_within_live_capture",
		},
	};
}

export function buildRecordedRelationForTest(input: {
	relationId: string;
	relationKind: string;
	relationStatementSubjectWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
	relationStatementAnchorWorkUnitRef: InterWorkUnitRelationWorkUnitReference;
	isCreationTimePrimaryProvenanceOfSubjectCard?: boolean;
	occurrenceCountByTaskMutationEventKind?: Record<string, number>;
	recordedRelationKindSpecificAttributes?: Record<string, unknown>;
	relationLastUpdatedAt?: number;
	mutedInPresentationAt?: number | null;
}): RecordedInterWorkUnitRelation {
	return {
		relationId: input.relationId,
		relationKind: input.relationKind,
		relationStatementSubjectWorkUnitRef: input.relationStatementSubjectWorkUnitRef,
		relationStatementAnchorWorkUnitRef: input.relationStatementAnchorWorkUnitRef,
		relationFirstEstablishedAt: 1_000,
		relationLastUpdatedAt: input.relationLastUpdatedAt ?? 3_000,
		mostRecentProjectedFromEventIds: [],
		captureChannelsOfDerivingEvents: ["live_runtime_capture"],
		occurrenceCountByTaskMutationEventKind: input.occurrenceCountByTaskMutationEventKind ?? {},
		recordedRelationKindSpecificAttributes: input.recordedRelationKindSpecificAttributes ?? {},
		isCreationTimePrimaryProvenanceOfSubjectCard: input.isCreationTimePrimaryProvenanceOfSubjectCard ?? false,
		mutedInPresentationAt: input.mutedInPresentationAt ?? null,
		mutedInPresentationByActorKind: input.mutedInPresentationAt
			? "kanban_web_ui_user_gesture_with_verified_page_load_nonce"
			: null,
	};
}

export function buildRelationNeighborhoodSummaryResponseForTest(input: {
	subjectWorkUnit: WorkUnitDisplayEntry;
	recordedRelations: RecordedInterWorkUnitRelation[];
	neighborWorkUnits: WorkUnitDisplayEntry[];
	conversationSessionOwnershipConflictCount?: number;
}): GetRelationNeighborhoodSummaryResponse {
	const subjectCard = input.subjectWorkUnit.workUnit;
	const conflictDiagnostic =
		subjectCard.workUnitType === "kanban_board_card"
			? {
					conversationSessionIdentityKey: {
						conversationSessionHostKanbanAgentId: "claude",
						nativeConversationSessionId: "session-shared",
					},
					currentOwningWorkUnit: subjectCard,
					previouslyOwningKanbanBoardCardObservedAgain: subjectCard,
					conflictObservedAt: 4_000,
					conflictObservedInEventId: "event-conflict",
				}
			: null;
	return {
		subjectWorkUnit: input.subjectWorkUnit,
		recordedRelations: input.recordedRelations,
		neighborWorkUnits: input.neighborWorkUnits,
		secondHopRecordedRelations: [],
		secondHopNeighborWorkUnits: [],
		conversationSessionOwnershipConflictDiagnostics: conflictDiagnostic
			? Array.from({ length: input.conversationSessionOwnershipConflictCount ?? 0 }, () => conflictDiagnostic)
			: [],
		renderedNeighborhoodSummaryText: "(rendered text not used by the panel)",
		hasAnyRelationVisibleByDefault: input.recordedRelations.length > 0,
		recordedInterWorkUnitRelationProjectionTableVersion: 1,
		projectedThroughGlobalCommittedEventSequence: 42,
	};
}

// 标准邻域：主体卡 + 三个邻居（跨项目在板 / 本项目 trash / 跨项目墓碑），覆盖正反读法、两个可见分区、
// 两组折叠计数、一条静音、一条本版不认识的 kind。
export const SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST = "abc12";
export const subjectKanbanBoardCardDisplayEntryForTest = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	taskId: SUBJECT_KANBAN_BOARD_CARD_TASK_ID_FOR_TEST,
	currentTitle: "Subject card",
});
export const creatorNeighborInOtherProjectDisplayEntryForTest = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	taskId: "def34",
	currentTitle: "Creator card in other project",
});
export const childNeighborInTrashOfCurrentProjectDisplayEntryForTest = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: CURRENT_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	taskId: "ghi56",
	currentTitle: "Child card in Done",
	lastKnownBoardColumnId: "trash",
});
export const amenderNeighborTombstoneDisplayEntryForTest = buildKanbanBoardCardDisplayEntryForTest({
	workspaceId: OTHER_KANBAN_PROJECT_WORKSPACE_ID_FOR_TEST,
	taskId: "jkl78",
	currentTitle: "Removed amender card",
	permanentlyRemovedFromBoardAt: 9_000,
});

export function buildStandardRelationNeighborhoodSummaryResponseForTest(): GetRelationNeighborhoodSummaryResponse {
	const subject = subjectKanbanBoardCardDisplayEntryForTest.workUnit;
	const creator = creatorNeighborInOtherProjectDisplayEntryForTest.workUnit;
	const child = childNeighborInTrashOfCurrentProjectDisplayEntryForTest.workUnit;
	const amender = amenderNeighborTombstoneDisplayEntryForTest.workUnit;
	return buildRelationNeighborhoodSummaryResponseForTest({
		subjectWorkUnit: subjectKanbanBoardCardDisplayEntryForTest,
		neighborWorkUnits: [
			creatorNeighborInOtherProjectDisplayEntryForTest,
			childNeighborInTrashOfCurrentProjectDisplayEntryForTest,
			amenderNeighborTombstoneDisplayEntryForTest,
		],
		recordedRelations: [
			// 主体是 A：反向读法 "created"。故意排在主来源前面，验证区内排序。
			buildRecordedRelationForTest({
				relationId: "relation-subject-created-child",
				relationKind: "provenance_created_by",
				relationStatementSubjectWorkUnitRef: child,
				relationStatementAnchorWorkUnitRef: subject,
				isCreationTimePrimaryProvenanceOfSubjectCard: true,
				relationLastUpdatedAt: 5_000,
			}),
			// 主体是 S：正向读法 "was created by"，且是主体卡的创建时主来源。
			buildRecordedRelationForTest({
				relationId: "relation-subject-created-by-creator",
				relationKind: "provenance_created_by",
				relationStatementSubjectWorkUnitRef: subject,
				relationStatementAnchorWorkUnitRef: creator,
				isCreationTimePrimaryProvenanceOfSubjectCard: true,
				relationLastUpdatedAt: 2_000,
			}),
			buildRecordedRelationForTest({
				relationId: "relation-subject-requirements-amended-by-tombstone",
				relationKind: "interaction_requirements_amended_by",
				relationStatementSubjectWorkUnitRef: subject,
				relationStatementAnchorWorkUnitRef: amender,
				occurrenceCountByTaskMutationEventKind: { task_card_fields_updated: 2 },
				recordedRelationKindSpecificAttributes: { amendedCardFieldNames: ["prompt", "title"] },
			}),
			buildRecordedRelationForTest({
				relationId: "relation-subject-lifecycle-transitioned-by-creator",
				relationKind: "interaction_board_lifecycle_transitioned_by",
				relationStatementSubjectWorkUnitRef: subject,
				relationStatementAnchorWorkUnitRef: creator,
				occurrenceCountByTaskMutationEventKind: { task_card_moved_between_columns: 1 },
			}),
			buildRecordedRelationForTest({
				relationId: "relation-subject-dispatched-child",
				relationKind: "interaction_agent_session_dispatched_or_controlled_by",
				relationStatementSubjectWorkUnitRef: child,
				relationStatementAnchorWorkUnitRef: subject,
				occurrenceCountByTaskMutationEventKind: { task_agent_session_started: 3 },
			}),
			buildRecordedRelationForTest({
				relationId: "relation-subject-forked-creator-muted",
				relationKind: "provenance_forked_conversation_session_of",
				relationStatementSubjectWorkUnitRef: subject,
				relationStatementAnchorWorkUnitRef: creator,
				mutedInPresentationAt: 6_000,
			}),
			buildRecordedRelationForTest({
				relationId: "relation-of-kind-unknown-to-this-web-ui",
				relationKind: "assertion_kind_added_in_a_later_projection_table_version",
				relationStatementSubjectWorkUnitRef: subject,
				relationStatementAnchorWorkUnitRef: creator,
			}),
		],
		conversationSessionOwnershipConflictCount: 1,
	});
}

export function buildEmptyRelationNeighborhoodSummaryResponseForTest(): GetRelationNeighborhoodSummaryResponse {
	return buildRelationNeighborhoodSummaryResponseForTest({
		subjectWorkUnit: subjectKanbanBoardCardDisplayEntryForTest,
		recordedRelations: [],
		neighborWorkUnits: [],
	});
}

export function buildTrpcClientErrorWithCodeForTest(trpcErrorCode: string, message: string): TRPCClientError<never> {
	return TRPCClientError.from({ error: { code: -32_000, message, data: { code: trpcErrorCode, httpStatus: 503 } } });
}
