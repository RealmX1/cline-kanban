import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	buildStatelessTaskIndexingAgentEnvironment,
	buildStatelessTaskIndexingAgentLaunchArguments,
	executeStatelessTaskIndexingAgent,
	parseStatelessTaskIndexingAgentEvents,
} from "../../../src/task-indexing-support/stateless-task-indexing-agent-executor";

vi.mock("node:child_process", { spy: true });

function mockHeadlessAgentProcessWithControlledStdout(stdoutChunks: readonly Buffer[], exitCode = 0) {
	const child = new childProcess.ChildProcess();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	child.stdin = stdin;
	child.stdout = stdout;
	child.stderr = new PassThrough();
	let stopped = false;
	vi.mocked(childProcess.spawn).mockReturnValue(child);
	vi.spyOn(child, "kill").mockImplementation(() => {
		stopped = true;
		queueMicrotask(() => child.emit("close", null, "SIGKILL"));
		return true;
	});
	stdin.once("finish", () => {
		for (const chunk of stdoutChunks) {
			stdout.write(chunk);
			if (stopped) return;
		}
		stdout.end();
		queueMicrotask(() => child.emit("close", exitCode, null));
	});
	return { child, stdin };
}

const expectedStructuredChineseResult = { reason: "中文理由", evidence: ["中文证据"] };
const successfulCodexStdout = `${JSON.stringify({
	type: "item.completed",
	item: { type: "agent_message", text: JSON.stringify(expectedStructuredChineseResult) },
})}\n${JSON.stringify({ type: "turn.completed" })}\n`;
const controlledExecutorRequest = {
	settings: { agentId: "codex" as const, modelId: null },
	instructionText: "只返回结构化关系理由与证据。",
	context: {
		schemaVersion: 1 as const,
		workspaceId: "isolated-controlled-stdout-workspace",
		levelOneBoardTaskIndexText: "",
		levelTwoProjectTaskRecapsText: "",
		levelThreeAppendedChangesText: "",
		snapshotFingerprint: "controlled-stdout-snapshot",
		contextCompleteness: [],
		asOf: 0,
		rebuildReason: null,
	},
	queryText: "验证中文输出。",
	outputSchema: z.object({ reason: z.string(), evidence: z.array(z.string()) }),
};

afterEach(() => vi.restoreAllMocks());

describe("共享索引执行器的 stdout 字节流边界", () => {
	it("Claude 原生 content block 与 Codex 独立图片参数均保留输入顺序且不进入共享前缀", async () => {
		const { stdin } = mockHeadlessAgentProcessWithControlledStdout([
			Buffer.from(
				`${JSON.stringify({ type: "result", subtype: "success", structured_output: expectedStructuredChineseResult })}\n`,
			),
		]);
		let receivedInput = "";
		stdin.on("data", (chunk) => {
			receivedInput += chunk.toString();
		});
		const questionImages = [
			{ id: "query-image", mimeType: "image/png", data: "aW1hZ2U=", name: "参考图.png" },
			{ id: "comparison-image", mimeType: "image/jpeg", data: "b3RoZXI=", name: "比较图.jpg" },
		];
		await executeStatelessTaskIndexingAgent({
			...controlledExecutorRequest,
			settings: { agentId: "claude", modelId: null },
			questionImages,
		});
		expect(JSON.parse(receivedInput).message.content).toEqual([
			{ type: "text", text: expect.stringContaining("验证中文输出") },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: questionImages[0]?.data } },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: questionImages[1]?.data } },
		]);
		expect(vi.mocked(childProcess.spawn).mock.calls[0]?.[1]).toContain("--input-format");
		mockHeadlessAgentProcessWithControlledStdout([Buffer.from(successfulCodexStdout)]);
		await executeStatelessTaskIndexingAgent({ ...controlledExecutorRequest, questionImages });
		const args = vi.mocked(childProcess.spawn).mock.calls.at(-1)?.[1] as string[];
		expect(args.flatMap((argument, index) => (argument === "--image" ? [args[index + 1]] : []))).toEqual([
			expect.stringMatching(/query-reference-image-0\.png$/u),
			expect.stringMatching(/query-reference-image-1\.jpg$/u),
		]);
		expect(args).not.toContain(questionImages[0]?.data);
	});
	it("中文的每个 UTF-8 字节分别到达时，理由和证据保持原文", async () => {
		mockHeadlessAgentProcessWithControlledStdout(
			Array.from(Buffer.from(successfulCodexStdout), (byte) => Buffer.from([byte])),
		);
		const result = await executeStatelessTaskIndexingAgent(controlledExecutorRequest);
		expect(result.value).toEqual(expectedStructuredChineseResult);
	});

	it("跨块中文输出恰好达到原始字节预算时仍可采用", async () => {
		const outputBytes = Buffer.from(successfulCodexStdout);
		mockHeadlessAgentProcessWithControlledStdout([
			...Array.from(outputBytes, (byte) => Buffer.from([byte])),
			Buffer.alloc(4 * 1024 * 1024 - outputBytes.length, " "),
		]);
		const result = await executeStatelessTaskIndexingAgent(controlledExecutorRequest);
		expect(result.value).toEqual(expectedStructuredChineseResult);
	});

	it("原始字节超过预算时，即使最后一块只有未完成 UTF-8 首字节也拒绝", async () => {
		mockHeadlessAgentProcessWithControlledStdout([Buffer.alloc(4 * 1024 * 1024, " "), Buffer.from([0xe4])]);
		await expect(executeStatelessTaskIndexingAgent(controlledExecutorRequest)).rejects.toThrow("输出超过预算");
	});

	it("非零退出仍拒绝，并保留跨块中文错误详情", async () => {
		mockHeadlessAgentProcessWithControlledStdout(
			Array.from(Buffer.from(JSON.stringify({ type: "error", message: "中文错误详情" })), (byte) =>
				Buffer.from([byte]),
			),
			1,
		);
		await expect(executeStatelessTaskIndexingAgent(controlledExecutorRequest)).rejects.toThrow(
			"退出码 1：中文错误详情",
		);
	});
});

