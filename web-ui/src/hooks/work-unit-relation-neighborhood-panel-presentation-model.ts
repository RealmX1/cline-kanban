// dd2db 1b Relations 面板的展示模型（纯函数）：把 workUnit.getRelationNeighborhoodSummary 的响应整理成分区。
//
// 与 runtime 的文本渲染（src/inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-text-rendering.ts）
// 同一套规则，只是产出结构而不是文本：
// - 读法一律以主体视角成句：主体是关系陈述的 S 用正向读法，是 A 用反向读法（读法的规范来源是 kind 注册表）；
// - 分区顺序按注册表的 neighborhoodSummarySectionPriority；
// - 注册表标为默认不可见的 kind（派发控制、配置、生命周期）折叠成计数；
// - 被用户静音的关系移出常规分区，单独归进「已静音」组（面板默认收起该组）——不能彻底消失：
//   用户要看得见它、能取消静音；本版界面不认识的 kind 只计数，绝不静默吞掉。
// 读法短语逐字取注册表（英文），不在前端另造译文：译文表会和注册表漂移。

import {
	isRecordedInterWorkUnitRelationKind,
	RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type RecordedInterWorkUnitRelation,
	type RecordedInterWorkUnitRelationKind,
} from "@runtime-inter-work-unit-recorded-relation-projection-contract";
import type {
	GetRelationNeighborhoodSummaryResponse,
	WorkUnitDisplayEntry,
} from "@runtime-work-unit-relation-read-api-contract";

type InterWorkUnitRelationWorkUnitReference = WorkUnitDisplayEntry["workUnit"];

const VISIBLE_NEIGHBORHOOD_SECTION_TITLE_BY_SECTION_PRIORITY: Record<number, string> = {
	6: "来源",
	7: "需求修订",
};
const VISIBLE_NEIGHBORHOOD_SECTION_TITLE_FOR_UNTITLED_SECTION_PRIORITY = "其他关系";

// 卡片在 board 上的存续状态。trash 列在界面上叫 Done。
export type NeighborKanbanBoardCardPresenceOnBoardStatus =
	| "on_kanban_board"
	| "moved_to_done_trash_column"
	| "permanently_removed_from_kanban_board_tombstone";

export type NeighborKanbanBoardCardOpenInProjectAvailability =
	| { isNeighborKanbanBoardCardOpenable: true }
	| { isNeighborKanbanBoardCardOpenable: false; neighborKanbanBoardCardNotOpenableReason: string };

export type WorkUnitRelationNeighborPresentation =
	| {
			neighborWorkUnitType: "kanban_board_card";
			neighborWorkUnitKey: string;
			// runtime 组装的展示标签（含 id、workspace、状态后缀）；标题缺失时的兜底。
			neighborWorkUnitDisplayLabel: string;
			neighborKanbanBoardCardWorkspaceId: string;
			neighborKanbanBoardCardTaskId: string;
			neighborKanbanBoardCardTaskIncarnationCreatedAtEpochMs: number;
			neighborKanbanBoardCardWorkspaceRepositoryPath: string | null;
			neighborKanbanBoardCardCurrentTitle: string | null;
			neighborKanbanBoardCardWorkspaceDisplayName: string;
			isNeighborKanbanBoardCardInCurrentKanbanProject: boolean;
			neighborKanbanBoardCardPresenceOnBoardStatus: NeighborKanbanBoardCardPresenceOnBoardStatus;
			neighborKanbanBoardCardOpenInProjectAvailability: NeighborKanbanBoardCardOpenInProjectAvailability;
	  }
	| {
			neighborWorkUnitType: "kanban_unmanaged_standalone_agent_conversation_session";
			neighborWorkUnitKey: string;
			neighborWorkUnitDisplayLabel: string;
	  };

export interface WorkUnitRelationSentenceFromPanelSubjectPerspective {
	relationId: string;
	relationKind: RecordedInterWorkUnitRelationKind;
	// 面板主体在这条关系陈述里是 S（主语）还是 A（锚点）——决定用正向还是反向读法。
	panelSubjectRoleInRelationStatement: "relation_statement_subject" | "relation_statement_anchor";
	readingPhraseFromPanelSubjectPerspective: string;
	counterpartNeighbor: WorkUnitRelationNeighborPresentation;
	// Y-PHASE-12：这条来源关系是关系陈述主语那张卡的创建时主来源。
	isCreationTimePrimaryProvenanceOfRelationStatementSubjectCard: boolean;
	// 交互轴按事件种类累加的总次数；来源轴为 0。
	relationOccurrenceCountAcrossTaskMutationEventKinds: number;
	// 需求修订 / 配置变更涉及的卡片字段名（来自 kind 专有属性）。
	changedKanbanBoardCardFieldNames: string[];
	relationFirstEstablishedAt: number;
	relationLastUpdatedAt: number;
	// null = 未静音。
	relationMutedInPresentationAt: number | null;
}

