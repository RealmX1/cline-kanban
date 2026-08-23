// 按任务描述向 OpenAI 兼容端点（默认 DeepSeek）要几个候选任务名。
//
// 全条链路都是**尽力而为**：密钥没配、端点不通、超时、回的不是 JSON——一律折成 `unavailable` 返回，
// 绝不抛。起名失败不该挡住建卡，而建卡界面本来就有「留空 = 用正则从描述里推导」的兜底。

import { z } from "zod";

import type { RuntimeTaskNameSuggestionRequest, RuntimeTaskNameSuggestionResponse } from "../core/api-contract";
import { DEFAULT_TASK_TITLE_MAX_CHARS } from "../core/task-title";
import {
	resolveTaskNameSuggestionEndpointConfiguration,
	type TaskNameSuggestionEndpointConfiguration,
} from "./task-name-suggestion-endpoint-configuration-from-environment";

/** 起名是交互式操作（用户盯着 spinner 等），超时给得比后台任务短。 */
export const TASK_NAME_SUGGESTION_REQUEST_TIMEOUT_MS = 15_000;

/** 一次要几个候选。用户可以反复按按钮追加轮次，所以单轮不必给多。 */
export const TASK_NAME_SUGGESTION_COUNT_PER_ROUND = 3;

/**
 * 送进模型的描述长度上限。
 *
 * 起名只需要开头那段就够；描述可能粘进一大段日志或轨迹，整份送上去纯属浪费 token 与时间。
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

const CHAT_COMPLETION_RESPONSE_SCHEMA = z.object({
	choices: z
		.array(
			z.object({
				message: z
					.object({
						content: z.string().nullish(),
					})
					.optional(),
			}),
		)
		.optional(),
});

const SUGGESTED_TASK_NAMES_JSON_SCHEMA = z.object({
	suggestedTaskNames: z.array(z.string()),
});

function unavailable(
	unavailableReason: "api_key_not_configured" | "task_description_empty" | "request_failed",
	unavailableDetail?: string,
): RuntimeTaskNameSuggestionResponse {
	return unavailableDetail
		? { status: "unavailable", unavailableReason, unavailableDetail }
		: { status: "unavailable", unavailableReason };
}

function toFailureDetail(error: unknown): string {
	if (error instanceof Error) {
		// AbortSignal.timeout 抛的是 TimeoutError，名字本身就是最有用的那句话。
		return error.name === "TimeoutError" ? "Request timed out." : error.message;
	}
	return String(error);
}

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

function readSuggestedTaskNamesFromChatCompletionPayload(payload: unknown): string[] {
	const parsedCompletion = CHAT_COMPLETION_RESPONSE_SCHEMA.safeParse(payload);
	if (!parsedCompletion.success) {
		return [];
	}
	const messageContent = parsedCompletion.data.choices?.[0]?.message?.content;
	if (typeof messageContent !== "string" || messageContent.trim().length === 0) {
		return [];
	}
	let parsedMessageJson: unknown;
	try {
		parsedMessageJson = JSON.parse(messageContent);
	} catch {
		return [];
	}
	const parsedNames = SUGGESTED_TASK_NAMES_JSON_SCHEMA.safeParse(parsedMessageJson);
	if (!parsedNames.success) {
		return [];
	}
	const normalizedNames = parsedNames.data.suggestedTaskNames
		.map(normalizeSuggestedTaskName)
		.filter((name) => name.length > 0);
	// 去重靠 Set；上限 5 与契约的 `.max(5)` 对齐，别让一个话痨模型把响应撑破 schema。
	return [...new Set(normalizedNames)].slice(0, 5);
}

async function requestSuggestedTaskNames(
	endpointConfiguration: TaskNameSuggestionEndpointConfiguration,
	taskDescription: string,
	fetchImplementation: typeof globalThis.fetch,
): Promise<RuntimeTaskNameSuggestionResponse> {
	const url = `${endpointConfiguration.baseUrl}/chat/completions`;
	try {
		const response = await fetchImplementation(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${endpointConfiguration.apiKey}`,
			},
			body: JSON.stringify({
				model: endpointConfiguration.modelId,
				messages: [
					{ role: "system", content: TASK_NAME_SUGGESTION_SYSTEM_PROMPT },
					{ role: "user", content: taskDescription.slice(0, TASK_DESCRIPTION_CHARACTERS_SENT_TO_MODEL_LIMIT) },
				],
				// DeepSeek 的思考模式默认开着，起名这种短活等不起。非 DeepSeek 网关会忽略这个字段。
				thinking: { type: "disabled" },
				response_format: { type: "json_object" },
				temperature: 1,
			}),
			signal: AbortSignal.timeout(TASK_NAME_SUGGESTION_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			return unavailable("request_failed", `Naming endpoint returned HTTP ${response.status}.`);
		}
		const suggestedTaskNames = readSuggestedTaskNamesFromChatCompletionPayload((await response.json()) as unknown);
		if (suggestedTaskNames.length === 0) {
			return unavailable("request_failed", "Naming endpoint returned no usable names.");
		}
		return { status: "suggested", suggestedTaskNames };
	} catch (error) {
		return unavailable("request_failed", toFailureDetail(error));
	}
}

export async function suggestTaskNamesFromTaskDescription(
	request: RuntimeTaskNameSuggestionRequest,
	options?: {
		environmentVariables?: NodeJS.ProcessEnv;
		fetchImplementation?: typeof globalThis.fetch;
	},
): Promise<RuntimeTaskNameSuggestionResponse> {
	const taskDescription = request.taskDescription.trim();
	if (taskDescription.length === 0) {
		return unavailable("task_description_empty");
	}
	const endpointConfiguration = resolveTaskNameSuggestionEndpointConfiguration(options?.environmentVariables);
	if (!endpointConfiguration) {
		return unavailable("api_key_not_configured");
	}
	return await requestSuggestedTaskNames(
		endpointConfiguration,
		taskDescription,
		options?.fetchImplementation ?? globalThis.fetch,
	);
}
