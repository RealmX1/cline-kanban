import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { RuntimeTaskImage } from "../core/api-contract";
import type {
	SharedTaskIndexingContext,
	TaskIndexingSupportExecutorSettings,
} from "../core/task-indexing-support-contract";
import type { ModelUsagePurpose } from "../model-provider-access/model-provider-usage-record";
import { recordModelProviderUsage } from "../model-provider-access/model-provider-usage-record";
import { taskIndexingTextFingerprint } from "./shared-task-indexing-context";

export interface StatelessTaskIndexingAgentRequest<T> {
	settings: TaskIndexingSupportExecutorSettings;
	instructionText: string;
	context: SharedTaskIndexingContext;
	queryText: string;
	outputSchema: z.ZodType<T>;
	timeoutMs?: number;
	abortSignal?: AbortSignal;
	modelUsagePurpose?: ModelUsagePurpose;
	questionImages?: RuntimeTaskImage[];
}
export interface StatelessTaskIndexingAgentUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	resolvedModelId: string | null;
}
export interface StatelessTaskIndexingAgentResult<T> {
	value: T;
	usage: StatelessTaskIndexingAgentUsage;
	stablePromptPrefixSha256: string;
	elapsedMs: number;
	diagnosticWarnings: string[];
}

export function assembleStatelessTaskIndexingAgentPrompt(
	request: Pick<StatelessTaskIndexingAgentRequest<unknown>, "instructionText" | "context" | "queryText">,
) {
	return {
		stablePrefix: `${request.instructionText}\n\nL1 看板任务目录（仅供查找候选）：\n${request.context.levelOneBoardTaskIndexText}\n\nL2 本项目任务 recap（不是完成证明）：\n${request.context.levelTwoProjectTaskRecapsText}`,
		query: `L3 快照后追加变化（覆盖旧快照对应字段）：\n${request.context.levelThreeAppendedChangesText}\n\nL4 本次查询：\n${request.queryText}`,
	};
}

export function buildStatelessTaskIndexingAgentLaunchArguments(input: {
	settings: TaskIndexingSupportExecutorSettings;
	stablePrefix: string;
	isolatedDirectoryPath: string;
	outputSchemaPath: string;
	outputSchemaJson: string;
	questionImageFilePaths?: string[];
}): string[] {
	const { settings } = input;
	if (settings.agentId === "claude")
		return [
			"-p",
			...(input.questionImageFilePaths?.length ? ["--input-format", "stream-json"] : []),
			"--safe-mode",
			...(Buffer.byteLength(input.stablePrefix) <= 100_000
				? ["--system-prompt", input.stablePrefix]
				: ["--system-prompt-file", join(input.isolatedDirectoryPath, "stable-model-instructions.txt")]),
			"--tools",
			"",
			"--strict-mcp-config",
			"--mcp-config",
			'{"mcpServers":{}}',
			"--disable-slash-commands",
			"--no-session-persistence",
			"--no-chrome",
			"--output-format",
			"stream-json",
			"--verbose",
			"--json-schema",
			input.outputSchemaJson,
			...(settings.modelId ? ["--model", settings.modelId] : []),
		];
	return [
		"exec",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--sandbox",
		"read-only",
		"--json",
		"--cd",
		input.isolatedDirectoryPath,
		"--output-schema",
		input.outputSchemaPath,
		...(input.questionImageFilePaths ?? []).flatMap((path) => ["--image", path]),
		"-c",
		`model_instructions_file=${JSON.stringify(join(input.isolatedDirectoryPath, "stable-model-instructions.txt"))}`,
		"-c",
		"project_doc_max_bytes=0",
		"-c",
		'developer_instructions=""',
		"-c",
		"mcp_servers={}",
		"-c",
		"skills.include_instructions=false",
		...[
			"shell_tool",
			"multi_agent",
			"multi_agent_v2",
			"apps",
			"plugins",
			"hooks",
			"memories",
			"external_agent_memory_import",
			"skill_search",
			"browser_use",
			"computer_use",
			"in_app_browser",
			"code_mode_host",
			"code_mode",
			"goals",
		].flatMap((feature) => ["-c", `features.${feature}=false`]),
		"-c",
		'web_search="disabled"',
		"-c",
		"agents.enabled=false",
		"-c",
		"apps._default.enabled=false",
		"-c",
		"features.skip_host_skill_discovery=true",
		"-c",
		"tools.update_plan.enabled=false",
		"-c",
		"tools.experimental_request_user_input.enabled=false",
		...(settings.modelId ? ["--model", settings.modelId] : []),
		"-",
	];
}

