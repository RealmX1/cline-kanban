import { z } from "zod";

// Web UI 页面加载 nonce（dd2db §R3 Y-EVENT-9）：runtime 为每次页面加载（runtime-state-stream 每次连上 / 重连）
// 签发一个只存在内存里的 nonce，Web UI 的每个请求都带上它。它只证明「请求来自一个 Kanban 页面」，
// 证明不了是用户手势——手势还是浏览器端自动流转，由 saveState 的逐卡逐变更发起方标注区分（Y-EVENT-8）。
export const KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_REQUEST_HEADER_NAME =
	"x-kanban-web-ui-page-load-request-origin-nonce";

// 带了 runtime 不认识的 nonce（runtime 重启过、或旧 nonce 已被淘汰）：可重试错误，Web UI 重取 nonce 后重发一次。
export const KANBAN_WEB_UI_PAGE_LOAD_REQUEST_ORIGIN_NONCE_UNKNOWN_REACQUIRE_AND_RETRY_ERROR_MESSAGE =
	"web_ui_page_load_nonce_unknown_reacquire_and_retry";

export const kanbanWebUiPageLoadRequestOriginNonceIssueResponseSchema = z.object({
	kanbanWebUiPageLoadIssuedRequestOriginNonce: z.string(),
});
export type KanbanWebUiPageLoadRequestOriginNonceIssueResponse = z.infer<
	typeof kanbanWebUiPageLoadRequestOriginNonceIssueResponseSchema
>;

// saveState 的逐卡逐变更发起方（Y-EVENT-8）。PR 模式不结案依赖区分 commit 模式与 PR 模式的自动完成。
export const WEB_UI_BOARD_MUTATION_INITIATORS = [
	"web_ui_user_gesture",
	"web_ui_user_gesture_post_deploy_verification_panel_completion",
	"web_ui_client_automation_session_facet_driven_column_autoflow",
	"web_ui_client_automation_interrupted_session_autoflow_into_done_column",
	"web_ui_client_automation_auto_review_commit_mode_completion",
	"web_ui_client_automation_auto_review_pull_request_mode_completion",
] as const;
export const webUiBoardMutationInitiatorSchema = z.enum(WEB_UI_BOARD_MUTATION_INITIATORS);
export type WebUiBoardMutationInitiator = z.infer<typeof webUiBoardMutationInitiatorSchema>;

// 标注用与 board diff 相同的事件词表，runtime 按 taskId + 变更种类（+ 列 / 字段）配对；有 diff 没标注的记为缺标注。
export const webUiBoardMutationInitiatorAnnotationForTaskMutationEventCaptureSchema = z.object({
	taskId: z.string(),
	annotatedBoardMutationKind: z.enum([
		"task_card_created_on_board",
		"task_card_field_value_changed",
		"task_card_moved_between_non_trash_board_columns",
		"task_card_moved_to_trash_column",
		"task_card_restored_from_trash_column",
		"task_card_permanently_removed_from_board",
	]),
	fromColumnId: z.string().optional(),
	toColumnId: z.string().optional(),
	changedCardFieldNames: z.array(z.string()).optional(),
	boardMutationInitiator: webUiBoardMutationInitiatorSchema,
});
export type WebUiBoardMutationInitiatorAnnotationForTaskMutationEventCapture = z.infer<
	typeof webUiBoardMutationInitiatorAnnotationForTaskMutationEventCaptureSchema
>;

// Web UI 建卡前向 runtime 预取 id（Y-EVENT-12：id 只由 runtime 分配）。null = 本 runtime 没有激活关系账本
// （例如打不开 better-sqlite3 的启动路径），这种实例的 board 本来就只读，建卡会在保存时失败。
export const runtimeTaskIdAllocationForNewWebUiTaskCardResponseSchema = z.object({
	allocatedTaskIdUniqueAgainstGlobalTaskIdentityRegistry: z.string().nullable(),
});
export type RuntimeTaskIdAllocationForNewWebUiTaskCardResponse = z.infer<
	typeof runtimeTaskIdAllocationForNewWebUiTaskCardResponseSchema
>;
