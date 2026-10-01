// Kanban 能用的**模型 provider 凭据注册表**：从环境变量按 provider 编址读出来。
//
// ## 为什么按 provider 编址，而不是按用途
//
// 一台机器上可能同时配着好几家（DeepSeek 起名、OpenRouter 兜底、将来某个 agent 的 key……）。按 provider
// 编址，凭据只配一次、谁都能按 id 取；按用途编址则同一把 key 要在每个用途下重复配一遍。
//
// 「哪个功能在用哪家」不写进变量名，而是**每次调用带一条用途 metadata 记进用量日志**
//（见 request-model-provider-chat-completion.ts 的 `modelUsagePurpose`）——那既能事后统计，也不会把
// 一次功能改名变成一次环境变量迁移。
//
// ## 变量形状
//
//   KANBAN_MODEL_PROVIDER_<ID>_API_KEY     必填，配了才算这家 provider 存在
//   KANBAN_MODEL_PROVIDER_<ID>_BASE_URL    可选，已知 provider 有内置默认值
//   KANBAN_MODEL_PROVIDER_<ID>_MODEL_ID    可选，已知 provider 有内置默认值
//   KANBAN_DEFAULT_MODEL_PROVIDER_ID       可选，但一旦写了就有约束力，见 resolveDefaultModelProviderId
//
// `<ID>` 是 provider id 的大写形式、连字符换成下划线：`deepseek` → `DEEPSEEK`，`my-gateway` → `MY_GATEWAY`。
// provider id 本身限定为小写 `[a-z0-9-]+`，于是两个方向的换算无歧义。
//
// ## 为什么是环境变量
//
// `~/.cline/kanban/config.json` 明令不放凭据（见 src/config/runtime-config.ts 顶部注释）。env 也让
// 「换一家网关」不需要改代码——把 base url 指向 LiteLLM / OpenRouter 这类聚合网关即可。
//
// 把 env 当参数传进来而不是在函数体里直接读全局：单测不必污染进程环境，顺带也绕开了
// 「禁解构 process.env」那条 lint 规则的诱惑。

export const MODEL_PROVIDER_ENVIRONMENT_VARIABLE_PREFIX = "KANBAN_MODEL_PROVIDER_";
export const MODEL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLE_SUFFIX = "_API_KEY";
export const MODEL_PROVIDER_BASE_URL_ENVIRONMENT_VARIABLE_SUFFIX = "_BASE_URL";
export const MODEL_PROVIDER_MODEL_ID_ENVIRONMENT_VARIABLE_SUFFIX = "_MODEL_ID";
export const DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME = "KANBAN_DEFAULT_MODEL_PROVIDER_ID";

/**
 * 已知 provider 的内置默认端点与模型——**只收录真正接过的**。
 *
 * 有默认值意味着「只配一个 API key 就能用」。没收录的 provider id 一样能用，只是必须自己把
 * base url 与 model id 也配齐。新接一家时在这里加一行，别提前塞一堆没验证过的条目。
 */
