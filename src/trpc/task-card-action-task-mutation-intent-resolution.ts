import type { WebUiBoardMutationInitiator } from "../core/kanban-web-ui-page-load-request-origin-nonce";
import { webUiBoardMutationInitiatorAnnotationForTaskMutationEventCaptureSchema } from "../core/kanban-web-ui-page-load-request-origin-nonce";
import type {
	KanbanActorResolutionLookups,
	KanbanRequestOriginActorEvidence,
} from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import { resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-lookups-backed-by-workspace-state-files";
import type { TaskMutationIntentWithResolvedActor } from "../state/workspace-board-persistence-funnel-task-mutation-event-capture-port";

// `taskCardAction.*` 每一次 board 写入进漏斗时带的意图与行动者（dd2db Y-EVENT-2 的必填参数）。
//
// 意图种类按请求来源分两套名字：
//   - 带 CLI 行动者声明头的请求（kanban CLI）：沿用迁移前 `workspace.applyKanbanCliTaskBoardMutation` 的旧名
//     （kanban_cli_task_update / _start_move_to_in_progress / _trash / _delete），账本读侧据此把迁移前后的同一
//     动词对齐；CLI 从没有过的动作用 `kanban_cli_task_card_action_*`。
//   - 其余请求（浏览器、裸 tRPC 调用方）：`web_ui_task_card_action_*`。
// 浏览器声明的发起方（boardMutationInitiator）在这里合成为该卡全部 board 变更的发起方标注：一次卡片动作 = 一个
// 发起方，而锁内只改这几张卡，所以按卡覆盖全部变更种类不会误配到别人的变更上。漏斗只在请求带已校验的页面 nonce
// 时才采信标注（CLI 声明头优先，永远不记为用户）；这里对 CLI 请求干脆不附标注，免得读者误以为它会生效。

export type TaskCardActionTaskMutationIntentSubject =
	| "start_agent_session_moving_task_card_into_in_progress"
	| "move_task_card_into_review_handing_agent_turn_to_user"
	| "move_task_card_between_non_trash_columns_without_session_side_effects"
	| "move_task_card_into_done"
	| "restore_task_card_from_done_into_review"
	| "move_task_card_back_into_done_after_failed_restore"
	| "permanently_delete_task_cards"
	| "update_task_card_field_values"
	| "pin_task_card_to_task_pinboard_or_update_pin_reason"
	| "unpin_task_card_from_task_pinboard";

const KANBAN_CLI_TASK_MUTATION_INTENT_KIND_BY_TASK_CARD_ACTION_SUBJECT = {
	start_agent_session_moving_task_card_into_in_progress: "kanban_cli_task_start_move_to_in_progress",
	move_task_card_into_review_handing_agent_turn_to_user: "kanban_cli_task_card_action_move_into_review",
	move_task_card_between_non_trash_columns_without_session_side_effects:
		"kanban_cli_task_card_action_move_between_non_trash_columns",
	move_task_card_into_done: "kanban_cli_task_trash",
	restore_task_card_from_done_into_review: "kanban_cli_task_card_action_restore_from_done_into_review",
	move_task_card_back_into_done_after_failed_restore:
		"kanban_cli_task_card_action_move_back_into_done_after_failed_restore",
	permanently_delete_task_cards: "kanban_cli_task_delete",
	update_task_card_field_values: "kanban_cli_task_update",
	pin_task_card_to_task_pinboard_or_update_pin_reason: "kanban_cli_task_card_action_pin_to_task_pinboard",
	unpin_task_card_from_task_pinboard: "kanban_cli_task_card_action_unpin_from_task_pinboard",
} as const satisfies Record<TaskCardActionTaskMutationIntentSubject, string>;

const WEB_UI_TASK_MUTATION_INTENT_KIND_BY_TASK_CARD_ACTION_SUBJECT = {
	start_agent_session_moving_task_card_into_in_progress:
		"web_ui_task_card_action_start_agent_session_moving_into_in_progress",
	move_task_card_into_review_handing_agent_turn_to_user:
		"web_ui_task_card_action_move_into_review_handing_agent_turn_to_user",
	move_task_card_between_non_trash_columns_without_session_side_effects:
		"web_ui_task_card_action_move_between_non_trash_columns",
	move_task_card_into_done: "web_ui_task_card_action_move_into_done",
	restore_task_card_from_done_into_review: "web_ui_task_card_action_restore_from_done_into_review",
	move_task_card_back_into_done_after_failed_restore:
		"web_ui_task_card_action_move_back_into_done_after_failed_restore",
	permanently_delete_task_cards: "web_ui_task_card_action_permanently_delete",
	update_task_card_field_values: "web_ui_task_card_action_update_field_values",
	pin_task_card_to_task_pinboard_or_update_pin_reason: "web_ui_task_card_action_pin_to_task_pinboard",
	unpin_task_card_from_task_pinboard: "web_ui_task_card_action_unpin_from_task_pinboard",
} as const satisfies Record<TaskCardActionTaskMutationIntentSubject, string>;

// 头存在但损坏也算 CLI 请求（行动者解析为 unresolved），与 resolveKanbanActorFromRequestOriginEvidence 同判据。
export function isKanbanRequestOriginCarryingKanbanCliActorClaimsHeader(
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
): boolean {
	return (
		kanbanRequestOriginActorEvidence.decodedCliActorClaimsRequestHeader.cliActorClaimsRequestHeaderStatus !== "absent"
	);
}

export function resolveTaskMutationIntentKindForTaskCardAction(
	taskCardActionTaskMutationIntentSubject: TaskCardActionTaskMutationIntentSubject,
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence,
): string {
	return isKanbanRequestOriginCarryingKanbanCliActorClaimsHeader(kanbanRequestOriginActorEvidence)
		? KANBAN_CLI_TASK_MUTATION_INTENT_KIND_BY_TASK_CARD_ACTION_SUBJECT[taskCardActionTaskMutationIntentSubject]
		: WEB_UI_TASK_MUTATION_INTENT_KIND_BY_TASK_CARD_ACTION_SUBJECT[taskCardActionTaskMutationIntentSubject];
}

const ANNOTATED_BOARD_MUTATION_KINDS_COVERING_EVERY_CHANGE_OF_ONE_TASK_CARD =
	webUiBoardMutationInitiatorAnnotationForTaskMutationEventCaptureSchema.shape.annotatedBoardMutationKind.options;

export async function resolveTaskMutationIntentWithResolvedActorForTaskCardAction(input: {
	taskCardActionTaskMutationIntentSubject: TaskCardActionTaskMutationIntentSubject;
	kanbanRequestOriginActorEvidence: KanbanRequestOriginActorEvidence;
	boardMutationInitiatorDeclaredByWebUi: WebUiBoardMutationInitiator | undefined;
	// 这次写入会改到的卡。只用于合成发起方标注；整列永久删除时是锁外预读到的那一列卡。
	subjectTaskIdsOfTaskCardAction: readonly string[];
	kanbanActorResolutionLookups?: KanbanActorResolutionLookups;
}): Promise<TaskMutationIntentWithResolvedActor> {
	const taskMutationIntentWithResolvedActor = await resolveTaskMutationIntentFromKanbanRequestOriginActorEvidence({
		taskMutationIntentKind: resolveTaskMutationIntentKindForTaskCardAction(
			input.taskCardActionTaskMutationIntentSubject,
			input.kanbanRequestOriginActorEvidence,
		),
		kanbanRequestOriginActorEvidence: input.kanbanRequestOriginActorEvidence,
		kanbanActorResolutionLookups: input.kanbanActorResolutionLookups,
	});
	const boardMutationInitiator = input.boardMutationInitiatorDeclaredByWebUi;
	if (
		boardMutationInitiator === undefined ||
		isKanbanRequestOriginCarryingKanbanCliActorClaimsHeader(input.kanbanRequestOriginActorEvidence)
	) {
		return taskMutationIntentWithResolvedActor;
	}
	return {
		...taskMutationIntentWithResolvedActor,
		webUiBoardMutationInitiatorAnnotationsForTaskMutationEventCapture: [
			...new Set(input.subjectTaskIdsOfTaskCardAction),
		].flatMap((taskId) =>
			ANNOTATED_BOARD_MUTATION_KINDS_COVERING_EVERY_CHANGE_OF_ONE_TASK_CARD.map((annotatedBoardMutationKind) => ({
				taskId,
				annotatedBoardMutationKind,
				boardMutationInitiator,
			})),
		),
	};
}
