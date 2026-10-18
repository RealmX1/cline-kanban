import { z } from "zod";

import {
	type AssertedInterWorkUnitRelation,
	assertedInterWorkUnitRelationSchema,
} from "../core/inter-work-unit-asserted-relation-kind-registry-contract";
import {
	type CommittedInterWorkUnitRelationLedgerEvent,
	type InterWorkUnitRelationWorkUnitReference,
	interWorkUnitRelationWorkUnitReferenceSchema,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import { buildInterWorkUnitRelationWorkUnitKey } from "./kanban-board-card-identity-projection-from-ledger-events";

// dd2db 阶段 2：断言型关系的读时投影（族 4 `inter_work_unit_relation_assertion_lifecycle_event`）。
// 与记录型关系同一个持有器、同一个游标（recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger.ts），
// 不物化：关系 = 族 4 事件 × 投影规则。写侧并发守卫在账本 worker 的当前态表里，那张表也只是可从事件重建的缓存。
// 事件 payload 读时一律防御性解析：账本只追加，旧 / 新 runtime 写的形状都要能读，读不懂的事件跳过不抛错。

const proposedInterWorkUnitRelationAssertionPayloadSchema = z
	.object({
		relationId: z.string(),
		relationKind: z.string(),
		relationStatementSubjectWorkUnitRef: interWorkUnitRelationWorkUnitReferenceSchema,
		relationStatementAnchorWorkUnitRef: interWorkUnitRelationWorkUnitReferenceSchema,
		relationAssertionNaturalKey: z.string(),
		relationAssertionRationaleOneSentence: z.string(),
		relationAssertionEvidencePointers: z.array(z.string()),
		assertedRelationKindSpecificAttributes: z.record(z.string(), z.unknown()),
	})
	.passthrough();

const relationAffectingConfirmableChangeCreatedAndRoutedPayloadSchema = z
	.object({
		relationAffectingConfirmableChangeId: z.string(),
		relationAffectingConfirmableChangeKind: z.string(),
		proposedInterWorkUnitRelationAssertion: proposedInterWorkUnitRelationAssertionPayloadSchema.optional(),
	})
	.passthrough();

const relationAffectingConfirmableChangeAppliedAndEffectivePayloadSchema = z
	.object({
		relationAffectingConfirmableChangeId: z.string(),
		relationAffectingConfirmableChangeKind: z.string(),
		relationAffectingConfirmableChangeDecisionSource: z.string(),
		assertedRelationStateVersionAfterApplication: z.number().int(),
		revokedRelationId: z.string().optional(),
		relationAssertionRevocationReason: z.string().optional(),
	})
	.passthrough();

const reassertionMergedIntoAlreadyEffectiveAssertionPayloadSchema = z
	.object({
		mergedIntoEffectiveRelationId: z.string(),
		reassertionDecisionSource: z.string(),
		reassertionEvidencePointers: z.array(z.string()),
		reassertionKindSpecificAttributes: z.record(z.string(), z.unknown()),
		assertedRelationStateVersionAfterMerge: z.number().int(),
	})
	.passthrough();

const assertionsInjectedIntoConversationSessionPayloadSchema = z
	.object({
		injectedIntoKanbanTaskConversationSession: z.object({
			workspaceId: z.string(),
			kanbanTaskConversationSessionId: z.string(),
		}),
		injectedAssertedRelations: z.array(
			z.object({ relationId: z.string(), assertedRelationStateVersion: z.number().int() }),
		),
	})
	.passthrough();

type ProposedInterWorkUnitRelationAssertionPayload = z.infer<
	typeof proposedInterWorkUnitRelationAssertionPayloadSchema
>;

export interface AssertedInterWorkUnitRelationInjectionReceipt {
	injectedIntoWorkspaceId: string;
	injectedIntoKanbanTaskConversationSessionId: string;
	injectedAssertedRelationStateVersion: number;
	injectedAt: number;
	injectionReceiptEventId: string;
}

export interface AssertedInterWorkUnitRelationProjectionState {
	assertedRelationsByRelationId: Map<string, AssertedInterWorkUnitRelation>;
	assertedRelationIdsByWorkUnitKey: Map<string, Set<string>>;
	// 已创建、还没生效的创建类变更（S1 在同一事务里紧接着生效；2.2 起 S2–S6 会在这里停留）。
	proposedAssertionsOfCreatedChangesAwaitingApplicationByChangeId: Map<
		string,
		{
			proposedAssertion: ProposedInterWorkUnitRelationAssertionPayload;
			createdByEvent: CommittedInterWorkUnitRelationLedgerEvent;
		}
	>;
	injectionReceiptsByRelationId: Map<string, AssertedInterWorkUnitRelationInjectionReceipt[]>;
}

export function createEmptyAssertedInterWorkUnitRelationProjectionState(): AssertedInterWorkUnitRelationProjectionState {
	return {
		assertedRelationsByRelationId: new Map(),
		assertedRelationIdsByWorkUnitKey: new Map(),
		proposedAssertionsOfCreatedChangesAwaitingApplicationByChangeId: new Map(),
		injectionReceiptsByRelationId: new Map(),
	};
}

function readActingWorkUnitOfLedgerEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
): InterWorkUnitRelationWorkUnitReference | null {
	const actor = event.actor as Record<string, unknown>;
	const actingWorkUnit =
		actor.kanbanActorKind === "kanban_board_card_work_unit"
			? actor.actingKanbanBoardCardWorkUnit
			: actor.kanbanActorKind === "kanban_unmanaged_standalone_agent_conversation_session_work_unit"
				? actor.actingStandaloneAgentConversationSession
				: null;
	const parsed = interWorkUnitRelationWorkUnitReferenceSchema.safeParse(actingWorkUnit);
	return parsed.success ? parsed.data : null;
}

