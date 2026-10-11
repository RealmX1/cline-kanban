import packageJson from "../../package.json" with { type: "json" };
import type {
	QueuedTaskPromptDeliveryEntry,
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
} from "../core/api-contract";
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

// 三条投递入口共用一个 eventKind；payload 的 taskMessageDeliveryChannel 区分走的是哪条路。
export type TaskMessageDeliveryChannelRecordedInLedger =
	| "immediate_delivery_into_task_conversation_session"
	| "agent_idle_gated_programmatic_delivery_queue"
	| "user_queued_prompt_delivery_after_current_turn";

interface TaskMessageDeliveryRequestedEventRecordingInput {
	workspaceId: string;
	// 投递目标会话（by-the-way 会话有自己的 kanban 会话 id）；subjectTaskId 是它所属的卡片。
	kanbanTaskConversationSessionId: string;
	subjectTaskId: string;
	taskMessageDeliveryChannel: TaskMessageDeliveryChannelRecordedInLedger;
	messageBodyText: string;
	// 调用方的投递幂等键原样留档；ledgerEventIdempotencyKey 是事件自己的幂等键（同一次投递意图只该有一条）。
	taskMessageDeliveryIdempotencyKey: string | null;
	ledgerEventIdempotencyKey: string | null;
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
	channelSpecificEventPayloadFields: Record<string, unknown>;
}

// 族 1 message 事件（Y-EVENT-14）：投递请求返回之后再记，不阻塞投递本身；行动者解析与卡片 incarnation 查找都在后台做。
// 记的是「请求了投递」与 runtime 当场给出的投递结论，不是送达确认（送达由 task-message-injection-ledger 收敛）。
// 发起时绑定当时激活的实例，整段后台工作纳入它的停用 drain：解析/读 board 期间 runtime 开始停机时，
// 事件仍在 worker 关闭之前落到发起时的实例；停用开始之后才发起的记录只告警、不记。
function recordTaskMessageDeliveryRequestedEventWithoutBlocking(
	input: TaskMessageDeliveryRequestedEventRecordingInput,
): void {
	const occurredAt = Date.now();
	startBackgroundLedgerEventRecordingBoundToActiveKanbanRuntimeLiveCaptureWithoutBlocking({
		backgroundLedgerEventRecordingDescriptionForDiagnostics: `${input.taskMessageDeliveryChannel} task message delivery request for ${input.kanbanTaskConversationSessionId}`,
		recordIntoLedgerOfBoundLiveCapture: async (boundLiveCapture) => {
			const intent = await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
				taskMutationIntentKind: "task_message_delivery_requested_into_task_conversation_session",
				kanbanRequestOriginActorEvidence: input.kanbanRequestOriginActorEvidence,
			});
			const subjectTaskCard = (await loadWorkspaceBoardById(input.workspaceId)).columns
				.flatMap((column) => column.cards)
				.find((card) => card.id === input.subjectTaskId);
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
						idempotencyKey: input.ledgerEventIdempotencyKey,
						subjectWorkspaceId: input.workspaceId,
						subjectTaskId: input.subjectTaskId,
						eventPayload: {
							subjectKanbanBoardCard: subjectTaskCard
								? {
										workUnitType: "kanban_board_card",
										workspaceId: input.workspaceId,
										taskId: input.subjectTaskId,
										taskIncarnationCreatedAtEpochMs: subjectTaskCard.createdAt,
									}
								: null,
							targetKanbanTaskConversationSessionId: input.kanbanTaskConversationSessionId,
							taskMessageDeliveryChannel: input.taskMessageDeliveryChannel,
							messageBodyAuthorshipIntentExtractionTreatment:
								inferMessageBodyAuthorshipIntentExtractionTreatmentFromActor(intent.resolvedKanbanActor),
							taskMessageDeliveryIdempotencyKey: input.taskMessageDeliveryIdempotencyKey,
							messageBodyContentSha256: computeSha256HexOfUtf8Text(input.messageBodyText),
							messageBodyCharacterLength: input.messageBodyText.length,
							...input.channelSpecificEventPayloadFields,
							kanbanRuntimeCodeVersion: KANBAN_RUNTIME_CODE_VERSION,
						},
					},
				],
			});
		},
	});
}

