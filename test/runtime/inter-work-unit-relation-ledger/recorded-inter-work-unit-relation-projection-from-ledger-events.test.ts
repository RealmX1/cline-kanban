import { describe, expect, it } from "vitest";
import { RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY } from "../../../src/core/inter-work-unit-recorded-relation-projection-contract";
import type {
	CommittedInterWorkUnitRelationLedgerEvent,
	KanbanBoardCardWorkUnitQualifiedReference,
} from "../../../src/core/inter-work-unit-relation-ledger-event-contract";
import {
	listConversationSessionOwnershipConflictDiagnosticsTouchingWorkUnit,
	listConversationSessionOwnershipPeriodsOfWorkUnit,
} from "../../../src/inter-work-unit-relation-ledger/conversation-session-ownership-period-projection-from-ledger-events";
import { listKanbanBoardCardIdentityProjectionsByBareTaskId } from "../../../src/inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import {
	applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection,
	createEmptyRecordedInterWorkUnitRelationProjectionState,
	createEmptyRecordedInterWorkUnitRelationProjectionStateInheritingLiveCaptureActivationSeededFactIndex,
	isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact,
	listRecordedInterWorkUnitRelationsTouchingWorkUnit,
	type RecordedInterWorkUnitRelationProjectionState,
} from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-from-ledger-events";
import {
	type InterWorkUnitRelationLedgerReadCapabilitiesUsedByRecordedRelationProjectionCatchUp,
	RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger,
	type RecordedInterWorkUnitRelationProjectionReader,
} from "../../../src/inter-work-unit-relation-ledger/recorded-inter-work-unit-relation-projection-kept-caught-up-with-ledger";
import { assembleRecordedRelationNeighborhoodSummaryOfWorkUnit } from "../../../src/inter-work-unit-relation-ledger/work-unit-relation-neighborhood-summary-assembly";

function card(workspaceId: string, taskId: string, incarnation = 1_000): KanbanBoardCardWorkUnitQualifiedReference {
	return { workUnitType: "kanban_board_card", workspaceId, taskId, taskIncarnationCreatedAtEpochMs: incarnation };
}

const PARENT = card("ws-a", "p0001");
const CHILD = card("ws-b", "c0001", 2_000);

it("侧会话分出复用建卡账本投影真实来源，不把内部固定种子投影成匿名来源", () => {
	const ledger = new SyntheticLedger();
	ledger.cardCreated(PARENT);
	ledger.retainedFieldValueCanonicalJsonBySha256.set(
		"side-origin",
		JSON.stringify({
			creationRequestId: "11111111-1111-4111-8111-111111111111",
			sourceWorkspaceId: PARENT.workspaceId,
			sourceTaskId: PARENT.taskId,
			sourceTaskConversationSessionId: "peer",
			sourceNativeSessionId: "original-native",
			sourceContextCapturedAt: 1,
			contextInheritance: "fork_source_conversation",
			worktreeSource: "copy_source_git_working_state_immediately",
			contextArtifactDirectory: "/persistent/source",
			inheritedGitHeadCommit: "inherited-head",
		}),
	);
	ledger.retainedFieldValueCanonicalJsonBySha256.set(
		"internal-seed",
		JSON.stringify({
			sourceAgentId: "codex",
			sourceSessionId: "immutable-seed",
			sourceSessionReuseMode: "fork_existing_session",
		}),
	);
	ledger.cardCreated(CHILD, undefined, {
		fieldValueSha256ByFieldNameAtCreation: {
			independentTaskCreationProvenance: "side-origin",
			taskAgentSessionInitialization: "internal-seed",
		},
	});
	ledger.identityObserved(CHILD, "codex", "new-task-native");
	const relations = listRecordedInterWorkUnitRelationsTouchingWorkUnit(ledger.project(), CHILD);
	expect(relations).toHaveLength(1);
	expect(relations[0]).toMatchObject({
		relationKind: "provenance_split_from_side_conversation_of",
		relationStatementAnchorWorkUnitRef: PARENT,
		isCreationTimePrimaryProvenanceOfSubjectCard: true,
		recordedRelationKindSpecificAttributes: {
			sourceTaskConversationSessionId: "peer",
			inheritedGitHeadCommit: "inherited-head",
		},
	});
});

// 照真实写入端（buildAgentConversationSessionNativeIdentityEventDraft）：subjectTaskId = kanban 会话 id，
// 所属卡在 taskConversationSessionMetadata.workspaceTaskId。主会话的 kanban 会话 id 等于卡 id。
interface KanbanTaskConversationSessionWithNativeIdentity {
	kanbanTaskConversationSessionId?: string;
	taskConversationSessionRole?: "main" | "by_the_way" | "task_collaborator";
	agentId: string;
	nativeId: string;
	sidecarObservedAt: number;
}

interface KanbanBoardCardSeededAtLiveCaptureActivation {
	card: KanbanBoardCardWorkUnitQualifiedReference;
	boardColumnId: string;
	sessions?: KanbanTaskConversationSessionWithNativeIdentity[];
	initialization?: {
		sourceAgentId: string;
		sourceSessionId: string;
		sourceSessionReuseMode: "resume_existing_session" | "fork_existing_session";
	};
}

function buildConversationSessionIdentityEventFields(
	owningCard: KanbanBoardCardWorkUnitQualifiedReference,
	session: KanbanTaskConversationSessionWithNativeIdentity,
) {
	const kanbanTaskConversationSessionId = session.kanbanTaskConversationSessionId ?? owningCard.taskId;
	const taskConversationSessionRole = session.taskConversationSessionRole ?? "main";
	return {
		subjectWorkspaceId: owningCard.workspaceId,
		subjectTaskId: kanbanTaskConversationSessionId,
		eventPayload: {
			kanbanTaskConversationSessionId,
			sessionSummaryAgentId: session.agentId,
			conversationSessionIdentityKey: {
				conversationSessionHostKanbanAgentId: session.agentId,
				nativeConversationSessionId: session.nativeId,
			},
			agentNativeConversationSessionIdentityObservedAt: session.sidecarObservedAt,
			agentNativeConversationSessionTranscriptPath: null,
			taskConversationSessionMetadata: {
				workspaceTaskId: owningCard.taskId,
				taskConversationSessionRole,
				taskConversationSessionContextSource:
					taskConversationSessionRole === "main" ? "main" : "started_from_scratch",
				parentTaskConversationSessionId: taskConversationSessionRole === "main" ? null : owningCard.taskId,
				mainSessionOriginTurnNumber: null,
				mainSessionOriginUserMessagePreview: null,
				latestUserMessagePreview: null,
			},
		},
	};
}

