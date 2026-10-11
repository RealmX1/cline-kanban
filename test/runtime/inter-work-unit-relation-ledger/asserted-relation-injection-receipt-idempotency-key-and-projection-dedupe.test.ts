import { describe, expect, it } from "vitest";

import type {
	CommittedInterWorkUnitRelationLedgerEvent,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	applyInterWorkUnitRelationAssertionLifecycleEvent,
	createEmptyAssertedInterWorkUnitRelationProjectionState,
	listInjectionReceiptsOfAssertedInterWorkUnitRelation,
} from "../../../src/inter-work-unit-relation-ledger/asserted-inter-work-unit-relation-projection-from-ledger-events";
import {
	type AssertedRelationInjectionReceiptPendingSuccessfulSessionLaunch,
	buildAssertedRelationInjectionReceiptEventDrafts,
	buildIdempotencyKeyOfAssertedRelationInjectionReceipt,
} from "../../../src/prompts/inter-work-unit-relation-neighborhood-append-system-prompt";

const injectionSubjectCardB: KanbanBoardCardWorkUnitQualifiedReference = {
	workUnitType: "kanban_board_card",
	workspaceId: "ws-a",
	taskId: "b0002",
	taskIncarnationCreatedAtEpochMs: 2_000,
};

const capturingKanbanRuntimeInstance = {
	kanbanRuntimeInstanceId: "runtime-instance-1",
	kanbanRuntimeProcessId: 4242,
	kanbanRuntimeCodeVersion: "test",
};

function pendingInjectionReceiptOfSessionB0002(
	assertedRelationsListedInInjectedText: AssertedRelationInjectionReceiptPendingSuccessfulSessionLaunch["assertedRelationsListedInInjectedText"],
): AssertedRelationInjectionReceiptPendingSuccessfulSessionLaunch {
	return {
		workspaceId: "ws-a",
		kanbanTaskConversationSessionId: "b0002",
		subjectKanbanBoardCard: injectionSubjectCardB,
		assertedRelationsListedInInjectedText,
	};
}

let nextGlobalCommittedEventSequence = 1;
function committedInjectionReceiptEvent(
	eventPayload: Record<string, unknown>,
	occurredAt: number,
): CommittedInterWorkUnitRelationLedgerEvent {
	const globalCommittedEventSequence = nextGlobalCommittedEventSequence++;
	return {
		eventId: `event-${globalCommittedEventSequence}`,
		globalCommittedEventSequence,
		recordedInSourceOfTruthEventLogAt: occurredAt,
		eventFamily: "inter_work_unit_relation_assertion_lifecycle_event",
		eventKind: "effective_inter_work_unit_relation_assertions_injected_into_conversation_session",
		occurredAt,
		actor: {
			kanbanActorKind: "kanban_runtime_system_component",
			kanbanRuntimeSystemComponentName:
				"kanban_runtime_session_start_inter_work_unit_relation_neighborhood_injector",
		},
		recordCaptureChannel: "live_runtime_capture",
		subjectWorkspaceId: "ws-a",
		subjectTaskId: "b0002",
		eventPayload,
	};
}