describe("共享索引无状态执行器的隔离与返回校验", () => {
	it("保留原认证位置与显式 OAuth，清除宿主任务和会话行动者身份", () => {
		const environment = buildStatelessTaskIndexingAgentEnvironment({
			HOME: "/home/person",
			CODEX_HOME: "/auth/codex",
			CLAUDE_CODE_OAUTH_TOKEN: "test-token",
			ANTHROPIC_API_KEY: "test-api-key",
			KANBAN_TASK_ID: "host-task",
			CODEX_THREAD_ID: "host-thread",
			CLAUDE_CODE_SESSION_ID: "host-session",
		});
		expect(environment).toMatchObject({
			HOME: "/home/person",
			CODEX_HOME: "/auth/codex",
			CLAUDE_CODE_OAUTH_TOKEN: "test-token",
			ANTHROPIC_API_KEY: "test-api-key",
		});
		expect(environment.KANBAN_TASK_ID).toBeUndefined();
		expect(environment.CODEX_THREAD_ID).toBeUndefined();
		expect(environment.CLAUDE_CODE_SESSION_ID).toBeUndefined();
	});
	it("Claude 替换系统指令、禁用定制与工具，保留订阅认证路径", () => {
		const args = buildStatelessTaskIndexingAgentLaunchArguments({
			settings: { agentId: "claude", modelId: null },
			stablePrefix: "稳定前缀",
			isolatedDirectoryPath: "/isolated",
			outputSchemaPath: "/isolated/schema",
			outputSchemaJson: "{}",
		});
		expect(args).toContain("--safe-mode");
		expect(args).toContain("--no-session-persistence");
		expect(args).not.toContain("--bare");
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(args[args.indexOf("--system-prompt") + 1]).toBe("稳定前缀");
	});
	it("Codex 不续会话、不加载用户配置/规则，采用只读 sandbox 和替换指令", () => {
		const args = buildStatelessTaskIndexingAgentLaunchArguments({
			settings: { agentId: "codex", modelId: "model" },
			stablePrefix: "稳定前缀",
			isolatedDirectoryPath: "/isolated",
			outputSchemaPath: "/isolated/schema",
			outputSchemaJson: "{}",
		});
		expect(args).toContain("--ephemeral");
		expect(args).toContain("--ignore-user-config");
		expect(args).toContain("--ignore-rules");
		expect(args).toContain("read-only");
		expect(args).toContain("features.shell_tool=false");
		expect(args).toContain("features.multi_agent=false");
		expect(args.join(" ")).not.toMatch(/resume|fork|dangerously-bypass/u);
	});
	it("大于安全 argv 限额的 Claude 前缀通过文件传入，不裁剪任务", () => {
		const args = buildStatelessTaskIndexingAgentLaunchArguments({
			settings: { agentId: "claude", modelId: null },
			stablePrefix: "完整任务材料".repeat(10000),
			isolatedDirectoryPath: "/isolated",
			outputSchemaPath: "/isolated/schema",
			outputSchemaJson: "{}",
		});
		expect(args).toContain("--system-prompt-file");
		expect(args).not.toContain("--system-prompt");
	});
	it("Claude 统计 input 包含缓存 token，只有成功结构化结果可采用", () => {
		const result = parseStatelessTaskIndexingAgentEvents("claude", [
			JSON.stringify({
				type: "result",
				subtype: "success",
				structured_output: { relation_candidates: [] },
				usage: {
					input_tokens: 10,
					cache_read_input_tokens: 1000,
					cache_creation_input_tokens: 20,
					output_tokens: 30,
				},
				modelUsage: { model: {} },
			}),
		]);
		expect(result.usage).toMatchObject({
			inputTokens: 1030,
			cacheReadTokens: 1000,
			cacheWriteTokens: 20,
			resolvedModelId: "model",
		});
		expect(() =>
			parseStatelessTaskIndexingAgentEvents("claude", [
				JSON.stringify({ type: "result", subtype: "error", is_error: true }),
			]),
		).toThrow("未成功");
	});
	it("拒绝 Codex 工具条目、未完成回合、畸形 JSON，不能冒充零候选", () => {
		expect(() =>
			parseStatelessTaskIndexingAgentEvents("codex", [
				JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "echo" } }),
			]),
		).toThrow("不允许");
		expect(() => parseStatelessTaskIndexingAgentEvents("codex", [])).toThrow("缺少");
		expect(() => parseStatelessTaskIndexingAgentEvents("codex", ["不是 JSON"])).toThrow();
	});
	it("Codex 主动关闭 code-mode 的明确 fail-closed 提示可与成功结果并存，真实错误仍拒绝", () => {
		const output = parseStatelessTaskIndexingAgentEvents("codex", [
			JSON.stringify({
				type: "item.completed",
				item: {
					type: "error",
					message:
						"Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable host.",
				},
			}),
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "准备返回结果。" } }),
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"confirmed":true}' } }),
			JSON.stringify({
				type: "turn.completed",
				usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
			}),
		]);
		expect(output.structured).toEqual({ confirmed: true });
		expect(output.diagnosticWarnings).toHaveLength(1);
		expect(() =>
			parseStatelessTaskIndexingAgentEvents("codex", [
				JSON.stringify({ type: "item.completed", item: { type: "error", message: "认证失败" } }),
			]),
		).toThrow("认证失败");
	});
});
