import { createHash } from "node:crypto";
import {
	type RecordedInterWorkUnitRelation,
	type RecordedInterWorkUnitRelationKind,
	TASK_CARD_FIELD_NAMES_PROJECTED_AS_EXECUTION_CONFIGURATION_CHANGE,
	TASK_CARD_FIELD_NAMES_PROJECTED_AS_REQUIREMENTS_AMENDMENT,
} from "../core/inter-work-unit-recorded-relation-projection-contract";
import type {
	CommittedInterWorkUnitRelationLedgerEvent,
	InterWorkUnitRelationWorkUnitReference,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import {
	type AssertedInterWorkUnitRelationProjectionState,
	applyInterWorkUnitRelationAssertionLifecycleEvent,
	createEmptyAssertedInterWorkUnitRelationProjectionState,
} from "./asserted-inter-work-unit-relation-projection-from-ledger-events";
import {
	applyConversationSessionIdentityObservedInKanbanBoardCard,
	applyKanbanUnmanagedStandaloneSessionActedAsActor,
	applyTaskAgentSessionInitializationSetOnKanbanBoardCard,
	type ConversationSessionInitializationForProvenanceProjection,
	type ConversationSessionOwnershipProjectionState,
	type ConversationSessionProvenanceRelationOccurrence,
	createEmptyConversationSessionOwnershipProjectionState,
	createEmptyConversationSessionOwnershipProjectionStateInheritingLiveCaptureActivationSeededFactIndex,
	findKanbanBoardCardObservedAtLiveCaptureActivationBaseline,
	readAgentConversationSessionIdentityKeyFromLedgerValue,
	readConversationSessionInitializationForProvenanceProjection,
	registerKanbanBoardCardsObservedAtLiveCaptureActivationBaselineIntoSeededFactIndex,
	registerSeededConversationSessionIdentityFactIntoSeededFactIndex,
	registerSeededResumeInitializationIntoSeededFactIndex,
} from "./conversation-session-ownership-period-projection-from-ledger-events";
import {
	applyCommittedLedgerEventToKanbanBoardCardIdentityProjection,
	buildInterWorkUnitRelationWorkUnitKey,
	createEmptyKanbanBoardCardIdentityProjectionState,
	findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId,
	type KanbanBoardCardIdentityProjectionState,
	readInterWorkUnitRelationWorkUnitReferenceFromLedgerValue,
	readKanbanBoardCardReferenceFromLedgerPayloadValue,
} from "./kanban-board-card-identity-projection-from-ledger-events";

// dd2db 1b：记录型关系投影器（来源 3 个 kind + 交互 4 个 kind）。
// 关系 = 事件日志 × 投影表版本的纯函数（d-vocab §2.2）：本模块按全局提交序号顺序消费已提交事件，
// 不写账本、不落盘；runtime 在内存里持有状态并按游标增量追上（见 ...-catch-up-against-ledger-worker.ts）。
// 投影规则改了就升版本号，持有方据此从头重放——账本只追加，所以重放的结果与「当初就按新规则投影」完全一致。
export const RECORDED_INTER_WORK_UNIT_RELATION_PROJECTION_TABLE_VERSION = 3;

const MOST_RECENT_PROJECTED_FROM_EVENT_IDS_RETAINED_PER_RECORDED_RELATION = 10;

// 起动 agent 会话的 CLI 意图：这类移列投影成「派发 / 控制」，其余移列投影成「看板生命周期」（d-vocab §5）。
const TASK_MUTATION_INTENT_KINDS_THAT_START_AGENT_SESSION = new Set(["kanban_cli_task_start_move_to_in_progress"]);

const TASK_MUTATION_EVENT_KINDS_PROJECTED_AS_BOARD_LIFECYCLE_TRANSITION = new Set([
	"task_card_moved_between_non_trash_board_columns",
	"task_card_moved_to_trash_column",
	"task_card_restored_from_trash_column",
	"task_card_permanently_removed_from_board",
]);

const REQUIREMENTS_AMENDMENT_FIELD_NAMES = new Set<string>(TASK_CARD_FIELD_NAMES_PROJECTED_AS_REQUIREMENTS_AMENDMENT);
const EXECUTION_CONFIGURATION_CHANGE_FIELD_NAMES = new Set<string>(
	TASK_CARD_FIELD_NAMES_PROJECTED_AS_EXECUTION_CONFIGURATION_CHANGE,
);

export interface RecordedInterWorkUnitRelationProjectionState {
	recordedInterWorkUnitRelationProjectionTableVersion: number;
	lastAppliedGlobalCommittedEventSequence: number;
	kanbanBoardCardIdentityProjectionState: KanbanBoardCardIdentityProjectionState;
	conversationSessionOwnershipProjectionState: ConversationSessionOwnershipProjectionState;
	recordedRelationsByRelationId: Map<string, RecordedInterWorkUnitRelation>;
	recordedRelationIdsByWorkUnitKey: Map<string, Set<string>>;
	// 族 7 静音偏好，按确定性 relationId 挂载（d-vocab §2.3）：关系还没投影出来时先到的静音也不会丢。
	presentationMuteStateByRelationId: Map<
		string,
		{ mutedInPresentationAt: number; mutedInPresentationByActorKind: string }
	>;
	// 阶段 2 起：断言型关系（族 4）的投影跟记录型共用这一份状态与游标，邻域读一次追赶就同时拿到两种关系。
	assertedInterWorkUnitRelationProjectionState: AssertedInterWorkUnitRelationProjectionState;
}

export function createEmptyRecordedInterWorkUnitRelationProjectionState(): RecordedInterWorkUnitRelationProjectionState {
	return createEmptyRecordedInterWorkUnitRelationProjectionStateWithConversationSessionOwnershipState(
		createEmptyConversationSessionOwnershipProjectionState(),
	);
}

// 迟到的激活播种推翻了先前的归属判断时，持有方用它从全局序号 0 重放：除激活播种事实索引外一切从空开始，
// 索引里已有全部已登记的播种事实，所以重放中不会再推断出被推翻的占位。
export function createEmptyRecordedInterWorkUnitRelationProjectionStateInheritingLiveCaptureActivationSeededFactIndex(
	previousState: RecordedInterWorkUnitRelationProjectionState,
): RecordedInterWorkUnitRelationProjectionState {
	return createEmptyRecordedInterWorkUnitRelationProjectionStateWithConversationSessionOwnershipState(
		createEmptyConversationSessionOwnershipProjectionStateInheritingLiveCaptureActivationSeededFactIndex(
			previousState.conversationSessionOwnershipProjectionState.liveCaptureActivationSeededFactIndex,
		),
	);
}

function createEmptyRecordedInterWorkUnitRelationProjectionStateWithConversationSessionOwnershipState(
	conversationSessionOwnershipProjectionState: ConversationSessionOwnershipProjectionState,
): RecordedInterWorkUnitRelationProjectionState {
	return {
		recordedInterWorkUnitRelationProjectionTableVersion: RECORDED_INTER_WORK_UNIT_RELATION_PROJECTION_TABLE_VERSION,
		lastAppliedGlobalCommittedEventSequence: 0,
		kanbanBoardCardIdentityProjectionState: createEmptyKanbanBoardCardIdentityProjectionState(),
		conversationSessionOwnershipProjectionState,
		recordedRelationsByRelationId: new Map(),
		recordedRelationIdsByWorkUnitKey: new Map(),
		presentationMuteStateByRelationId: new Map(),
		assertedInterWorkUnitRelationProjectionState: createEmptyAssertedInterWorkUnitRelationProjectionState(),
	};
}

export function isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
	state: RecordedInterWorkUnitRelationProjectionState,
): boolean {
	return state.conversationSessionOwnershipProjectionState
		.retroactiveRebuildRequiredBecauseLateSeededActivationFactContradictsEarlierOwnershipDecision;
}

