import { z } from "zod";

// dd2db 工作单元间关系账本的事件契约（阶段 1a：只写的前向捕获骨干）。
// 权威设计在 dd2db 设计归档（仓库外）的 §R3：Y-EVENT-4（10 族）、Y-EVENT-6（渠道）、Y-EVENT-7（行动者）、
// Y-EVENT-12（卡片限定引用）、Y-EVENT-14（公共信封与 TurnRef）。术语见 docs/context-inter-work-unit-relation-modeling-overhaul.md。
//
// 落盘纪律：读盘一律容忍未知取值（z.string() + 已知值集合），未知值原样保留、不抛错——账本只追加，
// 旧 runtime 读到新 runtime 写的事件不能整库报错。写侧用已知值集合在类型层收紧。

export const INTER_WORK_UNIT_RELATION_LEDGER_EVENT_FAMILIES = [
	"task_mutation_event",
	"agent_conversation_session_identity_event",
	"fact_observed_by_kanban_runtime_event",
	"inter_work_unit_relation_assertion_lifecycle_event",
	"requirement_obligation_unary_declaration_event",
	"work_unit_agent_self_declared_milestone_event",
	"relation_presentation_preference_event",
	"recorded_live_fact_attribution_compensation_event",
	"resource_disposition_decision_event",
	"extracted_record_effectiveness_transition_pointer_event",
] as const;
export type InterWorkUnitRelationLedgerEventFamily = (typeof INTER_WORK_UNIT_RELATION_LEDGER_EVENT_FAMILIES)[number];

// d-backfill §3.1 的 7 个渠道值。阶段 1a 只产出 live_runtime_capture。
export const KNOWN_RECORD_CAPTURE_CHANNELS_FOR_MUTATION_EVENT_RELATION_AND_IDENTITY_RECORDS = [
	"live_runtime_capture",
	"live_work_unit_authored_prose_reference_extraction",
	"historical_backfill_transcript_kanban_mutation_invocation_mining",
	"historical_backfill_transcript_card_creation_time_window_output_echo_join",
	"historical_backfill_work_unit_authored_prose_reference_extraction",
	"historical_backfill_existing_board_and_session_structured_field_projection",
	"historical_backfill_harness_transcript_directory_and_metadata_identity_scan",
] as const;
export type KnownRecordCaptureChannel =
	(typeof KNOWN_RECORD_CAPTURE_CHANNELS_FOR_MUTATION_EVENT_RELATION_AND_IDENTITY_RECORDS)[number];

export function isFirstHandRuntimeRecordCaptureChannel(recordCaptureChannel: string): boolean {
	return recordCaptureChannel === "live_runtime_capture";
}

// ---------------------------------------------------------------------------------------------
// 工作单元引用（Y-EVENT-11、Y-EVENT-12）
// ---------------------------------------------------------------------------------------------

// 卡片限定引用在所有落盘位置一律带 incarnation 戳：5 位 hex 的 id 空间约 105 万，删掉的 id 可能被复用。
export const kanbanBoardCardWorkUnitQualifiedReferenceSchema = z.object({
	workUnitType: z.literal("kanban_board_card"),
	workspaceId: z.string(),
	taskId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
});
export type KanbanBoardCardWorkUnitQualifiedReference = z.infer<typeof kanbanBoardCardWorkUnitQualifiedReferenceSchema>;

// 会话身份键：宿主 agentId 全集（开放字符串）+ 原生会话 id。harnessKind 这个名字停用，
// 映射到 thread graph 核心包的 harness 只在胶水层做。
export const agentConversationSessionIdentityKeySchema = z.object({
	conversationSessionHostKanbanAgentId: z.string(),
	nativeConversationSessionId: z.string(),
});
export type AgentConversationSessionIdentityKey = z.infer<typeof agentConversationSessionIdentityKeySchema>;

export const kanbanUnmanagedStandaloneAgentConversationSessionWorkUnitReferenceSchema =
	agentConversationSessionIdentityKeySchema.extend({
		workUnitType: z.literal("kanban_unmanaged_standalone_agent_conversation_session"),
	});
