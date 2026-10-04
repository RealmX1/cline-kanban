import {
	isRecordedInterWorkUnitRelationKind,
	RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type RecordedInterWorkUnitRelation,
} from "../core/inter-work-unit-recorded-relation-projection-contract";
import type {
	AgentConversationSessionIdentityKey,
	InterWorkUnitRelationWorkUnitReference,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import type { WorkUnitDisplayEntry } from "../core/work-unit-relation-read-api-contract";
import { buildInterWorkUnitRelationWorkUnitKey } from "./kanban-board-card-identity-projection-from-ledger-events";

// dd2db 1b：邻域摘要的文本渲染（给 agent 读：CLI 默认输出与会话启动注入共用这一份）。
// 一律以主体视角成句——主体是 S 用正向读法、是 A 用反向读法（读法的规范来源是 kind 注册表，d-vocab §1.1）；
// 分区顺序按注册表的 neighborhoodSummarySectionPriority；派发控制、配置、生命周期默认折叠成计数（d-vocab §10）。

const NEIGHBORHOOD_SUMMARY_SECTION_TITLE_BY_PRIORITY: Record<number, string> = {
	6: "Provenance",
	7: "Requirements amendments",
};

function formatEpochMsAsUtcMinute(epochMs: number): string {
	return `${new Date(epochMs).toISOString().slice(0, 16)}Z`;
}

function abbreviateNativeConversationSessionIdentity(identityKey: unknown): string {
	if (typeof identityKey !== "object" || identityKey === null) {
		return "unknown session";
	}
	const { conversationSessionHostKanbanAgentId, nativeConversationSessionId } =
		identityKey as Partial<AgentConversationSessionIdentityKey>;
	if (typeof conversationSessionHostKanbanAgentId !== "string" || typeof nativeConversationSessionId !== "string") {
		return "unknown session";
	}
	return `${conversationSessionHostKanbanAgentId} session ${nativeConversationSessionId}`;
}

function renderRelationDetails(relation: RecordedInterWorkUnitRelation): string {
	const attributes = relation.recordedRelationKindSpecificAttributes;
	const details: string[] = [];
	const occurrenceCount = Object.values(relation.occurrenceCountByTaskMutationEventKind).reduce(
		(total, count) => total + count,
		0,
	);
	if (occurrenceCount > 0) {
		details.push(`${occurrenceCount} time${occurrenceCount === 1 ? "" : "s"}`);
	}
	for (const listAttributeName of ["amendedCardFieldNames", "changedExecutionConfigurationFieldNames"]) {
		const fieldNames = attributes[listAttributeName];
		if (Array.isArray(fieldNames) && fieldNames.length > 0) {
			details.push(`fields: ${fieldNames.join(", ")}`);
		}
	}
	if (relation.relationKind === "provenance_forked_conversation_session_of") {
		details.push(
			`source: ${abbreviateNativeConversationSessionIdentity(attributes.forkedFromNativeConversationSessionIdentity)}`,
		);
		if (attributes.forkedIntoNativeConversationSessionIdentity === null) {
			details.push("forked-into session id not observed");
		}
	}
	if (relation.relationKind === "provenance_resumed_and_adopted_conversation_session_of") {
		details.push(
			`adopted: ${abbreviateNativeConversationSessionIdentity(attributes.adoptedNativeConversationSessionIdentity)}`,
		);
	}
	details.push(
		relation.relationFirstEstablishedAt === relation.relationLastUpdatedAt
			? formatEpochMsAsUtcMinute(relation.relationFirstEstablishedAt)
			: `${formatEpochMsAsUtcMinute(relation.relationFirstEstablishedAt)} → last ${formatEpochMsAsUtcMinute(relation.relationLastUpdatedAt)}`,
	);
	return details.join("; ");
}

export interface RenderedWorkUnitRelationNeighborhoodSummary {
	renderedNeighborhoodSummaryText: string;
	hasAnyRelationVisibleByDefault: boolean;
}

// depth 2 的二度行：以一度邻居为主语成句，只列默认可见、未静音的关系，其余只计数。
function renderSecondHopNeighborhoodLines(input: {
	firstHopNeighborWorkUnitKeys: Set<string>;
	secondHopRecordedRelations: RecordedInterWorkUnitRelation[];
	labelOf: (workUnit: InterWorkUnitRelationWorkUnitReference) => string;
}): string[] {
	const lines: string[] = [];
	let collapsedOrMutedSecondHopRelationCount = 0;
	for (const relation of input.secondHopRecordedRelations) {
		if (!isRecordedInterWorkUnitRelationKind(relation.relationKind)) {
			continue;
		}
		const registryEntry = RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relation.relationKind];
		if (!registryEntry.defaultVisibleInNeighborhoodSummary || relation.mutedInPresentationAt !== null) {
			collapsedOrMutedSecondHopRelationCount += 1;
			continue;
		}
		const viaRelationSubject = input.firstHopNeighborWorkUnitKeys.has(
			buildInterWorkUnitRelationWorkUnitKey(relation.relationStatementSubjectWorkUnitRef),
		);
		const [viaWorkUnit, readingPhrase, counterpartWorkUnit] = viaRelationSubject
			? [
					relation.relationStatementSubjectWorkUnitRef,
					registryEntry.forwardReadingPhraseFromSubject,
					relation.relationStatementAnchorWorkUnitRef,
				]
			: [
					relation.relationStatementAnchorWorkUnitRef,
					registryEntry.inverseReadingPhraseFromAnchor,
					relation.relationStatementSubjectWorkUnitRef,
				];
		lines.push(`- ${input.labelOf(viaWorkUnit)} ${readingPhrase} ${input.labelOf(counterpartWorkUnit)}`);
	}
	if (collapsedOrMutedSecondHopRelationCount > 0) {
		lines.push(`- (${collapsedOrMutedSecondHopRelationCount} collapsed or muted two-hop relation(s) not listed)`);
	}
	return lines.length > 0 ? ["## Two hops away", ...lines] : [];
}

