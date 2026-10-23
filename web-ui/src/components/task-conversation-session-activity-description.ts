import type { RuntimeTaskConversationSessionActivityObservation } from "@/runtime/types";
import { formatCompactElapsedSince } from "@/utils/format-compact-elapsed";

const SESSION_ROLE_LABEL: Record<RuntimeTaskConversationSessionActivityObservation["role"], string> = {
	main: "主对话",
	task_collaborator: "协作会话（peer）",
	by_the_way: "侧问会话（By the way）",
	former_main: "前主对话",
};
const ACTIVITY_KIND_LABEL = {
	accepted_user_input: "输入已被接受",
	agent_output: "Agent 新输出",
	tool_activity: "工具活动",
	context_compaction: "上下文压缩",
	agent_turn_boundary: "Agent 回合边界",
	model_request_dispatch: "模型请求参考",
} as const;

/** 各会话独立列出；未知时刻不以 updatedAt、进程启动或其他会话补值。 */
export function describeTaskConversationSessionActivityObservations(
	observations: readonly RuntimeTaskConversationSessionActivityObservation[],
	nowMs: number,
): string {
	return observations
		.map(({ sessionId, role, agentId, lastEffectiveAgentConversationActivityObservation: activity }) => {
			const identity = `${SESSION_ROLE_LABEL[role]} · ${agentId ?? "Agent 未知"} · ${sessionId}`;
			if (!activity) return `${identity}\n尚无可信活动时间`;
			return `${identity}\n${formatCompactElapsedSince(activity.observedAtMs, nowMs)} · ${new Date(activity.observedAtMs).toLocaleString()}\n${ACTIVITY_KIND_LABEL[activity.activityKind]} · 证据：${activity.evidenceKind}`;
		})
		.join("\n\n");
}
