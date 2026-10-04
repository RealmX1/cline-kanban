import { z } from "zod";

// CLI 请求随附的「调用环境行动者声明」（dd2db §R3 Y-EVENT-7、Y-EVENT-9）。
// 为什么由 CLI 读环境变量、交给 runtime 解析：agent 进程及其一切子进程（bash 变量、Python subprocess、
// JS exec）都会继承这些变量，所以不论 agent 用什么方式调 CLI，归属都能 100% 召回。
// 这只是「声明」：任何进程都能在命令前伪造环境变量，runtime 只把它当作行动者解析的输入，
// 绝不据此授予系统组件身份（Y-EVENT-7 解析第 1 步只接受进程内显式传入的系统组件身份）。

export const KANBAN_CLI_INVOCATION_ENVIRONMENT_ACTOR_CLAIMS_REQUEST_HEADER_NAME =
	"x-kanban-cli-invocation-environment-actor-claims";

// 只收白名单变量：卡片会话注入的 KANBAN_*，以及各 harness 向工具子进程暴露的原生会话 id
// （阶段 0 探针：Claude、Codex、Cursor 暴露；Kimi、omp 不暴露，按 Y-EVENT-15 降级）。
export const KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION = [
	"KANBAN_TASK_ID",
	"KANBAN_HOOK_WORKSPACE_ID",
	"KANBAN_TASK_CONVERSATION_SESSION_ID",
	"KANBAN_PROJECT_PATH",
	"CLAUDE_CODE_SESSION_ID",
	"CODEX_THREAD_ID",
	"CURSOR_CONVERSATION_ID",
] as const;
export type KanbanCliInvocationEnvironmentVariableNameClaimedForActorResolution =
	(typeof KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION)[number];

// 原生会话 id 变量 → 宿主 agentId（会话身份键的前半）。
export const NATIVE_CONVERSATION_SESSION_ID_ENVIRONMENT_VARIABLE_NAME_TO_CONVERSATION_SESSION_HOST_KANBAN_AGENT_ID = {
	CLAUDE_CODE_SESSION_ID: "claude",
	CODEX_THREAD_ID: "codex",
	CURSOR_CONVERSATION_ID: "cursor",
} as const satisfies Partial<Record<KanbanCliInvocationEnvironmentVariableNameClaimedForActorResolution, string>>;

const MAX_CLAIMED_ENVIRONMENT_VARIABLE_VALUE_LENGTH = 1024;

export const kanbanCliInvocationEnvironmentActorClaimsSchema = z.object({
	claimedEnvironmentVariableValuesByName: z.record(
		z.string(),
		z.string().max(MAX_CLAIMED_ENVIRONMENT_VARIABLE_VALUE_LENGTH),
	),
	invokingKanbanCliCodeVersion: z.string().max(64),
	invokingProcessWorkingDirectory: z.string().max(4096).nullable(),
});
export type KanbanCliInvocationEnvironmentActorClaims = z.infer<typeof kanbanCliInvocationEnvironmentActorClaimsSchema>;

export function collectKanbanCliInvocationEnvironmentActorClaims(input: {
	environment: Record<string, string | undefined>;
	invokingKanbanCliCodeVersion: string;
	invokingProcessWorkingDirectory: string | null;
}): KanbanCliInvocationEnvironmentActorClaims {
	const claimedEnvironmentVariableValuesByName: Record<string, string> = {};
	for (const variableName of KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION) {
		const value = input.environment[variableName]?.trim();
		if (value) {
			claimedEnvironmentVariableValuesByName[variableName] = value.slice(
				0,
				MAX_CLAIMED_ENVIRONMENT_VARIABLE_VALUE_LENGTH,
			);
		}
	}
	return {
		claimedEnvironmentVariableValuesByName,
		invokingKanbanCliCodeVersion: input.invokingKanbanCliCodeVersion,
		invokingProcessWorkingDirectory: input.invokingProcessWorkingDirectory,
	};
}

// 请求头只能放 ASCII：JSON → base64url。
export function encodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
	claims: KanbanCliInvocationEnvironmentActorClaims,
): string {
	return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

export type DecodedKanbanCliInvocationEnvironmentActorClaimsRequestHeader =
	| { cliActorClaimsRequestHeaderStatus: "absent" }
	| { cliActorClaimsRequestHeaderStatus: "present_but_malformed" }
	| { cliActorClaimsRequestHeaderStatus: "present"; claims: KanbanCliInvocationEnvironmentActorClaims };

// 头不存在 ≠ 头损坏：前者按「不是 CLI 请求」解析，后者是 CLI 请求但声明不可读，行动者为 unresolved。
export function decodeKanbanCliInvocationEnvironmentActorClaimsRequestHeaderValue(
	headerValue: string | string[] | undefined,
): DecodedKanbanCliInvocationEnvironmentActorClaimsRequestHeader {
	const rawValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;
	if (!rawValue) {
		return { cliActorClaimsRequestHeaderStatus: "absent" };
	}
	try {
		const parsed = kanbanCliInvocationEnvironmentActorClaimsSchema.safeParse(
			JSON.parse(Buffer.from(rawValue, "base64url").toString("utf8")),
		);
		if (!parsed.success) {
			return { cliActorClaimsRequestHeaderStatus: "present_but_malformed" };
		}
		const claimedEnvironmentVariableValuesByName: Record<string, string> = {};
		for (const variableName of KANBAN_CLI_INVOCATION_ENVIRONMENT_VARIABLE_NAMES_CLAIMED_FOR_ACTOR_RESOLUTION) {
			const value = parsed.data.claimedEnvironmentVariableValuesByName[variableName];
			if (value) claimedEnvironmentVariableValuesByName[variableName] = value;
		}
		return {
			cliActorClaimsRequestHeaderStatus: "present",
			claims: { ...parsed.data, claimedEnvironmentVariableValuesByName },
		};
	} catch {
		return { cliActorClaimsRequestHeaderStatus: "present_but_malformed" };
	}
}
