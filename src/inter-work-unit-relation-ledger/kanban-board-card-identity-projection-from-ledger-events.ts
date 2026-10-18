import { z } from "zod";

import {
	type CommittedInterWorkUnitRelationLedgerEvent,
	type InterWorkUnitRelationWorkUnitReference,
	interWorkUnitRelationWorkUnitReferenceSchema,
	type KanbanActor,
	type KanbanBoardCardWorkUnitQualifiedReference,
	kanbanBoardCardWorkUnitQualifiedReferenceSchema,
} from "../core/inter-work-unit-relation-ledger-event-contract";

// dd2db 1b：全局 task 身份登记簿的读侧投影（Y-EVENT-12「身份内容是 1b 从事件日志重建的投影」）。
// 每一世卡片（workspace + taskId + incarnation）一条：创建者、当前字段指纹、所在列、trash / 永久删除墓碑。
// 来源只有账本事件：激活基线给出激活时盘上的全部卡，之后的建卡、改字段、移列、删卡事件逐条推进。
// 激活之前就已删除的卡这里不认识——那是 2b 回填的 GONE 身份重建。

export type KanbanBoardCardIdentityFirstObservationRoute =
	| "task_card_created_on_board_within_live_capture"
	| "board_state_baseline_at_live_capture_activation"
	| "task_mutation_event_without_prior_creation_or_baseline";

export interface KanbanBoardCardIdentityProjection {
	kanbanBoardCard: KanbanBoardCardWorkUnitQualifiedReference;
	kanbanBoardCardFirstObservationRoute: KanbanBoardCardIdentityFirstObservationRoute;
	firstObservedAt: number;
	// 只有激活之后在 live 捕获内建的卡才知道创建者；基线里的存量卡为 null（2b 回填补）。
	creationActor: KanbanActor | null;
	creationOnBehalfOfInitiatingWorkUnit: InterWorkUnitRelationWorkUnitReference | null;
	currentFieldValueSha256ByFieldName: Record<string, string>;
	// 与 current 分开保留来源，基线和字段变更绝不冒充创建/删除时快照。
	fieldValueSha256ByFieldNameAtCreation?: Record<string, string>;
	lastFieldValueSha256ByFieldNameBeforeRemoval?: Record<string, string>;
	lastKnownBoardColumnId: string | null;
	movedToTrashColumnAt: number | null;
	permanentlyRemovedFromBoardAt: number | null;
}

export interface KanbanBoardCardIdentityProjectionState {
	projectionsByKanbanBoardCardWorkUnitKey: Map<string, KanbanBoardCardIdentityProjection>;
	// 每个（workspace, taskId）当前仍在 board 上（含 trash 列）的那一世；永久删除后移除。
	liveKanbanBoardCardWorkUnitKeyByWorkspaceAndTaskId: Map<string, string>;
	kanbanBoardCardWorkUnitKeysByBareTaskId: Map<string, string[]>;
	// 激活基线记下的 workspace → 仓库路径（跨 project 解析 `task get` 时给出去哪个 project 读卡）。
	workspaceRepositoryPathByWorkspaceIdObservedAtBaseline: Map<string, string>;
}

export function createEmptyKanbanBoardCardIdentityProjectionState(): KanbanBoardCardIdentityProjectionState {
	return {
		projectionsByKanbanBoardCardWorkUnitKey: new Map(),
		liveKanbanBoardCardWorkUnitKeyByWorkspaceAndTaskId: new Map(),
		kanbanBoardCardWorkUnitKeysByBareTaskId: new Map(),
		workspaceRepositoryPathByWorkspaceIdObservedAtBaseline: new Map(),
	};
}

export function buildInterWorkUnitRelationWorkUnitKey(workUnit: InterWorkUnitRelationWorkUnitReference): string {
	if (workUnit.workUnitType === "kanban_board_card") {
		return `kanban_board_card:${workUnit.workspaceId}:${workUnit.taskId}:${workUnit.taskIncarnationCreatedAtEpochMs}`;
	}
	return `kanban_unmanaged_standalone_agent_conversation_session:${workUnit.conversationSessionHostKanbanAgentId}:${workUnit.nativeConversationSessionId}`;
}

function buildWorkspaceAndTaskIdKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}\u0000${taskId}`;
}

const stringToStringRecordSchema = z.record(z.string(), z.string());

export function readKanbanBoardCardReferenceFromLedgerPayloadValue(
	value: unknown,
): KanbanBoardCardWorkUnitQualifiedReference | null {
	const parsed = kanbanBoardCardWorkUnitQualifiedReferenceSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function readInterWorkUnitRelationWorkUnitReferenceFromLedgerValue(
	value: unknown,
): InterWorkUnitRelationWorkUnitReference | null {
	const parsed = interWorkUnitRelationWorkUnitReferenceSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function readFieldValueSha256ByFieldName(value: unknown): Record<string, string> {
	const parsed = stringToStringRecordSchema.safeParse(value);
	return parsed.success ? { ...parsed.data } : {};
}

function readOptionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function registerKanbanBoardCardIdentityProjection(
	state: KanbanBoardCardIdentityProjectionState,
	projection: KanbanBoardCardIdentityProjection,
): void {
	const card = projection.kanbanBoardCard;
	const cardKey = buildInterWorkUnitRelationWorkUnitKey(card);
	state.projectionsByKanbanBoardCardWorkUnitKey.set(cardKey, projection);
	state.liveKanbanBoardCardWorkUnitKeyByWorkspaceAndTaskId.set(
		buildWorkspaceAndTaskIdKey(card.workspaceId, card.taskId),
		cardKey,
	);
	const cardKeysWithSameBareTaskId = state.kanbanBoardCardWorkUnitKeysByBareTaskId.get(card.taskId) ?? [];
	if (!cardKeysWithSameBareTaskId.includes(cardKey)) {
		state.kanbanBoardCardWorkUnitKeysByBareTaskId.set(card.taskId, [...cardKeysWithSameBareTaskId, cardKey]);
	}
}

// 事件涉及的那一世卡片的投影；还不认识时按「先见到事件、没见到创建或基线」登记（例如激活后才被索引的 workspace）。
function getOrRegisterKanbanBoardCardIdentityProjection(
	state: KanbanBoardCardIdentityProjectionState,
	card: KanbanBoardCardWorkUnitQualifiedReference,
	observedAt: number,
): KanbanBoardCardIdentityProjection {
	const existingProjection = state.projectionsByKanbanBoardCardWorkUnitKey.get(
		buildInterWorkUnitRelationWorkUnitKey(card),
	);
	if (existingProjection) {
		return existingProjection;
	}
	const projection: KanbanBoardCardIdentityProjection = {
		kanbanBoardCard: card,
		kanbanBoardCardFirstObservationRoute: "task_mutation_event_without_prior_creation_or_baseline",
		firstObservedAt: observedAt,
		creationActor: null,
		creationOnBehalfOfInitiatingWorkUnit: null,
		currentFieldValueSha256ByFieldName: {},
		lastKnownBoardColumnId: null,
		movedToTrashColumnAt: null,
		permanentlyRemovedFromBoardAt: null,
	};
	registerKanbanBoardCardIdentityProjection(state, projection);
	return projection;
}

const boardStateBaselineTaskCardSchema = z.object({
	kanbanBoardCard: kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	boardColumnId: z.string().nullable().optional(),
	fieldValueSha256ByFieldName: stringToStringRecordSchema.optional(),
});

function applyBoardStateBaselineObservedAtLiveCaptureActivation(
	state: KanbanBoardCardIdentityProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	const workspaceRepositoryPath = readOptionalString(event.eventPayload.workspaceRepositoryPath);
	if (event.subjectWorkspaceId && workspaceRepositoryPath) {
		state.workspaceRepositoryPathByWorkspaceIdObservedAtBaseline.set(
			event.subjectWorkspaceId,
			workspaceRepositoryPath,
		);
	}
	const baselineTaskCards = Array.isArray(event.eventPayload.baselineTaskCards)
		? event.eventPayload.baselineTaskCards
		: [];
	for (const baselineTaskCardValue of baselineTaskCards) {
		const baselineTaskCard = boardStateBaselineTaskCardSchema.safeParse(baselineTaskCardValue);
		if (!baselineTaskCard.success) {
			continue;
		}
		const card = baselineTaskCard.data.kanbanBoardCard;
		if (state.projectionsByKanbanBoardCardWorkUnitKey.has(buildInterWorkUnitRelationWorkUnitKey(card))) {
			continue;
		}
		const boardColumnId = baselineTaskCard.data.boardColumnId ?? null;
		registerKanbanBoardCardIdentityProjection(state, {
			kanbanBoardCard: card,
			kanbanBoardCardFirstObservationRoute: "board_state_baseline_at_live_capture_activation",
			firstObservedAt: event.occurredAt,
			creationActor: null,
			creationOnBehalfOfInitiatingWorkUnit: null,
			currentFieldValueSha256ByFieldName: { ...(baselineTaskCard.data.fieldValueSha256ByFieldName ?? {}) },
			lastKnownBoardColumnId: boardColumnId,
			movedToTrashColumnAt: boardColumnId === "trash" ? event.occurredAt : null,
			permanentlyRemovedFromBoardAt: null,
		});
	}
}

export function applyCommittedLedgerEventToKanbanBoardCardIdentityProjection(
	state: KanbanBoardCardIdentityProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	if (event.eventKind === "board_state_baseline_observed_at_live_task_mutation_capture_activation") {
		applyBoardStateBaselineObservedAtLiveCaptureActivation(state, event);
		return;
	}
	if (event.eventFamily !== "task_mutation_event") {
		return;
	}
	const card = readKanbanBoardCardReferenceFromLedgerPayloadValue(event.eventPayload.subjectKanbanBoardCard);
	if (!card) {
		return;
	}
	if (event.eventKind === "task_card_created_on_board") {
		const cardKey = buildInterWorkUnitRelationWorkUnitKey(card);
		const knownProjection = state.projectionsByKanbanBoardCardWorkUnitKey.get(cardKey);
		registerKanbanBoardCardIdentityProjection(state, {
			kanbanBoardCard: card,
			kanbanBoardCardFirstObservationRoute: "task_card_created_on_board_within_live_capture",
			firstObservedAt: knownProjection?.firstObservedAt ?? event.occurredAt,
			creationActor: event.actor as KanbanActor,
			fieldValueSha256ByFieldNameAtCreation: readFieldValueSha256ByFieldName(
				event.eventPayload.fieldValueSha256ByFieldNameAtCreation,
			),
			creationOnBehalfOfInitiatingWorkUnit: readInterWorkUnitRelationWorkUnitReferenceFromLedgerValue(
				event.onBehalfOfInitiatingWorkUnit,
			),
			currentFieldValueSha256ByFieldName: readFieldValueSha256ByFieldName(
				event.eventPayload.fieldValueSha256ByFieldNameAtCreation,
			),
			lastKnownBoardColumnId: readOptionalString(event.eventPayload.boardColumnIdAtCreation),
			movedToTrashColumnAt: null,
			permanentlyRemovedFromBoardAt: null,
		});
		return;
	}
	const projection = getOrRegisterKanbanBoardCardIdentityProjection(state, card, event.occurredAt);
	switch (event.eventKind) {
		case "task_card_field_value_changed": {
			const changedTaskCardFieldName = readOptionalString(event.eventPayload.changedTaskCardFieldName);
			if (!changedTaskCardFieldName) {
				return;
			}
			const fieldValueAfterSha256 = readOptionalString(event.eventPayload.fieldValueAfterSha256);
			if (fieldValueAfterSha256) {
				projection.currentFieldValueSha256ByFieldName[changedTaskCardFieldName] = fieldValueAfterSha256;
			} else {
				delete projection.currentFieldValueSha256ByFieldName[changedTaskCardFieldName];
			}
			return;
		}
		case "task_card_moved_between_non_trash_board_columns":
		case "task_card_restored_from_trash_column":
			projection.lastKnownBoardColumnId = readOptionalString(event.eventPayload.toBoardColumnId);
			projection.movedToTrashColumnAt = null;
			return;
		case "task_card_moved_to_trash_column":
			projection.lastKnownBoardColumnId = "trash";
			projection.movedToTrashColumnAt = event.occurredAt;
			return;
		case "task_card_permanently_removed_from_board": {
			projection.permanentlyRemovedFromBoardAt = event.occurredAt;
			projection.lastKnownBoardColumnId = readOptionalString(event.eventPayload.lastBoardColumnIdBeforeRemoval);
			const lastFieldValueSha256ByFieldName = readFieldValueSha256ByFieldName(
				event.eventPayload.lastFieldValueSha256ByFieldNameBeforeRemoval,
			);
			if (Object.keys(lastFieldValueSha256ByFieldName).length > 0) {
				projection.currentFieldValueSha256ByFieldName = lastFieldValueSha256ByFieldName;
			}
			const workspaceAndTaskIdKey = buildWorkspaceAndTaskIdKey(card.workspaceId, card.taskId);
			projection.lastFieldValueSha256ByFieldNameBeforeRemoval = { ...lastFieldValueSha256ByFieldName };
			if (
				state.liveKanbanBoardCardWorkUnitKeyByWorkspaceAndTaskId.get(workspaceAndTaskIdKey) ===
				buildInterWorkUnitRelationWorkUnitKey(card)
			) {
				state.liveKanbanBoardCardWorkUnitKeyByWorkspaceAndTaskId.delete(workspaceAndTaskIdKey);
			}
			return;
		}
		default:
			return;
	}
}

export function findLiveKanbanBoardCardIdentityProjectionByWorkspaceAndTaskId(
	state: KanbanBoardCardIdentityProjectionState,
	workspaceId: string,
	taskId: string,
): KanbanBoardCardIdentityProjection | null {
	const cardKey = state.liveKanbanBoardCardWorkUnitKeyByWorkspaceAndTaskId.get(
		buildWorkspaceAndTaskIdKey(workspaceId, taskId),
	);
	return cardKey ? (state.projectionsByKanbanBoardCardWorkUnitKey.get(cardKey) ?? null) : null;
}

// 裸 id 的全部已知世代（跨 workspace、含墓碑）。仍在 board 上的排前面，其余按最近观测排序。
export function listKanbanBoardCardIdentityProjectionsByBareTaskId(
	state: KanbanBoardCardIdentityProjectionState,
	taskId: string,
): KanbanBoardCardIdentityProjection[] {
	const projections = (state.kanbanBoardCardWorkUnitKeysByBareTaskId.get(taskId) ?? [])
		.map((cardKey) => state.projectionsByKanbanBoardCardWorkUnitKey.get(cardKey))
		.filter((projection): projection is KanbanBoardCardIdentityProjection => projection !== undefined);
	return projections.sort((left, right) => {
		const leftRemoved = left.permanentlyRemovedFromBoardAt !== null ? 1 : 0;
		const rightRemoved = right.permanentlyRemovedFromBoardAt !== null ? 1 : 0;
		if (leftRemoved !== rightRemoved) {
			return leftRemoved - rightRemoved;
		}
		return right.firstObservedAt - left.firstObservedAt;
	});
}
