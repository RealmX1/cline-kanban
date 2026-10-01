import packageJson from "../../package.json" with { type: "json" };
import type { RuntimeTaskChatSendRequest, RuntimeTaskChatSendResponse } from "../core/api-contract";
import type {
	KanbanActor,
	MessageBodyAuthorshipIntentExtractionTreatment,
} from "../core/inter-work-unit-relation-ledger-event-contract";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import type { KanbanRequestOriginActorEvidence } from "./kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "./kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import { startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking } from "./kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import { computeSha256HexOfUtf8Text } from "./workspace-board-task-mutation-occurrence-diff";

const KANBAN_RUNTIME_CODE_VERSION = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";

// 撰写者只能从「谁发的」间接推断：工作单元或侧边栏 agent 经 CLI 投递的正文一律不是用户陈述；
// Web UI 在 1a.3 接上页面 nonce 与发起方标注之前，聊天框直输与排队投递分不开，如实记「判不出」。
// EXPERIMENT_NODE: 无环境 CLI（人在终端敲 `kanban task message`）的正文是否应视为用户撰写；当前保守记为判不出。
function inferMessageBodyAuthorshipIntentExtractionTreatmentFromActor(
	actor: KanbanActor,
): MessageBodyAuthorshipIntentExtractionTreatment {
	switch (actor.kanbanActorKind) {
		case "kanban_board_card_work_unit":
		case "kanban_unmanaged_standalone_agent_conversation_session_work_unit":
		case "kanban_home_sidebar_agent_session_not_a_work_unit":
		case "kanban_runtime_system_component":
			return "context_only_never_quote_as_user_statement";
		default:
			return "message_body_authorship_not_determinable_from_request_origin";
	}
}

// 族 1 message 事件（Y-EVENT-14）：投递请求返回之后再记，不阻塞投递本身；行动者解析与卡片 incarnation 查找都在后台做。
// 记的是「请求了投递」与 runtime 当场给出的投递结论，不是送达确认（送达由 task-message-injection-ledger 收敛）。
// 发起时绑定当时激活的实例，整段后台工作纳入它的停用 drain：解析/读 board 期间 runtime 开始停机时，
// 事件仍在 worker 关闭之前落到发起时的实例；停用开始之后才发起的记录只告警、不记。
export function recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking(input: {
	workspaceId: string;
	taskChatSendRequest: RuntimeTaskChatSendRequest;
	taskChatSendResponse: RuntimeTaskChatSendResponse | null;
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
}): void {
	const occurredAt = Date.now();
	startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking({
		backgroundLedgerEventRecordingDescriptionForDiagnostics: `task message delivery request for ${input.taskChatSendRequest.taskId}`,
		recordIntoLedgerOfBoundLiveCapture: async (boundLiveCapture) => {
			const intent = await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
				taskMutationIntentKind: "task_message_delivery_requested_into_task_conversation_session",
				kanbanRequestOriginActorEvidence: input.kanbanRequestOriginActorEvidence,
			});
			const subjectTaskId = input.taskChatSendRequest.taskId;
			const subjectTaskCard = (await loadWorkspaceBoardById(input.workspaceId)).columns
				.flatMap((column) => column.cards)
				.find((card) => card.id === subjectTaskId);
			const taskMessageDeliveryIdempotencyKey = input.taskChatSendRequest.idempotencyKey ?? null;
			await boundLiveCapture.appendCommittedEventsIntoLedgerOfBoundLiveCapture({
				eventDrafts: [
					{
						eventFamily: "task_mutation_event",
						eventKind: "task_message_delivery_requested_into_task_conversation_session",
						occurredAt,
						actor: intent.resolvedKanbanActor,
						actorNativeConversationSessionIdentity: intent.actorNativeConversationSessionIdentity ?? null,
						actorKanbanTaskConversationSessionId: intent.actorKanbanTaskConversationSessionId ?? null,
						actorRepositoryIdentityAtEventTime: intent.actorRepositoryIdentityAtEventTime ?? null,
						onBehalfOfInitiatingWorkUnit: null,
						causedBySystemExecutedCause: null,
						recordCaptureChannel: "live_runtime_capture",
						capturingKanbanRuntimeInstance: boundLiveCapture.capturingKanbanRuntimeInstance,
						invokingKanbanCliCodeVersion: intent.invokingKanbanCliCodeVersion ?? null,
						occurredAtConversationTurnReference: null,
						idempotencyKey: taskMessageDeliveryIdempotencyKey
							? `task-message-delivery:${input.workspaceId}:${subjectTaskId}:${taskMessageDeliveryIdempotencyKey}`
							: null,
						subjectWorkspaceId: input.workspaceId,
						subjectTaskId,
						eventPayload: {
							subjectKanbanBoardCard: subjectTaskCard
								? {
										workUnitType: "kanban_board_card",
										workspaceId: input.workspaceId,
										taskId: subjectTaskId,
										taskIncarnationCreatedAtEpochMs: subjectTaskCard.createdAt,
									}
								: null,
							messageBodyAuthorshipIntentExtractionTreatment:
								inferMessageBodyAuthorshipIntentExtractionTreatmentFromActor(intent.resolvedKanbanActor),
							taskMessageDeliveryIdempotencyKey,
							messageBodyContentSha256: computeSha256HexOfUtf8Text(input.taskChatSendRequest.text),
							messageBodyCharacterLength: input.taskChatSendRequest.text.length,
							attachedImageCount: input.taskChatSendRequest.images?.length ?? 0,
							declaredMessageSourceLabel: input.taskChatSendRequest.source ?? null,
							requestedTaskSessionMode: input.taskChatSendRequest.mode ?? null,
							deliveryRequestAcceptedByRuntime: input.taskChatSendResponse?.ok ?? false,
							immediateTerminalDeliveryStatus: input.taskChatSendResponse?.terminalDelivery?.status ?? null,
							immediateTerminalDeliveryFailureReason:
								input.taskChatSendResponse?.terminalDelivery?.reason ?? null,
							kanbanRuntimeCodeVersion: KANBAN_RUNTIME_CODE_VERSION,
						},
					},
				],
			});
		},
	});
}
