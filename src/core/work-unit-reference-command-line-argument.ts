import { NATIVE_CONVERSATION_SESSION_ID_ENVIRONMENT_VARIABLE_NAME_TO_CONVERSATION_SESSION_HOST_KANBAN_AGENT_ID } from "./kanban-cli-invocation-environment-actor-claims";
import type { WorkUnitSelectorForRelationRead } from "./work-unit-relation-read-api-contract";

// dd2db：`kanban work-unit` 各动词的工作单元引用写法（1b 的读动词起用，阶段 2 的写动词沿用同一语法）：
//   <taskId>                                 裸卡片 id；runtime 跨 project 解析，候选不唯一时 fail closed
//   <workspaceId>/<taskId>                   限定 workspace 的卡片
//   standalone:<agentId>:<nativeSessionId>   看板外独立 agent 会话
// 主语缺省时从调用进程的环境解析（R3.4「主语一律由环境变量解析」）。

const STANDALONE_SESSION_WORK_UNIT_REFERENCE_PREFIX = "standalone:";

export const WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION =
	"<taskId> | <workspaceId>/<taskId> | standalone:<agentId>:<nativeSessionId>";

export function parseWorkUnitReferenceCommandLineArgument(argument: string): WorkUnitSelectorForRelationRead {
	const trimmedArgument = argument.trim();
	if (trimmedArgument.startsWith(STANDALONE_SESSION_WORK_UNIT_REFERENCE_PREFIX)) {
		const standaloneSessionIdentity = trimmedArgument.slice(STANDALONE_SESSION_WORK_UNIT_REFERENCE_PREFIX.length);
		const separatorIndex = standaloneSessionIdentity.indexOf(":");
		const conversationSessionHostKanbanAgentId = standaloneSessionIdentity.slice(0, separatorIndex).trim();
		const nativeConversationSessionId = standaloneSessionIdentity.slice(separatorIndex + 1).trim();
		if (separatorIndex <= 0 || !conversationSessionHostKanbanAgentId || !nativeConversationSessionId) {
			throw new Error(
				`Invalid standalone session work unit reference "${argument}"; expected standalone:<agentId>:<nativeSessionId>.`,
			);
		}
		return {
			workUnitSelectorKind: "kanban_unmanaged_standalone_agent_conversation_session",
			conversationSessionHostKanbanAgentId,
			nativeConversationSessionId,
		};
	}
	const workspaceSeparatorIndex = trimmedArgument.lastIndexOf("/");
	const workspaceId = workspaceSeparatorIndex > 0 ? trimmedArgument.slice(0, workspaceSeparatorIndex).trim() : "";
	const bareTaskId = trimmedArgument.slice(workspaceSeparatorIndex + 1).trim();
	if (!bareTaskId) {
		throw new Error(
			`Invalid work unit reference "${argument}"; expected ${WORK_UNIT_REFERENCE_COMMAND_LINE_ARGUMENT_SYNTAX_DESCRIPTION}.`,
		);
	}
	return {
		workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
		bareTaskId,
		...(workspaceId ? { workspaceId } : {}),
	};
}

// 调用进程自己是哪个工作单元：卡片会话注入的 KANBAN_TASK_ID（+ workspace id）优先，其次是 harness 暴露的原生会话 id
// （看板外独立会话）。两者都没有时返回 null，由调用方要求显式传引用。
export function resolveWorkUnitSelectorOfInvokingProcessEnvironment(
	environment: Record<string, string | undefined>,
): WorkUnitSelectorForRelationRead | null {
	const kanbanTaskId = environment.KANBAN_TASK_ID?.trim();
	if (kanbanTaskId) {
		const workspaceId = environment.KANBAN_HOOK_WORKSPACE_ID?.trim();
		return {
			workUnitSelectorKind: "kanban_board_card_by_bare_task_id",
			bareTaskId: kanbanTaskId,
			...(workspaceId ? { workspaceId } : {}),
		};
	}
	for (const [environmentVariableName, conversationSessionHostKanbanAgentId] of Object.entries(
		NATIVE_CONVERSATION_SESSION_ID_ENVIRONMENT_VARIABLE_NAME_TO_CONVERSATION_SESSION_HOST_KANBAN_AGENT_ID,
	)) {
		const nativeConversationSessionId = environment[environmentVariableName]?.trim();
		if (nativeConversationSessionId) {
			return {
				workUnitSelectorKind: "kanban_unmanaged_standalone_agent_conversation_session",
				conversationSessionHostKanbanAgentId,
				nativeConversationSessionId,
			};
		}
	}
	return null;
}
