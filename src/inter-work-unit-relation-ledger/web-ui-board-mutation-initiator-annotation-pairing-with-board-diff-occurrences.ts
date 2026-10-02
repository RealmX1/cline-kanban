import type { KanbanActor } from "../core/inter-work-unit-relation-ledger-event-contract";
import type {
	WebUiBoardMutationInitiator,
	WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture,
} from "../core/kanban-web-ui-page-load-request-origin-nonce";
import type { BoardDerivedTaskMutationOccurrence } from "./workspace-board-task-mutation-occurrence-diff";

function doesAnnotationDescribeOccurrence(
	annotation: WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture,
	occurrence: BoardDerivedTaskMutationOccurrence,
): boolean {
	if (annotation.taskId !== occurrence.taskId || annotation.annotatedBoardMutationKind !== occurrence.eventKind) {
		return false;
	}
	const payload = occurrence.eventPayloadSpecificToEventKind;
	if (annotation.fromColumnId !== undefined && annotation.fromColumnId !== payload.fromBoardColumnId) {
		return false;
	}
	if (annotation.toColumnId !== undefined && annotation.toColumnId !== payload.toBoardColumnId) {
		return false;
	}
	if (
		annotation.changedCardFieldNames !== undefined &&
		typeof payload.changedTaskCardFieldName === "string" &&
		!annotation.changedCardFieldNames.includes(payload.changedTaskCardFieldName)
	) {
		return false;
	}
	return true;
}

function describeKanbanActorForWebUiBoardMutationInitiator(initiator: WebUiBoardMutationInitiator): KanbanActor {
	if (
		initiator === "web_ui_user_gesture" ||
		initiator === "web_ui_user_gesture_post_deploy_verification_panel_completion"
	) {
		return { kanbanActorKind: "kanban_web_ui_user_gesture_with_verified_page_load_nonce" };
	}
	return {
		kanbanActorKind: "kanban_web_ui_client_side_automation_with_verified_page_load_nonce",
		boardMutationInitiator: initiator,
	};
}

// Y-EVENT-8：一次整板保存里可能同时有用户拖拽和浏览器端自动流转，所以按 occurrence 逐条配对发起方。
// 只在请求已经过页面 nonce 校验时细化（CLI 声明头优先、永远不记为用户）；配不上的 occurrence 保持「缺标注」。
// 同一条标注可以配多条 occurrence（例如一次编辑同时改了 prompt 与派生 title）。
export function resolveKanbanActorForBoardDerivedOccurrenceUsingWebUiBoardMutationInitiatorAnnotations(input: {
	requestLevelResolvedKanbanActor: KanbanActor;
	occurrence: BoardDerivedTaskMutationOccurrence;
	webUiBoardMutationInitiatorAnnotations: WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture[];
}): { actor: KanbanActor; pairedWebUiBoardMutationInitiator: WebUiBoardMutationInitiator | null } {
	if (
		input.requestLevelResolvedKanbanActor.kanbanActorKind !==
		"kanban_web_ui_request_with_verified_page_load_nonce_without_board_mutation_initiator_annotation"
	) {
		return { actor: input.requestLevelResolvedKanbanActor, pairedWebUiBoardMutationInitiator: null };
	}
	const pairedAnnotation = input.webUiBoardMutationInitiatorAnnotations.find((annotation) =>
		doesAnnotationDescribeOccurrence(annotation, input.occurrence),
	);
	if (!pairedAnnotation) {
		return { actor: input.requestLevelResolvedKanbanActor, pairedWebUiBoardMutationInitiator: null };
	}
	return {
		actor: describeKanbanActorForWebUiBoardMutationInitiator(pairedAnnotation.boardMutationInitiator),
		pairedWebUiBoardMutationInitiator: pairedAnnotation.boardMutationInitiator,
	};
}