export interface WorkUnitRelationNeighborhoodVisibleSection {
	neighborhoodSummarySectionPriority: number;
	neighborhoodSummarySectionTitle: string;
	relationSentences: WorkUnitRelationSentenceFromPanelSubjectPerspective[];
}

// 默认折叠的 kind：按「读法短语」聚成一组，只给计数；明细在面板里按需展开。
export interface WorkUnitRelationNeighborhoodCollapsedCountGroup {
	collapsedCountGroupKey: string;
	relationKind: RecordedInterWorkUnitRelationKind;
	readingPhraseFromPanelSubjectPerspective: string;
	collapsedRelationSentences: WorkUnitRelationSentenceFromPanelSubjectPerspective[];
}

export interface WorkUnitRelationNeighborhoodPanelPresentation {
	panelSubjectSelfReferenceInSentence: string;
	visibleSections: WorkUnitRelationNeighborhoodVisibleSection[];
	collapsedCountGroups: WorkUnitRelationNeighborhoodCollapsedCountGroup[];
	// 被用户静音的关系（不分 kind），按静音时间从新到旧。
	mutedInPresentationRelationSentences: WorkUnitRelationSentenceFromPanelSubjectPerspective[];
	unrecognizedRelationKindRelationCount: number;
	conversationSessionOwnershipConflictCount: number;
	// 账本里一条记录型关系都没有（含静音的）。只有读成功且为空才为 true——读失败走另一条状态，不会落到这里。
	hasNoRecordedRelationAtAll: boolean;
}

// null = 没有跨项目打开宿主（单测 / 独立挂载）：邻居只展示、不可点开。
export type KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel = ReadonlyMap<
	string,
	{ kanbanProjectName: string; isKanbanProjectAvailable: boolean }
> | null;

export function areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(
	left: InterWorkUnitRelationWorkUnitReference,
	right: InterWorkUnitRelationWorkUnitReference,
): boolean {
	if (left.workUnitType === "kanban_board_card" && right.workUnitType === "kanban_board_card") {
		return (
			left.workspaceId === right.workspaceId &&
			left.taskId === right.taskId &&
			left.taskIncarnationCreatedAtEpochMs === right.taskIncarnationCreatedAtEpochMs
		);
	}
	if (
		left.workUnitType === "kanban_unmanaged_standalone_agent_conversation_session" &&
		right.workUnitType === "kanban_unmanaged_standalone_agent_conversation_session"
	) {
		return (
			left.conversationSessionHostKanbanAgentId === right.conversationSessionHostKanbanAgentId &&
			left.nativeConversationSessionId === right.nativeConversationSessionId
		);
	}
	return false;
}

function readLastPathSegmentOfRepositoryPath(workspaceRepositoryPath: string | null): string | null {
	if (!workspaceRepositoryPath) {
		return null;
	}
	const pathSegments = workspaceRepositoryPath.split(/[\\/]+/u).filter((segment) => segment.length > 0);
	return pathSegments[pathSegments.length - 1] ?? null;
}

function resolveNeighborKanbanBoardCardPresenceOnBoardStatus(
	kanbanBoardCardIdentity: WorkUnitDisplayEntry["kanbanBoardCardIdentity"],
): NeighborKanbanBoardCardPresenceOnBoardStatus {
	if (kanbanBoardCardIdentity?.permanentlyRemovedFromBoardAt != null) {
		return "permanently_removed_from_kanban_board_tombstone";
	}
	// 与 runtime 展示标签同一判据：最后所在列是 trash。
	if (kanbanBoardCardIdentity?.lastKnownBoardColumnId === "trash") {
		return "moved_to_done_trash_column";
	}
	return "on_kanban_board";
}

