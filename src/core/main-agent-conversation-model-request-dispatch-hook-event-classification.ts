// 判定「这一条 hook 事件意味着 harness 紧接着要向**主对话**模型发请求」——Cache warm 倒计时起点的唯一写入判据。
// 字段语义见 api-contract.ts 的 runtimeMainAgentConversationModelRequestDispatchEvidenceKindSchema 注释。
//
// 纯函数，由 hooks-api 在恢复拦截之后、转移闸之前调用：被恢复守卫拦下的 UserPromptSubmit 早已 return，
// 走到这里的 UserPromptSubmit 都会真的触发一轮请求。

import type {
	RuntimeHookEvent,
	RuntimeMainAgentConversationContextCompactionTrigger,
	RuntimeMainAgentConversationModelRequestDispatchEvidenceKind,
	RuntimeTaskSessionUserTurnKind,
} from "./api-contract.js";
import type { SessionFacets } from "./session-activity.js";

// 由「一个尚未执行完的主 agent 工具调用」引出的用户回合：AskUserQuestion / ExitPlanMode / 权限请求。
// 用户在终端里答完，这个工具调用随即执行完毕、PostToolUse 照常触发、工具结果发回模型——是同一个 agent
// 回合的延续，算一次请求。刻意不复用 MODAL_USER_DECISION_TURN_KINDS：那份集合还收 needs_input（兜底
// 待输入），而它不对应任何悬而未决的工具调用，收进来就放进了「Stop 之后后台子代理的工具事件」。
const USER_TURN_KINDS_RAISED_BY_PENDING_MAIN_AGENT_TOOL_CALL: ReadonlySet<RuntimeTaskSessionUserTurnKind> =
	new Set<RuntimeTaskSessionUserTurnKind>(["question", "plan_review", "permission"]);

const TOOL_CALL_COMPLETION_EVIDENCE_KIND_BY_NORMALIZED_HOOK_EVENT_NAME: Readonly<
	Record<string, RuntimeMainAgentConversationModelRequestDispatchEvidenceKind>
> = {
	posttooluse: "post_tool_use_hook_event",
	posttoolusefailure: "post_tool_use_failure_hook_event",
	aftertool: "after_tool_hook_event",
};

export function classifyHookEventAsMainAgentConversationModelRequestDispatch(input: {
	event: RuntimeHookEvent;
	// 已 trim + 小写。
	normalizedHookEventName: string;
	hookEventFiredInsideSubagentContext: boolean;
	// ingest 时（转移之前）的会话 facet。
	sessionFacetsBeforeTransition: SessionFacets;
	// 仅压缩完成事件携带。
	mainAgentConversationContextCompactionTriggerReportedByHarness?: RuntimeMainAgentConversationContextCompactionTrigger;
}): RuntimeMainAgentConversationModelRequestDispatchEvidenceKind | null {
	// 子代理的请求走它自己的缓存前缀，不刷新主对话的缓存（子代理自己的自动压缩同理）。
	if (input.hookEventFiredInsideSubagentContext) {
		return null;
	}
	if (input.event === "main_agent_conversation_context_compaction_completed") {
		// 不受下方「用户回合冻结」约束：手动 /compact 本来就发生在用户回合，而 PostCompact 在主线程触发、
		// 不带 agent_id，不会混入后台子代理的事件。trigger 缺失时按回合归属判：agent 回合里的压缩只可能是自动的。
		const isAutomaticCompactionFollowedByContinuationRequest =
			input.mainAgentConversationContextCompactionTriggerReportedByHarness ===
				"automatic_context_window_compaction" ||
			(input.mainAgentConversationContextCompactionTriggerReportedByHarness === undefined &&
				input.sessionFacetsBeforeTransition.turnOwner === "agent");
		return isAutomaticCompactionFollowedByContinuationRequest
			? "automatic_context_compaction_completed_continuation_model_request_follows_immediately"
			: "manual_compact_command_completed_main_conversation_prompt_cache_replaced_without_follow_up_request";
	}
	if (input.event === "to_in_progress" && input.normalizedHookEventName === "userpromptsubmit") {
		return "user_prompt_submit_hook_event_accepted";
	}
	if (input.event === "to_in_progress" && input.normalizedHookEventName === "beforeagent") {
		return "before_agent_hook_event";
	}
	const toolCallCompletionEvidenceKind =
		TOOL_CALL_COMPLETION_EVIDENCE_KIND_BY_NORMALIZED_HOOK_EVENT_NAME[input.normalizedHookEventName];
	if (!toolCallCompletionEvidenceKind) {
		return null;
	}
	// 用户回合冻结：主 agent 已 Stop、球在用户手上时到来的工具事件，来自仍在跑的后台子代理
	// （harness 没给它带 agent_id 时这是唯一防线）——主对话此刻没有发请求。唯一例外是「工具调用本身
	// 引出的用户回合」，见上方集合注释。
	const facets = input.sessionFacetsBeforeTransition;
	if (facets.turnOwner === "agent") {
		return toolCallCompletionEvidenceKind;
	}
	if (facets.turnOwner === "user" && USER_TURN_KINDS_RAISED_BY_PENDING_MAIN_AGENT_TOOL_CALL.has(facets.userTurnKind)) {
		return toolCallCompletionEvidenceKind;
	}
	return null;
}