class SyntheticLedger {
	private nextSequence = 1;
	readonly events: CommittedInterWorkUnitRelationLedgerEvent[] = [];
	readonly retainedFieldValueCanonicalJsonBySha256 = new Map<string, string>();

	append(input: {
		eventFamily: string;
		eventKind: string;
		actor?: Record<string, unknown>;
		subjectWorkspaceId?: string | null;
		subjectTaskId?: string | null;
		eventPayload: Record<string, unknown>;
		onBehalfOfInitiatingWorkUnit?: unknown;
		occurredAt?: number;
	}): void {
		const sequence = this.nextSequence++;
		this.events.push({
			eventId: `event-${sequence}`,
			globalCommittedEventSequence: sequence,
			recordedInSourceOfTruthEventLogAt: sequence,
			eventFamily: input.eventFamily,
			eventKind: input.eventKind,
			occurredAt: input.occurredAt ?? sequence * 100,
			actor: (input.actor ?? {
				kanbanActorKind: "kanban_runtime_system_component",
				kanbanRuntimeSystemComponentName: "test",
			}) as { kanbanActorKind: string },
			recordCaptureChannel: "live_runtime_capture",
			subjectWorkspaceId: input.subjectWorkspaceId ?? null,
			subjectTaskId: input.subjectTaskId ?? null,
			onBehalfOfInitiatingWorkUnit: input.onBehalfOfInitiatingWorkUnit ?? null,
			eventPayload: input.eventPayload,
		});
	}

	cardCreated(subject: KanbanBoardCardWorkUnitQualifiedReference, actor?: Record<string, unknown>, extra = {}): void {
		this.append({
			eventFamily: "task_mutation_event",
			eventKind: "task_card_created_on_board",
			actor,
			subjectWorkspaceId: subject.workspaceId,
			subjectTaskId: subject.taskId,
			eventPayload: {
				subjectKanbanBoardCard: subject,
				boardColumnIdAtCreation: "backlog",
				fieldValueSha256ByFieldNameAtCreation: { title: `title-of-${subject.taskId}` },
				...extra,
			},
		});
	}

	taskMutation(
		eventKind: string,
		subject: KanbanBoardCardWorkUnitQualifiedReference,
		actor: Record<string, unknown>,
		payload: Record<string, unknown>,
	): void {
		this.append({
			eventFamily: "task_mutation_event",
			eventKind,
			actor,
			subjectWorkspaceId: subject.workspaceId,
			subjectTaskId: subject.taskId,
			eventPayload: { subjectKanbanBoardCard: subject, ...payload },
		});
	}

	identityObserved(subject: KanbanBoardCardWorkUnitQualifiedReference, agentId: string, nativeId: string): void {
		this.append({
			eventFamily: "agent_conversation_session_identity_event",
			eventKind: "new_native_conversation_session_identity_observed_for_kanban_task_conversation_session",
			subjectWorkspaceId: subject.workspaceId,
			subjectTaskId: subject.taskId,
			eventPayload: {
				kanbanTaskConversationSessionId: subject.taskId,
				conversationSessionIdentityKey: {
					conversationSessionHostKanbanAgentId: agentId,
					nativeConversationSessionId: nativeId,
				},
			},
		});
	}

	// 照真实写入端的激活批次顺序：board 基线 → 每个 kanban 会话的身份 sidecar → 每张卡的初始化 sidecar。
	liveCaptureActivationBatch(workspaceId: string, seededCards: KanbanBoardCardSeededAtLiveCaptureActivation[]): void {
		this.append({
			eventFamily: "fact_observed_by_kanban_runtime_event",
			eventKind: "board_state_baseline_observed_at_live_task_mutation_capture_activation",
			subjectWorkspaceId: workspaceId,
			eventPayload: {
				workspaceRepositoryPath: `/repo/${workspaceId}`,
				baselineTaskCards: seededCards.map((seededCard) => ({
					kanbanBoardCard: seededCard.card,
					boardColumnId: seededCard.boardColumnId,
					fieldValueSha256ByFieldName: {},
				})),
			},
		});
		for (const seededCard of seededCards) {
			for (const session of seededCard.sessions ?? []) {
				this.append({
					eventFamily: "agent_conversation_session_identity_event",
					eventKind: "persisted_session_native_identity_sidecar_read_at_live_capture_activation",
					...buildConversationSessionIdentityEventFields(seededCard.card, session),
				});
			}
		}
		for (const seededCard of seededCards) {
			if (!seededCard.initialization) {
				continue;
			}
			this.append({
				eventFamily: "agent_conversation_session_identity_event",
				eventKind: "persisted_card_agent_session_initialization_sidecar_read_at_live_capture_activation",
				subjectWorkspaceId: workspaceId,
				subjectTaskId: seededCard.card.taskId,
				eventPayload: {
					subjectKanbanBoardCard: seededCard.card,
					taskAgentSessionInitialization: seededCard.initialization,
					sourceConversationSessionIdentityKey: {
						conversationSessionHostKanbanAgentId: seededCard.initialization.sourceAgentId,
						nativeConversationSessionId: seededCard.initialization.sourceSessionId,
					},
				},
			});
		}
	}

	liveConversationSessionIdentityObserved(
		owningCard: KanbanBoardCardWorkUnitQualifiedReference,
		session: KanbanTaskConversationSessionWithNativeIdentity,
	): void {
		this.append({
			eventFamily: "agent_conversation_session_identity_event",
			eventKind: "new_native_conversation_session_identity_observed_for_kanban_task_conversation_session",
			...buildConversationSessionIdentityEventFields(owningCard, session),
		});
	}

	project(): RecordedInterWorkUnitRelationProjectionState {
		const state = createEmptyRecordedInterWorkUnitRelationProjectionState();
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(
			state,
			this.events,
			(sha256) => this.retainedFieldValueCanonicalJsonBySha256.get(sha256) ?? null,
		);
		return state;
	}
}

function actedByCard(actingCard: KanbanBoardCardWorkUnitQualifiedReference): Record<string, unknown> {
	return { kanbanActorKind: "kanban_board_card_work_unit", actingKanbanBoardCardWorkUnit: actingCard };
}

