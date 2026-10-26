import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { requestTaskAssistanceJsonObject } from "../../../src/model-provider-access/task-assistance-model-provider-routing";
import { createTempDir } from "../../utilities/temp-dir";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const outputSchema = z.object({ workspaceId: z.string() });
const request = {
	modelUsagePurpose: "task_project_assignment_analysis" as const,
	operationId: "operation-1",
	stage: "project_assignment",
	systemPrompt: "只输出 JSON",
	userPrompt: "选择项目",
	requestTimeoutMs: 100,
};
const environmentVariables = {
	KANBAN_MODEL_PROVIDER_MINIMAX_API_KEY: "fixture-minimax",
	KANBAN_MODEL_PROVIDER_MINIMAX_BASE_URL: "https://minimax.invalid/v1",
	KANBAN_MODEL_PROVIDER_MINIMAX_MODEL_ID: "MiniMax-M2.5",
	KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: "fixture-deepseek",
};
const completion = (content = '{"workspaceId":"registered"}') =>
	new Response(
		JSON.stringify({
			model: "actual-model",
			choices: [{ message: { content } }],
			usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 7 } },
		}),
	);

describe("辅助 AI 的有界 API 主备路由", () => {
	it("新进程从磁盘恢复冷却，届满后自动重验且不覆盖旧失败", async () => {
		const directory = createTempDir("task-assistance-restart-");
		try {
			await requestTaskAssistanceJsonObject(request, outputSchema, {
				environmentVariables,
				storageDirectoryPath: directory.path,
				now: () => 1000,
				fetchImplementation: vi
					.fn()
					.mockResolvedValueOnce(new Response("", { status: 503 }))
					.mockImplementation(async () => completion()),
			});
			const moduleUrl = pathToFileURL(
				join(process.cwd(), "src/model-provider-access/task-assistance-model-provider-routing.ts"),
			).href;
			for (const [now, expectedProvider] of [
				[1001, "deepseek"],
				[61001, "minimax"],
			] as const) {
				const script = `import {z} from 'zod'; import {requestTaskAssistanceJsonObject} from ${JSON.stringify(moduleUrl)}; const urls=[]; const result=await requestTaskAssistanceJsonObject(${JSON.stringify(request)},z.object({workspaceId:z.string()}),{environmentVariables:${JSON.stringify(environmentVariables)},storageDirectoryPath:${JSON.stringify(directory.path)},now:()=>${now},fetchImplementation:async url=>{urls.push(String(url));return new Response(JSON.stringify({choices:[{message:{content:'{"workspaceId":"registered"}'}}]}));}}); console.log(JSON.stringify({status:result.status,urls}));`;
				const child = await promisify(execFile)(
					process.execPath,
					["--import", "tsx", "--input-type=module", "--eval", script],
					{
						timeout: 30000,
						env: {
							...process.env,
							HOME: directory.path,
							CODEX_HOME: join(directory.path, "codex"),
							CODEX_SQLITE_HOME: join(directory.path, "codex"),
							KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT: directory.path,
						},
					},
				);
				const result = JSON.parse(child.stdout);
				expect(result.status).toBe("completed");
				expect(result.urls).toHaveLength(1);
				expect(result.urls[0]).toContain(expectedProvider);
			}
			expect(await readFile(join(directory.path, "provider-recovery-state.json"), "utf8")).toContain("lastFailure");
		} finally {
			directory.cleanup();
		}
	}, 60000);
	it("实际 AbortSignal 超时会结束请求并尝试备用", async () => {
		const directory = createTempDir("task-assistance-timeout-");
		const fetchImplementation = vi
			.fn()
			.mockImplementationOnce(
				(_url, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					}),
			)
			.mockImplementation(async () => completion());
		try {
			const result = await requestTaskAssistanceJsonObject({ ...request, requestTimeoutMs: 10 }, outputSchema, {
				environmentVariables,
				storageDirectoryPath: directory.path,
				fetchImplementation,
			});
			expect(result.status).toBe("completed");
			expect(fetchImplementation).toHaveBeenCalledTimes(2);
		} finally {
			directory.cleanup();
		}
	});
	it("首选成功只请求一次，按型号适配参数并保留实际模型及缓存用量", async () => {
		const directory = createTempDir("task-assistance-routing-");
		const fetchImplementation = vi.fn().mockResolvedValue(completion());
		try {
			const result = await requestTaskAssistanceJsonObject(request, outputSchema, {
				environmentVariables,
				storageDirectoryPath: directory.path,
				fetchImplementation,
			});
			expect(result).toMatchObject({
				status: "completed",
				parsedJsonObject: { workspaceId: "registered" },
				attempts: [
					{
						modelProviderId: "minimax",
						requestedModelId: "MiniMax-M2.5",
						resolvedModelId: "actual-model",
						cacheReadTokens: 7,
					},
				],
			});
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			const body = JSON.parse(fetchImplementation.mock.calls[0]?.[1].body);
			expect(body.thinking).toBeUndefined();
			expect(body.reasoning_split).toBe(true);
			expect(body.tools).toBeUndefined();
		} finally {
			directory.cleanup();
		}
	});
	it.each(["http", "json", "identity", "timeout"])(
		"%s 失败切换一次；冷却跨调用恢复，届满后自动重验",
		async (failure) => {
			const directory = createTempDir("task-assistance-routing-");
			let now = 1000;
			const fetchImplementation = vi
				.fn()
				.mockImplementationOnce(async () =>
					failure === "timeout"
						? Promise.reject(new DOMException("超时", "TimeoutError"))
						: failure === "http"
							? new Response("", { status: 503 })
							: completion(failure === "json" ? "invalid" : '{"workspaceId":"unknown"}'),
				)
				.mockImplementation(async () => completion());
			const options = {
				environmentVariables,
				storageDirectoryPath: directory.path,
				fetchImplementation,
				now: () => now,
				validateParsedJsonObject: (value: { workspaceId: string }) => {
					if (value.workspaceId !== "registered") throw new Error("身份无效");
				},
			};
			try {
				const first = await requestTaskAssistanceJsonObject(request, outputSchema, options);
				expect(first).toMatchObject({
					status: "completed",
					attempts: [
						{ modelProviderId: "minimax", outcome: "unavailable" },
						{ modelProviderId: "deepseek", outcome: "completed" },
					],
				});
				expect(fetchImplementation).toHaveBeenCalledTimes(2);
				await requestTaskAssistanceJsonObject({ ...request, operationId: "operation-2" }, outputSchema, options);
				expect(fetchImplementation.mock.calls[2]?.[0]).toContain("deepseek");
				now += 60_001;
				await requestTaskAssistanceJsonObject({ ...request, operationId: "operation-3" }, outputSchema, options);
				expect(fetchImplementation.mock.calls[3]?.[0]).toContain("minimax");
				const persisted = await readFile(join(directory.path, "provider-recovery-state.json"), "utf8");
				expect(persisted).toContain("lastFailure");
			} finally {
				directory.cleanup();
			}
		},
	);
	it("未配置首选时 DeepSeek 独立完成；未知缓存保持缺省", async () => {
		const directory = createTempDir("task-assistance-routing-");
		const fetchImplementation = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: '{"workspaceId":"registered"}' } }] })),
			);
		try {
			const result = await requestTaskAssistanceJsonObject(request, outputSchema, {
				environmentVariables: { KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: "fixture" },
				storageDirectoryPath: directory.path,
				fetchImplementation,
			});
			expect(result.status).toBe("completed");
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			expect(result.attempts.at(-1)?.cacheReadTokens).toBeUndefined();
			const body = JSON.parse(fetchImplementation.mock.calls[0]?.[1].body);
			expect(body.thinking).toEqual({ type: "disabled" });
			expect(body.response_format).toEqual({ type: "json_object" });
		} finally {
			directory.cleanup();
		}
	});
	it("取消立即结束，不触发备用或冷却", async () => {
		const directory = createTempDir("task-assistance-routing-");
		const controller = new AbortController();
		const fetchImplementation = vi.fn().mockImplementation(async () => {
			controller.abort();
			throw controller.signal.reason;
		});
		try {
			const result = await requestTaskAssistanceJsonObject(
				{ ...request, abortSignal: controller.signal },
				outputSchema,
				{ environmentVariables, storageDirectoryPath: directory.path, fetchImplementation },
			);
			expect(result).toMatchObject({ status: "unavailable", unavailableReason: "execution_cancelled" });
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
		} finally {
			directory.cleanup();
		}
	});
	it("两家都失败最多两次；同一家配置为主备只请求一次", async () => {
		const directory = createTempDir("task-assistance-routing-");
		const fetchImplementation = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
		try {
			const first = await requestTaskAssistanceJsonObject(request, outputSchema, {
				environmentVariables,
				storageDirectoryPath: directory.path,
				fetchImplementation,
			});
			expect(first).toMatchObject({ status: "unavailable", unavailableReason: "request_failed" });
			expect(fetchImplementation).toHaveBeenCalledTimes(2);
			fetchImplementation.mockClear();
			await requestTaskAssistanceJsonObject(request, outputSchema, {
				environmentVariables,
				storageDirectoryPath: directory.path,
				fetchImplementation,
				routingSettings: { preferredModelProviderId: "deepseek", fallbackModelProviderId: "deepseek" },
			});
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
		} finally {
			directory.cleanup();
		}
	});
	it("模型配置变化立即解除旧冷却，MiniMax M3.1 使用低推理参数", async () => {
		const directory = createTempDir("task-assistance-routing-");
		const fetchImplementation = vi
			.fn()
			.mockResolvedValueOnce(new Response("", { status: 503 }))
			.mockImplementation(async () => completion());
		try {
			await requestTaskAssistanceJsonObject(request, outputSchema, {
				environmentVariables,
				storageDirectoryPath: directory.path,
				fetchImplementation,
			});
			await requestTaskAssistanceJsonObject(request, outputSchema, {
				environmentVariables: {
					...environmentVariables,
					KANBAN_MODEL_PROVIDER_MINIMAX_MODEL_ID: "MiniMax-M3.1-Flash",
				},
				storageDirectoryPath: directory.path,
				fetchImplementation,
			});
			expect(fetchImplementation.mock.calls[2]?.[0]).toContain("minimax");
			const body = JSON.parse(fetchImplementation.mock.calls[2]?.[1].body);
			expect(body.reasoning_effort).toBe("low");
			expect(body.thinking).toBeUndefined();
		} finally {
			directory.cleanup();
		}
	});
	it("不支持图片的首选不发送，兼容备用收到完整图片且保持顺序", async () => {
		const directory = createTempDir("task-assistance-routing-");
		const fetchImplementation = vi.fn().mockResolvedValue(completion());
		const questionImages = [
			{ id: "image-1", name: "首图", mimeType: "image/png", data: "aW1hZ2U=" },
			{ id: "image-2", name: "次图", mimeType: "image/jpeg", data: "b3RoZXI=" },
		];
		try {
			const result = await requestTaskAssistanceJsonObject({ ...request, questionImages }, outputSchema, {
				environmentVariables: { ...environmentVariables, KANBAN_MODEL_PROVIDER_MINIMAX_MODEL_ID: "MiniMax-M3" },
				storageDirectoryPath: directory.path,
				fetchImplementation,
				routingSettings: { preferredModelProviderId: "deepseek", fallbackModelProviderId: "minimax" },
			});
			expect(result).toMatchObject({
				status: "completed",
				attempts: [
					{ modelProviderId: "deepseek", outcome: "skipped", failureReason: "image_input_not_supported" },
					{ modelProviderId: "minimax", outcome: "completed" },
				],
			});
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			const body = JSON.parse(fetchImplementation.mock.calls[0]?.[1].body);
			expect(
				body.messages[1].content.slice(1).map((part: { image_url: { url: string } }) => part.image_url.url),
			).toEqual(["data:image/png;base64,aW1hZ2U=", "data:image/jpeg;base64,b3RoZXI="]);
			expect(body.thinking).toEqual({ type: "disabled" });
		} finally {
			directory.cleanup();
		}
	});
	it("全部模型不支持图片时明确失败，不发送去掉图片的请求", async () => {
		const directory = createTempDir("task-assistance-routing-");
		const fetchImplementation = vi.fn();
		try {
			const result = await requestTaskAssistanceJsonObject(
				{ ...request, questionImages: [{ id: "image", name: "图", mimeType: "image/png", data: "aW1hZ2U=" }] },
				outputSchema,
				{ environmentVariables, storageDirectoryPath: directory.path, fetchImplementation },
			);
			expect(result).toMatchObject({ status: "unavailable", unavailableReason: "request_failed" });
			expect(fetchImplementation).not.toHaveBeenCalled();
		} finally {
			directory.cleanup();
		}
	});
});