// 重建后仍为真（重建期间又提交了推翻先前判断的播种事实）时，持有方记诊断告警后清除，避免每次读都整表重放。
export function clearRetroactiveRebuildRequirementOfRecordedInterWorkUnitRelationProjectionAfterDiagnosticWarning(
	state: RecordedInterWorkUnitRelationProjectionState,
): void {
	state.conversationSessionOwnershipProjectionState.retroactiveRebuildRequiredBecauseLateSeededActivationFactContradictsEarlierOwnershipDecision = false;
}

function applyRelationPresentationPreferenceEvent(
	state: RecordedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	const relationId = event.eventPayload.relationId;
	if (typeof relationId !== "string") {
		return;
	}
	if (event.eventKind === "recorded_relation_muted_in_presentation_by_user") {
		state.presentationMuteStateByRelationId.set(relationId, {
			mutedInPresentationAt: event.occurredAt,
			mutedInPresentationByActorKind: event.actor.kanbanActorKind,
		});
	} else if (event.eventKind === "recorded_relation_unmuted_in_presentation_by_user") {
		state.presentationMuteStateByRelationId.delete(relationId);
	}
}

// 记录型 relationId 由去重键哈希确定性生成（d-vocab §2.4），重放多少次都是同一个 id。
export function buildRecordedInterWorkUnitRelationId(
	relationKind: RecordedInterWorkUnitRelationKind,
	subjectWorkUnit: InterWorkUnitRelationWorkUnitReference,
	anchorWorkUnit: InterWorkUnitRelationWorkUnitReference,
): string {
	const dedupKey = [
		relationKind,
		buildInterWorkUnitRelationWorkUnitKey(subjectWorkUnit),
		buildInterWorkUnitRelationWorkUnitKey(anchorWorkUnit),
	].join("\u0000");
	return `recorded-relation-${createHash("sha256").update(dedupKey, "utf8").digest("hex").slice(0, 32)}`;
}

interface RecordedRelationOccurrence {
	relationKind: RecordedInterWorkUnitRelationKind;
	subjectWorkUnit: InterWorkUnitRelationWorkUnitReference;
	anchorWorkUnit: InterWorkUnitRelationWorkUnitReference;
	occurredAt: number;
	derivingEventId: string;
	derivingEventCaptureChannel: string;
	// 交互轴计数用的事件种类；来源轴为 null。
	countedTaskMutationEventKind: string | null;
	mergeKindSpecificAttributes(existingAttributes: Record<string, unknown>): Record<string, unknown>;
}

