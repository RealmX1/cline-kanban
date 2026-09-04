import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
	DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR,
	getDiagnosticEventJournalActiveFilePath,
	waitForPendingDiagnosticEventJournalWrites,
} from "../../../src/diagnostics/rotating-jsonl-diagnostic-event-journal.js";
import { getModelProviderApiKeyEnvironmentVariableName } from "../../../src/model-provider-access/model-provider-credentials-from-environment.js";
import {
	requestModelProviderJsonObject,
	requestModelProviderText,
} from "../../../src/model-provider-access/request-model-provider-chat-completion.js";
import { createTempDir } from "../../utilities/temp-dir.js";

// 全局 setup 把 journal 根目录挪到一个**固定**的 tmp 路径，于是同一通道会被所有测试文件共写。
// `model-provider-usage` 这个通道不止本文件在写（起名功能那套用例也会经共享层写进来），而 vitest 用的是
// forks pool、文件各在自己的进程里并行跑，所以要断言「刚写下的那条」就必须先把根目录换成本文件专属的。
let journalRootDirOverrideBeforeThisFile: string | undefined;
let journalRootDir: { path: string; cleanup: () => void } | null = null;

beforeAll(() => {
	journalRootDirOverrideBeforeThisFile = process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR];
	journalRootDir = createTempDir("kanban-test-model-provider-usage-journal-");
	process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR] = journalRootDir.path;
});

afterAll(async () => {
	await waitForPendingDiagnosticEventJournalWrites();
	if (journalRootDirOverrideBeforeThisFile === undefined) {
		delete process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR];
	} else {
		process.env[DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR_ENV_VAR] = journalRootDirOverrideBeforeThisFile;
	}
	journalRootDir?.cleanup();
});

const DEEPSEEK_API_KEY_VARIABLE = getModelProviderApiKeyEnvironmentVariableName("deepseek");
const ENVIRONMENT_WITH_DEEPSEEK_ONLY: NodeJS.ProcessEnv = { [DEEPSEEK_API_KEY_VARIABLE]: "sk-test" };

