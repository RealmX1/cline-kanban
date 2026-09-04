// 按任务描述要几个候选任务名。
//
// 这是 `src/model-provider-access/` 的第一个消费方，本文件只负责这个功能自己的三件事：prompt 怎么写、
// 回来的名字怎么归一、以及把共享层的失败原因翻译成本功能契约里的那几个。provider 凭据、端点、超时、
// JSON 模式、降级语义、用量记录全在共享层，别在这里重写。
//
// 全条链路尽力而为、绝不抛：起名失败不该挡住建卡，建卡界面本来就有「留空 = 用正则从描述里推导」的兜底。

import { z } from "zod";

import type { RuntimeTaskNameSuggestionRequest, RuntimeTaskNameSuggestionResponse } from "../core/api-contract";
import { DEFAULT_TASK_TITLE_MAX_CHARS } from "../core/task-title";
import {
	DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME,
	readConfiguredModelProviderIds,
	resolveDefaultModelProviderId,
} from "../model-provider-access/model-provider-credentials-from-environment";
import {
	type ModelProviderRequestOptions,
	requestModelProviderJsonObject,
} from "../model-provider-access/request-model-provider-chat-completion";

/** 一次要几个候选。用户可以反复按按钮追加轮次，所以单轮不必给多。 */
export const TASK_NAME_SUGGESTION_COUNT_PER_ROUND = 3;

/**
 * 送进模型的描述长度上限。
 *
 * 起名只需要开头那段就够；描述可能粘进一大段日志或轨迹，整份送上去纯属浪费 token 与时间。
 * 裁剪留在本文件而不是共享层：只有本功能知道自己的输入可能很长、且开头那段就够用。
 */
const TASK_DESCRIPTION_CHARACTERS_SENT_TO_MODEL_LIMIT = 8_000;

const TASK_NAME_SUGGESTION_SYSTEM_PROMPT = [
	"You name software engineering tasks on a Kanban board.",
	"",
	`Read the task description and reply with a JSON object of the exact form {"suggestedTaskNames": ["...", "...", "..."]}.`,
	"",
	"Rules:",
	`- Return exactly ${TASK_NAME_SUGGESTION_COUNT_PER_ROUND} names, ordered from most to least recommended.`,
	"- Write every name in the same language as the task description.",
	`- At most ${DEFAULT_TASK_TITLE_MAX_CHARS} characters per name. No surrounding quotes and no trailing punctuation.`,
	"- Name the intended outcome or the change being made, not the process of working on it.",
	"- Be specific enough that the name is distinguishable from other tasks in the same repository.",
	"- Output the JSON object and nothing else.",
].join("\n");

const SUGGESTED_TASK_NAMES_JSON_SCHEMA = z.object({
	suggestedTaskNames: z.array(z.string()),
});

/** 契约里 `suggestedTaskNames` 是 `.max(5)`；模型话痨时截断，别让响应撑破 schema。 */
const SUGGESTED_TASK_NAMES_RETURNED_LIMIT = 5;

/**
 * 把模型回的一条名字收拾成能直接写进标题框的样子。
 *
 * 模型常见的三种越界：整句加引号、结尾带句号、比标题上限长。这里逐条修掉而不是整份作废——
 * 三条候选里坏一条不该让另外两条也拿不到。
 */