function addRelationIdToWorkUnitIndex(
	state: RecordedInterWorkUnitRelationProjectionState,
	workUnit: InterWorkUnitRelationWorkUnitReference,
	relationId: string,
): void {
	const workUnitKey = buildInterWorkUnitRelationWorkUnitKey(workUnit);
	const relationIds = state.recordedRelationIdsByWorkUnitKey.get(workUnitKey) ?? new Set();
	relationIds.add(relationId);
	state.recordedRelationIdsByWorkUnitKey.set(workUnitKey, relationIds);
}

function upsertRecordedRelationOccurrence(
	state: RecordedInterWorkUnitRelationProjectionState,
	occurrence: RecordedRelationOccurrence,
): void {
	// 所有 kind 都拒绝自环（d-vocab §3）：卡对自己发消息（例如 RVF hook 投给本会话）不是工作单元之间的关系。
	if (
		buildInterWorkUnitRelationWorkUnitKey(occurrence.subjectWorkUnit) ===
		buildInterWorkUnitRelationWorkUnitKey(occurrence.anchorWorkUnit)
	) {
		return;
	}
	const relationId = buildRecordedInterWorkUnitRelationId(
		occurrence.relationKind,
		occurrence.subjectWorkUnit,
		occurrence.anchorWorkUnit,
	);
	const existingRelation = state.recordedRelationsByRelationId.get(relationId);
	const relation: RecordedInterWorkUnitRelation = existingRelation ?? {
		relationId,
		relationKind: occurrence.relationKind,
		relationStatementSubjectWorkUnitRef: occurrence.subjectWorkUnit,
		relationStatementAnchorWorkUnitRef: occurrence.anchorWorkUnit,
		relationFirstEstablishedAt: occurrence.occurredAt,
		relationLastUpdatedAt: occurrence.occurredAt,
		mostRecentProjectedFromEventIds: [],
		captureChannelsOfDerivingEvents: [],
		occurrenceCountByTaskMutationEventKind: {},
		recordedRelationKindSpecificAttributes: {},
		isCreationTimePrimaryProvenanceOfSubjectCard: false,
		mutedInPresentationAt: null,
		mutedInPresentationByActorKind: null,
	};
	relation.relationLastUpdatedAt = Math.max(relation.relationLastUpdatedAt, occurrence.occurredAt);
	relation.relationFirstEstablishedAt = Math.min(relation.relationFirstEstablishedAt, occurrence.occurredAt);
	relation.mostRecentProjectedFromEventIds = [
		...relation.mostRecentProjectedFromEventIds.filter((eventId) => eventId !== occurrence.derivingEventId),
		occurrence.derivingEventId,
	].slice(-MOST_RECENT_PROJECTED_FROM_EVENT_IDS_RETAINED_PER_RECORDED_RELATION);
	if (!relation.captureChannelsOfDerivingEvents.includes(occurrence.derivingEventCaptureChannel)) {
		relation.captureChannelsOfDerivingEvents = [
			...relation.captureChannelsOfDerivingEvents,
			occurrence.derivingEventCaptureChannel,
		];
	}
	if (occurrence.countedTaskMutationEventKind) {
		relation.occurrenceCountByTaskMutationEventKind[occurrence.countedTaskMutationEventKind] =
			(relation.occurrenceCountByTaskMutationEventKind[occurrence.countedTaskMutationEventKind] ?? 0) + 1;
	}
	relation.recordedRelationKindSpecificAttributes = occurrence.mergeKindSpecificAttributes(
		relation.recordedRelationKindSpecificAttributes,
	);
	if (!existingRelation) {
		state.recordedRelationsByRelationId.set(relationId, relation);
		addRelationIdToWorkUnitIndex(state, occurrence.subjectWorkUnit, relationId);
		addRelationIdToWorkUnitIndex(state, occurrence.anchorWorkUnit, relationId);
	}
}

function keepExistingKindSpecificAttributes(existingAttributes: Record<string, unknown>): Record<string, unknown> {
	return existingAttributes;
}

function unionSortedFieldNames(existingValue: unknown, fieldName: string): string[] {
	const existingFieldNames = Array.isArray(existingValue)
		? existingValue.filter((value): value is string => typeof value === "string")
		: [];
	return [...new Set([...existingFieldNames, fieldName])].sort();
}

// 行动者是工作单元时返回它；系统组件、浏览器自动化、Web UI 用户等非工作单元行动者一律不投影交互（Y-EVENT-10）。
function resolveActingWorkUnitOfLedgerEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
): InterWorkUnitRelationWorkUnitReference | null {
	if (event.actor.kanbanActorKind === "kanban_board_card_work_unit") {
		return readInterWorkUnitRelationWorkUnitReferenceFromLedgerValue(event.actor.actingKanbanBoardCardWorkUnit);
	}
	if (event.actor.kanbanActorKind === "kanban_unmanaged_standalone_agent_conversation_session_work_unit") {
		return readInterWorkUnitRelationWorkUnitReferenceFromLedgerValue(
			event.actor.actingStandaloneAgentConversationSession,
		);
	}
	return null;
}