function summarize(
	state: RecordedInterWorkUnitRelationProjectionState,
	workUnit: KanbanBoardCardWorkUnitQualifiedReference,
) {
	return listRecordedInterWorkUnitRelationsTouchingWorkUnit(state, workUnit).map((relation) => ({
		relationKind: relation.relationKind,
		subject:
			relation.relationStatementSubjectWorkUnitRef.workUnitType === "kanban_board_card"
				? relation.relationStatementSubjectWorkUnitRef.taskId
				: relation.relationStatementSubjectWorkUnitRef.nativeConversationSessionId,
		anchor:
			relation.relationStatementAnchorWorkUnitRef.workUnitType === "kanban_board_card"
				? relation.relationStatementAnchorWorkUnitRef.taskId
				: relation.relationStatementAnchorWorkUnitRef.nativeConversationSessionId,
		occurrenceCountByTaskMutationEventKind: relation.occurrenceCountByTaskMutationEventKind,
		attributes: relation.recordedRelationKindSpecificAttributes,
		primary: relation.isCreationTimePrimaryProvenanceOfSubjectCard,
	}));
}

describe("recorded inter-work-unit relation projection", () => {
	it("registers every recorded kind with distinct forward and inverse reading phrases", () => {
		for (const registryEntry of Object.values(RECORDED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY)) {
			expect(registryEntry.forwardReadingPhraseFromSubject).not.toBe(registryEntry.inverseReadingPhraseFromAnchor);
		}
	});

	it("projects a cross-workspace card creation as provenance_created_by and marks it as the creation-time primary provenance", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT, { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" });
		ledger.cardCreated(CHILD, actedByCard(PARENT));
		const state = ledger.project();
		expect(summarize(state, CHILD)).toEqual([
			{
				relationKind: "provenance_created_by",
				subject: "c0001",
				anchor: "p0001",
				occurrenceCountByTaskMutationEventKind: {},
				attributes: {},
				primary: true,
			},
		]);
		// 出边在锚点一侧同样可见；Web UI 用户建卡不产生工作单元之间的关系。
		expect(summarize(state, PARENT).map((relation) => relation.relationKind)).toEqual(["provenance_created_by"]);
	});

	it("projects a system component card creation onto its onBehalfOf work unit", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		ledger.append({
			eventFamily: "task_mutation_event",
			eventKind: "task_card_created_on_board",
			actor: { kanbanActorKind: "kanban_runtime_system_component", kanbanRuntimeSystemComponentName: "gate" },
			onBehalfOfInitiatingWorkUnit: PARENT,
			subjectWorkspaceId: CHILD.workspaceId,
			subjectTaskId: CHILD.taskId,
			eventPayload: { subjectKanbanBoardCard: CHILD, fieldValueSha256ByFieldNameAtCreation: {} },
		});
		expect(summarize(ledger.project(), CHILD).map((relation) => [relation.relationKind, relation.anchor])).toEqual([
			["provenance_created_by", "p0001"],
		]);
	});

	it("aggregates interaction events per kind using the field whitelist and suppresses self-loops", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		ledger.cardCreated(CHILD);
		const byParent = actedByCard(PARENT);
		ledger.taskMutation("task_card_field_value_changed", CHILD, byParent, { changedTaskCardFieldName: "prompt" });
		ledger.taskMutation("task_card_field_value_changed", CHILD, byParent, { changedTaskCardFieldName: "title" });
		ledger.taskMutation("task_card_field_value_changed", CHILD, byParent, { changedTaskCardFieldName: "baseRef" });
		// 置顶不在白名单：只进日志。
		ledger.taskMutation("task_card_field_value_changed", CHILD, byParent, {
			changedTaskCardFieldName: "pinnedToTaskPinboardAt",
		});
		ledger.taskMutation("task_card_moved_between_non_trash_board_columns", CHILD, byParent, {
			taskMutationIntentKind: "kanban_cli_task_start_move_to_in_progress",
			toBoardColumnId: "in_progress",
		});
		ledger.taskMutation("task_message_delivery_requested_into_task_conversation_session", CHILD, byParent, {});
		ledger.taskMutation("task_card_moved_to_trash_column", CHILD, byParent, {});
		// 卡给自己投递消息（RVF hook 投给本会话）：自环不投影。
		ledger.taskMutation(
			"task_message_delivery_requested_into_task_conversation_session",
			CHILD,
			actedByCard(CHILD),
			{},
		);
		// 浏览器自动流转不是工作单元：不投影。
		ledger.taskMutation(
			"task_card_moved_between_non_trash_board_columns",
			CHILD,
			{
				kanbanActorKind: "kanban_web_ui_client_side_automation_with_verified_page_load_nonce",
				boardMutationInitiator: "web_ui_client_automation_session_facet_driven_column_autoflow",
			},
			{ toBoardColumnId: "review" },
		);
		expect(summarize(ledger.project(), CHILD)).toEqual([
			{
				relationKind: "interaction_requirements_amended_by",
				subject: "c0001",
				anchor: "p0001",
				occurrenceCountByTaskMutationEventKind: { task_card_field_value_changed: 2 },
				attributes: { amendedCardFieldNames: ["prompt", "title"] },
				primary: false,
			},
			{
				relationKind: "interaction_execution_configuration_changed_by",
				subject: "c0001",
				anchor: "p0001",
				occurrenceCountByTaskMutationEventKind: { task_card_field_value_changed: 1 },
				attributes: { changedExecutionConfigurationFieldNames: ["baseRef"] },
				primary: false,
			},
			{
				relationKind: "interaction_agent_session_dispatched_or_controlled_by",
				subject: "c0001",
				anchor: "p0001",
				occurrenceCountByTaskMutationEventKind: {
					task_card_moved_between_non_trash_board_columns: 1,
					task_message_delivery_requested_into_task_conversation_session: 1,
				},
				attributes: {},
				primary: false,
			},
			{
				relationKind: "interaction_board_lifecycle_transitioned_by",
				subject: "c0001",
				anchor: "p0001",
				occurrenceCountByTaskMutationEventKind: { task_card_moved_to_trash_column: 1 },
				attributes: { boardLifecycleTransitionCountByTransitionKind: { task_card_moved_to_trash_column: 1 } },
				primary: false,
			},
		]);
	});

	it("deduplicates repeated observations of the same native identity into a single ownership period", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		for (let repetition = 0; repetition < 5; repetition += 1) {
			ledger.identityObserved(PARENT, "claude", "native-a");
		}
		ledger.identityObserved(PARENT, "claude", "native-b");
		const state = ledger.project();
		expect(
			listConversationSessionOwnershipPeriodsOfWorkUnit(
				state.conversationSessionOwnershipProjectionState,
				PARENT,
			).map((period) => period.conversationSessionIdentityKey.nativeConversationSessionId),
		).toEqual(["native-a", "native-b"]);
		expect(summarize(state, PARENT)).toEqual([]);
	});

	it("projects a fork of another card's session at session start, without transferring ownership", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		ledger.identityObserved(PARENT, "codex", "native-parent");
		ledger.retainedFieldValueCanonicalJsonBySha256.set(
			"init-fork",
			JSON.stringify({
				sourceAgentId: "codex",
				sourceSessionId: "native-parent",
				sourceSessionReuseMode: "fork_existing_session",
			}),
		);
		ledger.cardCreated(CHILD, undefined, {
			fieldValueSha256ByFieldNameAtCreation: { taskAgentSessionInitialization: "init-fork" },
		});
		// 还没启动：fork 没有真正发生，不投影。
		expect(summarize(ledger.project(), CHILD)).toEqual([]);
		ledger.identityObserved(CHILD, "codex", "native-child");
		const state = ledger.project();
		expect(summarize(state, CHILD)).toEqual([
			{
				relationKind: "provenance_forked_conversation_session_of",
				subject: "c0001",
				anchor: "p0001",
				occurrenceCountByTaskMutationEventKind: {},
				attributes: {
					forkedFromNativeConversationSessionIdentity: {
						conversationSessionHostKanbanAgentId: "codex",
						nativeConversationSessionId: "native-parent",
					},
					forkedIntoNativeConversationSessionIdentity: {
						conversationSessionHostKanbanAgentId: "codex",
						nativeConversationSessionId: "native-child",
					},
					identityObservationSource: "kanban_task_conversation_session_native_identity_observation",
				},
				primary: true,
			},
		]);
		expect(
			listConversationSessionOwnershipPeriodsOfWorkUnit(
				state.conversationSessionOwnershipProjectionState,
				PARENT,
			).map((period) => [
				period.conversationSessionIdentityKey.nativeConversationSessionId,
				period.ownershipPeriodEndedAt,
			]),
		).toEqual([["native-parent", null]]);
	});

	it("projects an activation-time fork sidecar of a card that had left backlog even without an identity sidecar", () => {
		const ledger = new SyntheticLedger();
		const baselineCard = (taskId: string, boardColumnId: string) => ({
			kanbanBoardCard: card("ws-a", taskId),
			boardColumnId,
			fieldValueSha256ByFieldName: {},
		});
		ledger.append({
			eventFamily: "fact_observed_by_kanban_runtime_event",
			eventKind: "board_state_baseline_observed_at_live_task_mutation_capture_activation",
			subjectWorkspaceId: "ws-a",
			eventPayload: {
				workspaceRepositoryPath: "/repo/a",
				baselineTaskCards: [baselineCard("f0001", "trash"), baselineCard("f0002", "backlog")],
			},
		});
		for (const taskId of ["f0001", "f0002"]) {
			ledger.append({
				eventFamily: "agent_conversation_session_identity_event",
				eventKind: "persisted_card_agent_session_initialization_sidecar_read_at_live_capture_activation",
				subjectWorkspaceId: "ws-a",
				subjectTaskId: taskId,
				eventPayload: {
					subjectKanbanBoardCard: card("ws-a", taskId),
					taskAgentSessionInitialization: {
						sourceAgentId: "codex",
						sourceSessionId: "native-terminal-source",
						sourceSessionReuseMode: "fork_existing_session",
					},
				},
			});
		}
		const state = ledger.project();
		// 已离开 backlog 的卡：fork 已经发生，fork 成什么 id 未知；仍在 backlog 的卡等真正启动。
		expect(
			summarize(state, card("ws-a", "f0001")).map((relation) => [
				relation.relationKind,
				relation.anchor,
				relation.attributes.forkedIntoNativeConversationSessionIdentity,
				relation.attributes.identityObservationSource,
			]),
		).toEqual([
			[
				"provenance_forked_conversation_session_of",
				"native-terminal-source",
				null,
				"session_start_inferred_from_card_having_left_backlog_at_live_capture_activation_baseline",
			],
		]);
		expect(summarize(state, card("ws-a", "f0002"))).toEqual([]);
	});

	it("projects a resume of a never-seen session as adoption of an unmanaged standalone session", () => {
		const ledger = new SyntheticLedger();
		ledger.retainedFieldValueCanonicalJsonBySha256.set(
			"init-resume",
			JSON.stringify({
				sourceAgentId: "claude",
				sourceSessionId: "native-terminal",
				sourceSessionReuseMode: "resume_existing_session",
			}),
		);
		ledger.cardCreated(CHILD, undefined, {
			fieldValueSha256ByFieldNameAtCreation: { taskAgentSessionInitialization: "init-resume" },
		});
		ledger.identityObserved(CHILD, "claude", "native-terminal");
		const state = ledger.project();
		expect(
			summarize(state, CHILD).map((relation) => [relation.relationKind, relation.anchor, relation.primary]),
		).toEqual([["provenance_resumed_and_adopted_conversation_session_of", "native-terminal", false]]);
		expect(
			listConversationSessionOwnershipPeriodsOfWorkUnit(
				state.conversationSessionOwnershipProjectionState,
				CHILD,
			).map((period) => period.conversationSessionIdentityKey.nativeConversationSessionId),
		).toEqual(["native-terminal"]);
	});

	it("projects card-to-card adoption and only diagnoses the source card reappearing with the same session", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		ledger.identityObserved(PARENT, "claude", "native-shared");
		ledger.cardCreated(CHILD);
		ledger.identityObserved(CHILD, "claude", "native-shared");
		ledger.identityObserved(PARENT, "claude", "native-shared");
		const state = ledger.project();
		expect(summarize(state, CHILD).map((relation) => [relation.relationKind, relation.anchor])).toEqual([
			["provenance_resumed_and_adopted_conversation_session_of", "p0001"],
		]);
		expect(
			listConversationSessionOwnershipConflictDiagnosticsTouchingWorkUnit(
				state.conversationSessionOwnershipProjectionState,
				PARENT,
			).map((diagnostic) => diagnostic.previouslyOwningKanbanBoardCardObservedAgain.taskId),
		).toEqual(["p0001"]);
	});

	it("keeps a tombstone for a permanently removed card and resolves bare ids across workspaces", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		ledger.taskMutation(
			"task_card_permanently_removed_from_board",
			PARENT,
			{ kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" },
			{
				lastBoardColumnIdBeforeRemoval: "review",
				lastFieldValueSha256ByFieldNameBeforeRemoval: { title: "t-last" },
			},
		);
		const reusedIdInOtherWorkspace = card("ws-b", "p0001", 9_000);
		ledger.cardCreated(reusedIdInOtherWorkspace);
		const projections = listKanbanBoardCardIdentityProjectionsByBareTaskId(
			ledger.project().kanbanBoardCardIdentityProjectionState,
			"p0001",
		);
		expect(
			projections.map((projection) => [
				projection.kanbanBoardCard.workspaceId,
				projection.permanentlyRemovedFromBoardAt !== null,
				projection.currentFieldValueSha256ByFieldName.title,
			]),
		).toEqual([
			["ws-b", false, "title-of-p0001"],
			["ws-a", true, "t-last"],
		]);
	});

	it("is idempotent when the same events are applied twice", () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		ledger.cardCreated(CHILD, actedByCard(PARENT));
		ledger.taskMutation(
			"task_message_delivery_requested_into_task_conversation_session",
			CHILD,
			actedByCard(PARENT),
			{},
		);
		const state = ledger.project();
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(state, ledger.events, () => null);
		expect(summarize(state, CHILD).map((relation) => relation.occurrenceCountByTaskMutationEventKind)).toEqual([
			{},
			{ task_message_delivery_requested_into_task_conversation_session: 1 },
		]);
	});

	it("mounts mute preferences on the deterministic relation id, hides muted relations from the summary but counts them", async () => {
		const ledger = new SyntheticLedger();
		ledger.cardCreated(PARENT);
		ledger.cardCreated(CHILD, actedByCard(PARENT));
		const createdByRelationId = listRecordedInterWorkUnitRelationsTouchingWorkUnit(ledger.project(), CHILD)[0]
			?.relationId;
		const appendPresentationPreference = (eventKind: string) =>
			ledger.append({
				eventFamily: "relation_presentation_preference_event",
				eventKind,
				actor: { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" },
				eventPayload: { relationId: createdByRelationId },
			});
		appendPresentationPreference("recorded_relation_muted_in_presentation_by_user");
		const mutedState = ledger.project();
		const [mutedRelation] = listRecordedInterWorkUnitRelationsTouchingWorkUnit(mutedState, CHILD);
		expect(mutedRelation?.mutedInPresentationByActorKind).toBe(
			"kanban_web_ui_user_gesture_with_verified_page_load_nonce",
		);
		const mutedNeighborhood = await assembleRecordedRelationNeighborhoodSummaryOfWorkUnit(
			readerOf(mutedState),
			CHILD,
			() => null,
		);
		expect(mutedNeighborhood.hasAnyRelationVisibleByDefault).toBe(false);
		expect(mutedNeighborhood.renderedNeighborhoodSummaryText).not.toContain("was created by");
		expect(mutedNeighborhood.renderedNeighborhoodSummaryText).toContain("1 relation(s) muted by the user");

		appendPresentationPreference("recorded_relation_unmuted_in_presentation_by_user");
		expect(
			listRecordedInterWorkUnitRelationsTouchingWorkUnit(ledger.project(), CHILD)[0]?.mutedInPresentationAt,
		).toBe(null);
	});

	it("adds the neighbors' own relations at depth 2 without repeating relations that touch the subject", async () => {
		const ledger = new SyntheticLedger();
		const GRANDCHILD = card("ws-b", "g0001", 3_000);
		ledger.cardCreated(PARENT);
		ledger.cardCreated(CHILD, actedByCard(PARENT));
		ledger.cardCreated(GRANDCHILD, actedByCard(CHILD));
		const state = ledger.project();
		const depthOne = await assembleRecordedRelationNeighborhoodSummaryOfWorkUnit(readerOf(state), PARENT, () => null);
		expect(depthOne.secondHopRecordedRelations).toEqual([]);
		const depthTwo = await assembleRecordedRelationNeighborhoodSummaryOfWorkUnit(
			readerOf(state),
			PARENT,
			() => null,
			2,
		);
		expect(depthTwo.recordedRelations).toHaveLength(1);
		expect(depthTwo.secondHopRecordedRelations.map((relation) => relation.relationKind)).toEqual([
			"provenance_created_by",
		]);
		expect(depthTwo.secondHopNeighborWorkUnits.map((entry) => entry.workUnitDisplayLabel)).toEqual([
			"task g0001 [ws-b]",
		]);
		expect(depthTwo.renderedNeighborhoodSummaryText).toContain("## Two hops away");
		expect(depthTwo.renderedNeighborhoodSummaryText).toContain("- task c0001 [ws-b] created task g0001 [ws-b]");
	});
});

const SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION = card("ws-source", "a0001", 1_100);
const CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION = card("ws-fork", "b0001", 1_200);

function appendSourceWorkspaceActivationWhereSourceCardHoldsNativeX(ledger: SyntheticLedger): void {
	ledger.liveCaptureActivationBatch("ws-source", [
		{
			card: SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION,
			boardColumnId: "review",
			sessions: [{ agentId: "codex", nativeId: "native-x", sidecarObservedAt: 10 }],
		},
	]);
}

function appendForkWorkspaceActivationWhereChildCardForkedNativeX(ledger: SyntheticLedger): void {
	ledger.liveCaptureActivationBatch("ws-fork", [
		{
			card: CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION,
			boardColumnId: "in_progress",
			sessions: [{ agentId: "codex", nativeId: "native-b-forked-from-x", sidecarObservedAt: 30 }],
			initialization: {
				sourceAgentId: "codex",
				sourceSessionId: "native-x",
				sourceSessionReuseMode: "fork_existing_session",
			},
		},
	]);
}

function summarizeRelationKindSubjectAnchor(
	state: RecordedInterWorkUnitRelationProjectionState,
	workUnit: KanbanBoardCardWorkUnitQualifiedReference,
): string[][] {
	return summarize(state, workUnit).map((relation) => [relation.relationKind, relation.subject, relation.anchor]);
}