function readRelationProposerWorkUnitRefOfCreatedChangeEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
): InterWorkUnitRelationWorkUnitReference | null {
	const parsed = interWorkUnitRelationWorkUnitReferenceSchema.safeParse(
		event.eventPayload.relationProposerWorkUnitRef,
	);
	return parsed.success ? parsed.data : null;
}

// 重断言方工作单元以写入时按会话归属解析过的那一个为准；旧事件没有该字段时退用行动者（Web UI 用户两者皆无 → 不是 agent 贡献方）。
function readReassertingProposerWorkUnitRefOfMergedReassertionEvent(
	event: CommittedInterWorkUnitRelationLedgerEvent,
): InterWorkUnitRelationWorkUnitReference | null {
	const parsed = interWorkUnitRelationWorkUnitReferenceSchema.safeParse(
		event.eventPayload.reassertingProposerWorkUnitRef,
	);
	return parsed.success ? parsed.data : readActingWorkUnitOfLedgerEvent(event);
}

function addAssertedRelationIdToWorkUnitIndex(
	state: AssertedInterWorkUnitRelationProjectionState,
	workUnit: InterWorkUnitRelationWorkUnitReference,
	relationId: string,
): void {
	const workUnitKey = buildInterWorkUnitRelationWorkUnitKey(workUnit);
	const relationIds = state.assertedRelationIdsByWorkUnitKey.get(workUnitKey) ?? new Set();
	relationIds.add(relationId);
	state.assertedRelationIdsByWorkUnitKey.set(workUnitKey, relationIds);
}

function unionPreservingOrder(existingValues: string[], addedValues: string[]): string[] {
	return [...new Set([...existingValues, ...addedValues])];
}

// d-vocab §2.4 重断言：标量属性直接替换；列表属性并集去重；核验中的论断按 claimSummary 合并（新判定覆盖旧判定）。
export function mergeAssertedReferenceRelationKindSpecificAttributesOnReassertion(
	existingAttributes: Record<string, unknown>,
	reassertionAttributes: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...existingAttributes };
	for (const [attributeKey, reassertedValue] of Object.entries(reassertionAttributes)) {
		if (reassertedValue === undefined) {
			continue;
		}
		const existingValue = merged[attributeKey];
		if (attributeKey === "claimsUnderVerification" && Array.isArray(reassertedValue)) {
			const claimsBySummary = new Map<string, unknown>();
			for (const claim of [...(Array.isArray(existingValue) ? existingValue : []), ...reassertedValue]) {
				const claimSummary = (claim as { claimSummary?: unknown }).claimSummary;
				if (typeof claimSummary === "string") {
					claimsBySummary.set(claimSummary, claim);
				}
			}
			merged[attributeKey] = [...claimsBySummary.values()];
		} else if (Array.isArray(reassertedValue)) {
			merged[attributeKey] = unionPreservingOrder(
				(Array.isArray(existingValue) ? existingValue : []).filter(
					(value): value is string => typeof value === "string",
				),
				reassertedValue.filter((value): value is string => typeof value === "string"),
			);
		} else {
			merged[attributeKey] = reassertedValue;
		}
	}
	return merged;
}