function buildInteractionRelationOccurrenceFromTaskMutationEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
	subjectCard: KanbanBoardCardWorkUnitQualifiedReference,
	actingWorkUnit: InterWorkUnitRelationWorkUnitReference,
): RecordedRelationOccurrence | null {
	const commonOccurrence = {
		subjectWorkUnit: subjectCard,
		anchorWorkUnit: actingWorkUnit,
		occurredAt: event.occurredAt,
		derivingEventId: event.eventId,
		derivingEventCaptureChannel: event.recordCaptureChannel,
		countedTaskMutationEventKind: event.eventKind,
	};
	if (event.eventKind === "task_message_delivery_requested_into_task_conversation_session") {
		return {
			...commonOccurrence,
			relationKind: "interaction_agent_session_dispatched_or_controlled_by",
			mergeKindSpecificAttributes: keepExistingKindSpecificAttributes,
		};
	}
	if (event.eventKind === "task_card_field_value_changed") {
		const changedTaskCardFieldName = event.eventPayload.changedTaskCardFieldName;
		if (typeof changedTaskCardFieldName !== "string") {
			return null;
		}
		if (REQUIREMENTS_AMENDMENT_FIELD_NAMES.has(changedTaskCardFieldName)) {
			return {
				...commonOccurrence,
				relationKind: "interaction_requirements_amended_by",
				mergeKindSpecificAttributes: (existingAttributes) => ({
					...existingAttributes,
					amendedCardFieldNames: unionSortedFieldNames(
						existingAttributes.amendedCardFieldNames,
						changedTaskCardFieldName,
					),
				}),
			};
		}
		if (EXECUTION_CONFIGURATION_CHANGE_FIELD_NAMES.has(changedTaskCardFieldName)) {
			return {
				...commonOccurrence,
				relationKind: "interaction_execution_configuration_changed_by",
				mergeKindSpecificAttributes: (existingAttributes) => ({
					...existingAttributes,
					changedExecutionConfigurationFieldNames: unionSortedFieldNames(
						existingAttributes.changedExecutionConfigurationFieldNames,
						changedTaskCardFieldName,
					),
				}),
			};
		}
		// 白名单外的字段（置顶、runtime 维护的派生字段……）只进日志。
		return null;
	}
	if (
		event.eventKind === "task_card_moved_between_non_trash_board_columns" &&
		typeof event.eventPayload.taskMutationIntentKind === "string" &&
		TASK_MUTATION_INTENT_KINDS_THAT_START_AGENT_SESSION.has(event.eventPayload.taskMutationIntentKind)
	) {
		return {
			...commonOccurrence,
			relationKind: "interaction_agent_session_dispatched_or_controlled_by",
			mergeKindSpecificAttributes: keepExistingKindSpecificAttributes,
		};
	}
	if (TASK_MUTATION_EVENT_KINDS_PROJECTED_AS_BOARD_LIFECYCLE_TRANSITION.has(event.eventKind)) {
		const transitionKind = event.eventKind;
		return {
			...commonOccurrence,
			relationKind: "interaction_board_lifecycle_transitioned_by",
			mergeKindSpecificAttributes: (existingAttributes) => {
				const existingCounts =
					typeof existingAttributes.boardLifecycleTransitionCountByTransitionKind === "object" &&
					existingAttributes.boardLifecycleTransitionCountByTransitionKind !== null
						? (existingAttributes.boardLifecycleTransitionCountByTransitionKind as Record<string, number>)
						: {};
				return {
					...existingAttributes,
					boardLifecycleTransitionCountByTransitionKind: {
						...existingCounts,
						[transitionKind]: (existingCounts[transitionKind] ?? 0) + 1,
					},
				};
			},
		};
	}
	return null;
}

function toRecordedRelationOccurrence(
	provenanceOccurrence: ConversationSessionProvenanceRelationOccurrence,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): RecordedRelationOccurrence {
	return {
		relationKind: provenanceOccurrence.relationKind,
		subjectWorkUnit: provenanceOccurrence.subjectKanbanBoardCard,
		anchorWorkUnit: provenanceOccurrence.anchorWorkUnit,
		occurredAt: provenanceOccurrence.occurredAt,
		derivingEventId: event.eventId,
		derivingEventCaptureChannel: event.recordCaptureChannel,
		countedTaskMutationEventKind: null,
		mergeKindSpecificAttributes: (existingAttributes) =>
			Object.keys(existingAttributes).length > 0
				? existingAttributes
				: provenanceOccurrence.recordedRelationKindSpecificAttributes,
	};
}

// 账本里读到的初始化字段指纹 → 正文：调用方先批量预取（catch-up 模块），这里只做同步查找。
export type RetainedTaskCardFieldValueCanonicalJsonLookupBySha256 = (fieldValueSha256: string) => string | null;

function readTaskAgentSessionInitializationFromRetainedFieldValue(
	fieldValueSha256: unknown,
	lookupRetainedFieldValueCanonicalJson: RetainedTaskCardFieldValueCanonicalJsonLookupBySha256,
): {
	fieldValueSha256Present: boolean;
	initialization: ConversationSessionInitializationForProvenanceProjection | null;
} {
	if (typeof fieldValueSha256 !== "string") {
		return { fieldValueSha256Present: false, initialization: null };
	}
	const canonicalJson = lookupRetainedFieldValueCanonicalJson(fieldValueSha256);
	if (!canonicalJson) {
		return { fieldValueSha256Present: true, initialization: null };
	}
	try {
		return {
			fieldValueSha256Present: true,
			initialization: readConversationSessionInitializationForProvenanceProjection(JSON.parse(canonicalJson)),
		};
	} catch {
		return { fieldValueSha256Present: true, initialization: null };
	}
}