function resolveNeighborKanbanBoardCardOpenInProjectAvailability(input: {
	neighborKanbanBoardCardWorkspaceId: string;
	neighborKanbanBoardCardPresenceOnBoardStatus: NeighborKanbanBoardCardPresenceOnBoardStatus;
	knownKanbanProjectByWorkspaceId: KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel;
}): NeighborKanbanBoardCardOpenInProjectAvailability {
	if (input.neighborKanbanBoardCardPresenceOnBoardStatus === "permanently_removed_from_kanban_board_tombstone") {
		return {
			isNeighborKanbanBoardCardOpenable: false,
			neighborKanbanBoardCardNotOpenableReason: "这张卡已被永久删除，只剩关系账本里的墓碑记录。",
		};
	}
	if (input.knownKanbanProjectByWorkspaceId === null) {
		return {
			isNeighborKanbanBoardCardOpenable: false,
			neighborKanbanBoardCardNotOpenableReason: "当前视图没有打开其他卡片的入口。",
		};
	}
	const knownKanbanProject = input.knownKanbanProjectByWorkspaceId.get(input.neighborKanbanBoardCardWorkspaceId);
	if (!knownKanbanProject) {
		return {
			isNeighborKanbanBoardCardOpenable: false,
			neighborKanbanBoardCardNotOpenableReason: "这张卡所在的项目不在当前 Kanban 的项目列表里。",
		};
	}
	if (!knownKanbanProject.isKanbanProjectAvailable) {
		return {
			isNeighborKanbanBoardCardOpenable: false,
			neighborKanbanBoardCardNotOpenableReason: "这张卡所在的项目当前不可用。",
		};
	}
	return { isNeighborKanbanBoardCardOpenable: true };
}

// 断言型关系的展示模型（work-unit-asserted-relation-neighborhood-presentation-model.ts）复用同一套邻居展示。
export function buildWorkUnitRelationNeighborPresentation(input: {
	neighborWorkUnit: InterWorkUnitRelationWorkUnitReference;
	neighborDisplayEntry: WorkUnitDisplayEntry | null;
	currentKanbanProjectWorkspaceId: string | null;
	knownKanbanProjectByWorkspaceId: KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel;
}): WorkUnitRelationNeighborPresentation {
	const { neighborWorkUnit, neighborDisplayEntry } = input;
	if (neighborWorkUnit.workUnitType === "kanban_unmanaged_standalone_agent_conversation_session") {
		return {
			neighborWorkUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
			neighborWorkUnitKey:
				neighborDisplayEntry?.workUnitKey ??
				`kanban_unmanaged_standalone_agent_conversation_session:${neighborWorkUnit.conversationSessionHostKanbanAgentId}:${neighborWorkUnit.nativeConversationSessionId}`,
			neighborWorkUnitDisplayLabel:
				neighborDisplayEntry?.workUnitDisplayLabel ??
				`standalone ${neighborWorkUnit.conversationSessionHostKanbanAgentId} session ${neighborWorkUnit.nativeConversationSessionId}`,
		};
	}
	const kanbanBoardCardIdentity = neighborDisplayEntry?.kanbanBoardCardIdentity ?? null;
	// 账本端点和 key 保留 canonical 身份；读卡、项目可用性和导航使用任务当前位置。
	const currentKanbanBoardCardReference = kanbanBoardCardIdentity?.kanbanBoardCard ?? neighborWorkUnit;
	const neighborKanbanBoardCardPresenceOnBoardStatus =
		resolveNeighborKanbanBoardCardPresenceOnBoardStatus(kanbanBoardCardIdentity);
	return {
		neighborWorkUnitType: "kanban_board_card",
		neighborWorkUnitKey:
			neighborDisplayEntry?.workUnitKey ??
			`kanban_board_card:${neighborWorkUnit.workspaceId}:${neighborWorkUnit.taskId}:${neighborWorkUnit.taskIncarnationCreatedAtEpochMs}`,
		neighborWorkUnitDisplayLabel:
			neighborDisplayEntry?.workUnitDisplayLabel ??
			`task ${neighborWorkUnit.taskId} [${neighborWorkUnit.workspaceId}]`,
		neighborKanbanBoardCardWorkspaceId: currentKanbanBoardCardReference.workspaceId,
		neighborKanbanBoardCardTaskId: currentKanbanBoardCardReference.taskId,
		neighborKanbanBoardCardTaskIncarnationCreatedAtEpochMs:
			currentKanbanBoardCardReference.taskIncarnationCreatedAtEpochMs,
		neighborKanbanBoardCardWorkspaceRepositoryPath: kanbanBoardCardIdentity?.workspaceRepositoryPath ?? null,
		neighborKanbanBoardCardCurrentTitle: kanbanBoardCardIdentity?.currentTitle ?? null,
		neighborKanbanBoardCardWorkspaceDisplayName:
			input.knownKanbanProjectByWorkspaceId?.get(currentKanbanBoardCardReference.workspaceId)?.kanbanProjectName ??
			readLastPathSegmentOfRepositoryPath(kanbanBoardCardIdentity?.workspaceRepositoryPath ?? null) ??
			currentKanbanBoardCardReference.workspaceId,
		isNeighborKanbanBoardCardInCurrentKanbanProject:
			input.currentKanbanProjectWorkspaceId !== null &&
			currentKanbanBoardCardReference.workspaceId === input.currentKanbanProjectWorkspaceId,
		neighborKanbanBoardCardPresenceOnBoardStatus,
		neighborKanbanBoardCardOpenInProjectAvailability: resolveNeighborKanbanBoardCardOpenInProjectAvailability({
			neighborKanbanBoardCardWorkspaceId: currentKanbanBoardCardReference.workspaceId,
			neighborKanbanBoardCardPresenceOnBoardStatus,
			knownKanbanProjectByWorkspaceId: input.knownKanbanProjectByWorkspaceId,
		}),
	};
}