// 立即投递（sendTaskChatMessage）：每次调用都记，包括被拒的；同一幂等键的重发由 1b 投影按幂等键去重。
export function recordTaskMessageDeliveryRequestedIntoTaskConversationSessionWithoutBlocking(input: {
	workspaceId: string;
	taskChatSendRequest: RuntimeTaskChatSendRequest;
	taskChatSendResponse: RuntimeTaskChatSendResponse | null;
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
}): void {
	const subjectTaskId = input.taskChatSendRequest.taskId;
	const taskMessageDeliveryIdempotencyKey = input.taskChatSendRequest.idempotencyKey ?? null;
	recordTaskMessageDeliveryRequestedEventWithoutBlocking({
		workspaceId: input.workspaceId,
		kanbanTaskConversationSessionId: subjectTaskId,
		subjectTaskId,
		taskMessageDeliveryChannel: "immediate_delivery_into_task_conversation_session",
		messageBodyText: input.taskChatSendRequest.text,
		taskMessageDeliveryIdempotencyKey,
		ledgerEventIdempotencyKey: taskMessageDeliveryIdempotencyKey
			? `task-message-delivery:${input.workspaceId}:${subjectTaskId}:${taskMessageDeliveryIdempotencyKey}`
			: null,
		kanbanRequestOriginActorEvidence: input.kanbanRequestOriginActorEvidence,
		channelSpecificEventPayloadFields: {
			attachedImageCount: input.taskChatSendRequest.images?.length ?? 0,
			declaredMessageSourceLabel: input.taskChatSendRequest.source ?? null,
			requestedTaskSessionMode: input.taskChatSendRequest.mode ?? null,
			deliveryRequestAcceptedByRuntime: input.taskChatSendResponse?.ok ?? false,
			immediateTerminalDeliveryStatus: input.taskChatSendResponse?.terminalDelivery?.status ?? null,
			immediateTerminalDeliveryFailureReason: input.taskChatSendResponse?.terminalDelivery?.reason ?? null,
		},
	});
}

// `kanban task message --deliver-when-agent-idle`：只在本次调用新建了注入账本记录时记一条（同 key 重发什么都不做，
// 也就没有新的投递意图）。事件幂等键与立即投递同一命名空间：同一个 CLI 幂等键只对应一次投递意图，不论走哪条路。
// 排进队列后因满额落成失败的，失败由注入账本收敛，这里仍记「请求了投递」。
export function recordAgentIdleGatedProgrammaticTaskMessageDeliveryRequestedWithoutBlocking(input: {
	workspaceId: string;
	taskId: string;
	messageBodyText: string;
	taskMessageDeliveryIdempotencyKey: string;
	declaredMessageSourceLabel: string;
	queuedPromptDeliveryQueueEntryId: string;
	maxWaitForAgentIdleMs: number;
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
}): void {
	recordTaskMessageDeliveryRequestedEventWithoutBlocking({
		workspaceId: input.workspaceId,
		kanbanTaskConversationSessionId: input.taskId,
		subjectTaskId: input.taskId,
		taskMessageDeliveryChannel: "agent_idle_gated_programmatic_delivery_queue",
		messageBodyText: input.messageBodyText,
		taskMessageDeliveryIdempotencyKey: input.taskMessageDeliveryIdempotencyKey,
		ledgerEventIdempotencyKey: `task-message-delivery:${input.workspaceId}:${input.taskId}:${input.taskMessageDeliveryIdempotencyKey}`,
		kanbanRequestOriginActorEvidence: input.kanbanRequestOriginActorEvidence,
		channelSpecificEventPayloadFields: {
			attachedImageCount: 0,
			declaredMessageSourceLabel: input.declaredMessageSourceLabel,
			deliveryRequestAcceptedByRuntime: true,
			queuedPromptDeliveryQueueEntryId: input.queuedPromptDeliveryQueueEntryId,
			maxWaitForAgentIdleMs: input.maxWaitForAgentIdleMs,
		},
	});
}

// Web UI Queue tab 人排（入队，或把一条失败条目重排成新条目）：只在本次调用真的新建了队列条目时记一条。
// 同一条目 id 的重发、满额被拒都不新建条目，也就没有新的投递意图；事件幂等键按条目 id。
export function recordUserQueuedTaskPromptDeliveryRequestedWithoutBlocking(input: {
	workspaceId: string;
	newlyCreatedQueueEntry: QueuedTaskPromptDeliveryEntry;
	retriedFromSettledFailedQueueEntryId: string | null;
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
}): void {
	const entry = input.newlyCreatedQueueEntry;
	recordTaskMessageDeliveryRequestedEventWithoutBlocking({
		workspaceId: input.workspaceId,
		kanbanTaskConversationSessionId: entry.taskId,
		subjectTaskId: entry.workspaceTaskId ?? entry.taskId,
		taskMessageDeliveryChannel: "user_queued_prompt_delivery_after_current_turn",
		messageBodyText: entry.text,
		taskMessageDeliveryIdempotencyKey: null,
		ledgerEventIdempotencyKey: `task-message-delivery:${input.workspaceId}:${entry.taskId}:queue-entry:${entry.queueEntryId}`,
		kanbanRequestOriginActorEvidence: input.kanbanRequestOriginActorEvidence,
		channelSpecificEventPayloadFields: {
			attachedImageCount: 0,
			declaredMessageSourceLabel: null,
			deliveryRequestAcceptedByRuntime: true,
			queuedPromptDeliveryQueueEntryId: entry.queueEntryId,
			retriedFromSettledFailedQueueEntryId: input.retriedFromSettledFailedQueueEntryId,
			sourcePromptLibraryEntryId: entry.sourcePromptLibraryEntryId,
			queuedPromptDeliveryExpiresAtEpochMs: entry.expiresAt,
		},
	});
}