function chatCompletionResponseWith(messageContent: string, usage?: Record<string, number>): Response {
	return new Response(
		JSON.stringify({ choices: [{ message: { content: messageContent } }], ...(usage ? { usage } : {}) }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

function usageJournalFilePath(): string {
	return getDiagnosticEventJournalActiveFilePath("model-provider-usage");
}

async function readUsageJournalRecords(): Promise<Array<Record<string, unknown>>> {
	await waitForPendingDiagnosticEventJournalWrites();
	let journalText = "";
	try {
		journalText = readFileSync(usageJournalFilePath(), "utf8");
	} catch {
		return [];
	}
	return journalText
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
	await waitForPendingDiagnosticEventJournalWrites();
	rmSync(usageJournalFilePath(), { force: true });
});

describe("requestModelProviderText", () => {
	it("reports an unconfigured provider without touching the network, and still journals the attempt", async () => {
		const fetchImplementation = vi.fn();
		const result = await requestModelProviderText(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "s", userPrompt: "u" },
			{ environmentVariables: {}, fetchImplementation },
		);
		expect(result).toEqual({ status: "unavailable", unavailableReason: "model_provider_not_configured" });
		expect(fetchImplementation).not.toHaveBeenCalled();

		// 「一家都没配」必须留痕，否则统计里它与「从没用过这个功能」逐字同形。
		const [usageRecord] = await readUsageJournalRecords();
		expect(usageRecord).toMatchObject({
			channel: "model-provider-usage",
			modelUsagePurpose: "task_name_suggestion",
			modelProviderId: null,
			outcome: "unavailable",
			unavailableReason: "model_provider_not_configured",
		});
	});

	it("posts to the only configured provider and journals a completed call with its usage metadata", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(
				chatCompletionResponseWith("plain answer", { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }),
			);
		const result = await requestModelProviderText(
			{
				modelUsagePurpose: "task_name_suggestion",
				systemPrompt: "be terse",
				userPrompt: "say hi",
				temperature: 0.2,
			},
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		expect(result).toEqual({ status: "completed", messageContent: "plain answer" });

		const [requestUrl, requestInit] = fetchImplementation.mock.calls[0] as [string, RequestInit];
		expect(requestUrl).toBe("https://api.deepseek.com/chat/completions");
		expect((requestInit.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
		const requestBody = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
		expect(requestBody.model).toBe("deepseek-v4-flash");
		expect(requestBody.messages).toEqual([
			{ role: "system", content: "be terse" },
			{ role: "user", content: "say hi" },
		]);
		expect(requestBody.temperature).toBe(0.2);
		// 纯文本请求不该带 JSON 模式。
		expect(requestBody.response_format).toBeUndefined();

		const [usageRecord] = await readUsageJournalRecords();
		expect(usageRecord).toMatchObject({
			modelUsagePurpose: "task_name_suggestion",
			modelProviderId: "deepseek",
			modelId: "deepseek-v4-flash",
			outcome: "completed",
			httpStatusCode: 200,
			promptCharacterCount: "be terse".length + "say hi".length,
			promptTokenCount: 11,
			completionTokenCount: 4,
			totalTokenCount: 15,
		});
		expect(typeof usageRecord?.elapsedMs).toBe("number");
	});

	it("routes to an explicitly requested provider instead of the default", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(chatCompletionResponseWith("answer"));
		await requestModelProviderText(
			{
				modelUsagePurpose: "task_name_suggestion",
				systemPrompt: "s",
				userPrompt: "u",
				modelProviderId: "my-gateway",
			},
			{
				environmentVariables: {
					...ENVIRONMENT_WITH_DEEPSEEK_ONLY,
					KANBAN_MODEL_PROVIDER_MY_GATEWAY_API_KEY: "sk-gateway",
					KANBAN_MODEL_PROVIDER_MY_GATEWAY_BASE_URL: "https://my-gateway.example",
					KANBAN_MODEL_PROVIDER_MY_GATEWAY_MODEL_ID: "house-model",
				},
				fetchImplementation,
			},
		);
		const [requestUrl, requestInit] = fetchImplementation.mock.calls[0] as [string, RequestInit];
		expect(requestUrl).toBe("https://my-gateway.example/chat/completions");
		expect((requestInit.headers as Record<string, string>).Authorization).toBe("Bearer sk-gateway");

		const [usageRecord] = await readUsageJournalRecords();
		expect(usageRecord).toMatchObject({ modelProviderId: "my-gateway", modelId: "house-model" });
	});

	it("disables provider-side thinking by default and honours an explicit opt-out", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(chatCompletionResponseWith("answer"));
		await requestModelProviderText(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "s", userPrompt: "u" },
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		const defaultBody = JSON.parse(String((fetchImplementation.mock.calls[0] as [string, RequestInit])[1].body));
		expect(defaultBody.thinking).toEqual({ type: "disabled" });

		await requestModelProviderText(
			{
				modelUsagePurpose: "task_name_suggestion",
				systemPrompt: "s",
				userPrompt: "u",
				providerSideThinking: "provider_default",
			},
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		const optedOutBody = JSON.parse(String((fetchImplementation.mock.calls[1] as [string, RequestInit])[1].body));
		expect(optedOutBody.thinking).toBeUndefined();
	});

	it("keeps the DeepSeek-only thinking extension field off the wire for providers not known to accept it", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(chatCompletionResponseWith("answer"));
		await requestModelProviderText(
			{
				modelUsagePurpose: "task_name_suggestion",
				systemPrompt: "s",
				userPrompt: "u",
				modelProviderId: "my-gateway",
			},
			{
				environmentVariables: {
					KANBAN_MODEL_PROVIDER_MY_GATEWAY_API_KEY: "sk-gateway",
					KANBAN_MODEL_PROVIDER_MY_GATEWAY_BASE_URL: "https://my-gateway.example",
					KANBAN_MODEL_PROVIDER_MY_GATEWAY_MODEL_ID: "house-model",
				},
				fetchImplementation,
			},
		);
		const requestBody = JSON.parse(
			String((fetchImplementation.mock.calls[0] as [string, RequestInit])[1].body),
		) as Record<string, unknown>;
		// `thinking` 是 DeepSeek 扩展，不属 OpenAI chat-completions schema。严格校验未知字段的兼容端点
		// （LiteLLM / OpenRouter 之类的聚合网关，以及不少自建服务）会以 HTTP 400 拒掉**整个**请求，于是
		// 「三项配齐的任意 provider 都能用」这条承诺对它们固定失效。发给未知 provider 的 body 必须是纯标准字段。
		expect(requestBody.thinking).toBeUndefined();
		expect(Object.keys(requestBody).sort()).toEqual(["messages", "model"]);
	});

	it("degrades to unavailable on a non-2xx status and journals the status code", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
		const result = await requestModelProviderText(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "s", userPrompt: "u" },
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		expect(result).toEqual({
			status: "unavailable",
			unavailableReason: "request_failed",
			unavailableDetail: "Model provider returned HTTP 401.",
		});
		const [usageRecord] = await readUsageJournalRecords();
		expect(usageRecord).toMatchObject({
			outcome: "unavailable",
			unavailableReason: "request_failed",
			httpStatusCode: 401,
		});
	});

	it("reports a timeout as a plain unavailable result instead of throwing", async () => {
		const timeoutError = new Error("The operation was aborted due to timeout");
		timeoutError.name = "TimeoutError";
		const fetchImplementation = vi.fn().mockRejectedValue(timeoutError);
		const result = await requestModelProviderText(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "s", userPrompt: "u" },
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		expect(result).toEqual({
			status: "unavailable",
			unavailableReason: "request_failed",
			unavailableDetail: "Request timed out.",
		});
	});
});