function readChangedKanbanBoardCardFieldNamesFromRelation(relation: RecordedInterWorkUnitRelation): string[] {
	const changedFieldNames: string[] = [];
	for (const listAttributeName of ["amendedCardFieldNames", "changedExecutionConfigurationFieldNames"]) {
		const attributeValue = relation.recordedRelationKindSpecificAttributes[listAttributeName];
		if (Array.isArray(attributeValue)) {
			changedFieldNames.push(
				...attributeValue.filter((fieldName): fieldName is string => typeof fieldName === "string"),
			);
		}
	}
	return changedFieldNames;
}

// 区内排序：创建时主来源置顶，其余按最近更新从新到旧。
function compareRelationSentencesForDisplayOrder(
	left: WorkUnitRelationSentenceFromPanelSubjectPerspective,
	right: WorkUnitRelationSentenceFromPanelSubjectPerspective,
): number {
	if (
		left.isCreationTimePrimaryProvenanceOfRelationStatementSubjectCard !==
		right.isCreationTimePrimaryProvenanceOfRelationStatementSubjectCard
	) {
		return left.isCreationTimePrimaryProvenanceOfRelationStatementSubjectCard ? -1 : 1;
	}
	return right.relationLastUpdatedAt - left.relationLastUpdatedAt;
}