function summarizeOwnershipPeriods(
	state: RecordedInterWorkUnitRelationProjectionState,
	workUnit: KanbanBoardCardWorkUnitQualifiedReference,
) {
	return listConversationSessionOwnershipPeriodsOfWorkUnit(
		state.conversationSessionOwnershipProjectionState,
		workUnit,
	).map((period) => ({
		nativeId: period.conversationSessionIdentityKey.nativeConversationSessionId,
		startedAt: period.ownershipPeriodStartedAt,
		endedAt: period.ownershipPeriodEndedAt,
		observedInKanbanTaskConversationSessionIds: period.observedInKanbanTaskConversationSessionIds,
	}));
}

function listConflictDiagnosticEventIds(
	state: RecordedInterWorkUnitRelationProjectionState,
	workUnit: KanbanBoardCardWorkUnitQualifiedReference,
): string[] {
	return listConversationSessionOwnershipConflictDiagnosticsTouchingWorkUnit(
		state.conversationSessionOwnershipProjectionState,
		workUnit,
	).map((diagnostic) => diagnostic.conflictObservedInEventId);
}

describe("recorded inter-work-unit relation projection over live-capture-activation seeding", () => {
	it("adopts an unmanaged standalone session exactly once when the resuming card's identity sidecar precedes its resume initialization sidecar", () => {
		const resumingCard = card("ws-a", "r0001", 1_300);
		const ledger = new SyntheticLedger();
		ledger.liveCaptureActivationBatch("ws-a", [
			{
				card: resumingCard,
				boardColumnId: "review",
				sessions: [{ agentId: "claude", nativeId: "native-standalone-s", sidecarObservedAt: 50 }],
				initialization: {
					sourceAgentId: "claude",
					sourceSessionId: "native-standalone-s",
					sourceSessionReuseMode: "resume_existing_session",
				},
			},
		]);
		const state = ledger.project();
		expect(summarizeRelationKindSubjectAnchor(state, resumingCard)).toEqual([
			["provenance_resumed_and_adopted_conversation_session_of", "r0001", "native-standalone-s"],
		]);
		expect(summarizeOwnershipPeriods(state, resumingCard)).toEqual([
			{
				nativeId: "native-standalone-s",
				startedAt: 50,
				endedAt: null,
				observedInKanbanTaskConversationSessionIds: ["r0001"],
			},
		]);
		expect(listConflictDiagnosticEventIds(state, resumingCard)).toEqual([]);
	});

	it("anchors an activation-time fork onto the source card seeded by another workspace, independent of activation commit order", () => {
		const forkWorkspaceActivatedFirst = new SyntheticLedger();
		appendForkWorkspaceActivationWhereChildCardForkedNativeX(forkWorkspaceActivatedFirst);
		appendSourceWorkspaceActivationWhereSourceCardHoldsNativeX(forkWorkspaceActivatedFirst);
		const sourceWorkspaceActivatedFirst = new SyntheticLedger();
		appendSourceWorkspaceActivationWhereSourceCardHoldsNativeX(sourceWorkspaceActivatedFirst);
		appendForkWorkspaceActivationWhereChildCardForkedNativeX(sourceWorkspaceActivatedFirst);
		const projectedStates = [forkWorkspaceActivatedFirst.project(), sourceWorkspaceActivatedFirst.project()];
		for (const state of projectedStates) {
			expect(summarizeRelationKindSubjectAnchor(state, CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION)).toEqual([
				["provenance_forked_conversation_session_of", "b0001", "a0001"],
			]);
			// 源卡只有那条入边 fork：它从未 resume 过，sidecar 只证明它一直持有 native-x。
			expect(summarizeRelationKindSubjectAnchor(state, SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION)).toEqual([
				["provenance_forked_conversation_session_of", "b0001", "a0001"],
			]);
			expect(summarizeOwnershipPeriods(state, SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION)).toEqual([
				{
					nativeId: "native-x",
					startedAt: 10,
					endedAt: null,
					observedInKanbanTaskConversationSessionIds: ["a0001"],
				},
			]);
			expect(listConflictDiagnosticEventIds(state, SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION)).toEqual([]);
			expect(
				isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(state),
			).toBe(false);
		}
		const [forkFirstState, sourceFirstState] = projectedStates;
		if (!forkFirstState || !sourceFirstState) {
			throw new Error("expected two projected states");
		}
		expect(summarize(forkFirstState, CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION)).toEqual(
			summarize(sourceFirstState, CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION),
		);
	});

	it("flags a source card seeded in a later apply that contradicts an inferred standalone placeholder, and converges after replay with the inherited seeded fact index", () => {
		const ledger = new SyntheticLedger();
		appendForkWorkspaceActivationWhereChildCardForkedNativeX(ledger);
		const eventsOfForkWorkspaceActivation = [...ledger.events];
		appendSourceWorkspaceActivationWhereSourceCardHoldsNativeX(ledger);

		const incrementallyProjectedState = createEmptyRecordedInterWorkUnitRelationProjectionState();
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(
			incrementallyProjectedState,
			eventsOfForkWorkspaceActivation,
			() => null,
		);
		// 第一次 apply 时账本里还没有任何卡播种过 native-x：只能推断为看板外独立会话。
		expect(
			summarizeRelationKindSubjectAnchor(
				incrementallyProjectedState,
				CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION,
			),
		).toEqual([["provenance_forked_conversation_session_of", "b0001", "native-x"]]);
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(
			incrementallyProjectedState,
			ledger.events,
			() => null,
		);
		expect(
			isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
				incrementallyProjectedState,
			),
		).toBe(true);
		// 迟到的播种不在原地铸「源卡采纳了独立会话」。
		expect(
			summarize(incrementallyProjectedState, SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION).filter(
				(relation) => relation.relationKind === "provenance_resumed_and_adopted_conversation_session_of",
			),
		).toEqual([]);

		const rebuiltState =
			createEmptyRecordedInterWorkUnitRelationProjectionStateInheritingLiveCaptureActivationSeededFactIndex(
				incrementallyProjectedState,
			);
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(rebuiltState, ledger.events, () => null);
		expect(
			isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
				rebuiltState,
			),
		).toBe(false);
		const singleBatchState = ledger.project();
		for (const workUnit of [
			CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION,
			SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION,
		]) {
			expect(summarize(rebuiltState, workUnit)).toEqual(summarize(singleBatchState, workUnit));
			expect(summarizeOwnershipPeriods(rebuiltState, workUnit)).toEqual(
				summarizeOwnershipPeriods(singleBatchState, workUnit),
			);
		}
		expect(
			summarizeRelationKindSubjectAnchor(rebuiltState, CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION),
		).toEqual([["provenance_forked_conversation_session_of", "b0001", "a0001"]]);
	});

	it("projects an activation-time card-to-card resume as adoption from the source card in either activation order, without conflict or reverse adoption", () => {
		const adoptingCard = card("ws-adopt", "c0002", 1_400);
		const appendAdoptingWorkspaceActivation = (ledger: SyntheticLedger) =>
			ledger.liveCaptureActivationBatch("ws-adopt", [
				{
					card: adoptingCard,
					boardColumnId: "review",
					sessions: [{ agentId: "codex", nativeId: "native-x", sidecarObservedAt: 20 }],
					initialization: {
						sourceAgentId: "codex",
						sourceSessionId: "native-x",
						sourceSessionReuseMode: "resume_existing_session",
					},
				},
			]);
		const adoptingWorkspaceActivatedFirst = new SyntheticLedger();
		appendAdoptingWorkspaceActivation(adoptingWorkspaceActivatedFirst);
		appendSourceWorkspaceActivationWhereSourceCardHoldsNativeX(adoptingWorkspaceActivatedFirst);
		const sourceWorkspaceActivatedFirst = new SyntheticLedger();
		appendSourceWorkspaceActivationWhereSourceCardHoldsNativeX(sourceWorkspaceActivatedFirst);
		appendAdoptingWorkspaceActivation(sourceWorkspaceActivatedFirst);
		for (const state of [adoptingWorkspaceActivatedFirst.project(), sourceWorkspaceActivatedFirst.project()]) {
			for (const workUnit of [adoptingCard, SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION]) {
				expect(summarizeRelationKindSubjectAnchor(state, workUnit)).toEqual([
					["provenance_resumed_and_adopted_conversation_session_of", "c0002", "a0001"],
				]);
				expect(listConflictDiagnosticEventIds(state, workUnit)).toEqual([]);
			}
			expect(summarizeOwnershipPeriods(state, SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION)).toEqual([
				{ nativeId: "native-x", startedAt: 10, endedAt: 20, observedInKanbanTaskConversationSessionIds: ["a0001"] },
			]);
			expect(summarizeOwnershipPeriods(state, adoptingCard)).toEqual([
				{
					nativeId: "native-x",
					startedAt: 20,
					endedAt: null,
					observedInKanbanTaskConversationSessionIds: ["c0002"],
				},
			]);
		}
	});

	it("requests a retroactive rebuild when a split activation batch registers a resume initialization after the adopter's identity sidecar was consumed", () => {
		const adoptingCard = card("ws-source", "c0003", 1_700);
		const ledger = new SyntheticLedger();
		ledger.liveCaptureActivationBatch("ws-source", [
			{
				card: SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION,
				boardColumnId: "review",
				sessions: [{ agentId: "codex", nativeId: "native-x", sidecarObservedAt: 10 }],
			},
			{
				card: adoptingCard,
				boardColumnId: "review",
				sessions: [{ agentId: "codex", nativeId: "native-x", sidecarObservedAt: 20 }],
				initialization: {
					sourceAgentId: "codex",
					sourceSessionId: "native-x",
					sourceSessionReuseMode: "resume_existing_session",
				},
			},
		]);
		// 账本分页把同一激活批次拆开：第一页止于采纳方的身份 sidecar，resume 初始化 sidecar 落在下一页。
		const firstEventIndexOfSecondPage = ledger.events.findIndex(
			(event) =>
				event.eventKind === "persisted_card_agent_session_initialization_sidecar_read_at_live_capture_activation",
		);
		const pagedState = createEmptyRecordedInterWorkUnitRelationProjectionState();
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(
			pagedState,
			ledger.events.slice(0, firstEventIndexOfSecondPage),
			() => null,
		);
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(pagedState, ledger.events, () => null);
		expect(
			isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
				pagedState,
			),
		).toBe(true);
		const rebuiltState =
			createEmptyRecordedInterWorkUnitRelationProjectionStateInheritingLiveCaptureActivationSeededFactIndex(
				pagedState,
			);
		applyCommittedLedgerEventsToRecordedInterWorkUnitRelationProjection(rebuiltState, ledger.events, () => null);
		expect(
			isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
				rebuiltState,
			),
		).toBe(false);
		expect(summarizeRelationKindSubjectAnchor(rebuiltState, adoptingCard)).toEqual([
			["provenance_resumed_and_adopted_conversation_session_of", "c0003", "a0001"],
		]);
		expect(listConflictDiagnosticEventIds(rebuiltState, SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION)).toEqual([]);
		expect(summarize(rebuiltState, adoptingCard)).toEqual(summarize(ledger.project(), adoptingCard));
	});

	it.each(["by_the_way", "task_collaborator"] as const)(
		"%s 原生身份归属宿主卡片，后续 fork 关系不冒充主会话",
		(role) => {
			const byTheWaySessionOwningCard = card("ws-a", "k0001", 1_500);
			const forkingCard = card("ws-a", "f0009", 9_000);
			const ledger = new SyntheticLedger();
			ledger.liveCaptureActivationBatch("ws-a", [
				{
					card: byTheWaySessionOwningCard,
					boardColumnId: "in_progress",
					sessions: [
						{ agentId: "claude", nativeId: "native-k-main", sidecarObservedAt: 40 },
						{
							kanbanTaskConversationSessionId: "btw-seeded-1",
							taskConversationSessionRole: role,
							agentId: "claude",
							nativeId: "native-btw-seeded",
							sidecarObservedAt: 45,
						},
					],
				},
			]);
			ledger.liveConversationSessionIdentityObserved(byTheWaySessionOwningCard, {
				kanbanTaskConversationSessionId: "btw-live-2",
				taskConversationSessionRole: role,
				agentId: "claude",
				nativeId: "native-btw-live",
				sidecarObservedAt: 60,
			});
			ledger.retainedFieldValueCanonicalJsonBySha256.set(
				"init-fork-of-by-the-way-session",
				JSON.stringify({
					sourceAgentId: "claude",
					sourceSessionId: "native-btw-live",
					sourceSessionReuseMode: "fork_existing_session",
				}),
			);
			ledger.cardCreated(forkingCard, undefined, {
				fieldValueSha256ByFieldNameAtCreation: {
					taskAgentSessionInitialization: "init-fork-of-by-the-way-session",
				},
			});
			ledger.liveConversationSessionIdentityObserved(forkingCard, {
				agentId: "claude",
				nativeId: "native-f",
				sidecarObservedAt: 70,
			});
			const state = ledger.project();
			expect(
				summarizeOwnershipPeriods(state, byTheWaySessionOwningCard).map((period) => [
					period.nativeId,
					period.observedInKanbanTaskConversationSessionIds,
				]),
			).toEqual([
				["native-k-main", ["k0001"]],
				["native-btw-seeded", ["btw-seeded-1"]],
				["native-btw-live", ["btw-live-2"]],
			]);
			expect(summarizeRelationKindSubjectAnchor(state, forkingCard)).toEqual([
				["provenance_forked_conversation_session_of", "f0009", "k0001"],
			]);
		},
	);

	it("does not treat a by-the-way session start as the start of the card's main session awaited by its fork initialization", () => {
		const awaitingCard = card("ws-a", "w0001", 1_600);
		const ledger = new SyntheticLedger();
		ledger.liveCaptureActivationBatch("ws-a", [
			{
				card: awaitingCard,
				boardColumnId: "backlog",
				initialization: {
					sourceAgentId: "codex",
					sourceSessionId: "native-upstream",
					sourceSessionReuseMode: "fork_existing_session",
				},
			},
		]);
		ledger.liveConversationSessionIdentityObserved(awaitingCard, {
			kanbanTaskConversationSessionId: "btw-1",
			taskConversationSessionRole: "by_the_way",
			agentId: "codex",
			nativeId: "native-btw",
			sidecarObservedAt: 0,
		});
		expect(summarize(ledger.project(), awaitingCard)).toEqual([]);
		ledger.liveConversationSessionIdentityObserved(awaitingCard, {
			agentId: "codex",
			nativeId: "native-main",
			sidecarObservedAt: 0,
		});
		expect(
			summarize(ledger.project(), awaitingCard).map((relation) => [
				relation.relationKind,
				relation.anchor,
				relation.attributes.forkedIntoNativeConversationSessionIdentity,
			]),
		).toEqual([
			[
				"provenance_forked_conversation_session_of",
				"native-upstream",
				{ conversationSessionHostKanbanAgentId: "codex", nativeConversationSessionId: "native-main" },
			],
		]);
	});
});