export type KanbanUnmanagedStandaloneAgentConversationSessionWorkUnitReference = z.infer<
	typeof kanbanUnmanagedStandaloneAgentConversationSessionWorkUnitReferenceSchema
>;

export const interWorkUnitRelationWorkUnitReferenceSchema = z.discriminatedUnion("workUnitType", [
	kanbanBoardCardWorkUnitQualifiedReferenceSchema,
	kanbanUnmanagedStandaloneAgentConversationSessionWorkUnitReferenceSchema,
]);
export type InterWorkUnitRelationWorkUnitReference = z.infer<typeof interWorkUnitRelationWorkUnitReferenceSchema>;

// ---------------------------------------------------------------------------------------------
// 行动者（Y-EVENT-7）。解析顺序见 kanban-actor-resolution；这里只定义形状。
// ---------------------------------------------------------------------------------------------

export const KANBAN_ACTOR_KINDS = [
	"kanban_board_card_work_unit",
	"kanban_unmanaged_standalone_agent_conversation_session_work_unit",
	"kanban_home_sidebar_agent_session_not_a_work_unit",
	"kanban_web_ui_user_gesture_with_verified_page_load_nonce",
	"kanban_web_ui_client_side_automation_with_verified_page_load_nonce",
	"kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation",
	"kanban_runtime_system_component",
	"kanban_cli_invocation_without_task_or_session_environment",
	"direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce",
	"unresolved_actor",
] as const;
export type KanbanActorKind = (typeof KANBAN_ACTOR_KINDS)[number];

