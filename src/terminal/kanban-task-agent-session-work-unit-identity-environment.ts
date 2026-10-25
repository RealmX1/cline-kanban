import { resolveKanbanCommandParts } from "../core/kanban-command";
import { KANBAN_HOOK_TASK_ID_ENV, KANBAN_HOOK_WORKSPACE_ID_ENV } from "./hook-runtime-context";

// 卡片 agent 会话的「工作单元身份」环境变量（dd2db §R3 R3.3 1a：三种 transport 注入 KANBAN_*）。
// agent 及其一切子进程继承这些变量；CLI 把它们作为行动者声明发给 runtime，归属与调用方式无关。
// PTY 路径在 session-manager 里内联构造同名变量；ACP 写进 omp 进程 env；Cline SDK（进程内）经按会话的
// bash executor env 注入（Cline 的非 bash 工具不起子进程，不涉及）。
export function buildKanbanTaskAgentSessionWorkUnitIdentityEnvironment(input: {
	workspaceTaskId: string;
	kanbanTaskConversationSessionId: string;
	workspaceId: string;
	workspaceRepositoryPath: string;
}): Record<string, string> {
	return {
		KANBAN_VISUALIZATION_PUBLISH_COMMAND_JSON: JSON.stringify(resolveKanbanCommandParts()),
		KANBAN_TASK_ID: input.workspaceTaskId,
		KANBAN_ATTEMPT_ID: input.kanbanTaskConversationSessionId,
		CLINE_KANBAN_TASK_ID: input.workspaceTaskId,
		CLINE_KANBAN_ATTEMPT_ID: input.kanbanTaskConversationSessionId,
		KANBAN_TASK_CONVERSATION_SESSION_ID: input.kanbanTaskConversationSessionId,
		KANBAN_PROJECT_PATH: input.workspaceRepositoryPath,
		CLINE_KANBAN_PROJECT_PATH: input.workspaceRepositoryPath,
		[KANBAN_HOOK_TASK_ID_ENV]: input.kanbanTaskConversationSessionId,
		[KANBAN_HOOK_WORKSPACE_ID_ENV]: input.workspaceId,
	};
}

// runtime 进程启动时要擦除的继承变量：runtime 若是从某张卡的 shell 或某个独立 agent 会话里启动的
// （例如在 task worktree 里跑 dev:full），这些变量会经 process.env 泄漏给进程内的 Cline 工具调用与
// 没有显式覆盖的子进程，把它们的一切 CLI 调用错记到那张卡或那个会话名下。
export const KANBAN_RUNTIME_INHERITED_WORK_UNIT_IDENTITY_ENVIRONMENT_VARIABLE_NAMES_TO_SCRUB_AT_START = [
	"KANBAN_VISUALIZATION_PUBLISH_COMMAND_JSON",
	"KANBAN_TASK_ID",
	"KANBAN_ATTEMPT_ID",
	"CLINE_KANBAN_TASK_ID",
	"CLINE_KANBAN_ATTEMPT_ID",
	"KANBAN_TASK_CONVERSATION_SESSION_ID",
	"KANBAN_PROJECT_PATH",
	"CLINE_KANBAN_PROJECT_PATH",
	KANBAN_HOOK_TASK_ID_ENV,
	KANBAN_HOOK_WORKSPACE_ID_ENV,
	"CLAUDE_CODE_SESSION_ID",
	"CODEX_THREAD_ID",
	"CURSOR_CONVERSATION_ID",
] as const;

export function scrubInheritedWorkUnitIdentityEnvironmentVariablesFromKanbanRuntimeProcess(
	environment: Record<string, string | undefined>,
): string[] {
	const scrubbedEnvironmentVariableNames: string[] = [];
	for (const variableName of KANBAN_RUNTIME_INHERITED_WORK_UNIT_IDENTITY_ENVIRONMENT_VARIABLE_NAMES_TO_SCRUB_AT_START) {
		if (environment[variableName] !== undefined) {
			delete environment[variableName];
			scrubbedEnvironmentVariableNames.push(variableName);
		}
	}
	return scrubbedEnvironmentVariableNames;
}