// 最小 fake：实现持有器需要的只读能力，并数 listCommittedEvents 的调用次数（验证单飞）。
function createInMemoryLedgerReadCapabilitiesOverSyntheticLedger(ledger: SyntheticLedger): {
	ledgerReadCapabilities: InterWorkUnitRelationLedgerReadCapabilitiesUsedByRecordedRelationProjectionCatchUp;
	countListCommittedEventsCalls: () => number;
} {
	let listCommittedEventsCallCount = 0;
	return {
		ledgerReadCapabilities: {
			listCommittedEvents: async ({ afterGlobalCommittedEventSequence = 0, limit = Number.POSITIVE_INFINITY }) => {
				listCommittedEventsCallCount += 1;
				return ledger.events
					.filter((event) => event.globalCommittedEventSequence > afterGlobalCommittedEventSequence)
					.slice(0, limit);
			},
			readRetainedFieldContents: async (fieldValueSha256s) =>
				fieldValueSha256s.flatMap((fieldValueSha256) => {
					const fieldValueCanonicalJson = ledger.retainedFieldValueCanonicalJsonBySha256.get(fieldValueSha256);
					return fieldValueCanonicalJson === undefined ? [] : [{ fieldValueSha256, fieldValueCanonicalJson }];
				}),
			findRetainedTaskCardFieldKeywordMatches: async () => [],
		},
		countListCommittedEventsCalls: () => listCommittedEventsCallCount,
	};
}

