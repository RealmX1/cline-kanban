// 向某一家已配置的模型 provider 发一次单轮 chat completion。**所有** Kanban 自己发起的模型调用都该
// 经这里，而不是各自手写一遍 fetch + 超时 + 降级 + 用量记录。
//
// 这一层刻意只做五件事：按 provider id 取凭据、拼 OpenAI 兼容的 `/chat/completions` 请求、限时、
// 把回包正文取出来、把这次调用连同**用途角色**记进用量日志。**它不认识任何具体功能**——prompt 怎么写、
// 回来的内容怎么校验、失败了界面上说什么，都归调用方（例如 `src/task-name-suggestion/`）。
//
// 为什么全程不抛：这些调用没有一个是必需品。凭据没配、网关挂了、超时、回了一坨散文——用户该看到的是
// 「这次没成」，而不是一个把业务流程打断的异常。调用方拿到 `unavailable` 自己决定怎么降级。

import { z } from "zod";
import { resolveKanbanChatCredential } from "./kanban-model-provider-settings";
import {
	type ModelProviderCredential,
	resolveDefaultModelProviderId,
	resolveModelProviderCredential,
} from "./model-provider-credentials-from-environment";
import { type ModelUsagePurpose, recordModelProviderUsage } from "./model-provider-usage-record";

/**
 * 默认超时。
 *
 * 这一层跑的都是「用户盯着 spinner 等」的交互式小请求，所以给得比后台任务短。需要更长的调用方自己传。
 */
export const DEFAULT_MODEL_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export type ModelProviderRequestUnavailableReason =
	/** 一家都没配、指定的那家没配、或配了多家却没指定默认值。 */
	| "model_provider_not_configured"
	/** 发出去了但没拿到可用结果：非 2xx、超时、断连、回包形状不对。 */
	| "request_failed";

export type ModelProviderTextResult =
	| { status: "completed"; messageContent: string }
	| {
			status: "unavailable";
			unavailableReason: ModelProviderRequestUnavailableReason;
			/** 供界面直接显示的一句话（HTTP 状态码、超时之类）。没有额外可说的就省略。 */
			unavailableDetail?: string;
	  };

export type ModelProviderJsonObjectResult<TParsed> =
	| { status: "completed"; parsedJsonObject: TParsed }
	| {
			status: "unavailable";
			unavailableReason: ModelProviderRequestUnavailableReason;
			unavailableDetail?: string;
	  };

export interface ModelProviderChatCompletionRequest {
	/**
	 * 「Kanban 的哪个功能在发这次调用」。必填、没有默认值——它是用量日志唯一能把一次 HTTP 调用归因到
	 * 功能上的钥匙，给了默认值就等于允许调用点悄悄不表态。
	 */
	modelUsagePurpose: ModelUsagePurpose;
	/** 交代角色与输出格式的那一段。 */
	systemPrompt: string;
	/** 这一次真正要处理的内容。调用方负责先裁到合理长度。 */
	userPrompt: string;
	/** 指定用哪家 provider；省略则用默认那家（见 resolveDefaultModelProviderId）。 */
	modelProviderId?: string;
	/**
	 * 要不要让服务端关掉「思考模式」。
	 *
	 * DeepSeek 的思考模式默认开着，短任务等不起，所以默认关——但**只对声明支持该扩展字段的 provider 生效**，
	 * 见 MODEL_PROVIDER_IDS_ACCEPTING_THINKING_EXTENSION_FIELD。传 `"provider_default"` 则对谁都不发。
	 */
	providerSideThinking?: "disabled" | "provider_default";
	/** 采样温度。省略则用服务端默认。 */
	temperature?: number;
	requestTimeoutMs?: number;
}

export interface ModelProviderRequestOptions {
	/** 单测用：不必污染进程环境就能覆盖各种配置组合。 */
	environmentVariables?: NodeJS.ProcessEnv;
	/** 单测用：不必真的联网。 */
	fetchImplementation?: typeof globalThis.fetch;
	credential?: ModelProviderCredential | null;
	observeAttempt?: (observation: {
		modelProviderId: string;
		modelId: string;
		elapsedMs: number;
		httpStatusCode?: number;
		promptTokenCount?: number;
		completionTokenCount?: number;
		result: ModelProviderTextResult;
	}) => Promise<void>;
}

