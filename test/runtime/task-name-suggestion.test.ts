import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME,
	getModelProviderApiKeyEnvironmentVariableName,
} from "../../src/model-provider-access/model-provider-credentials-from-environment.js";
import {
	SUGGESTED_TASK_CATEGORY_TAG_VOCABULARY,
	suggestTaskNamesFromTaskDescription,
} from "../../src/task-name-suggestion/suggest-task-names-from-task-description.js";

// provider 解析、超时、JSON 模式、HTTP 失败降级、用量记录都归共享层，已在
// test/runtime/model-provider-access/ 覆盖。这里只测起名功能自己的事：prompt 送了什么、分类 tag 与名字怎么拼、
// 名字怎么归一与按书写系统过滤、共享层的失败原因怎么翻译成本功能对外的契约。
const ENVIRONMENT_WITH_API_KEY_ONLY: NodeJS.ProcessEnv = {
	[getModelProviderApiKeyEnvironmentVariableName("deepseek")]: "sk-test",
};

function chatCompletionResponseWith(messageContent: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: messageContent } }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

interface SuggestedTaskNameItemFromModel {
	/** 约定是数组或逗号串；`null` / 数字等越界类型也放进来，测「坏 tag 只丢 tag 不丢名字」。 */
	taskCategoryTags?: string[] | string | null | number;
	taskNameWithoutCategoryTags: string;
}

/** 字符串 = 模型没按结构化形状回、直接给了一整条名字；对象 = 约定的 tags + 名字两字段。两种都要接得住。 */
function suggestedTaskNamesResponse(...suggestedTaskNames: Array<SuggestedTaskNameItemFromModel | string>): Response {
	return chatCompletionResponseWith(JSON.stringify({ suggestedTaskNames }));
}

function readSentChatCompletionRequestBody(fetchImplementation: ReturnType<typeof vi.fn>): {
	messages: Array<{ role: string; content: string }>;
	temperature?: number;
} {
	return JSON.parse(String((fetchImplementation.mock.calls[0] as [string, RequestInit])[1].body));
}