// 建卡与改字段事件里引用到的会话初始化字段指纹：catch-up 在投影前批量取回正文。
export function collectTaskAgentSessionInitializationFieldValueSha256sReferencedByLedgerEvents(
	events: CommittedInterWorkUnitRelationLedgerEvent[],
): string[] {
	const fieldValueSha256s = new Set<string>();
	for (const event of events) {
		if (event.eventKind === "task_card_created_on_board") {
			const fieldValueSha256ByFieldName = event.eventPayload.fieldValueSha256ByFieldNameAtCreation;
			if (typeof fieldValueSha256ByFieldName === "object" && fieldValueSha256ByFieldName !== null) {
				const initializationSha256 = (fieldValueSha256ByFieldName as Record<string, unknown>)
					.taskAgentSessionInitialization;
				if (typeof initializationSha256 === "string") {
					fieldValueSha256s.add(initializationSha256);
				}
			}
		} else if (
			event.eventKind === "task_card_field_value_changed" &&
			event.eventPayload.changedTaskCardFieldName === "taskAgentSessionInitialization" &&
			typeof event.eventPayload.fieldValueAfterSha256 === "string"
		) {
			fieldValueSha256s.add(event.eventPayload.fieldValueAfterSha256);
		}
	}
	return [...fieldValueSha256s];
}

function applyTaskMutationEvent(
	state: RecordedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
	lookupRetainedFieldValueCanonicalJson: RetainedTaskCardFieldValueCanonicalJsonLookupBySha256,
): void {
	const subjectCard = readKanbanBoardCardReferenceFromLedgerPayloadValue(event.eventPayload.subjectKanbanBoardCard);
	if (!subjectCard) {
		return;
	}
	const actingWorkUnit = resolveActingWorkUnitOfLedgerEvent(event);
	if (actingWorkUnit?.workUnitType === "kanban_unmanaged_standalone_agent_conversation_session") {
		applyKanbanUnmanagedStandaloneSessionActedAsActor(state.conversationSessionOwnershipProjectionState, {
			identityKey: {
				conversationSessionHostKanbanAgentId: actingWorkUnit.conversationSessionHostKanbanAgentId,
				nativeConversationSessionId: actingWorkUnit.nativeConversationSessionId,
			},
			actedAt: event.occurredAt,
		});
	}
	if (event.eventKind === "task_card_created_on_board") {
		// 建卡只投影成来源（d-vocab §6）。系统组件代行时按 onBehalfOf 投影（Y-EVENT-10）。
		const creatingWorkUnit =
			actingWorkUnit ??
			(event.actor.kanbanActorKind === "kanban_runtime_system_component"
				? readInterWorkUnitRelationWorkUnitReferenceFromLedgerValue(event.onBehalfOfInitiatingWorkUnit)
				: null);
		if (creatingWorkUnit) {
			upsertRecordedRelationOccurrence(state, {
				relationKind: "provenance_created_by",
				subjectWorkUnit: subjectCard,
				anchorWorkUnit: creatingWorkUnit,
				occurredAt: event.occurredAt,
				derivingEventId: event.eventId,
				derivingEventCaptureChannel: event.recordCaptureChannel,
				countedTaskMutationEventKind: null,
				mergeKindSpecificAttributes: keepExistingKindSpecificAttributes,
			});
		}
		const initializationFieldValueSha256 =
			typeof event.eventPayload.fieldValueSha256ByFieldNameAtCreation === "object" &&
			event.eventPayload.fieldValueSha256ByFieldNameAtCreation !== null
				? (event.eventPayload.fieldValueSha256ByFieldNameAtCreation as Record<string, unknown>)
						.taskAgentSessionInitialization
				: undefined;
		const { initialization } = readTaskAgentSessionInitializationFromRetainedFieldValue(
			initializationFieldValueSha256,
			lookupRetainedFieldValueCanonicalJson,
		);
		if (initialization) {
			applyTaskAgentSessionInitializationSetOnKanbanBoardCard(state.conversationSessionOwnershipProjectionState, {
				card: subjectCard,
				taskAgentSessionInitialization: initialization,
				setByActivationTimeSidecarRead: false,
				cardHadLeftBacklogAtLiveCaptureActivationBaseline: false,
				observedAt: event.occurredAt,
				eventId: event.eventId,
			});
		}
		return;
	}
	if (
		event.eventKind === "task_card_field_value_changed" &&
		event.eventPayload.changedTaskCardFieldName === "taskAgentSessionInitialization"
	) {
		const { initialization } = readTaskAgentSessionInitializationFromRetainedFieldValue(
			event.eventPayload.fieldValueAfterSha256,
			lookupRetainedFieldValueCanonicalJson,
		);
		applyTaskAgentSessionInitializationSetOnKanbanBoardCard(state.conversationSessionOwnershipProjectionState, {
			card: subjectCard,
			taskAgentSessionInitialization: initialization,
			setByActivationTimeSidecarRead: false,
			cardHadLeftBacklogAtLiveCaptureActivationBaseline: false,
			observedAt: event.occurredAt,
			eventId: event.eventId,
		});
	}
	if (!actingWorkUnit) {
		return;
	}
	const interactionOccurrence = buildInteractionRelationOccurrenceFromTaskMutationEvent(
		event,
		subjectCard,
		actingWorkUnit,
	);
	if (interactionOccurrence) {
		upsertRecordedRelationOccurrence(state, interactionOccurrence);
	}
}