const jsonRecordSchema = z.record(z.string(), z.unknown());
const token = (record: Record<string, unknown>, key: string) =>
	typeof record[key] === "number" ? (record[key] as number) : undefined;

export function buildStatelessTaskIndexingAgentEnvironment(parentEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment = { ...parentEnvironment };
	for (const key of Object.keys(environment)) {
		const isAuthenticationSetting = key === "CLAUDE_CODE_OAUTH_TOKEN";
		if (
			!isAuthenticationSetting &&
			/^(KANBAN_|CODEX_RVF_|CLAUDE_CODE_|CLAUDECODE$|CODEX_THREAD_ID$|CODEX_SESSION_ID$)/u.test(key)
		)
			delete environment[key];
	}
	environment.CLAUDE_CODE_SAFE_MODE = "1";
	return environment;
}

export function readStatelessTaskIndexingAgentFailureDetail(stdout: string): string {
	const details: string[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		try {
			const event = jsonRecordSchema.parse(JSON.parse(line));
			if (event.type === "result" && event.is_error === true && typeof event.result === "string")
				details.push(event.result);
			if (event.type === "error" && typeof event.message === "string") details.push(event.message);
			const nested = jsonRecordSchema.safeParse(event.item ?? event.error);
			if (nested.success && typeof nested.data.message === "string") details.push(nested.data.message);
		} catch {
			/* 不把非结构化 stdout 或任务正文复制到错误信息。 */
		}
	}
	return details.join("\n").slice(-3000);
}