export function buildWorkUnitRelationNeighborhoodPanelPresentation(input: {
	relationNeighborhoodSummary: GetRelationNeighborhoodSummaryResponse;
	currentKanbanProjectWorkspaceId: string | null;
	knownKanbanProjectByWorkspaceId: KnownKanbanProjectByWorkspaceIdForRelationNeighborhoodPanel;
}): WorkUnitRelationNeighborhoodPanelPresentation {
	const { relationNeighborhoodSummary } = input;
	const panelSubjectWorkUnit = relationNeighborhoodSummary.subjectWorkUnit.workUnit;
	const visibleRelationSentencesBySectionPriority = new Map<
		number,
		WorkUnitRelationSentenceFromPanelSubjectPerspective[]
	>();
	const collapsedCountGroupsByKey = new Map<string, WorkUnitRelationNeighborhoodCollapsedCountGroup>();
	const mutedInPresentationRelationSentences: WorkUnitRelationSentenceFromPanelSubjectPerspective[] = [];
	let unrecognizedRelationKindRelationCount = 0;

	for (const relation of relationNeighborhoodSummary.recordedRelations) {
		const relationKind = relation.relationKind;
		if (!isRecordedInterWorkUnitRelationKind(relationKind)) {
			unrecognizedRelationKindRelationCount += 1;
			continue;
		}
		const relationKindRegistryEntry = RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind];
		const isPanelSubjectTheRelationStatementSubject = areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(
			relation.relationStatementSubjectWorkUnitRef,
			panelSubjectWorkUnit,
		);
		const counterpartWorkUnit = isPanelSubjectTheRelationStatementSubject
			? relation.relationStatementAnchorWorkUnitRef
			: relation.relationStatementSubjectWorkUnitRef;
		const counterpartDisplayEntry =
			relationNeighborhoodSummary.neighborWorkUnits.find((neighborDisplayEntry) =>
				areInterWorkUnitRelationWorkUnitReferencesSameWorkUnit(neighborDisplayEntry.workUnit, counterpartWorkUnit),
			) ?? null;
		const relationSentence: WorkUnitRelationSentenceFromPanelSubjectPerspective = {
			relationId: relation.relationId,
			relationKind,
			panelSubjectRoleInRelationStatement: isPanelSubjectTheRelationStatementSubject
				? "relation_statement_subject"
				: "relation_statement_anchor",
			readingPhraseFromPanelSubjectPerspective: isPanelSubjectTheRelationStatementSubject
				? relationKindRegistryEntry.forwardReadingPhraseFromSubject
				: relationKindRegistryEntry.inverseReadingPhraseFromAnchor,
			counterpartNeighbor: buildWorkUnitRelationNeighborPresentation({
				neighborWorkUnit: counterpartWorkUnit,
				neighborDisplayEntry: counterpartDisplayEntry,
				currentKanbanProjectWorkspaceId: input.currentKanbanProjectWorkspaceId,
				knownKanbanProjectByWorkspaceId: input.knownKanbanProjectByWorkspaceId,
			}),
			isCreationTimePrimaryProvenanceOfRelationStatementSubjectCard:
				relation.isCreationTimePrimaryProvenanceOfSubjectCard,
			relationOccurrenceCountAcrossTaskMutationEventKinds: Object.values(
				relation.occurrenceCountByTaskMutationEventKind,
			).reduce((total, occurrenceCount) => total + occurrenceCount, 0),
			changedKanbanBoardCardFieldNames: readChangedKanbanBoardCardFieldNamesFromRelation(relation),
			relationFirstEstablishedAt: relation.relationFirstEstablishedAt,
			relationLastUpdatedAt: relation.relationLastUpdatedAt,
			relationMutedInPresentationAt: relation.mutedInPresentationAt,
		};
		// 静音只隐藏展示：移出常规分区与折叠计数，归进「已静音」组，用户仍能看见并取消静音。
		if (relation.mutedInPresentationAt !== null) {
			mutedInPresentationRelationSentences.push(relationSentence);
			continue;
		}
		if (!relationKindRegistryEntry.defaultVisibleInNeighborhoodSummary) {
			const collapsedCountGroupKey = `${relationKind}:${relationSentence.panelSubjectRoleInRelationStatement}`;
			const collapsedCountGroup = collapsedCountGroupsByKey.get(collapsedCountGroupKey) ?? {
				collapsedCountGroupKey,
				relationKind,
				readingPhraseFromPanelSubjectPerspective: relationSentence.readingPhraseFromPanelSubjectPerspective,
				collapsedRelationSentences: [],
			};
			collapsedCountGroup.collapsedRelationSentences.push(relationSentence);
			collapsedCountGroupsByKey.set(collapsedCountGroupKey, collapsedCountGroup);
			continue;
		}
		const sectionPriority = relationKindRegistryEntry.neighborhoodSummarySectionPriority;
		const sectionRelationSentences = visibleRelationSentencesBySectionPriority.get(sectionPriority) ?? [];
		sectionRelationSentences.push(relationSentence);
		visibleRelationSentencesBySectionPriority.set(sectionPriority, sectionRelationSentences);
	}

	const visibleSections = [...visibleRelationSentencesBySectionPriority.entries()]
		.sort(([leftPriority], [rightPriority]) => leftPriority - rightPriority)
		.map(([neighborhoodSummarySectionPriority, relationSentences]) => ({
			neighborhoodSummarySectionPriority,
			neighborhoodSummarySectionTitle:
				VISIBLE_NEIGHBORHOOD_SECTION_TITLE_BY_SECTION_PRIORITY[neighborhoodSummarySectionPriority] ??
				VISIBLE_NEIGHBORHOOD_SECTION_TITLE_FOR_UNTITLED_SECTION_PRIORITY,
			relationSentences: [...relationSentences].sort(compareRelationSentencesForDisplayOrder),
		}));
	const collapsedCountGroups = [...collapsedCountGroupsByKey.values()].map((collapsedCountGroup) => ({
		...collapsedCountGroup,
		collapsedRelationSentences: [...collapsedCountGroup.collapsedRelationSentences].sort(
			compareRelationSentencesForDisplayOrder,
		),
	}));

	return {
		panelSubjectSelfReferenceInSentence:
			panelSubjectWorkUnit.workUnitType === "kanban_board_card" ? "This task" : "This standalone session",
		visibleSections,
		collapsedCountGroups,
		mutedInPresentationRelationSentences: [...mutedInPresentationRelationSentences].sort(
			(left, right) => (right.relationMutedInPresentationAt ?? 0) - (left.relationMutedInPresentationAt ?? 0),
		),
		unrecognizedRelationKindRelationCount,
		conversationSessionOwnershipConflictCount:
			relationNeighborhoodSummary.conversationSessionOwnershipConflictDiagnostics.length,
		hasNoRecordedRelationAtAll: relationNeighborhoodSummary.recordedRelations.length === 0,
	};
}