function applyAgentConversationSessionIdentityEvent(
	state: RecordedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	if (event.eventKind === "persisted_card_agent_session_initialization_sidecar_read_at_live_capture_activation") {
		const card = readKanbanBoardCardReferenceFromLedgerPayloadValue(event.eventPayload.subjectKanbanBoardCard);
		const initialization = readConversationSessionInitializationForProvenanceProjection(
			event.eventPayload.taskAgentSessionInitialization,
		);
		if (!card || !initialization) {
			return;
		}
		// 激活基线先于初始化 sidecar 写入（同一激活批次内，基线最先），所以此刻能读到基线里的列。
		const boardColumnIdAtBaseline =
			findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId(
				state.kanbanBoardCardIdentityProjectionState,
				card.workspaceId,
				card.taskId,
			)?.lastKnownBoardColumnId ?? null;
		for (const provenanceOccurrence of applyTaskAgentSessionInitializationSetOnKanbanBoardCard(
			state.conversationSessionOwnershipProjectionState,
			{
				card,
				taskAgentSessionInitialization: initialization,
				setByActivationTimeSidecarRead: true,
				cardHadLeftBacklogAtLiveCaptureActivationBaseline:
					boardColumnIdAtBaseline !== null && boardColumnIdAtBaseline !== "backlog",
				observedAt: event.occurredAt,
				eventId: event.eventId,
			},
		)) {
			upsertRecordedRelationOccurrence(state, toRecordedRelationOccurrence(provenanceOccurrence, event));
		}
		return;
	}
	const identityKey = readAgentConversationSessionIdentityKeyFromLedgerValue(
		event.eventPayload.conversationSessionIdentityKey,
	);
	const owningKanbanTaskId = readOwningKanbanTaskIdOfConversationSessionIdentityEvent(event);
	if (!identityKey || !event.subjectWorkspaceId || !owningKanbanTaskId) {
		return;
	}
	// 身份事件只带（workspace, taskId）：取当时仍在 board 上的那一世。认不出卡（例如别的项目串写进来的会话条目）就不归属。
	const cardProjection = findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId(
		state.kanbanBoardCardIdentityProjectionState,
		event.subjectWorkspaceId,
		owningKanbanTaskId,
	);
	if (!cardProjection) {
		return;
	}
	const observedBySessionIdentitySidecarReadAtLiveCaptureActivation =
		event.eventKind === "persisted_session_native_identity_sidecar_read_at_live_capture_activation";
	const sidecarObservedAt = readSessionIdentitySidecarObservedAtOfConversationSessionIdentityEvent(event);
	for (const provenanceOccurrence of applyConversationSessionIdentityObservedInKanbanBoardCard(
		state.conversationSessionOwnershipProjectionState,
		{
			card: cardProjection.kanbanBoardCard,
			identityKey,
			kanbanTaskConversationSessionId: readKanbanTaskConversationSessionIdOfConversationSessionIdentityEvent(event),
			observedInMainKanbanTaskConversationSessionOfCard:
				isConversationSessionIdentityEventObservedInMainKanbanTaskConversationSession(event, owningKanbanTaskId),
			observedBySessionIdentitySidecarReadAtLiveCaptureActivation,
			observedAt:
				observedBySessionIdentitySidecarReadAtLiveCaptureActivation && sidecarObservedAt !== null
					? sidecarObservedAt
					: event.occurredAt,
			eventId: event.eventId,
		},
	)) {
		upsertRecordedRelationOccurrence(state, toRecordedRelationOccurrence(provenanceOccurrence, event));
	}
}

function readTaskConversationSessionMetadataFieldOfConversationSessionIdentityEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
	metadataFieldName: "workspaceTaskId" | "taskConversationSessionRole",
): string | null {
	const metadata = event.eventPayload.taskConversationSessionMetadata;
	if (typeof metadata !== "object" || metadata === null) {
		return null;
	}
	const metadataFieldValue = (metadata as Record<string, unknown>)[metadataFieldName];
	return typeof metadataFieldValue === "string" ? metadataFieldValue : null;
}

// 族 2 身份事件的 subjectTaskId 是 kanban 会话 id：主会话与卡 id 相同，by-the-way 会话不同——它所属的卡在
// taskConversationSessionMetadata.workspaceTaskId。元数据优先，缺失时回退 subjectTaskId（兼容主会话与旧事件）。
export function readOwningKanbanTaskIdOfConversationSessionIdentityEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
): string | null {
	return (
		readTaskConversationSessionMetadataFieldOfConversationSessionIdentityEvent(event, "workspaceTaskId") ??
		event.subjectTaskId
	);
}