/** 拒绝执行工具、错误与不完整回合；结构化输出工具只是 Claude 的返回通道。 */
export function parseStatelessTaskIndexingAgentEvents(
	agentId: "claude" | "codex",
	lines: readonly string[],
): { structured: unknown; usage: StatelessTaskIndexingAgentUsage; diagnosticWarnings: string[] } {
	let structured: unknown;
	let lastCodexAgentMessage: string | null = null;
	const diagnosticWarnings: string[] = [];
	let completed = false;
	const usage: StatelessTaskIndexingAgentUsage = { resolvedModelId: null };
	for (const line of lines) {
		if (!line.trim()) continue;
		const event = jsonRecordSchema.parse(JSON.parse(line));
		if (event.type === "error" || event.type === "turn.failed") throw new Error("共享索引 Agent 返回错误回合。");
		if (agentId === "claude") {
			if (event.type === "assistant") {
				const message = jsonRecordSchema.parse(event.message);
				if (typeof message.model === "string") usage.resolvedModelId = message.model;
				for (const block of Array.isArray(message.content) ? message.content : []) {
					const content = jsonRecordSchema.parse(block);
					if (content.type === "tool_use" && content.name !== "StructuredOutput")
						throw new Error("共享索引 Agent 尝试调用工具，结果未采用。");
				}
			}
			if (event.type !== "result") continue;
			if (event.is_error === true || event.subtype !== "success") throw new Error("共享索引 Agent 未成功完成。");
			structured =
				event.structured_output ?? (typeof event.result === "string" ? JSON.parse(event.result) : undefined);
			const counts = jsonRecordSchema.parse(event.usage ?? {});
			usage.cacheReadTokens = token(counts, "cache_read_input_tokens");
			usage.cacheWriteTokens = token(counts, "cache_creation_input_tokens");
			usage.inputTokens =
				(token(counts, "input_tokens") ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
			usage.outputTokens = token(counts, "output_tokens");
			const models = Object.keys(jsonRecordSchema.parse(event.modelUsage ?? {}));
			if (models.length === 1) usage.resolvedModelId = models[0] ?? null;
			completed = true;
		} else {
			if (event.type === "item.started" || event.type === "item.completed") {
				const item = jsonRecordSchema.parse(event.item);
				if (item.type === "error") {
					const message = String(item.message ?? "未知错误");
					// 当前 Codex 把主动禁用 code-mode host 的 fail-closed 提示也编码成 error 条目；它不是模型失败或工具调用。
					if (
						message.startsWith("Code Mode is unavailable because code-mode host is disabled.") &&
						message.includes("Code mode will fail closed")
					) {
						diagnosticWarnings.push(message);
						continue;
					}
					// EXPERIMENT_NODE: skip_host_skill_discovery 仍是实验选项；保留其明确诊断，版本升级时复测是否仍能隔离全局 skills。
					if (message.startsWith("Under-development features enabled: skip_host_skill_discovery.")) {
						diagnosticWarnings.push(message);
						continue;
					}
					throw new Error(`共享索引 Agent 返回错误：${message}`);
				}
				if (!["agent_message", "reasoning"].includes(String(item.type)))
					throw new Error(`共享索引 Agent 返回不允许的工具或条目：${String(item.type)}`);
				if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string")
					lastCodexAgentMessage = item.text;
			}
			if (event.type === "turn.completed") {
				const counts = jsonRecordSchema.parse(event.usage ?? {});
				usage.inputTokens = token(counts, "input_tokens");
				usage.cacheReadTokens = token(counts, "cached_input_tokens");
				usage.outputTokens = token(counts, "output_tokens");
				completed = true;
			}
		}
	}
	if (agentId === "codex" && lastCodexAgentMessage !== null) structured = JSON.parse(lastCodexAgentMessage);
	if (!completed || structured === undefined) throw new Error("共享索引 Agent 缺少完整结构化结果。");
	return { structured, usage, diagnosticWarnings };
}

export async function executeStatelessTaskIndexingAgent<T>(
	request: StatelessTaskIndexingAgentRequest<T>,
): Promise<StatelessTaskIndexingAgentResult<T>> {
	const startedAt = Date.now();
	const prompt = assembleStatelessTaskIndexingAgentPrompt(request);
	const prefixHash = taskIndexingTextFingerprint(prompt.stablePrefix);
	// EXPERIMENT_NODE: 按 UTF-8 字节保守预检 argv 与模型输入；后续可按已解析模型的实际 context 上限细分。
	if (Buffer.byteLength(prompt.stablePrefix + prompt.query) > 1_200_000)
		throw new Error("共享任务 Context 超出执行器输入预算；未静默丢弃任务，请缩小项目或调整显式限额。");
	const directory = await mkdtemp(join(tmpdir(), "kanban-stateless-task-indexing-agent-"));
	let usage: StatelessTaskIndexingAgentUsage = { resolvedModelId: request.settings.modelId };
	let failure: string | undefined;
	try {
		const schema = JSON.stringify(z.toJSONSchema(request.outputSchema, { target: "draft-7" }));
		const schemaPath = join(directory, "structured-response-schema.json");
		await writeFile(schemaPath, schema);
		await writeFile(join(directory, "stable-model-instructions.txt"), prompt.stablePrefix);
		const questionImageFilePaths = await Promise.all(
			(request.questionImages ?? []).map(async (image, index) => {
				const extension = (
					{ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" } as Record<
						string,
						string
					>
				)[image.mimeType];
				if (!extension) throw new Error("查卡图片格式不受支持。");
				const imageFilePath = join(directory, `query-reference-image-${index}${extension}`);
				await writeFile(imageFilePath, Buffer.from(image.data, "base64"));
				return imageFilePath;
			}),
		);
		const args = buildStatelessTaskIndexingAgentLaunchArguments({
			settings: request.settings,
			stablePrefix: prompt.stablePrefix,
			isolatedDirectoryPath: directory,
			outputSchemaPath: schemaPath,
			outputSchemaJson: schema,
			questionImageFilePaths,
		});
		if (args.some((arg) => Buffer.byteLength(arg) > 100_000))
			throw new Error("共享索引执行器单个启动参数超出保守系统限额。");
		// 身份认证沿用原位置；不复制凭据，不修改 HOME/CODEX_HOME，也不继承宿主 task 行动者声明。
		const environment = buildStatelessTaskIndexingAgentEnvironment(process.env);
		const output = await new Promise<string>((resolve, reject) => {
			request.abortSignal?.throwIfAborted();
			const child = spawn(request.settings.agentId, args, {
				cwd: directory,
				env: environment,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			let stdout = "",
				stderr = "",
				stdoutByteCount = 0,
				rejected: Error | null = null;
			const stdoutDecoder = new StringDecoder("utf8");
			const stop = (error: Error) => {
				rejected ??= error;
				try {
					if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			};
			const timeout = setTimeout(
				() => stop(new Error("共享索引 Agent 调用超时，未自动重试。")),
				request.timeoutMs ?? 180_000,
			);
			const onAbort = () => stop(new Error("runtime 停止，共享索引 Agent 调用已取消。"));
			request.abortSignal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdoutByteCount += chunk.length;
				if (stdoutByteCount > 4 * 1024 * 1024) {
					stop(new Error("共享索引 Agent 输出超过预算。"));
					return;
				}
				stdout += stdoutDecoder.write(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString("utf8")).slice(-4000);
			});
			const cleanup = () => {
				clearTimeout(timeout);
				request.abortSignal?.removeEventListener("abort", onAbort);
			};
			child.on("error", (error) => {
				cleanup();
				reject(error);
			});
			child.on("close", (code) => {
				cleanup();
				stdout += stdoutDecoder.end();
				if (rejected) reject(rejected);
				else if (code !== 0)
					reject(
						new Error(
							`共享索引 Agent 退出码 ${code}：${readStatelessTaskIndexingAgentFailureDetail(stdout) || stderr || "无结构化错误详情"}`,
						),
					);
				else resolve(stdout);
			});
			child.stdin.on("error", () => {});
			child.stdin.end(
				request.settings.agentId === "claude" && request.questionImages?.length
					? `${JSON.stringify({
							type: "user",
							message: {
								role: "user",
								content: [
									{ type: "text", text: prompt.query },
									...request.questionImages.map((image) => ({
										type: "image",
										source: { type: "base64", media_type: image.mimeType, data: image.data },
									})),
								],
							},
						})}\n`
					: prompt.query,
			);
		});
		const parsed = parseStatelessTaskIndexingAgentEvents(request.settings.agentId, output.split(/\r?\n/u));
		usage = { ...parsed.usage, resolvedModelId: parsed.usage.resolvedModelId ?? request.settings.modelId };
		return {
			value: request.outputSchema.parse(parsed.structured),
			usage,
			stablePromptPrefixSha256: prefixHash,
			elapsedMs: Date.now() - startedAt,
			diagnosticWarnings: parsed.diagnosticWarnings,
		};
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		await rm(directory, { recursive: true, force: true });
		recordModelProviderUsage({
			modelUsagePurpose: request.modelUsagePurpose ?? "task_indexing_support_relation_analysis",
			modelProviderId: `headless-${request.settings.agentId}`,
			modelId: usage.resolvedModelId,
			outcome: failure ? "unavailable" : "completed",
			unavailableReason: failure,
			elapsedMs: Date.now() - startedAt,
			promptCharacterCount: prompt.stablePrefix.length + prompt.query.length,
			promptTokenCount: usage.inputTokens,
			completionTokenCount: usage.outputTokens,
			cacheReadTokenCount: usage.cacheReadTokens,
			cacheWriteTokenCount: usage.cacheWriteTokens,
			stablePromptPrefixSha256: prefixHash,
		});
	}
}