describe("requestModelProviderJsonObject", () => {
	const schema = z.object({ items: z.array(z.string()) });

	it("asks for JSON mode and returns the parsed object", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(chatCompletionResponseWith(JSON.stringify({ items: ["a", "b"] })));
		const result = await requestModelProviderJsonObject(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "reply with json", userPrompt: "u" },
			schema,
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		expect(result).toEqual({ status: "completed", parsedJsonObject: { items: ["a", "b"] } });
		const requestBody = JSON.parse(String((fetchImplementation.mock.calls[0] as [string, RequestInit])[1].body));
		expect(requestBody.response_format).toEqual({ type: "json_object" });
	});

	it("degrades to unavailable when the model does not answer with parsable JSON, and journals that verdict", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(chatCompletionResponseWith("Sure! Here you go:"));
		const result = await requestModelProviderJsonObject(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "reply with json", userPrompt: "u" },
			schema,
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		expect(result).toMatchObject({ status: "unavailable", unavailableReason: "request_failed" });

		// 用量日志存在的理由就是事后统计成功率。调用方拿到 request_failed、journal 里却写着 completed，
		// 这条通道就成了噪声——所以记录必须反映**公开入口最终交给调用方**的结论，且一次调用只记一条。
		const usageRecords = await readUsageJournalRecords();
		expect(usageRecords).toHaveLength(1);
		expect(usageRecords[0]).toMatchObject({
			modelUsagePurpose: "task_name_suggestion",
			modelProviderId: "deepseek",
			outcome: "unavailable",
			unavailableReason: "request_failed",
			httpStatusCode: 200,
		});
	});

	it("degrades to unavailable when the JSON has the wrong shape, and journals that verdict", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(chatCompletionResponseWith(JSON.stringify({ notItems: 1 })));
		const result = await requestModelProviderJsonObject(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "reply with json", userPrompt: "u" },
			schema,
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		expect(result).toMatchObject({ status: "unavailable", unavailableReason: "request_failed" });

		const usageRecords = await readUsageJournalRecords();
		expect(usageRecords).toHaveLength(1);
		expect(usageRecords[0]).toMatchObject({
			outcome: "unavailable",
			unavailableReason: "request_failed",
			httpStatusCode: 200,
		});
	});

	it("journals exactly one completed record — with token counts — when the JSON entry point does answer", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(
			chatCompletionResponseWith(JSON.stringify({ items: ["a"] }), {
				prompt_tokens: 7,
				completion_tokens: 3,
				total_tokens: 10,
			}),
		);
		const result = await requestModelProviderJsonObject(
			{ modelUsagePurpose: "task_name_suggestion", systemPrompt: "reply with json", userPrompt: "u" },
			schema,
			{ environmentVariables: ENVIRONMENT_WITH_DEEPSEEK_ONLY, fetchImplementation },
		);
		expect(result).toEqual({ status: "completed", parsedJsonObject: { items: ["a"] } });

		const usageRecords = await readUsageJournalRecords();
		expect(usageRecords).toHaveLength(1);
		expect(usageRecords[0]).toMatchObject({
			outcome: "completed",
			httpStatusCode: 200,
			promptTokenCount: 7,
			completionTokenCount: 3,
			totalTokenCount: 10,
		});
		expect(usageRecords[0]?.unavailableReason).toBeUndefined();
	});
});