function readKanbanTaskConversationSessionIdOfConversationSessionIdentityEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
): string | null {
	return typeof event.eventPayload.kanbanTaskConversationSessionId === "string"
		? event.eventPayload.kanbanTaskConversationSessionId
		: null;
}

function readSessionIdentitySidecarObservedAtOfConversationSessionIdentityEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
): number | null {
	const sidecarObservedAt = event.eventPayload.agentNativeConversationSessionIdentityObservedAt;
	return typeof sidecarObservedAt === "number" ? sidecarObservedAt : null;
}

// 元数据写明角色时以它为准；没有元数据（旧事件）时，kanban 会话 id 等于所属卡 id 的就是主会话。
function isConversationSessionIdentityEventObservedInMainKanbanTaskConversationSession(
	event: CommittedInterWorkUnitRelationLedgerEvent,
	owningKanbanTaskId: string,
): boolean {
	const taskConversationSessionRole = readTaskConversationSessionMetadataFieldOfConversationSessionIdentityEvent(
		event,
		"taskConversationSessionRole",
	);
	if (taskConversationSessionRole !== null) {
		return taskConversationSessionRole === "main";
	}
	const kanbanTaskConversationSessionId = readKanbanTaskConversationSessionIdOfConversationSessionIdentityEvent(event);
	return kanbanTaskConversationSessionId === null || kanbanTaskConversationSessionId === owningKanbanTaskId;
}

// 预扫描：把这一批里的激活播种事实（基线卡片引用、身份 sidecar、resume 初始化 sidecar）先登记进只增不减的索引，
// 再按序消费。激活批次按 workspace 索引顺序逐个提交，提交顺序不是历史顺序；有了索引，「推断源会话持有者」就不必
// 等到原主卡所在 workspace 的播种按序到达。按 eventId 去重，重复 apply / 从头重放时再登记是空操作。
function registerLiveCaptureActivationSeededFactsOfLedgerEventsBeforeOrderedConsumption(
	state: RecordedInterWorkUnitRelationProjectionState,
	eventsInGlobalCommittedSequenceOrder: CommittedInterWorkUnitRelationLedgerEvent[],
): void {
	const ownershipState = state.conversationSessionOwnershipProjectionState;
	for (const event of eventsInGlobalCommittedSequenceOrder) {
		if (event.eventKind === "board_state_baseline_observed_at_live_task_mutation_capture_activation") {
			const baselineTaskCards = Array.isArray(event.eventPayload.baselineTaskCards)
				? event.eventPayload.baselineTaskCards
				: [];
			registerKanbanBoardCardsObservedAtLiveCaptureActivationBaselineIntoSeededFactIndex(ownershipState, {
				ledgerEventId: event.eventId,
				baselineKanbanBoardCards: baselineTaskCards
					.map((baselineTaskCard) =>
						typeof baselineTaskCard === "object" && baselineTaskCard !== null
							? readKanbanBoardCardReferenceFromLedgerPayloadValue(
									(baselineTaskCard as Record<string, unknown>).kanbanBoardCard,
								)
							: null,
					)
					.filter((card): card is KanbanBoardCardWorkUnitQualifiedReference => card !== null),
			});
		} else if (event.eventKind === "persisted_session_native_identity_sidecar_read_at_live_capture_activation") {
			const identityKey = readAgentConversationSessionIdentityKeyFromLedgerValue(
				event.eventPayload.conversationSessionIdentityKey,
			);
			const owningKanbanTaskId = readOwningKanbanTaskIdOfConversationSessionIdentityEvent(event);
			const owningKanbanBoardCard =
				event.subjectWorkspaceId && owningKanbanTaskId
					? findKanbanBoardCardObservedAtLiveCaptureActivationBaseline(
							ownershipState,
							event.subjectWorkspaceId,
							owningKanbanTaskId,
						)
					: null;
			if (!identityKey || !owningKanbanBoardCard) {
				continue;
			}
			registerSeededConversationSessionIdentityFactIntoSeededFactIndex(ownershipState, {
				ledgerEventId: event.eventId,
				identityKey,
				owningKanbanBoardCard,
				kanbanTaskConversationSessionId:
					readKanbanTaskConversationSessionIdOfConversationSessionIdentityEvent(event),
				sessionIdentitySidecarObservedAt:
					readSessionIdentitySidecarObservedAtOfConversationSessionIdentityEvent(event),
			});
		} else if (
			event.eventKind === "persisted_card_agent_session_initialization_sidecar_read_at_live_capture_activation"
		) {
			const adoptingCard = readKanbanBoardCardReferenceFromLedgerPayloadValue(
				event.eventPayload.subjectKanbanBoardCard,
			);
			const initialization = readConversationSessionInitializationForProvenanceProjection(
				event.eventPayload.taskAgentSessionInitialization,
			);
			if (!adoptingCard || initialization?.sourceSessionReuseMode !== "resume_existing_session") {
				continue;
			}
			registerSeededResumeInitializationIntoSeededFactIndex(ownershipState, {
				ledgerEventId: event.eventId,
				adoptingCard,
				resumedSourceIdentityKey: {
					conversationSessionHostKanbanAgentId: initialization.sourceAgentId,
					nativeConversationSessionId: initialization.sourceSessionId,
				},
			});
		}
	}
}

