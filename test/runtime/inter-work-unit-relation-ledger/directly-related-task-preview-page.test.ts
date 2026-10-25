import { describe, expect, it, vi } from "vitest";
import type { AssertedInterWorkUnitRelation } from "../../../src/core/inter-work-unit-asserted-relation-kind-registry-contract";
import type { RecordedInterWorkUnitRelation } from "../../../src/core/inter-work-unit-recorded-relation-projection-contract";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import { assembleDirectlyRelatedTaskPreviewPage } from "../../../src/inter-work-unit-relation-ledger/directly-related-task-preview-page";
import { buildInterWorkUnitRelationWorkUnitKey } from "../../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { createEmptyRecordedInterWorkUnitRelationProjectionState } from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";

const task = (taskId: string, workspaceId = "project-a", createdAt = 1): KanbanBoardCardWorkUnitQualifiedReference => ({
	workUnitType: "kanban_board_card",
	workspaceId,
	taskId,
	taskIncarnationCreatedAtEpochMs: createdAt,
});

function createPreviewHarness() {
	const projectionState = createEmptyRecordedInterWorkUnitRelationProjectionState();
	const subject = task("subject");
	const readRetainedTaskCardFieldValuesBySha256 = vi.fn(
		async (hashes: string[]) => new Map(hashes.map((hash) => [hash, `标题 ${hash}`])),
	);
	const reader = {
		projectionState,
		readRetainedTaskCardFieldValuesBySha256,
		findRetainedTaskCardFieldKeywordMatchesBySha256: vi.fn(async () => new Map<string, number[]>()),
	};
	const addTask = (reference: KanbanBoardCardWorkUnitQualifiedReference) => {
		projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.set(
			buildInterWorkUnitRelationWorkUnitKey(reference),
			{
				kanbanBoardCard: reference,
				kanbanBoardCardFirstObservationRoute: "board_state_baseline_at_live_capture_activation",
				firstObservedAt: 1,
				creationActor: null,
				creationOnBehalfOfInitiatingWorkUnit: null,
				currentFieldValueSha256ByFieldName: { title: reference.taskId, prompt: `prompt-${reference.taskId}` },
				lastKnownBoardColumnId: "review",
				movedToTrashColumnAt: null,
				permanentlyRemovedFromBoardAt: null,
			},
		);
	};
	const addRecorded = (
		id: string,
		neighbor: RecordedInterWorkUnitRelation["relationStatementAnchorWorkUnitRef"],
		muted = false,
	) => {
		const relation: RecordedInterWorkUnitRelation = {
			relationId: id,
			relationKind: "interaction_agent_session_dispatched_or_controlled_by",
			relationStatementSubjectWorkUnitRef: subject,
			relationStatementAnchorWorkUnitRef: neighbor,
			relationFirstEstablishedAt: 1,
			relationLastUpdatedAt: 1,
			mostRecentProjectedFromEventIds: [],
			captureChannelsOfDerivingEvents: [],
			occurrenceCountByTaskMutationEventKind: {},
			recordedRelationKindSpecificAttributes: {},
			isCreationTimePrimaryProvenanceOfSubjectCard: false,
			mutedInPresentationAt: null,
			mutedInPresentationByActorKind: null,
		};
		projectionState.recordedRelationsByRelationId.set(id, relation);
		const key = buildInterWorkUnitRelationWorkUnitKey(subject);
		projectionState.recordedRelationIdsByWorkUnitKey.set(
			key,
			new Set([...(projectionState.recordedRelationIdsByWorkUnitKey.get(key) ?? []), id]),
		);
		if (muted)
			projectionState.presentationMuteStateByRelationId.set(id, {
				mutedInPresentationAt: 2,
				mutedInPresentationByActorKind: "web_ui_user",
			});
	};
	const addAsserted = (id: string, neighbor: KanbanBoardCardWorkUnitQualifiedReference, effective = true) => {
		const relation: AssertedInterWorkUnitRelation = {
			relationId: id,
			relationKind: "reference_is_generally_related_with",
			relationStatementSubjectWorkUnitRef: neighbor,
			relationStatementAnchorWorkUnitRef: subject,
			relationAssertionNaturalKey: id,
			assertionEffectivenessState: effective ? "applied_and_effective" : "revoked",
			assertedRelationStateVersion: 1,
			relationFirstEstablishedAt: 1,
			relationLastUpdatedAt: 1,
			relationAsserterActorKind: "web_ui_user",
			relationAsserterWorkUnitRef: null,
			relationAsserterPolicyIdentityKey: null,
			relationContributingAgentWorkUnitRefs: [],
			relationAssertionRationaleOneSentence: "不应读取的大段说明",
			relationAssertionEvidencePointers: ["不应读取的证据"],
			assertedRelationKindSpecificAttributes: {},
			effectiveConfirmableChangeIdForCurrentAssertionState: id,
			effectiveConfirmableChangeDecisionSource: "web_ui_user_direct_assertion",
			effectiveConfirmableChangeAppliedAt: 1,
			decisionSourcesOfEffectiveAssertion: ["web_ui_user_direct_assertion"],
			reassertingActorKinds: [],
			revokedAt: null,
			relationAssertionRevocationReason: null,
			revokedByActorKind: null,
		};
		const state = projectionState.assertedInterWorkUnitRelationProjectionState;
		state.assertedRelationsByRelationId.set(id, relation);
		const key = buildInterWorkUnitRelationWorkUnitKey(subject);
		state.assertedRelationIdsByWorkUnitKey.set(
			key,
			new Set([...(state.assertedRelationIdsByWorkUnitKey.get(key) ?? []), id]),
		);
	};
	addTask(subject);
	const read = (cursor?: string) =>
		assembleDirectlyRelatedTaskPreviewPage(reader, { task: subject, cursor }, () => "/repo");
	return { subject, reader, addTask, addRecorded, addAsserted, read };
}

