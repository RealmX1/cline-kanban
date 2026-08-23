// 建卡起名所用的 OpenAI 兼容端点：从环境变量解析出「往哪发、用哪个模型、拿什么密钥」。
//
// 为什么是环境变量而不是 `~/.cline/kanban/config.json`：那份配置**明令不放凭据**
// （见 src/config/runtime-config.ts 顶部注释），而这里必须带一个 API key。
//
// 为什么把 env 当参数传进来而不是在函数体里直接读全局：单测不必污染进程环境就能覆盖三个变量的
// 各种缺省/覆盖组合，顺带也绕开了「禁解构 process.env」那条 lint 规则的诱惑。

/** 必填。缺了它整条起名能力就关掉——不猜、不回落到别的凭据来源。 */
export const TASK_NAME_SUGGESTION_API_KEY_ENVIRONMENT_VARIABLE_NAME =
	"KANBAN_TASK_NAME_SUGGESTION_OPENAI_COMPATIBLE_API_KEY";
export const TASK_NAME_SUGGESTION_BASE_URL_ENVIRONMENT_VARIABLE_NAME =
	"KANBAN_TASK_NAME_SUGGESTION_OPENAI_COMPATIBLE_BASE_URL";
export const TASK_NAME_SUGGESTION_MODEL_ID_ENVIRONMENT_VARIABLE_NAME = "KANBAN_TASK_NAME_SUGGESTION_MODEL_ID";

/** DeepSeek 官方直连。换成任何 OpenAI 兼容网关只需覆盖 base url 与 model id 两个变量。 */
export const DEFAULT_TASK_NAME_SUGGESTION_BASE_URL = "https://api.deepseek.com";
/** DeepSeek-V4-Flash-0731 的稳定别名。起名是短任务，选 flash 档而不是 pro 档。 */
export const DEFAULT_TASK_NAME_SUGGESTION_MODEL_ID = "deepseek-v4-flash";

export interface TaskNameSuggestionEndpointConfiguration {
	apiKey: string;
	/** 已去掉结尾斜杠，调用方直接拼 `/chat/completions`。 */
	baseUrl: string;
	modelId: string;
}

function readTrimmedEnvironmentVariable(
	environmentVariables: NodeJS.ProcessEnv,
	variableName: string,
): string | undefined {
	const value = environmentVariables[variableName]?.trim();
	return value && value.length > 0 ? value : undefined;
}

/**
 * 解析端点配置；密钥缺失时返回 `null`（= 这台机器上没配起名能力）。
 *
 * base url 与 model id 各有默认值，所以「只配一个密钥」就能用。
 */
export function resolveTaskNameSuggestionEndpointConfiguration(
	environmentVariables: NodeJS.ProcessEnv = process.env,
): TaskNameSuggestionEndpointConfiguration | null {
	const apiKey = readTrimmedEnvironmentVariable(
		environmentVariables,
		TASK_NAME_SUGGESTION_API_KEY_ENVIRONMENT_VARIABLE_NAME,
	);
	if (!apiKey) {
		return null;
	}
	const baseUrl =
		readTrimmedEnvironmentVariable(environmentVariables, TASK_NAME_SUGGESTION_BASE_URL_ENVIRONMENT_VARIABLE_NAME) ??
		DEFAULT_TASK_NAME_SUGGESTION_BASE_URL;
	return {
		apiKey,
		baseUrl: baseUrl.replace(/\/+$/u, ""),
		modelId:
			readTrimmedEnvironmentVariable(
				environmentVariables,
				TASK_NAME_SUGGESTION_MODEL_ID_ENVIRONMENT_VARIABLE_NAME,
			) ?? DEFAULT_TASK_NAME_SUGGESTION_MODEL_ID,
	};
}