describe("asserted relation injection receipt: deterministic idempotency key per (session, relation, version)", () => {
	it("builds one receipt draft per listed relation, each keyed by workspace + Kanban session + relation id + state version", () => {
		const drafts = buildAssertedRelationInjectionReceiptEventDrafts({
			assertedRelationInjectionReceipt: pendingInjectionReceiptOfSessionB0002([
				{ relationId: "asserted-relation-1", assertedRelationStateVersion: 2 },
				{ relationId: "asserted-relation-2", assertedRelationStateVersion: 1 },
			]),
			occurredAt: 5_000,
			capturingKanbanRuntimeInstance,
		});
		expect(drafts.map((draft) => draft.idempotencyKey)).toEqual([
			buildIdempotencyKeyOfAssertedRelationInjectionReceipt({
				workspaceId: "ws-a",
				kanbanTaskConversationSessionId: "b0002",
				relationId: "asserted-relation-1",
				assertedRelationStateVersion: 2,
			}),
			buildIdempotencyKeyOfAssertedRelationInjectionReceipt({
				workspaceId: "ws-a",
				kanbanTaskConversationSessionId: "b0002",
				relationId: "asserted-relation-2",
				assertedRelationStateVersion: 1,
			}),
		]);
		expect(drafts[0]).toMatchObject({
			eventFamily: "inter_work_unit_relation_assertion_lifecycle_event",
			eventKind: "effective_inter_work_unit_relation_assertions_injected_into_conversation_session",
			occurredAt: 5_000,
			capturingKanbanRuntimeInstance,
			subjectWorkspaceId: "ws-a",
			subjectTaskId: "b0002",
			eventPayload: {
				injectedIntoKanbanTaskConversationSession: {
					workspaceId: "ws-a",
					kanbanTaskConversationSessionId: "b0002",
				},
				injectionSubjectKanbanBoardCard: injectionSubjectCardB,
				assertedRelationInjectionChannel: "session_start_append_system_prompt",
				injectedAssertedRelations: [{ relationId: "asserted-relation-1", assertedRelationStateVersion: 2 }],
			},
		});

		// 同一会话重启（同一版本）⇒ 同一把幂等键，worker 原子跳过；关系升版本、或换了会话 ⇒ 新键，照常记。
		const restartDrafts = buildAssertedRelationInjectionReceiptEventDrafts({
			assertedRelationInjectionReceipt: pendingInjectionReceiptOfSessionB0002([
				{ relationId: "asserted-relation-1", assertedRelationStateVersion: 2 },
			]),
			occurredAt: 9_000,
			capturingKanbanRuntimeInstance,
		});
		expect(restartDrafts[0]?.idempotencyKey).toBe(drafts[0]?.idempotencyKey);
		const keyOfVersion3 = buildIdempotencyKeyOfAssertedRelationInjectionReceipt({
			workspaceId: "ws-a",
			kanbanTaskConversationSessionId: "b0002",
			relationId: "asserted-relation-1",
			assertedRelationStateVersion: 3,
		});
		const keyOfAnotherSession = buildIdempotencyKeyOfAssertedRelationInjectionReceipt({
			workspaceId: "ws-a",
			kanbanTaskConversationSessionId: "c0003",
			relationId: "asserted-relation-1",
			assertedRelationStateVersion: 2,
		});
		expect(new Set([drafts[0]?.idempotencyKey, keyOfVersion3, keyOfAnotherSession]).size).toBe(3);
	});
});

describe("asserted relation projection: injection receipts deduplicated per (session, relation, version)", () => {
	it("keeps only the earliest receipt of the same session and version, and still records a new version or another session", () => {
		const state = createEmptyAssertedInterWorkUnitRelationProjectionState();
		const injectionPayload = (kanbanTaskConversationSessionId: string, assertedRelationStateVersion: number) => ({
			injectedIntoKanbanTaskConversationSession: { workspaceId: "ws-a", kanbanTaskConversationSessionId },
			injectedAssertedRelations: [{ relationId: "asserted-relation-1", assertedRelationStateVersion }],
		});
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedInjectionReceiptEvent(injectionPayload("b0002", 2), 10_000),
		);
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedInjectionReceiptEvent(injectionPayload("b0002", 2), 11_000),
		);
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedInjectionReceiptEvent(injectionPayload("b0002", 3), 12_000),
		);
		applyInterWorkUnitRelationAssertionLifecycleEvent(
			state,
			committedInjectionReceiptEvent(injectionPayload("c0003", 2), 13_000),
		);
		expect(listInjectionReceiptsOfAssertedInterWorkUnitRelation(state, "asserted-relation-1")).toEqual([
			expect.objectContaining({
				injectedIntoKanbanTaskConversationSessionId: "b0002",
				injectedAssertedRelationStateVersion: 2,
				injectedAt: 10_000,
			}),
			expect.objectContaining({
				injectedIntoKanbanTaskConversationSessionId: "b0002",
				injectedAssertedRelationStateVersion: 3,
				injectedAt: 12_000,
			}),
			expect.objectContaining({
				injectedIntoKanbanTaskConversationSessionId: "c0003",
				injectedAssertedRelationStateVersion: 2,
				injectedAt: 13_000,
			}),
		]);
	});
});