describe("直接关联任务的轻量分页预览", () => {
	it("合并记录和有效声明，完整身份去重，独立会话不混入任务列表", async () => {
		const h = createPreviewHarness();
		const first = task("same"),
			otherProject = task("same", "project-b"),
			otherIncarnation = task("same", "project-a", 2);
		for (const neighbor of [first, otherProject, otherIncarnation]) {
			h.addTask(neighbor);
			h.addRecorded(JSON.stringify(neighbor), neighbor);
		}
		h.addAsserted("asserted", first);
		h.addAsserted("revoked", task("revoked"), false);
		h.addRecorded("session", {
			workUnitType: "kanban_unmanaged_standalone_agent_conversation_session",
			conversationSessionHostKanbanAgentId: "codex",
			nativeConversationSessionId: "session",
		});
		const page = await h.read();
		expect(page.totalTaskCount).toBe(3);
		expect(page.standaloneSessionCount).toBe(1);
		expect(
			page.entries.find(
				(entry) =>
					entry.task.taskId === "same" &&
					entry.task.workspaceId === "project-a" &&
					entry.task.taskIncarnationCreatedAtEpochMs === 1,
			)?.relations,
		).toHaveLength(2);
		expect(JSON.stringify(page)).not.toContain("不应读取");
		expect(h.reader.readRetainedTaskCardFieldValuesBySha256).toHaveBeenCalledWith(["same"]);
	});

	it("1000 个邻居能完整分页遍历，每页最多读取 20 个标题，静音单列", async () => {
		const h = createPreviewHarness();
		for (let index = 0; index < 1000; index++) {
			const neighbor = task(`neighbor-${String(index).padStart(4, "0")}`);
			h.addTask(neighbor);
			h.addRecorded(`relation-${index}`, neighbor, index === 999);
		}
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await h.read(cursor);
			expect(page.totalTaskCount).toBe(1000);
			expect(page.mutedOnlyTaskCount).toBe(1);
			expect(page.entries.length).toBeLessThanOrEqual(20);
			keys.push(...page.entries.map((entry) => entry.task.taskId));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(new Set(keys).size).toBe(1000);
		for (const [hashes] of h.reader.readRetainedTaskCardFieldValuesBySha256.mock.calls) {
			expect(hashes.length).toBeLessThanOrEqual(20);
			expect(hashes.some((hash) => hash.startsWith("prompt-"))).toBe(false);
		}
	});

	it("无关全局事件不打断分页，主体邻域变化返回可恢复的失效结果", async () => {
		const h = createPreviewHarness();
		for (let index = 0; index < 21; index++) {
			h.addTask(task(String(index)));
			h.addRecorded(String(index), task(String(index)));
		}
		const first = await h.read();
		h.reader.projectionState.lastAppliedGlobalCommittedEventSequence += 1;
		expect((await h.read(first.nextCursor ?? undefined)).entries).toHaveLength(1);
		h.addRecorded("new", task("new"));
		await expect(h.read(first.nextCursor ?? undefined)).rejects.toMatchObject({
			code: "CONFLICT",
			message: "RELATED_TASK_PREVIEW_PAGE_EXPIRED",
		});
	});

	it("只读旧一世的墓碑，不把同裸 ID 的新卡当旧卡；主体未知不冒充空列表", async () => {
		const h = createPreviewHarness();
		const oldTask = task("reused");
		h.addTask(oldTask);
		h.addTask(task("reused", "project-a", 2));
		const identity =
			h.reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.get(
				buildInterWorkUnitRelationWorkUnitKey(oldTask),
			);
		if (identity) {
			identity.permanentlyRemovedFromBoardAt = 5;
			identity.lastKnownBoardColumnId = "trash";
		}
		h.addRecorded("old", oldTask, true);
		const page = await h.read();
		expect(page.entries[0]).toMatchObject({ task: oldTask, permanentlyRemovedFromBoardAt: 5, mutedOnly: true });
		h.reader.projectionState.kanbanBoardCardIdentityProjectionState.projectionsByKanbanBoardCardWorkUnitKey.delete(
			buildInterWorkUnitRelationWorkUnitKey(h.subject),
		);
		await expect(h.read()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