describe("recorded inter-work-unit relation projection kept caught up with ledger", () => {
	it("rebuilds once from global sequence 0 with the inherited seeded fact index when a later catch-up seeds the source card of an inferred placeholder, sharing the single flight across readers", async () => {
		const ledger = new SyntheticLedger();
		appendForkWorkspaceActivationWhereChildCardForkedNativeX(ledger);
		const { ledgerReadCapabilities, countListCommittedEventsCalls } =
			createInMemoryLedgerReadCapabilitiesOverSyntheticLedger(ledger);
		const projectionKeptCaughtUp = new RecordedInterWorkUnitRelationProjectionKeptCaughtUpWithLedger(
			ledgerReadCapabilities,
		);
		const readProjectionOutcome = () =>
			projectionKeptCaughtUp.readCaughtUpProjection((reader) => ({
				childCardRelations: summarizeRelationKindSubjectAnchor(
					reader.projectionState,
					CHILD_CARD_FORKED_FROM_NATIVE_X_BEFORE_ACTIVATION,
				),
				sourceCardRelations: summarizeRelationKindSubjectAnchor(
					reader.projectionState,
					SOURCE_CARD_HOLDING_NATIVE_X_AT_ACTIVATION,
				),
				retroactiveRebuildRequired:
					isRetroactiveRebuildOfRecordedInterWorkUnitRelationProjectionRequiredBecauseLateSeededActivationFact(
						reader.projectionState,
					),
				lastAppliedGlobalCommittedEventSequence: reader.projectionState.lastAppliedGlobalCommittedEventSequence,
			}));

		expect((await readProjectionOutcome()).childCardRelations).toEqual([
			["provenance_forked_conversation_session_of", "b0001", "native-x"],
		]);
		const listCommittedEventsCallsBeforeLateSeeding = countListCommittedEventsCalls();

		appendSourceWorkspaceActivationWhereSourceCardHoldsNativeX(ledger);
		const concurrentReadOutcomes = await Promise.all([readProjectionOutcome(), readProjectionOutcome()]);
		for (const outcome of concurrentReadOutcomes) {
			expect(outcome).toEqual({
				childCardRelations: [["provenance_forked_conversation_session_of", "b0001", "a0001"]],
				sourceCardRelations: [["provenance_forked_conversation_session_of", "b0001", "a0001"]],
				retroactiveRebuildRequired: false,
				lastAppliedGlobalCommittedEventSequence: ledger.events.length,
			});
		}
		// 一次追赶（一页）+ 一次从头重放（一页）；两个并发读者共用同一次单飞。
		expect(countListCommittedEventsCalls() - listCommittedEventsCallsBeforeLateSeeding).toBe(2);
	});
});

function readerOf(state: RecordedInterWorkUnitRelationProjectionState): RecordedInterWorkUnitRelationProjectionReader {
	return {
		projectionState: state,
		readRetainedTaskCardFieldValuesBySha256: async () => new Map(),
		findRetainedTaskCardFieldKeywordMatchesBySha256: async () => new Map(),
	};
}