// 按全局提交序号顺序消费；序号不大于游标的事件跳过（重复调用幂等）。消费前先预扫描这一批的激活播种事实。
export function applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(
	state: RecordedInterWorkUnitRelationProjectionState,
	eventsInGlobalCommittedSequenceOrder: CommittedInterWorkUnitRelationLedgerEvent[],
	lookupRetainedFieldValueCanonicalJson: RetainedTaskCardFieldValueCanonicalJsonLookupBySha256,
): void {
	registerLiveCaptureActivationSeededFactsOfLedgerEventsBeforeOrderedConsumption(
		state,
		eventsInGlobalCommittedSequenceOrder,
	);
	for (const event of eventsInGlobalCommittedSequenceOrder) {
		if (event.globalCommittedEventSequence <= state.lastAppliedGlobalCommittedEventSequence) {
			continue;
		}
		applyCommittedLedgerEventToKanbanBoardCardIdentityProjection(state.kanbanBoardCardIdentityProjectionState, event);
		if (event.eventFamily === "task_mutation_event") {
			applyTaskMutationEvent(state, event, lookupRetainedFieldValueCanonicalJson);
		} else if (event.eventFamily === "agent_conversation_session_identity_event") {
			applyAgentConversationSessionIdentityEvent(state, event);
		} else if (event.eventFamily === "relation_presentation_preference_event") {
			applyRelationPresentationPreferenceEvent(state, event);
		} else if (event.eventFamily === "inter_work_unit_relation_assertion_lifecycle_event") {
			applyInterWorkUnitRelationAssertionLifecycleEvent(state.assertedInterWorkUnitRelationProjectionState, event);
		}
		state.lastAppliedGlobalCommittedEventSequence = event.globalCommittedEventSequence;
	}
}

// Y-PHASE-12：created_by 优先，没有时取最早的 fork；采纳永远不当主来源。
function findCreationTimePrimaryProvenanceRelationIdOfCard(
	state: RecordedInterWorkUnitRelationProjectionState,
	card: InterWorkUnitRelationWorkUnitReference,
): string | null {
	const cardKey = buildInterWorkUnitRelationWorkUnitKey(card);
	let earliestForkRelation: RecordedInterWorkUnitRelation | null = null;
	for (const relationId of state.recordedRelationIdsByWorkUnitKey.get(cardKey) ?? []) {
		const relation = state.recordedRelationsByRelationId.get(relationId);
		if (
			!relation ||
			buildInterWorkUnitRelationWorkUnitKey(relation.relationStatementSubjectWorkUnitRef) !== cardKey
		) {
			continue;
		}
		if (relation.relationKind === "provenance_created_by") {
			return relation.relationId;
		}
		if (
			relation.relationKind === "provenance_forked_conversation_session_of" &&
			(!earliestForkRelation ||
				relation.relationFirstEstablishedAt < earliestForkRelation.relationFirstEstablishedAt)
		) {
			earliestForkRelation = relation;
		}
	}
	return earliestForkRelation?.relationId ?? null;
}

// 一个工作单元的一度邻域（入边 + 出边），按建立时间排序；返回的是带主来源标记的副本，不暴露内部可变状态。
export function listRecordedInterWorkUnitRelationsTouchingWorkUnit(
	state: RecordedInterWorkUnitRelationProjectionState,
	workUnit: InterWorkUnitRelationWorkUnitReference,
): RecordedInterWorkUnitRelation[] {
	const relations: RecordedInterWorkUnitRelation[] = [];
	for (const relationId of state.recordedRelationIdsByWorkUnitKey.get(
		buildInterWorkUnitRelationWorkUnitKey(workUnit),
	) ?? []) {
		const relation = state.recordedRelationsByRelationId.get(relationId);
		if (!relation) {
			continue;
		}
		const subjectWorkUnit = relation.relationStatementSubjectWorkUnitRef;
		const presentationMuteState = state.presentationMuteStateByRelationId.get(relation.relationId);
		relations.push({
			...relation,
			mostRecentProjectedFromEventIds: [...relation.mostRecentProjectedFromEventIds],
			captureChannelsOfDerivingEvents: [...relation.captureChannelsOfDerivingEvents],
			occurrenceCountByTaskMutationEventKind: { ...relation.occurrenceCountByTaskMutationEventKind },
			recordedRelationKindSpecificAttributes: structuredClone(relation.recordedRelationKindSpecificAttributes),
			isCreationTimePrimaryProvenanceOfSubjectCard:
				subjectWorkUnit.workUnitType === "kanban_board_card" &&
				findCreationTimePrimaryProvenanceRelationIdOfCard(state, subjectWorkUnit) === relation.relationId,
			mutedInPresentationAt: presentationMuteState?.mutedInPresentationAt ?? null,
			mutedInPresentationByActorKind: presentationMuteState?.mutedInPresentationByActorKind ?? null,
		});
	}
	return relations.sort((left, right) => left.relationFirstEstablishedAt - right.relationFirstEstablishedAt);
}