export const KNOWN_MODEL_PROVIDER_DEFAULTS: Readonly<Record<string, { baseUrl: string; modelId: string }>> = {
	// deepseek-v4-flash 是 DeepSeek 侧的浮动别名：它背后是哪个模型、按哪档计价随上游变（见官方定价页），
	// 别把某一时刻的解析结果写死进注释或文案。
	deepseek: { baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash" },
};

export interface ModelProviderCredential {
	modelProviderId: string;
	apiKey: string;
	/** 已去掉结尾斜杠，调用方直接拼 `/chat/completions`。 */
	baseUrl: string;
	modelId: string;
}

/** provider id → 环境变量里那一段。 */
export function toModelProviderEnvironmentVariableSegment(modelProviderId: string): string {
	return modelProviderId.trim().toUpperCase().replaceAll("-", "_");
}

/** 环境变量里那一段 → provider id。与上面互逆（provider id 限定小写 `[a-z0-9-]+`）。 */
function toModelProviderIdFromEnvironmentVariableSegment(environmentVariableSegment: string): string {
	return environmentVariableSegment.toLowerCase().replaceAll("_", "-");
}

function readTrimmedEnvironmentVariable(
	environmentVariables: NodeJS.ProcessEnv,
	variableName: string,
): string | undefined {
	const value = environmentVariables[variableName]?.trim();
	return value && value.length > 0 ? value : undefined;
}

export function getModelProviderApiKeyEnvironmentVariableName(modelProviderId: string): string {
	return `${MODEL_PROVIDER_ENVIRONMENT_VARIABLE_PREFIX}${toModelProviderEnvironmentVariableSegment(modelProviderId)}${MODEL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLE_SUFFIX}`;
}

/**
 * 这台机器上配了哪些 provider——以「有没有 API key」为唯一判据，扫环境变量得出。
 *
 * 扫描而不是维护一份写死的清单：用户接一家我们没听说过的网关时，不该还要改 Kanban 的代码。
 * 返回值按 id 排序，让「只配了一家」这类判断与遍历顺序无关。
 */
export function readConfiguredModelProviderIds(environmentVariables: NodeJS.ProcessEnv = process.env): string[] {
	const modelProviderIds = new Set<string>();
	for (const [variableName, variableValue] of Object.entries(environmentVariables)) {
		if (
			!variableName.startsWith(MODEL_PROVIDER_ENVIRONMENT_VARIABLE_PREFIX) ||
			!variableName.endsWith(MODEL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLE_SUFFIX)
		) {
			continue;
		}
		if (!variableValue || variableValue.trim().length === 0) {
			continue;
		}
		const environmentVariableSegment = variableName.slice(
			MODEL_PROVIDER_ENVIRONMENT_VARIABLE_PREFIX.length,
			variableName.length - MODEL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLE_SUFFIX.length,
		);
		if (environmentVariableSegment.length === 0) {
			continue;
		}
		modelProviderIds.add(toModelProviderIdFromEnvironmentVariableSegment(environmentVariableSegment));
	}
	return [...modelProviderIds].sort();
}

/**
 * 取一家 provider 的完整凭据；缺 API key、或缺 base url / model id 又没有内置默认值时返回 `null`。
 *
 * 「配了 key 但没配 base url 且不是已知 provider」刻意判成不可用而不是猜一个默认端点：把凭据发到猜出来
 * 的地址上，比什么都不做危险得多。
 */
export function resolveModelProviderCredential(
	modelProviderId: string,
	environmentVariables: NodeJS.ProcessEnv = process.env,
): ModelProviderCredential | null {
	const normalizedModelProviderId = modelProviderId.trim().toLowerCase();
	if (normalizedModelProviderId.length === 0) {
		return null;
	}
	const environmentVariableSegment = toModelProviderEnvironmentVariableSegment(normalizedModelProviderId);
	const apiKey = readTrimmedEnvironmentVariable(
		environmentVariables,
		`${MODEL_PROVIDER_ENVIRONMENT_VARIABLE_PREFIX}${environmentVariableSegment}${MODEL_PROVIDER_API_KEY_ENVIRONMENT_VARIABLE_SUFFIX}`,
	);
	if (!apiKey) {
		return null;
	}
	const knownDefaults = KNOWN_MODEL_PROVIDER_DEFAULTS[normalizedModelProviderId];
	const baseUrl =
		readTrimmedEnvironmentVariable(
			environmentVariables,
			`${MODEL_PROVIDER_ENVIRONMENT_VARIABLE_PREFIX}${environmentVariableSegment}${MODEL_PROVIDER_BASE_URL_ENVIRONMENT_VARIABLE_SUFFIX}`,
		) ?? knownDefaults?.baseUrl;
	const modelId =
		readTrimmedEnvironmentVariable(
			environmentVariables,
			`${MODEL_PROVIDER_ENVIRONMENT_VARIABLE_PREFIX}${environmentVariableSegment}${MODEL_PROVIDER_MODEL_ID_ENVIRONMENT_VARIABLE_SUFFIX}`,
		) ?? knownDefaults?.modelId;
	if (!baseUrl || !modelId) {
		return null;
	}
	return {
		modelProviderId: normalizedModelProviderId,
		apiKey,
		baseUrl: baseUrl.replace(/\/+$/u, ""),
		modelId,
	};
}

/**
 * 没显式指定 provider 时该用哪家。
 *
 * 两条规则，**互斥**而不是依次兜底：
 *   1. 写了 `KANBAN_DEFAULT_MODEL_PROVIDER_ID` → 只认它。指到一家已配置的 provider 就用它，指到一家
 *      没配的就返回 `null`；
 *   2. 没写 → 全机只配了一家就是它（只配一家的人不该被逼着再写一个默认值变量）。
 *
 * 规则 1 为什么是 fail closed：显式默认值一旦写出来就是用户的选择声明，「那家没配」是配置错误
 *（打错字、忘了导 key），不是「随便挑一家继续」的许可。早先这里会在无效显式默认值上落回规则 2，于是
 * 「声明用 openrouter、只配了 deepseek」会把请求静默发给 DeepSeek——正是下面那句要防的事。
 *
 * 配了多家却没指定默认值时同样返回 `null`，而不是挑「排序第一的那家」——静默选中一家用户没打算用的
 * provider 去花钱，比让这次调用降级要糟得多。
 */
export function resolveDefaultModelProviderId(environmentVariables: NodeJS.ProcessEnv = process.env): string | null {
	const configuredModelProviderIds = readConfiguredModelProviderIds(environmentVariables);
	const explicitDefaultModelProviderId = readTrimmedEnvironmentVariable(
		environmentVariables,
		DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME,
	)?.toLowerCase();
	if (explicitDefaultModelProviderId) {
		return configuredModelProviderIds.includes(explicitDefaultModelProviderId)
			? explicitDefaultModelProviderId
			: null;
	}
	return configuredModelProviderIds.length === 1 ? (configuredModelProviderIds[0] ?? null) : null;
}
