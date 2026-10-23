import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as modelProviderUsageRecord from "../../../src/model-provider-access/model-provider-usage-record";
import {
	assembleStatelessTaskIndexingAgentPrompt,
	buildStatelessTaskIndexingAgentEnvironment,
	buildStatelessTaskIndexingAgentLaunchArguments,
	executeStatelessTaskIndexingAgent,
	parseStatelessTaskIndexingAgentEvents,
} from "../../../src/task-indexing-support/stateless-task-indexing-agent-executor";

vi.mock("node:child_process", { spy: true });

function mockHeadlessAgentProcessWithControlledStdout(
	stdoutChunks: readonly Buffer[],
	exitCode = 0,
	stderrChunks: readonly Buffer[] = [],
) {
	const child = new childProcess.ChildProcess();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	child.stdin = stdin;
	child.stdout = stdout;
	child.stderr = stderr;
	let stopped = false;
	vi.mocked(childProcess.spawn).mockReturnValue(child);
	vi.spyOn(child, "kill").mockImplementation(() => {
		stopped = true;
		queueMicrotask(() => child.emit("close", null, "SIGKILL"));
		return true;
	});
	stdin.once("finish", () => {
		child.emit("spawn");
		for (const chunk of stderrChunks) {
			stderr.write(chunk);
			if (stopped) return;
		}
		for (const chunk of stdoutChunks) {
			stdout.write(chunk);
			if (stopped) return;
		}
		stdout.end();
		queueMicrotask(() => child.emit("close", exitCode, null));
	});
	return child;
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

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("共享索引执行器的 stdout 字节流边界", () => {
	it("请求的模型别名不能冒充 Agent 实际返回的模型身份", async () => {
		mockHeadlessAgentProcessWithControlledStdout([Buffer.from(successfulCodexStdout)]);
		const result = await executeStatelessTaskIndexingAgent({
			...controlledExecutorRequest,
			settings: { agentId: "codex", modelId: "requested-alias" },
		});
		expect(result.usage.resolvedModelId).toBeNull();
	});
	it("实时活动在跨字节和 Unicode 分隔符下完整到达，且不暴露模型正文", async () => {
		const text = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ reason: "甲\u2028乙\u2029丙", evidence: [] }) } })}\n${JSON.stringify({ type: "turn.completed" })}\n`;
		mockHeadlessAgentProcessWithControlledStdout(Array.from(Buffer.from(text), (byte) => Buffer.from([byte])));
		const activity = vi.fn();
		const result = await executeStatelessTaskIndexingAgent({
			...controlledExecutorRequest,
			onExecutionActivity: activity,
		});
		expect(result.value.reason).toBe("甲\u2028乙\u2029丙");
		expect(activity.mock.calls.flat().map((event) => event.eventKind)).toEqual([
			"agent_process_started",
			"agent_response_received",
			"agent_response_received",
			"agent_execution_completed",
		]);
		expect(JSON.stringify(activity.mock.calls)).not.toContain("甲");
	});
	it("异常退出保存退出码和完整中文 stderr，并隐藏认证令牌", async () => {
		const stderr = "认证失败 access_token=secret-example-value 中文尾部";
		mockHeadlessAgentProcessWithControlledStdout(
			[],
			1,
			Array.from(Buffer.from(stderr), (byte) => Buffer.from([byte])),
		);
		await expect(executeStatelessTaskIndexingAgent(controlledExecutorRequest)).rejects.toMatchObject({
			reasonCode: "authentication_failed",
			exitCode: 1,
			stderrTail: "认证失败 access_token=[已隐藏] 中文尾部",
		});
	});
	it.each([
		{ agentId: "codex" as const, exitCode: 0, eventType: "error" },
		{ agentId: "codex" as const, exitCode: 1, eventType: "error" },
		{ agentId: "codex" as const, exitCode: 0, eventType: "turn.failed" },
		{ agentId: "codex" as const, exitCode: 0, eventType: "item.started" },
		{ agentId: "codex" as const, exitCode: 0, eventType: "item.completed" },
		{ agentId: "claude" as const, exitCode: 0, eventType: "result" },
		{ agentId: "claude" as const, exitCode: 1, eventType: "result" },
	])(
		"$agentId 的 $eventType 错误在退出码 $exitCode 时先隐藏长输入再截断",
		async ({ agentId, exitCode, eventType }) => {
			const usageRecorder = vi
				.spyOn(modelProviderUsageRecord, "recordModelProviderUsage")
				.mockImplementation(() => {});
			const activity = vi.fn();
			const request = {
				...controlledExecutorRequest,
				settings: { agentId, modelId: null },
				queryText: `${"查询前缀".repeat(1300)}PRIVATE_QUESTION_MARKER`,
				context: {
					...controlledExecutorRequest.context,
					levelOneBoardTaskIndexText: `${"材料前缀".repeat(1300)}PRIVATE_CONTEXT_MARKER`,
				},
				onExecutionActivity: activity,
			};
			const prompt = assembleStatelessTaskIndexingAgentPrompt(request);
			const detail = `认证失败 E401\n${prompt.stablePrefix}\n${prompt.query}\n{"access_token":"PRIVATE_ACCESS_TOKEN","password":"PRIVATE PASSWORD VALUE"}`;
			const event =
				eventType === "result"
					? { type: eventType, is_error: true, subtype: "error", result: detail }
					: eventType.startsWith("item.")
						? { type: eventType, item: { type: "error", message: detail } }
						: eventType === "turn.failed"
							? { type: eventType, error: { message: detail } }
							: { type: eventType, message: detail };
			mockHeadlessAgentProcessWithControlledStdout([Buffer.from(`${JSON.stringify(event)}\n`)], exitCode);
			const failure = await executeStatelessTaskIndexingAgent(request).catch((error: unknown) => error);
			expect(failure).toMatchObject({ reasonCode: "authentication_failed", exitCode });
			const diagnostic = JSON.stringify({ failure, message: failure instanceof Error ? failure.message : failure });
			expect(diagnostic).toContain("E401");
			expect(diagnostic).toContain("[输入材料已隐藏]");
			for (const privateText of ["PRIVATE_", "查询前缀", "材料前缀"])
				expect(JSON.stringify([diagnostic, usageRecorder.mock.calls, activity.mock.calls])).not.toContain(
					privateText,
				);
		},
	);
	it.each([false, true])("分块 stderr 的完整输入与带引号凭据在截取尾部之前隐藏（JSON 转义：%s）", async (escaped) => {
		const request = {
			...controlledExecutorRequest,
			queryText: `${"查询前缀".repeat(1300)}PRIVATE_STDERR_QUESTION_MARKER`,
		};
		const prompt = assembleStatelessTaskIndexingAgentPrompt(request);
		const stderr = `认证失败 E401\n${prompt.query}\n{"access_token":"PRIVATE_JSON_TOKEN","secret":"PRIVATE SECRET VALUE"}`;
		const stderrBytes = Buffer.from(escaped ? `日志前缀 ${JSON.stringify(stderr)}` : stderr);
		mockHeadlessAgentProcessWithControlledStdout(
			[],
			1,
			Array.from({ length: Math.ceil(stderrBytes.length / 257) }, (_, index) =>
				stderrBytes.subarray(index * 257, (index + 1) * 257),
			),
		);
		const failure = await executeStatelessTaskIndexingAgent(request).catch((error: unknown) => error);
		expect(failure).toMatchObject({ reasonCode: "authentication_failed", exitCode: 1 });
		expect(failure).toHaveProperty("stderrTail", expect.stringContaining("E401"));
		expect(JSON.stringify(failure)).not.toContain("PRIVATE_");
		expect(JSON.stringify(failure)).not.toContain("查询前缀");
	});
	it("进程启动错误也先隐藏输入材料和 JSON 凭据", async () => {
		const child = mockHeadlessAgentProcessWithControlledStdout([]);
		child.stdin?.removeAllListeners("finish");
		child.stdin?.once("finish", () =>
			child.emit(
				"error",
				new Error(`ENOENT ${controlledExecutorRequest.queryText} {"access_token":"PRIVATE_SPAWN_TOKEN"}`),
			),
		);
		const failure = await executeStatelessTaskIndexingAgent(controlledExecutorRequest).catch(
			(error: unknown) => error,
		);
		expect(failure).toMatchObject({ reasonCode: "process_spawn_failed" });
		expect(failure).toHaveProperty("message", expect.stringContaining("ENOENT"));
		expect(failure).toHaveProperty("message", expect.not.stringContaining(controlledExecutorRequest.queryText));
		expect(failure).toHaveProperty("message", expect.not.stringContaining("PRIVATE_SPAWN_TOKEN"));
	});
	it("诊断警告的返回值和活动摘要均隐藏原始与 JSON 转义输入", async () => {
		const activity = vi.fn();
		const request = { ...controlledExecutorRequest, onExecutionActivity: activity };
		const prompt = assembleStatelessTaskIndexingAgentPrompt(request);
		const warning = `Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed. ${JSON.stringify(prompt.query)} {"access_token":"PRIVATE_WARNING_TOKEN"}`;
		mockHeadlessAgentProcessWithControlledStdout([
			Buffer.from(
				`${JSON.stringify({ type: "item.completed", item: { type: "error", message: warning } })}\n${successfulCodexStdout}`,
			),
		]);
		const result = await executeStatelessTaskIndexingAgent(request);
		expect(result.value).toEqual(expectedStructuredChineseResult);
		expect(result.diagnosticWarnings[0]).toContain("Code mode will fail closed");
		expect(JSON.stringify([result.diagnosticWarnings, activity.mock.calls])).not.toContain(request.queryText);
		expect(JSON.stringify([result.diagnosticWarnings, activity.mock.calls])).not.toContain("PRIVATE_WARNING_TOKEN");
	});
	it("stderr 超出预算时终止进程且不保留可能截断的输入片段", async () => {
		const oversizedStderr = Buffer.concat([Buffer.from("PRIVATE_PARTIAL_INPUT"), Buffer.alloc(4 * 1024 * 1024)]);
		mockHeadlessAgentProcessWithControlledStdout([], 1, [oversizedStderr]);
		await expect(executeStatelessTaskIndexingAgent(controlledExecutorRequest)).rejects.toMatchObject({
			reasonCode: "output_budget_exceeded",
			signal: "SIGKILL",
			stderrTail: "错误输出超过预算，未保留原文。",
		});
	});
	it("超时终止子进程并保留明确原因和退出信号", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = mockHeadlessAgentProcessWithControlledStdout([]);
		child.stdin?.removeAllListeners("finish");
		const launched = new Promise<void>((resolve) => child.stdin?.once("finish", () => resolve()));
		const execution = executeStatelessTaskIndexingAgent({ ...controlledExecutorRequest, timeoutMs: 25 });
		const assertion = expect(execution).rejects.toMatchObject({ reasonCode: "execution_timeout", signal: "SIGKILL" });
		await launched;
		await vi.advanceTimersByTimeAsync(25);
		await assertion;
		expect(child.kill).toHaveBeenCalled();
	});
	it("进程无法启动与结构化结果损坏有不同诊断", async () => {
		const child = mockHeadlessAgentProcessWithControlledStdout([]);
		child.stdin?.removeAllListeners("finish");
		child.stdin?.once("finish", () => child.emit("error", new Error("ENOENT")));
		await expect(executeStatelessTaskIndexingAgent(controlledExecutorRequest)).rejects.toMatchObject({
			reasonCode: "process_spawn_failed",
		});
		mockHeadlessAgentProcessWithControlledStdout([Buffer.from("不是 JSON\n")]);
		await expect(executeStatelessTaskIndexingAgent(controlledExecutorRequest)).rejects.toMatchObject({
			reasonCode: "invalid_agent_response",
			exitCode: 0,
		});
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