function applyRelationAffectingConfirmableChangeCreatedAndRoutedEvent(
	state: AssertedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	const payload = relationAffectingConfirmableChangeCreatedAndRoutedPayloadSchema.safeParse(event.eventPayload);
	if (!payload.success || !payload.data.proposedInterWorkUnitRelationAssertion) {
		return;
	}
	state.proposedAssertionsOfCreatedChangesAwaitingApplicationByChangeId.set(
		payload.data.relationAffectingConfirmableChangeId,
		{ proposedAssertion: payload.data.proposedInterWorkUnitRelationAssertion, createdByEvent: event },
	);
}

function applyRelationAffectingConfirmableChangeAppliedAndEffectiveEvent(
	state: AssertedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	const payload = relationAffectingConfirmableChangeAppliedAndEffectivePayloadSchema.safeParse(event.eventPayload);
	if (!payload.success) {
		return;
	}
	const applied = payload.data;
	if (applied.relationAffectingConfirmableChangeKind === "applied_asserted_relation_or_work_unit_gate_revocation") {
		const revokedRelation = applied.revokedRelationId
			? state.assertedRelationsByRelationId.get(applied.revokedRelationId)
			: undefined;
		if (!revokedRelation) {
			return;
		}
		revokedRelation.assertionEffectivenessState = "revoked";
		revokedRelation.assertedRelationStateVersion = applied.assertedRelationStateVersionAfterApplication;
		revokedRelation.relationLastUpdatedAt = event.occurredAt;
		revokedRelation.revokedAt = event.occurredAt;
		revokedRelation.relationAssertionRevocationReason = applied.relationAssertionRevocationReason ?? null;
		revokedRelation.revokedByActorKind = event.actor.kanbanActorKind;
		return;
	}
	const created = state.proposedAssertionsOfCreatedChangesAwaitingApplicationByChangeId.get(
		applied.relationAffectingConfirmableChangeId,
	);
	if (!created) {
		return;
	}
	state.proposedAssertionsOfCreatedChangesAwaitingApplicationByChangeId.delete(
		applied.relationAffectingConfirmableChangeId,
	);
	const proposed = created.proposedAssertion;
	// 断言方工作单元以写入时按会话归属解析过的那一个为准（独立会话已被卡采纳时是那张卡）；旧事件没有该字段时退用行动者。
	const relationAsserterWorkUnitRef =
		readRelationProposerWorkUnitRefOfCreatedChangeEvent(created.createdByEvent) ??
		readActingWorkUnitOfLedgerEvent(created.createdByEvent);
	const relation: AssertedInterWorkUnitRelation = {
		relationId: proposed.relationId,
		relationKind: proposed.relationKind,
		relationStatementSubjectWorkUnitRef: proposed.relationStatementSubjectWorkUnitRef,
		relationStatementAnchorWorkUnitRef: proposed.relationStatementAnchorWorkUnitRef,
		relationAssertionNaturalKey: proposed.relationAssertionNaturalKey,
		assertionEffectivenessState: "applied_and_effective",
		assertedRelationStateVersion: applied.assertedRelationStateVersionAfterApplication,
		relationFirstEstablishedAt: event.occurredAt,
		relationLastUpdatedAt: event.occurredAt,
		relationAsserterActorKind: created.createdByEvent.actor.kanbanActorKind,
		relationAsserterWorkUnitRef,
		relationAsserterPolicyIdentityKey:
			typeof created.createdByEvent.eventPayload.relationProposerPolicyIdentityKey === "string"
				? created.createdByEvent.eventPayload.relationProposerPolicyIdentityKey
				: null,
		relationContributingAgentWorkUnitRefs: relationAsserterWorkUnitRef ? [relationAsserterWorkUnitRef] : [],
		relationAssertionRationaleOneSentence: proposed.relationAssertionRationaleOneSentence,
		relationAssertionEvidencePointers: [...proposed.relationAssertionEvidencePointers],
		assertedRelationKindSpecificAttributes: structuredClone(proposed.assertedRelationKindSpecificAttributes),
		effectiveConfirmableChangeIdForCurrentAssertionState: applied.relationAffectingConfirmableChangeId,
		effectiveConfirmableChangeDecisionSource: applied.relationAffectingConfirmableChangeDecisionSource,
		effectiveConfirmableChangeAppliedAt: event.occurredAt,
		decisionSourcesOfEffectiveAssertion: [applied.relationAffectingConfirmableChangeDecisionSource],
		reassertingActorKinds: [],
		revokedAt: null,
		relationAssertionRevocationReason: null,
		revokedByActorKind: null,
	};
	state.assertedRelationsByRelationId.set(relation.relationId, relation);
	addAssertedRelationIdToWorkUnitIndex(state, relation.relationStatementSubjectWorkUnitRef, relation.relationId);
	addAssertedRelationIdToWorkUnitIndex(state, relation.relationStatementAnchorWorkUnitRef, relation.relationId);
}