function normalizeSuggestedTaskName(rawName: string): string {
	const withoutSurroundingQuotes = rawName
		.trim()
		.replaceAll(/\s+/gu, " ")
		.replace(/^["'“”「『]+/u, "")
		.replace(/["'“”」』]+$/u, "")
		.replace(/[.。！!？?、,，;；：:]+$/u, "")
		.trim();
	return withoutSurroundingQuotes.length > DEFAULT_TASK_TITLE_MAX_CHARS
		? withoutSurroundingQuotes.slice(0, DEFAULT_TASK_TITLE_MAX_CHARS).trimEnd()
		: withoutSurroundingQuotes;
}

/**
 * 「配了 provider，却没有一家能当默认」时给一句可操作的说明；其余情形返回 `undefined`。
 *
 * 为什么在本文件里回读一次环境：共享层的 `model_provider_not_configured` 是一个刻意粗的原因，
 * 「一家都没配」与「配了却没有可用的默认」在它眼里同形，而这两件事要用户做的动作完全相反——前者去配一把
 * API key，后者去声明 `KANBAN_DEFAULT_MODEL_PROVIDER_ID`（key 早就配好了）。本功能对外的契约 enum 不为
 * 后者加成员（那个 enum 已在界面文案与测试里生根），于是差异走契约里那个已有的 `unavailableDetail`。
 *
 * 只在后者返回句子：前者不带 detail，界面照旧显示「去配一把 key」那条，语义不变。
 */
function describeConfiguredModelProvidersWithoutUsableDefault(
	environmentVariables: NodeJS.ProcessEnv | undefined,
): string | undefined {
	if (resolveDefaultModelProviderId(environmentVariables) !== null) {
		return undefined;
	}
	const configuredModelProviderIds = readConfiguredModelProviderIds(environmentVariables);
	if (configuredModelProviderIds.length === 0) {
		return undefined;
	}
	// 列出已配置的几家：没有它们，用户知道该写哪个变量、却仍不知道该往里写什么值。
	return `no default model provider is selected. Set ${DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME} to one of the configured providers (${configuredModelProviderIds.join(", ")}) for the Kanban runtime process.`;
}

export async function suggestTaskNamesFromTaskDescription(
	request: RuntimeTaskNameSuggestionRequest,
	options?: ModelProviderRequestOptions,
): Promise<RuntimeTaskNameSuggestionResponse> {
	const taskDescription = request.taskDescription.trim();
	if (taskDescription.length === 0) {
		return { status: "unavailable", unavailableReason: "task_description_empty" };
	}
	const result = await requestModelProviderJsonObject(
		{
			// 用量日志靠它把这次调用归因到「建卡起名」这个功能上。
			modelUsagePurpose: "task_name_suggestion",
			systemPrompt: TASK_NAME_SUGGESTION_SYSTEM_PROMPT,
			userPrompt: taskDescription.slice(0, TASK_DESCRIPTION_CHARACTERS_SENT_TO_MODEL_LIMIT),
			temperature: 1,
		},
		SUGGESTED_TASK_NAMES_JSON_SCHEMA,
		options,
	);
	if (result.status === "unavailable") {
		// 共享层说的是 provider 词汇（`model_provider_not_configured`），本功能对外的契约用的是更早定下的
		// `api_key_not_configured`。在这里翻译一次，而不是去改前端契约——那个 enum 已经在界面文案与测试里
		// 生根，且「一家 provider 都没配」对用户而言就是「没配 key」。
		const unavailableReason =
			result.unavailableReason === "model_provider_not_configured" ? "api_key_not_configured" : "request_failed";
		// 但「配了却没有可用的默认」不是「没配 key」，得靠 detail 把它从上面那条里分出来。共享层若已经就这次
		// 失败给了更具体的一句话，以它为准。
		const unavailableDetail =
			result.unavailableDetail ??
			(result.unavailableReason === "model_provider_not_configured"
				? describeConfiguredModelProvidersWithoutUsableDefault(options?.environmentVariables)
				: undefined);
		return unavailableDetail
			? { status: "unavailable", unavailableReason, unavailableDetail }
			: { status: "unavailable", unavailableReason };
	}
	const normalizedNames = result.parsedJsonObject.suggestedTaskNames
		.map(normalizeSuggestedTaskName)
		.filter((name) => name.length > 0);
	const suggestedTaskNames = [...new Set(normalizedNames)].slice(0, SUGGESTED_TASK_NAMES_RETURNED_LIMIT);
	if (suggestedTaskNames.length === 0) {
		// 请求本身成功、JSON 形状也对，但归一完一条都不剩（全是空串 / 全是标点）。对界面而言同样是「这次
		// 没拿到可用结果」，走同一条降级分支。
		return {
			status: "unavailable",
			unavailableReason: "request_failed",
			unavailableDetail: "Model provider returned no usable names.",
		};
	}
	return { status: "suggested", suggestedTaskNames };
}