async function suggestTaskNamesFromModelItems(
	...suggestedTaskNames: Array<SuggestedTaskNameItemFromModel | string>
): Promise<Awaited<ReturnType<typeof suggestTaskNamesFromTaskDescription>>> {
	const fetchImplementation = vi.fn().mockResolvedValue(suggestedTaskNamesResponse(...suggestedTaskNames));
	return await suggestTaskNamesFromTaskDescription(
		{ taskDescription: "Login redirects to a blank page" },
		{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
	);
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

	it("辅助起名默认路由不受旧默认 provider 或多家环境配置干扰", async () => {
		for (const extraEnvironment of [
			{ [getModelProviderApiKeyEnvironmentVariableName("openrouter")]: "sk-other" },
			{ [DEFAULT_MODEL_PROVIDER_ID_ENVIRONMENT_VARIABLE_NAME]: "unconfigured" },
		]) {
			const fetchImplementation = vi
				.fn()
				.mockResolvedValue(
					suggestedTaskNamesResponse({ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: "修复登录" }),
				);
			const result = await suggestTaskNamesFromTaskDescription(
				{ taskDescription: "登录故障" },
				{ environmentVariables: { ...ENVIRONMENT_WITH_API_KEY_ONLY, ...extraEnvironment }, fetchImplementation },
			);
			expect(result.status).toBe("suggested");
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			expect(fetchImplementation.mock.calls[0]?.[0]).toContain("deepseek");
		}
	});

	it("wraps the description as data in the user prompt and joins category tags and name into the titles", async () => {
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(
				suggestedTaskNamesResponse(
					{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: "修复登录跳转白屏" },
					{ taskCategoryTags: ["FIX", "UI"], taskNameWithoutCategoryTags: "登录页 redirect 后空白" },
					{ taskCategoryTags: [], taskNameWithoutCategoryTags: "修复 auth redirect" },
				),
			);
		const response = await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Login redirects to a blank page" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: ["[FIX]修复登录跳转白屏", "[FIX,UI]登录页 redirect 后空白", "修复 auth redirect"],
		});
		const requestBody = readSentChatCompletionRequestBody(fetchImplementation);
		expect(requestBody.messages.at(-1)?.content).toBe(
			"<task_description>\nLogin redirects to a blank page\n</task_description>",
		);
		// DeepSeek 的 JSON 模式要求 prompt 里出现 "json" 字样。
		expect(requestBody.messages[0]?.content.toLowerCase()).toContain("json");
	});

	it("asks for Chinese-primary names restricted to Han and ASCII letters, offering the tag vocabulary", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(suggestedTaskNamesResponse("修复登录"));
		await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "Login redirects to a blank page" },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		const requestBody = readSentChatCompletionRequestBody(fetchImplementation);
		const systemPrompt = requestBody.messages[0]?.content ?? "";
		expect(systemPrompt).toContain("Simplified Chinese");
		// 旧规则「跟描述同语言」对混杂描述不设任何书写系统约束，正是第三种文字混进来的口子。
		expect(systemPrompt).not.toContain("same language as the task description");
		for (const suggestedTaskCategoryTag of Object.keys(SUGGESTED_TASK_CATEGORY_TAG_VOCABULARY)) {
			expect(systemPrompt).toContain(`"${suggestedTaskCategoryTag}"`);
		}
		// 高温采样是跨书写系统漂移（state machine → मशीन）的主因之一。
		expect(requestBody.temperature).toBe(0.7);
	});

	it("truncates a very long description before sending it", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(suggestedTaskNamesResponse("Name"));
		await suggestTaskNamesFromTaskDescription(
			{ taskDescription: "x".repeat(20_000) },
			{ environmentVariables: ENVIRONMENT_WITH_API_KEY_ONLY, fetchImplementation },
		);
		const userPrompt = readSentChatCompletionRequestBody(fetchImplementation).messages.at(-1)?.content ?? "";
		const wrappedDescription = /<task_description>\n(x*)\n<\/task_description>/u.exec(userPrompt)?.[1] ?? "";
		expect(wrappedDescription).toHaveLength(8_000);
	});

	it("strips wrapping quotes, trailing punctuation and duplicates from the model's names", async () => {
		const response = await suggestTaskNamesFromModelItems(
			{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: '"Fix login."' },
			{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: "Fix login" },
			{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: "  " },
			{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: "修复登录跳转。" },
		);
		expect(response).toEqual({ status: "suggested", suggestedTaskNames: ["[FIX]Fix login", "[FIX]修复登录跳转"] });
	});

	it("normalizes tag casing, dedupes tags, keeps coined tags and drops malformed ones", async () => {
		const response = await suggestTaskNamesFromModelItems(
			{ taskCategoryTags: ["fix", "ui", "FIX"], taskNameWithoutCategoryTags: "展示 worktree 状态" },
			// 词表之外的短 tag 允许自由发挥（例如子系统名），统一大写。
			{ taskCategoryTags: ["feat", "orchestration"], taskNameWithoutCategoryTags: "自动注入续跑消息" },
			// 中文 tag 也接受；空串、过长、带空格或括号的视为不成形，丢掉 tag 不丢名字。
			{
				taskCategoryTags: ["RVF历史卡", "", "x".repeat(40), "two words", "a]b"],
				taskNameWithoutCategoryTags: "清理历史卡",
			},
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: [
				"[FIX,UI]展示 worktree 状态",
				"[FEAT,ORCHESTRATION]自动注入续跑消息",
				"[RVF历史卡]清理历史卡",
			],
		});
	});

	it("treats null or non-string, non-array tags as no tags and keeps the name", async () => {
		const response = await suggestTaskNamesFromModelItems(
			// JSON 模式下模型常用 null 表达「没有 tag」；数字等越界类型同理，只丢 tag 不丢名字。
			{ taskCategoryTags: null, taskNameWithoutCategoryTags: "修复登录" },
			{ taskCategoryTags: 42, taskNameWithoutCategoryTags: "[UI] 展示 worktree 状态" },
		);
		expect(response).toEqual({ status: "suggested", suggestedTaskNames: ["修复登录", "[UI]展示 worktree 状态"] });
	});

	it("checks tag shape on the raw characters and requires at least one letter or Han character", async () => {
		const response = await suggestTaskNamesFromModelItems(
			// `ß` / `ſ` 大写后会变成 `SS` / `S`，必须在大写前按原始字符拦下；纯连字符、纯数字也不算 tag。
			{ taskCategoryTags: ["ß", "ſ", "---", "123"], taskNameWithoutCategoryTags: "修复登录跳转" },
			{ taskCategoryTags: ["v2", "FIX", "ß"], taskNameWithoutCategoryTags: "迁移配置格式" },
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: ["修复登录跳转", "[V2,FIX]迁移配置格式"],
		});
	});

	it("strips surrounding quotes before reading the bracketed tag prefix, so tags are never doubled", async () => {
		const response = await suggestTaskNamesFromModelItems(
			{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: '"[UI] 修复登录跳转"' },
			"“[perf]降低看板渲染内存”",
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: ["[FIX]修复登录跳转", "[PERF]降低看板渲染内存"],
		});
	});

	it("keeps at most three tags", async () => {
		const response = await suggestTaskNamesFromModelItems({
			taskCategoryTags: ["FIX", "UI", "PERF", "AGENT"],
			taskNameWithoutCategoryTags: "修复卡片渲染卡顿",
		});
		expect(response).toEqual({ status: "suggested", suggestedTaskNames: ["[FIX,UI,PERF]修复卡片渲染卡顿"] });
	});

	it("reads comma-separated tags from a string field or from a bracketed prefix, without doubling them", async () => {
		const response = await suggestTaskNamesFromModelItems(
			{ taskCategoryTags: "fix, ui", taskNameWithoutCategoryTags: "[FIX,UI] 展示 worktree 状态" },
			"[perf，ui]降低看板渲染内存",
			"【docs】补充 AGENTS.md 指针",
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: ["[FIX,UI]展示 worktree 状态", "[PERF,UI]降低看板渲染内存", "[DOCS]补充 AGENTS.md 指针"],
		});
	});

	it("keeps the whole tag prefix and truncates only the name part when the joined title is too long", async () => {
		const response = await suggestTaskNamesFromModelItems({
			taskCategoryTags: ["REFACTOR", "UI"],
			taskNameWithoutCategoryTags: "拆".repeat(200),
		});
		const [suggestedTaskName] = (response as { suggestedTaskNames: string[] }).suggestedTaskNames;
		expect(suggestedTaskName).toBe(`[REFACTOR,UI]${"拆".repeat(80 - "[REFACTOR,UI]".length)}`);
	});

	it("drops names that contain letters from scripts other than Han and ASCII Latin", async () => {
		const response = await suggestTaskNamesFromModelItems(
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "可视化 unit lifecycle state मशीन" },
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "可视化 unit 生命周期のステート" },
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "可视化 상태 머신" },
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "Визуализация state machine" },
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "可视化 unit lifecycle state machine" },
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "Visualize unit lifecycle (v2)：状态机 #3" },
		);
		expect(response).toEqual({
			status: "suggested",
			suggestedTaskNames: [
				"[UI]可视化 unit lifecycle state machine",
				"[UI]Visualize unit lifecycle (v2)：状态机 #3",
			],
		});
	});

	it("drops foreign-script tags but keeps the name", async () => {
		const response = await suggestTaskNamesFromModelItems({
			taskCategoryTags: ["UI", "मशीन"],
			taskNameWithoutCategoryTags: "可视化状态机",
		});
		expect(response).toEqual({ status: "suggested", suggestedTaskNames: ["[UI]可视化状态机"] });
	});

	it("degrades to unavailable when every name is in a foreign script", async () => {
		const response = await suggestTaskNamesFromModelItems(
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "स्टेट मशीन" },
			{ taskCategoryTags: ["UI"], taskNameWithoutCategoryTags: "ステートマシン" },
		);
		expect(response).toEqual({
			status: "unavailable",
			unavailableReason: "request_failed",
			unavailableDetail: "Model provider returned JSON in an unexpected shape.",
		});
	});

	it("degrades to unavailable when nothing survives normalization", async () => {
		const response = await suggestTaskNamesFromModelItems(
			{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: "   " },
			{ taskCategoryTags: ["FIX"], taskNameWithoutCategoryTags: "。" },
			"",
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