function applyReassertionMergedIntoAlreadyEffectiveAssertionEvent(
	state: AssertedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	const payload = reassertionMergedIntoAlreadyEffectiveAssertionPayloadSchema.safeParse(event.eventPayload);
	if (!payload.success) {
		return;
	}
	const merged = payload.data;
	const relation = state.assertedRelationsByRelationId.get(merged.mergedIntoEffectiveRelationId);
	if (!relation || relation.assertionEffectivenessState !== "applied_and_effective") {
		return;
	}
	relation.relationAssertionEvidencePointers = unionPreservingOrder(
		relation.relationAssertionEvidencePointers,
		merged.reassertionEvidencePointers,
	);
	relation.assertedRelationKindSpecificAttributes = mergeAssertedReferenceRelationKindSpecificAttributesOnReassertion(
		relation.assertedRelationKindSpecificAttributes,
		merged.reassertionKindSpecificAttributes,
	);
	relation.decisionSourcesOfEffectiveAssertion = unionPreservingOrder(relation.decisionSourcesOfEffectiveAssertion, [
		merged.reassertionDecisionSource,
	]);
	relation.reassertingActorKinds = unionPreservingOrder(relation.reassertingActorKinds, [event.actor.kanbanActorKind]);
	// 对称 kind 的另一端点也会并进来：记下这次并入内容的 agent 工作单元，渲染据此判断内容是不是读者自己写的（RVF-002）。
	const reassertingProposerWorkUnitRef = readReassertingProposerWorkUnitRefOfMergedReassertionEvent(event);
	if (
		reassertingProposerWorkUnitRef &&
		!relation.relationContributingAgentWorkUnitRefs.some(
			(contributingWorkUnit) =>
				buildInterWorkUnitRelationWorkUnitKey(contributingWorkUnit) ===
				buildInterWorkUnitRelationWorkUnitKey(reassertingProposerWorkUnitRef),
		)
	) {
		relation.relationContributingAgentWorkUnitRefs = [
			...relation.relationContributingAgentWorkUnitRefs,
			reassertingProposerWorkUnitRef,
		];
	}
	relation.assertedRelationStateVersion = merged.assertedRelationStateVersionAfterMerge;
	relation.relationLastUpdatedAt = event.occurredAt;
}

function applyAssertionsInjectedIntoConversationSessionEvent(
	state: AssertedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	const payload = assertionsInjectedIntoConversationSessionPayloadSchema.safeParse(event.eventPayload);
	if (!payload.success) {
		return;
	}
	const session = payload.data.injectedIntoKanbanTaskConversationSession;
	for (const injected of payload.data.injectedAssertedRelations) {
		const receipts = state.injectionReceiptsByRelationId.get(injected.relationId) ?? [];
		// 同一（会话，关系，版本）只留最早那一条：写侧的幂等键已挡住同一会话重启的重复回执，这里兜住幂等键之外
		// 重复记下的（例如不带幂等键的旧回执），免得修订通知对同一会话的同一版本重复通知。
		const sameSessionSameVersionReceiptAlreadyProjected = receipts.some(
			(receipt) =>
				receipt.injectedIntoWorkspaceId === session.workspaceId &&
				receipt.injectedIntoKanbanTaskConversationSessionId === session.kanbanTaskConversationSessionId &&
				receipt.injectedAssertedRelationStateVersion === injected.assertedRelationStateVersion,
		);
		if (sameSessionSameVersionReceiptAlreadyProjected) {
			continue;
		}
		receipts.push({
			injectedIntoWorkspaceId: session.workspaceId,
			injectedIntoKanbanTaskConversationSessionId: session.kanbanTaskConversationSessionId,
			injectedAssertedRelationStateVersion: injected.assertedRelationStateVersion,
			injectedAt: event.occurredAt,
			injectionReceiptEventId: event.eventId,
		});
		state.injectionReceiptsByRelationId.set(injected.relationId, receipts);
	}
}