export type KanbanActor =
	| {
			kanbanActorKind: "kanban_board_card_work_unit";
			actingKanbanBoardCardWorkUnit: KanbanBoardCardWorkUnitQualifiedReference;
	  }
	| {
			kanbanActorKind: "kanban_unmanaged_standalone_agent_conversation_session_work_unit";
			actingStandaloneAgentConversationSession: KanbanUnmanagedStandaloneAgentConversationSessionWorkUnitReference;
	  }
	| {
			kanbanActorKind: "kanban_home_sidebar_agent_session_not_a_work_unit";
			homeSidebarAgentSessionId: string;
	  }
	| { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" }
	| {
			kanbanActorKind: "kanban_web_ui_client_side_automation_with_verified_page_load_nonce";
			boardMutationInitiator: string;
	  }
	| {
			kanbanActorKind: "kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation";
	  }
	| {
			kanbanActorKind: "kanban_runtime_system_component";
			kanbanRuntimeSystemComponentName: string;
	  }
	| {
			kanbanActorKind: "kanban_cli_invocation_without_task_or_session_environment";
			missingEnvironmentVariableNames: string[];
	  }
	| { kanbanActorKind: "direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce" }
	| { kanbanActorKind: "unresolved_actor"; unresolvedActorReason: string };

// Y-EVENT-17：这 4 个值在确认、门、义务规则里一律按「未解析」处理。
export function isKanbanActorTreatedAsUnresolvedForConfirmationGateAndObligationRules(actor: KanbanActor): boolean {
	return (
		actor.kanbanActorKind === "unresolved_actor" ||
		actor.kanbanActorKind === "kanban_cli_invocation_without_task_or_session_environment" ||
		actor.kanbanActorKind === "direct_runtime_trpc_caller_without_cli_actor_header_or_web_ui_page_load_nonce" ||
		actor.kanbanActorKind ===
			"kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation"
	);
}

// ---------------------------------------------------------------------------------------------
// TurnRef（Y-EVENT-14）：两种会话身份并存，至少一个非空。用判别联合会在两种身份都已知时丢掉对应关系。
// ---------------------------------------------------------------------------------------------

export const ANCHORED_TURN_USER_MESSAGE_PREVIEW_FOR_HUMAN_VERIFICATION_MAX_LENGTH = 200;

export const occurredAtConversationTurnReferenceSchema = z
	.object({
		anchoredNativeConversationSessionIdentity: agentConversationSessionIdentityKeySchema.nullable(),
		anchoredKanbanTaskConversationSessionQualifiedRef: z
			.object({ workspaceId: z.string(), kanbanTaskConversationSessionId: z.string() })
			.nullable(),
		anchoredCompletedTurnCheckpointReference: z.string().nullable(),
		anchoredTurnUserMessagePreviewForHumanVerification: z
			.string()
			.max(ANCHORED_TURN_USER_MESSAGE_PREVIEW_FOR_HUMAN_VERIFICATION_MAX_LENGTH)
			.nullable(),
	})
	.refine(
		(turnReference) =>
			turnReference.anchoredNativeConversationSessionIdentity !== null ||
			turnReference.anchoredKanbanTaskConversationSessionQualifiedRef !== null,
		{ message: "TurnRef requires at least one conversation session identity." },
	);
export type OccurredAtConversationTurnReference = z.infer<typeof occurredAtConversationTurnReferenceSchema>;

// ---------------------------------------------------------------------------------------------
// 公共信封（Y-EVENT-14）
// ---------------------------------------------------------------------------------------------

export interface CapturingKanbanRuntimeInstanceIdentity {
	kanbanRuntimeInstanceId: string;
	kanbanRuntimeProcessId: number;
	kanbanRuntimeCodeVersion: string;
}

export type SystemExecutedCauseOfRuntimeSystemComponentAction =
	| { systemExecutedCauseKind: "work_unit_gate_action_instance"; workUnitGateActionInstanceId: string }
	| {
			systemExecutedCauseKind: "relation_affecting_confirmable_change_side_effect_step";
			relationAffectingConfirmableChangeId: string;
			sideEffectStepIndex: number;
	  };

// 由 runtime 写入账本前组装的事件草稿；eventId、globalCommittedEventSequence 与
// recordedInSourceOfTruthEventLogAt 由账本在写入 / 提交时分配。
export interface InterWorkUnitRelationLedgerEventDraft {
	eventFamily: InterWorkUnitRelationLedgerEventFamily;
	eventKind: string;
	occurredAt: number;
	actor: KanbanActor;
	actorNativeConversationSessionIdentity: AgentConversationSessionIdentityKey | null;
	actorKanbanTaskConversationSessionId: string | null;
	actorRepositoryIdentityAtEventTime: { workspaceId: string; repositoryPath: string } | null;
	onBehalfOfInitiatingWorkUnit: InterWorkUnitRelationWorkUnitReference | null;
	causedBySystemExecutedCause: SystemExecutedCauseOfRuntimeSystemComponentAction | null;
	recordCaptureChannel: KnownRecordCaptureChannel;
	capturingKanbanRuntimeInstance: CapturingKanbanRuntimeInstanceIdentity;
	invokingKanbanCliCodeVersion: string | null;
	occurredAtConversationTurnReference: OccurredAtConversationTurnReference | null;
	idempotencyKey: string | null;
	// 账本索引用：事件涉及的 workspace 与卡片（没有时为 null）。
	subjectWorkspaceId: string | null;
	subjectTaskId: string | null;
	eventPayload: Record<string, unknown>;
}

export const INTER_WORK_UNIT_RELATION_LEDGER_EVENT_COMMIT_STATUSES = [
	"pending_board_file_write",
	"committed",
	"abandoned",
] as const;
export type InterWorkUnitRelationLedgerEventCommitStatus =
	(typeof INTER_WORK_UNIT_RELATION_LEDGER_EVENT_COMMIT_STATUSES)[number];

// 读侧形状：信封字段按 passthrough 读取，未知字段保留。
export const committedInterWorkUnitRelationLedgerEventSchema = z
	.object({
		eventId: z.string(),
		globalCommittedEventSequence: z.number().int().positive(),
		recordedInSourceOfTruthEventLogAt: z.number(),
		eventFamily: z.string(),
		eventKind: z.string(),
		occurredAt: z.number(),
		actor: z.object({ kanbanActorKind: z.string() }).passthrough(),
		recordCaptureChannel: z.string(),
		subjectWorkspaceId: z.string().nullable(),
		subjectTaskId: z.string().nullable(),
		eventPayload: z.record(z.string(), z.unknown()),
	})
	.passthrough();
export type CommittedInterWorkUnitRelationLedgerEvent = z.infer<typeof committedInterWorkUnitRelationLedgerEventSchema>;

// ---------------------------------------------------------------------------------------------
// 族 1 task_mutation_event 的 eventKind（board diff 可见的部分；message/start/park 等由各自 procedure 产出）
// ---------------------------------------------------------------------------------------------

export const TASK_MUTATION_EVENT_KINDS_DERIVED_FROM_BOARD_DIFF = [
	"task_card_created_on_board",
	"task_card_field_value_changed",
	"task_card_moved_between_non_trash_board_columns",
	"task_card_moved_to_trash_column",
	"task_card_restored_from_trash_column",
	"task_card_permanently_removed_from_board",
] as const;
export type TaskMutationEventKindDerivedFromBoardDiff =
	(typeof TASK_MUTATION_EVENT_KINDS_DERIVED_FROM_BOARD_DIFF)[number];

// 族 1 中 board diff 看不见、由专门 procedure 在 runtime 内产出的 eventKind。
export const TASK_MUTATION_EVENT_KINDS_PRODUCED_BY_DEDICATED_RUNTIME_PROCEDURES = [
	"task_card_project_transfer_completed",
	"task_message_delivery_requested_into_task_conversation_session",
] as const;
export type TaskMutationEventKindProducedByDedicatedRuntimeProcedure =
	(typeof TASK_MUTATION_EVENT_KINDS_PRODUCED_BY_DEDICATED_RUNTIME_PROCEDURES)[number];

// message 事件的「正文由谁撰写」（Y-EVENT-14）。前两个值逐字复用 ac08e 程序化注入溯源块协议的
// intent_extraction_treatment，意图系统据此把 transcript 里的用户消息与事件日志对上；读写都按开放字符串处理。
// actor 只回答「谁发的」：排队 prompt 是用户写的、由机器投递，agent 经 CLI 投递的正文不是用户陈述。
export const MESSAGE_BODY_AUTHORSHIP_INTENT_EXTRACTION_TREATMENTS = [
	"context_only_never_quote_as_user_statement",
	"user_authored_delivered_programmatically",
	"message_body_authorship_not_determinable_from_request_origin",
] as const;
export type MessageBodyAuthorshipIntentExtractionTreatment =
	(typeof MESSAGE_BODY_AUTHORSHIP_INTENT_EXTRACTION_TREATMENTS)[number];

export const TASK_MUTATION_OCCURRENCE_CAPTURE_MODES = [
	"captured_within_runtime_persistence_funnel",
	"detected_by_board_diff_outside_runtime_persistence_funnel",
] as const;
export type TaskMutationOccurrenceCaptureMode = (typeof TASK_MUTATION_OCCURRENCE_CAPTURE_MODES)[number];

// 族 3 的 observedFactKind（Y-EVENT-4）。1a 首批产出基线观测与能力激活标记。
export const FACT_OBSERVED_BY_KANBAN_RUNTIME_KINDS = [
	"main_session_turn_handed_back_to_user_observed",
	"task_commits_integrated_into_local_base_observed",
	"post_deploy_verification_passed_observed",
	// 未全勾、每个未勾项带原因移入 Done（2026-10-11）。不是「通过」，完成条件 4 不认它。
	"post_deploy_verification_closed_into_done_with_unchecked_items_reasoned_observed",
	"user_terminal_input_submission_observed_for_session",
	"legacy_board_dependency_observed_at_retirement",
	"runtime_instance_live_capture_capabilities_activated",
	"task_id_reservation_seeded_from_existing_artifacts",
	"board_state_baseline_observed_at_live_task_mutation_capture_activation",
	"task_commit_integration_final_snapshot_unavailable_at_worktree_deletion",
] as const;
export type FactObservedByKanbanRuntimeKind = (typeof FACT_OBSERVED_BY_KANBAN_RUNTIME_KINDS)[number];
