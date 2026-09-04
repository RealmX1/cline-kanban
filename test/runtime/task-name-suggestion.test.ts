import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME,
	getModelProviderApiKeyEnvironmentVariableName,
} from "../../src/model-provider-access/model-provider-credentials-from-environment.js";
import { suggestTaskNamesFromTaskDescription } from "../../src/task-name-suggestion/suggest-task-names-from-task-description.js";

// provider 解析、超时、JSON 模式、HTTP 失败降级、用量记录都归共享层，已在
// test/runtime/model-provider-access/ 覆盖。这里只测起名功能自己那三件事：prompt 送了什么、
// 名字怎么归一、共享层的失败原因怎么翻译成本功能对外的契约。
const ENVIRONMENT_WITH_API_KEY_ONLY: NodeJS.ProcessEnv = {
	[getModelProviderApiKeyEnvironmentVariableName("deepseek")]: "sk-test",
};

function chatCompletionResponseWith(messageContent: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: messageContent } }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function suggestedTaskNamesResponse(...suggestedTaskNames: string[]): Response {
	return chatCompletionResponseWith(JSON.stringify({ suggestedTaskNames }));
}

describe("suggestTaskNamesFromTaskDescription", () => {
	it("reports an empty description without touching the network", async () => {
		const fetchImplementation = vi.fn();
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "   \n  " },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({ status: "unavailable", unavailableReason: "task_description_empty" });
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("translates the shared layer's unconfigured-provider reason into this feature's contract", async () => {
		const fetchImplementation = vi.fn();
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{ environmentVariables: {}, fetchImplementation },
		);
		expect(response).toEqual({ status: "unavailable", unavailableReason: "api_key_not_configured" });
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	// 「一家都没配」与「配了却没有可用的默认」共用同一个 reason（契约 enum 不为后者加成员），所以后者
	// 必须靠 unavailableDetail 把「该声明哪个变量」说出来——否则界面只会让用户去配一个早就配好的 key。
	it("names the default-provider variable when several providers are configured but none is the default", async () => {
		const fetchImplementation = vi.fn();
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{
				environmentVariables: {
					[getModelProviderApiKeyEnvironmentVariableName("deepseek")]: "sk-a",
					[getModelProviderApiKeyEnvironmentVariableName("openrouter")]: "sk-b",
				},
				fetchImplementation,
			},
		);
		expect(response).toMatchObject({ status: "unavailable", unavailableReason: "api_key_not_configured" });
		const unavailableDetail = (response as { unavailableDetail?: string }).unavailableDetail ?? "";
		expect(unavailableDetail).toContain(DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME);
		// 可操作的前提是用户知道有哪几家可填。
		expect(unavailableDetail).toContain("deepseek");
		expect(unavailableDetail).toContain("openrouter");
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("names the default-provider variable when the explicit default points at an unconfigured provider", async () => {
		const fetchImplementation = vi.fn();
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{
				environmentVariables: {
					[getModelProviderApiKeyEnvironmentVariableName("deepseek")]: "sk-a",
					[DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME]: "openrouter",
				},
				fetchImplementation,
			},
		);
		expect(response).toMatchObject({ status: "unavailable", unavailableReason: "api_key_not_configured" });
		expect((response as { unavailableDetail?: string }).unavailableDetail ?? "").toContain(
			DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME,
		);
		// 显式默认指向没配的那家时绝不能改发给 deepseek。
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("sends the description as the user prompt and returns the suggested names", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(suggestedTaskNamesResponse("Fix login redirect", "Repair auth redirect", "Unbreak login"));
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Login redirects to a blank page" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: ["Fix login redirect", "Repair auth redirect", "Unbreak login"],
		});
		const requestBody = JSON.parse(String((fetchImplementation.mock.calls[0] as [string, RequestInit])[1].body)) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(requestBody.messages.at(-1)?.content).toBe("Login redirects to a blank page");
		// DeepSeek 的 JSON 模式要求 prompt 里出现 "json" 字样。
		expect(requestBody.messages[0]?.content.toLowerCase()).toContain("json");
	});

	it("truncates a very long description before sending it", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(suggestedTaskNamesResponse("Name"));
		await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "x".repeat(20_000) },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		const requestBody = JSON.parse(String((fetchImplementation.mock.calls[0] as [string, RequestInit])[1].body)) as {
			messages: Array<{ role: string; content: string }>;
		};
		expect(requestBody.messages.at(-1)?.content).toHaveLength(8_000);
	});

	it("strips wrapping quotes, trailing punctuation and duplicates from the model's names", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(suggestedTaskNamesResponse('"Fix login."', "Fix login", "  ", "修复登录跳转。"));
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Login redirects to a blank page" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({ status: "suggested", suggestedTaskNames: ["Fix login", "修复登录跳转"] });
	});

	it("degrades to unavailable when nothing survives normalization", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(suggestedTaskNamesResponse("   ", "。", ""));
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Login redirects to a blank page" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toMatchObject({ status: "unavailable", unavailableReason: "request_failed" });
	});

	it("degrades to unavailable when the JSON has the wrong shape", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(chatCompletionResponseWith(JSON.stringify({ names: ["Fix login"] })));
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toMatchObject({ status: "unavailable", unavailableReason: "request_failed" });
	});

	it("degrades to unavailable on a non-2xx status without throwing", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({
			status: "unavailable",
			unavailableReason: "request_failed",
			unavailableDetail: "Model provider returned HTTP 401.",
		});
	});
});