export function renderWorkUnitRelationNeighborhoodSummaryText(input: {
	subjectWorkUnit: WorkUnitDisplayEntry;
	recordedRelations: RecordedInterWorkUnitRelation[];
	// 只在 depth 2 时传入：一度邻居各自的、不触及主体的关系。
	secondHopRecordedRelations?: RecordedInterWorkUnitRelation[];
	workUnitDisplayLabelByWorkUnitKey: Map<string, string>;
	conversationSessionOwnershipConflictDiagnosticCount: number;
}): RenderedWorkUnitRelationNeighborhoodSummary {
	const subjectWorkUnitKey = input.subjectWorkUnit.workUnitKey;
	const subjectSelfReference =
		input.subjectWorkUnit.workUnit.workUnitType === "kanban_board_card" ? "This task" : "This standalone session";
	const labelOf = (workUnit: InterWorkUnitRelationWorkUnitReference): string =>
		input.workUnitDisplayLabelByWorkUnitKey.get(buildInterWorkUnitRelationWorkUnitKey(workUnit)) ??
		buildInterWorkUnitRelationWorkUnitKey(workUnit);
	const visibleLinesBySectionPriority = new Map<number, string[]>();
	const collapsedRelationCountByPhrase = new Map<string, number>();
	const firstHopNeighborWorkUnitKeys = new Set<string>();
	let mutedRelationCount = 0;
	for (const relation of input.recordedRelations) {
		if (!isRecordedInterWorkUnitRelationKind(relation.relationKind)) {
			continue;
		}
		for (const endpoint of [
			relation.relationStatementSubjectWorkUnitRef,
			relation.relationStatementAnchorWorkUnitRef,
		]) {
			const endpointKey = buildInterWorkUnitRelationWorkUnitKey(endpoint);
			if (endpointKey !== subjectWorkUnitKey) {
				firstHopNeighborWorkUnitKeys.add(endpointKey);
			}
		}
		// 静音只隐藏展示：不列出，但计数，绝不静默吞掉。
		if (relation.mutedInPresentationAt !== null) {
			mutedRelationCount += 1;
			continue;
		}
		const registryEntry = RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relation.relationKind];
		const subjectIsRelationSubject =
			buildInterWorkUnitRelationWorkUnitKey(relation.relationStatementSubjectWorkUnitRef) === subjectWorkUnitKey;
		const readingPhrase = subjectIsRelationSubject
			? registryEntry.forwardReadingPhraseFromSubject
			: registryEntry.inverseReadingPhraseFromAnchor;
		const counterpartWorkUnit = subjectIsRelationSubject
			? relation.relationStatementAnchorWorkUnitRef
			: relation.relationStatementSubjectWorkUnitRef;
		if (!registryEntry.defaultVisibleInNeighborhoodSummary) {
			collapsedRelationCountByPhrase.set(
				readingPhrase,
				(collapsedRelationCountByPhrase.get(readingPhrase) ?? 0) + 1,
			);
			continue;
		}
		const sectionLines = visibleLinesBySectionPriority.get(registryEntry.neighborhoodSummarySectionPriority) ?? [];
		sectionLines.push(
			`- ${subjectSelfReference} ${readingPhrase} ${labelOf(counterpartWorkUnit)} (${renderRelationDetails(relation)})`,
		);
		visibleLinesBySectionPriority.set(registryEntry.neighborhoodSummarySectionPriority, sectionLines);
	}
	const lines = [`# Kanban relation neighborhood of ${input.subjectWorkUnit.workUnitDisplayLabel}`];
	if (input.recordedRelations.length === 0) {
		lines.push("No recorded relations with other Kanban work units yet.");
	}
	for (const sectionPriority of [...visibleLinesBySectionPriority.keys()].sort((left, right) => left - right)) {
		lines.push(`## ${NEIGHBORHOOD_SUMMARY_SECTION_TITLE_BY_PRIORITY[sectionPriority] ?? "Relations"}`);
		lines.push(...(visibleLinesBySectionPriority.get(sectionPriority) ?? []));
	}
	if (collapsedRelationCountByPhrase.size > 0) {
		lines.push("## Collapsed (counts only; pass --json for details)");
		for (const [readingPhrase, relationCount] of collapsedRelationCountByPhrase) {
			lines.push(
				`- ${subjectSelfReference} ${readingPhrase}: ${relationCount} work unit${relationCount === 1 ? "" : "s"}`,
			);
		}
	}
	if (mutedRelationCount > 0) {
		lines.push(`(${mutedRelationCount} relation(s) muted by the user are not listed.)`);
	}
	if (input.secondHopRecordedRelations) {
		lines.push(
			...renderSecondHopNeighborhoodLines({
				firstHopNeighborWorkUnitKeys,
				secondHopRecordedRelations: input.secondHopRecordedRelations,
				labelOf,
			}),
		);
	}
	if (input.conversationSessionOwnershipConflictDiagnosticCount > 0) {
		lines.push(
			`Warning: ${input.conversationSessionOwnershipConflictDiagnosticCount} shared conversation session conflict(s): a card that handed its session over to another card resumed the same session again.`,
		);
	}
	return {
		renderedNeighborhoodSummaryText: lines.join("\n"),
		hasAnyRelationVisibleByDefault: visibleLinesBySectionPriority.size > 0,
	};
}
