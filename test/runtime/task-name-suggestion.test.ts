import { describe, expect, it, vi } from "vitest";

import { suggestTaskNamesFromTaskDescription } from "../../src/task-name-suggestion/suggest-task-names-from-task-description.js";
import {
	DEFAULT_TASK_NAME_SUGGESTION_BASE_URL,
	DEFAULT_TASK_NAME_SUGGESTION_MODEL_ID,
	resolveTaskNameSuggestionEndpointConfiguration,
	TASK_NAME_SUGGESTION_API_KEY_ENVIRONMENT_VARIABLE_NAME,
	TASK_NAME_SUGGESTION_BASE_URL_ENVIRONMENT_VARIABLE_NAME,
	TASK_NAME_SUGGESTION_MODEL_ID_ENVIRONMENT_VARIABLE_NAME,
} from "../../src/task-name-suggestion/task-name-suggestion-endpoint-configuration-from-environment.js";

const ENVIRONMENT_WITH_API_KEY_ONLY: NodeJS.ProcessEnv = {
	[TASK_NAME_SUGGESTION_API_KEY_ENVIRONMENT_VARIABLE_NAME]: "sk-test",
};

function chatCompletionResponseWith(messageContent: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: messageContent } }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("resolveTaskNameSuggestionEndpointConfiguration", () => {
	it("returns null when no API key is configured", () => {
		expect(resolveTaskNameSuggestionEndpointConfiguration({})).toBeNull();
	});

	it("treats a whitespace-only API key as not configured", () => {
		expect(
			resolveTaskNameSuggestionEndpointConfiguration({
				[TASK_NAME_SUGGESTION_API_KEY_ENVIRONMENT_VARIABLE_NAME]: "   ",
			}),
		).toBeNull();
	});

	it("falls back to the DeepSeek defaults when only the API key is set", () => {
		expect(resolveTaskNameSuggestionEndpointConfiguration(ENVIRONMENT_WITH_API_KEY_ONLY)).toEqual({
			apiKey: "sk-test",
			baseUrl: DEFAULT_TASK_NAME_SUGGESTION_BASE_URL,
			modelId: DEFAULT_TASK_NAME_SUGGESTION_MODEL_ID,
		});
	});

	it("lets the base URL and model be overridden independently", () => {
		expect(
			resolveTaskNameSuggestionEndpointConfiguration({
				[TASK_NAME_SUGGESTION_API_KEY_ENVIRONMENT_VARIABLE_NAME]: "sk-test",
				[TASK_NAME_SUGGESTION_BASE_URL_ENVIRONMENT_VARIABLE_NAME]: "https://gateway.example/v1/",
				[TASK_NAME_SUGGESTION_MODEL_ID_ENVIRONMENT_VARIABLE_NAME]: "some-other-model",
			}),
		).toEqual({
			apiKey: "sk-test",
			// 结尾斜杠必须被吃掉，否则调用方拼出来的是 `.../v1//chat/completions`。
			baseUrl: "https://gateway.example/v1",
			modelId: "some-other-model",
		});
	});
});

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

	it("reports a missing API key without touching the network", async () => {
		const fetchImplementation = vi.fn();
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{ environmentVariables: {}, fetchImplementation },
		);
		expect(response).toEqual({ status: "unavailable", unavailableReason: "api_key_not_configured" });
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("posts to the configured endpoint and returns the suggested names", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(
				chatCompletionResponseWith(
					JSON.stringify({ suggestedTaskNames: ["Fix login redirect", "Repair auth redirect", "Unbreak login"] }),
				),
			);
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Login redirects to a blank page" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: ["Fix login redirect", "Repair auth redirect", "Unbreak login"],
		});
		const [requestUrl, requestInit] = fetchImplementation.mock.calls[0] as [string, RequestInit];
		expect(requestUrl).toBe(`${DEFAULT_TASK_NAME_SUGGESTION_BASE_URL}/chat/completions`);
		const requestBody = JSON.parse(String(requestInit.body)) as {
			model: string;
			messages: Array<{ role: string; content: string }>;
		};
		expect(requestBody.model).toBe(DEFAULT_TASK_NAME_SUGGESTION_MODEL_ID);
		expect(requestBody.messages.at(-1)?.content).toBe("Login redirects to a blank page");
	});

	it("strips wrapping quotes, trailing punctuation and duplicates from the model's names", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(
				chatCompletionResponseWith(
					JSON.stringify({ suggestedTaskNames: ['"Fix login."', "Fix login", "  ", "修复登录跳转。"] }),
				),
			);
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Login redirects to a blank page" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({ status: "suggested", suggestedTaskNames: ["Fix login", "修复登录跳转"] });
	});

	it("degrades to unavailable when the endpoint answers with a non-2xx status", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({
			status: "unavailable",
			unavailableReason: "request_failed",
			unavailableDetail: "Naming endpoint returned HTTP 401.",
		});
	});

	it("degrades to unavailable when the model does not answer with parsable JSON", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(chatCompletionResponseWith("Sure! Here are some names:"));
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
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

	it("reports a timeout as a plain unavailable result instead of throwing", async () => {
		const timeoutError = new Error("The operation was aborted due to timeout");
		timeoutError.name = "TimeoutError";
		const fetchImplementation = vi.fn().mockRejectedValue(timeoutError);
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Fix the login bug" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({
			status: "unavailable",
			unavailableReason: "request_failed",
			unavailableDetail: "Request timed out.",
		});
	});
});