export function applyInterWorkUnitRelationAssertionLifecycleEvent(
	state: AssertedInterWorkUnitRelationProjectionState,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): void {
	switch (event.eventKind) {
		case "reference_relation_modeling_changes_applied_by_web_ui_user": {
			const parsed = z.array(assertedInterWorkUnitRelationSchema).safeParse(event.eventPayload.relationsAfterChange);
			if (!parsed.success) return;
			for (const relation of parsed.data) {
				state.assertedRelationsByRelationId.set(relation.relationId, relation);
				addAssertedRelationIdToWorkUnitIndex(
					state,
					relation.relationStatementSubjectWorkUnitRef,
					relation.relationId,
				);
				addAssertedRelationIdToWorkUnitIndex(
					state,
					relation.relationStatementAnchorWorkUnitRef,
					relation.relationId,
				);
			}
			return;
		}
		case "relation_affecting_confirmable_change_created_and_routed":
			applyRelationAffectingConfirmableChangeCreatedAndRoutedEvent(state, event);
			return;
		case "relation_affecting_confirmable_change_applied_and_effective":
			applyRelationAffectingConfirmableChangeAppliedAndEffectiveEvent(state, event);
			return;
		case "inter_work_unit_relation_reassertion_merged_into_already_effective_assertion":
			applyReassertionMergedIntoAlreadyEffectiveAssertionEvent(state, event);
			return;
		case "effective_inter_work_unit_relation_assertions_injected_into_conversation_session":
			applyAssertionsInjectedIntoConversationSessionEvent(state, event);
			return;
		default:
			return;
	}
}

function copyAssertedInterWorkUnitRelation(relation: AssertedInterWorkUnitRelation): AssertedInterWorkUnitRelation {
	return structuredClone(relation);
}

// 一个工作单元的一度断言型邻域；默认只给生效中的（撤销的只在审计 / 面板历史里有用），按建立时间排序，返回副本。
export function listAssertedInterWorkUnitRelationsTouchingWorkUnit(
	state: AssertedInterWorkUnitRelationProjectionState,
	workUnit: InterWorkUnitRelationWorkUnitReference,
	options: { includeRevokedAssertions?: boolean } = {},
): AssertedInterWorkUnitRelation[] {
	const relations: AssertedInterWorkUnitRelation[] = [];
	for (const relationId of state.assertedRelationIdsByWorkUnitKey.get(
		buildInterWorkUnitRelationWorkUnitKey(workUnit),
	) ?? []) {
		const relation = state.assertedRelationsByRelationId.get(relationId);
		if (!relation) {
			continue;
		}
		if (relation.assertionEffectivenessState !== "applied_and_effective" && !options.includeRevokedAssertions) {
			continue;
		}
		relations.push(copyAssertedInterWorkUnitRelation(relation));
	}
	return relations.sort((left, right) => left.relationFirstEstablishedAt - right.relationFirstEstablishedAt);
}

export function findAssertedInterWorkUnitRelationByRelationId(
	state: AssertedInterWorkUnitRelationProjectionState,
	relationId: string,
): AssertedInterWorkUnitRelation | null {
	const relation = state.assertedRelationsByRelationId.get(relationId);
	return relation ? copyAssertedInterWorkUnitRelation(relation) : null;
}

export function findEffectiveAssertedInterWorkUnitRelationByNaturalKey(
	state: AssertedInterWorkUnitRelationProjectionState,
	relationAssertionNaturalKey: string,
): AssertedInterWorkUnitRelation | null {
	for (const relation of state.assertedRelationsByRelationId.values()) {
		if (
			relation.relationAssertionNaturalKey === relationAssertionNaturalKey &&
			relation.assertionEffectivenessState === "applied_and_effective"
		) {
			return copyAssertedInterWorkUnitRelation(relation);
		}
	}
	return null;
}

export function listInjectionReceiptsOfAssertedInterWorkUnitRelation(
	state: AssertedInterWorkUnitRelationProjectionState,
	relationId: string,
): AssertedInterWorkUnitRelationInjectionReceipt[] {
	return [...(state.injectionReceiptsByRelationId.get(relationId) ?? [])];
}