const CHAT_COMPLETION_RESPONSE_SCHEMA = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({ content: z.string().nullish() }).optional(),
			}),
		)
		.optional(),
	usage: z
		.object({
			prompt_tokens: z.number().optional(),
			completion_tokens: z.number().optional(),
			total_tokens: z.number().optional(),
		})
		.optional(),
});

interface ChatCompletionAttemptOutcome {
	result: ModelProviderTextResult;
	httpStatusCode?: number;
	promptTokenCount?: number;
	completionTokenCount?: number;
	totalTokenCount?: number;
}

function unavailable(
	unavailableReason: ModelProviderRequestUnavailableReason,
	unavailableDetail?: string,
): Extract<ModelProviderTextResult, { status: "unavailable" }> {
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
 * 哪些 provider 明确接受 `{"thinking":{"type":"disabled"}}` 这个**非 OpenAI 标准**的扩展字段。
 *
 * 这里有个真实取舍，别把它简化掉：
 * - 不发这个字段，DeepSeek 的思考模式就会打开，把这条「用户盯着 spinner 等」的交互式请求拖慢——这正是
 *   当初默认关掉它的原因；
 * - 无条件发给所有人，则严格校验未知字段的 OpenAI 兼容端点（LiteLLM / OpenRouter 这类聚合网关，以及不少
 *   自建服务）会直接以 HTTP 400 拒掉**整个**请求。「非 DeepSeek 网关会忽略它」是个未经验证、且对严格端点
 *   为假的假设，而本层与 docs/cli-environment.md 对外承诺的恰恰是「任意 provider 三项配齐即可用」。
 *
 * 所以取白名单：只对**已知接受该扩展**的 provider 发，其余一律发纯标准 body。两头都不牺牲——默认那家
 * （deepseek）保住低延迟，任意未知 provider 保住可用性。别的 provider 支持了同名字段，把它的 id 加进来即可。
 */
const MODEL_PROVIDER_IDS_ACCEPTING_THINKING_EXTENSION_FIELD: ReadonlySet<string> = new Set(["deepseek"]);

function buildChatCompletionRequestBody(
	credential: ModelProviderCredential,
	request: ModelProviderChatCompletionRequest,
	responseFormat: { type: "json_object" } | undefined,
): string {
	const disablesProviderSideThinking = (request.providerSideThinking ?? "disabled") === "disabled";
	const sendsThinkingExtensionField =
		disablesProviderSideThinking &&
		MODEL_PROVIDER_IDS_ACCEPTING_THINKING_EXTENSION_FIELD.has(credential.modelProviderId);
	return JSON.stringify({
		model: credential.modelId,
		messages: [
			{ role: "system", content: request.systemPrompt },
			{ role: "user", content: request.userPrompt },
		],
		...(sendsThinkingExtensionField ? { thinking: { type: "disabled" } } : {}),
		...(responseFormat ? { response_format: responseFormat } : {}),
		...(request.temperature === undefined ? {} : { temperature: request.temperature }),
	});
}

async function attemptChatCompletion(
	credential: ModelProviderCredential,
	request: ModelProviderChatCompletionRequest,
	responseFormat: { type: "json_object" } | undefined,
	fetchImplementation: typeof globalThis.fetch,
): Promise<ChatCompletionAttemptOutcome> {
	const url = `${credential.baseUrl}/chat/completions`;
	try {
		const response = await fetchImplementation(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credential.apiKey}`,
			},
			body: buildChatCompletionRequestBody(credential, request, responseFormat),
			signal: AbortSignal.timeout(request.requestTimeoutMs ?? DEFAULT_MODEL_PROVIDER_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			return {
				result: unavailable("request_failed", `Model provider returned HTTP ${response.status}.`),
				httpStatusCode: response.status,
			};
		}
		const parsedCompletion = CHAT_COMPLETION_RESPONSE_SCHEMA.safeParse((await response.json()) as unknown);
		const tokenCounts = parsedCompletion.success
			? {
					promptTokenCount: parsedCompletion.data.usage?.prompt_tokens,
					completionTokenCount: parsedCompletion.data.usage?.completion_tokens,
					totalTokenCount: parsedCompletion.data.usage?.total_tokens,
				}
			: {};
		const messageContent = parsedCompletion.success ? parsedCompletion.data.choices?.[0]?.message?.content : null;
		if (typeof messageContent !== "string" || messageContent.trim().length === 0) {
			return {
				result: unavailable("request_failed", "Model provider returned an empty answer."),
				httpStatusCode: response.status,
				...tokenCounts,
			};
		}
		return { result: { status: "completed", messageContent }, httpStatusCode: response.status, ...tokenCounts };
	} catch (error) {
		return { result: unavailable("request_failed", toFailureDetail(error)) };
	}
}

/**
 * 一次调用的**最终**结论：网络层拿回正文之后，还要过调用方那道解读/校验，两步都成了才算 completed。
 *
 * 之所以要有这个中间类型：用量日志必须记「公开入口交给调用方的那个结论」。此前记账发生在解读之前，
 * 于是回包是散文时调用方收到 request_failed、journal 里却是 completed —— 那条通道正是为事后统计成功率
 * 而存在的，这样一污染就没了意义。
 */
type InterpretedChatCompletionAnswer<TInterpretedAnswer> =
	| { status: "completed"; interpretedAnswer: TInterpretedAnswer }
	| {
			status: "unavailable";
			unavailableReason: ModelProviderRequestUnavailableReason;
			unavailableDetail?: string;
	  };

/**
 * 发一次请求，并在**记账之前**先让调用方把正文解读成它真正想要的东西。
 *
 * 一次调用只写一条用量记录，写在解读之后，outcome 取的就是本函数的返回值——`requestModelProviderText` 与
 * `requestModelProviderJsonObject` 的公开返回值都由它直接映射而来，两者不可能再分叉。
 * 记账本身仍是 fire-and-forget（`recordModelProviderUsage` 内部吞错、不阻塞），这里只是把它挪到了正确的时点。
 */
async function requestChatCompletionAnswerInterpretedByCaller<TInterpretedAnswer>(
	request: ModelProviderChatCompletionRequest,
	responseFormat: { type: "json_object" } | undefined,
	options: ModelProviderRequestOptions | undefined,
	interpretMessageContent: (messageContent: string) => InterpretedChatCompletionAnswer<TInterpretedAnswer>,
): Promise<InterpretedChatCompletionAnswer<TInterpretedAnswer>> {
	const environmentVariables = options?.environmentVariables;
	const requestedModelProviderId = request.modelProviderId ?? resolveDefaultModelProviderId(environmentVariables);
	let credential: ModelProviderCredential | null;
	try {
		credential =
			options && "credential" in options
				? (options.credential ?? null)
				: environmentVariables
					? requestedModelProviderId
						? resolveModelProviderCredential(requestedModelProviderId, environmentVariables)
						: null
					: await resolveKanbanChatCredential(request.modelUsagePurpose, request.modelProviderId);
	} catch {
		return unavailable("model_provider_not_configured", "模型设置或系统凭据库不可用。");
	}

	if (!credential) {
		// 没发出请求也要记一条：否则「一家都没配」在统计里与「从没用过这个功能」逐字同形。
		recordModelProviderUsage({
			modelUsagePurpose: request.modelUsagePurpose,
			modelProviderId: requestedModelProviderId ?? null,
			modelId: null,
			outcome: "unavailable",
			unavailableReason: "model_provider_not_configured",
			elapsedMs: 0,
			promptCharacterCount: request.systemPrompt.length + request.userPrompt.length,
		});
		return unavailable("model_provider_not_configured");
	}

	const startedAtEpochMs = Date.now();
	const attemptOutcome = await attemptChatCompletion(
		credential,
		request,
		responseFormat,
		options?.fetchImplementation ?? globalThis.fetch,
	);
	const elapsedMs = Date.now() - startedAtEpochMs;
	const interpretedAnswer = interpretAttemptOutcome(attemptOutcome, interpretMessageContent);
	await options?.observeAttempt?.({
		modelProviderId: credential.modelProviderId,
		modelId: credential.modelId,
		elapsedMs,
		...attemptOutcome,
	});
	recordModelProviderUsage({
		modelUsagePurpose: request.modelUsagePurpose,
		modelProviderId: credential.modelProviderId,
		modelId: credential.modelId,
		outcome: interpretedAnswer.status === "completed" ? "completed" : "unavailable",
		...(interpretedAnswer.status === "completed" ? {} : { unavailableReason: interpretedAnswer.unavailableReason }),
		...(attemptOutcome.httpStatusCode === undefined ? {} : { httpStatusCode: attemptOutcome.httpStatusCode }),
		elapsedMs,
		promptCharacterCount: request.systemPrompt.length + request.userPrompt.length,
		...(attemptOutcome.promptTokenCount === undefined ? {} : { promptTokenCount: attemptOutcome.promptTokenCount }),
		...(attemptOutcome.completionTokenCount === undefined
			? {}
			: { completionTokenCount: attemptOutcome.completionTokenCount }),
		...(attemptOutcome.totalTokenCount === undefined ? {} : { totalTokenCount: attemptOutcome.totalTokenCount }),
	});
	return interpretedAnswer;
}

function interpretAttemptOutcome<TInterpretedAnswer>(
	attemptOutcome: ChatCompletionAttemptOutcome,
	interpretMessageContent: (messageContent: string) => InterpretedChatCompletionAnswer<TInterpretedAnswer>,
): InterpretedChatCompletionAnswer<TInterpretedAnswer> {
	if (attemptOutcome.result.status !== "completed") {
		return attemptOutcome.result;
	}
	try {
		return interpretMessageContent(attemptOutcome.result.messageContent);
	} catch (error) {
		// 解读器（例如调用方 zod schema 里的 transform）自己抛了。本层对外承诺全程不抛，所以折成一次
		// 普通的降级，并且照样只记这一条——绝不能因为解读炸了就让这次调用在用量日志里彻底消失。
		return unavailable("request_failed", toFailureDetail(error));
	}
}

/** 要一段自由文本。调用方自己决定怎么解读。 */
export async function requestModelProviderText(
	request: ModelProviderChatCompletionRequest,
	options?: ModelProviderRequestOptions,
): Promise<ModelProviderTextResult> {
	const answer = await requestChatCompletionAnswerInterpretedByCaller<string>(
		request,
		undefined,
		options,
		(messageContent) => ({ status: "completed", interpretedAnswer: messageContent }),
	);
	return answer.status === "completed" ? { status: "completed", messageContent: answer.interpretedAnswer } : answer;
}

/**
 * 要一个 JSON 对象，并用调用方给的 zod schema 校验。
 *
 * 走服务端的 JSON 模式（`response_format: json_object`）而不是事后从散文里抠 JSON。注意 DeepSeek 的
 * JSON 模式要求 prompt 里出现 "json" 字样，所以 `systemPrompt` 的措辞里必须留着这个词。
 *
 * 解析不出来 / 形状不对一律折成 `request_failed`：对调用方而言这与「网关挂了」是同一件事——这次拿不到
 * 可用结果，该降级了。这两种失败同样会以 `unavailable` 记进用量日志（校验先于记账），统计里不会被算成成功。
 */
export async function requestModelProviderJsonObject<TParsed>(
	request: ModelProviderChatCompletionRequest,
	parsedJsonObjectSchema: z.ZodType<TParsed>,
	options?: ModelProviderRequestOptions,
): Promise<ModelProviderJsonObjectResult<TParsed>> {
	const answer = await requestChatCompletionAnswerInterpretedByCaller<TParsed>(
		request,
		{ type: "json_object" },
		options,
		(messageContent) => {
			let parsedJson: unknown;
			try {
				parsedJson = JSON.parse(messageContent);
			} catch {
				return unavailable("request_failed", "Model provider did not return parsable JSON.");
			}
			const parsed = parsedJsonObjectSchema.safeParse(parsedJson);
			if (!parsed.success) {
				return unavailable("request_failed", "Model provider returned JSON in an unexpected shape.");
			}
			return { status: "completed", interpretedAnswer: parsed.data };
		},
	);
	return answer.status === "completed" ? { status: "completed", parsedJsonObject: answer.interpretedAnswer } : answer;
}
