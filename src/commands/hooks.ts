import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTRPCProxyClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { Command } from "commander";
import {
	appendHookEventToHostedSessionSpoolThroughAgentSessionPtyHost,
	type HostedSessionBindingToAgentSessionPtyHost,
	readHostedSessionBindingToAgentSessionPtyHostFromEnvironment,
} from "../agent-session-pty-host/runtime-client/hosted-session-cli-client-requests-to-agent-session-pty-host";
import type {
	RuntimeAgentNativeConversationSessionIdentity,
	RuntimeAgentRaisedToolPermissionPayload,
	RuntimeAgentRaisedUserQuestionPayload,
	RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload,
	RuntimeAgentToolCallExecutionOutcome,
	RuntimeHarnessUserPromptProcessingDirective,
	RuntimeHookCliProcessResourceUsage,
	RuntimeHookEvent,
	RuntimeHookIngestRequest,
	RuntimeHookIngestResponse,
	RuntimeMainAgentConversationContextCompactionTrigger,
	RuntimeTaskHookActivity,
} from "../core/api-contract";
import { mergeAbortSignals } from "../core/cli-process-guards";
import { buildKanbanAgentHookCommandParts } from "../core/kanban-command";
import {
	normalizeKimiNativeHookToolCallIdentity,
	resolveKimiPrimaryConversationHookEvent,
} from "../core/kimi-primary-conversation-hook-lifecycle";
import { buildKanbanRuntimeUrl, getRuntimeFetch } from "../core/runtime-endpoint";
import { buildWindowsCmdArgsArray, resolveWindowsComSpec, shouldUseWindowsCmdLaunch } from "../core/windows-cmd-launch";
import {
	type HookDeliveryFailureKind,
	recordHookDeliveryFailure,
} from "../diagnostics/hook-ingest-delivery-failure-logger";
import {
	captureNotificationSignal,
	recordNotificationSignalDecision,
} from "../notifications/notification-signal-capture";
import { parseHookRuntimeContextFromEnv } from "../terminal/hook-runtime-context";
import type { RuntimeAppRouter } from "../trpc/app-router";
import {
	extractAgentRaisedToolPermissionPayload,
	extractAgentRaisedUserQuestionPayload,
	extractAgentRaisedUserQuestionResolvedInAgentTerminalPayload,
} from "./agent-raised-decision-payload-extraction";
import {
	extractCodexUserQuestionPayload,
	extractCodexUserQuestionResolution,
	resolveCodexUserQuestionHookEvent,
} from "./codex-user-question-payload-extraction";
import {
	extractAgentNativeConversationSessionIdentityFromHookPayload,
	isCodexConversationWithoutPersistedTranscript,
	readAgentNativeConversationTranscriptPathFromHookPayload,
} from "./hook-events/agent-native-conversation-session-identity-extraction";
import { extractAgentToolCallExecutionOutcomeFromHookPayload } from "./hook-events/agent-tool-call-execution-outcome-extraction";
import {
	type CodexMappedHookEvent,
	resolveCodexRolloutFinalMessageForCwd,
	startCodexSessionWatcher,
} from "./hook-events/codex-hook-events";
import { enrichDroidReviewMetadata } from "./hook-events/droid-hook-events";
import {
	type ExplorationWorkBranchJobHookDisposition,
	resolveExplorationWorkBranchJobHookDisposition,
} from "./hook-events/exploration-work-branch-job-hook-short-circuit";
import { asRecord, normalizeWhitespace, readNestedString, readStringField } from "./hook-events/hook-utils";
import { normalizeKiroHookMetadata } from "./hook-events/kiro-hook-events";
import { extractMainAgentConversationContextCompactionFactsFromHookPayload } from "./hook-events/main-agent-conversation-context-compaction-hook-payload-extraction";

export {
	createCodexWatcherState,
	parseCodexEventLine,
	resolveCodexRolloutFinalMessageForCwd,
	startCodexSessionWatcher,
} from "./hook-events/codex-hook-events";

const VALID_EVENTS = new Set<RuntimeHookEvent>([
	"to_review",
	"to_in_progress",
	"activity",
	"agent_conversation_session_identity_observed",
	"main_agent_conversation_context_compaction_completed",
]);

interface HooksIngestArgs {
	notificationCandidateId?: string;
	event: RuntimeHookEvent;
	taskId: string;
	workspaceId: string;
	metadata?: Partial<RuntimeTaskHookActivity>;
	payload?: Record<string, unknown> | null;
	// agent 正在等你拍板时才携带的白名单 payload（二者互斥）。会话被回收后靠它重现问题。
	agentRaisedUserQuestion?: RuntimeAgentRaisedUserQuestionPayload;
	agentRaisedToolPermission?: RuntimeAgentRaisedToolPermissionPayload;
	agentRaisedUserQuestionResolvedInAgentTerminal?: RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload;
	submittedPromptText?: string;
	claudeNativeTaskListIdForPhaseGoalProjection?: string | null;
	// hook stdin 带 `agent_id` ⇔ 事件从子代理内部触发（Claude Code 只在子代理内的事件上带它）。
	hookEventFiredInsideSubagentContext?: boolean;
	// 仅压缩完成事件：hook stdin 的 `trigger`（manual / auto）派生而来；未知值或缺失时不带。
	mainAgentConversationContextCompactionTriggerReportedByHarness?: RuntimeMainAgentConversationContextCompactionTrigger;
	// 仅压缩完成事件：harness 报告的压缩后上下文大小（Kimi 的 estimatedTokenCount）；不报则不带。
	mainAgentConversationContextTokenCountAfterCompactionReportedByHarness?: number;
	// N0a：终端 agent 原生会话身份（session_id + transcript_path），每个事件都带，服务端幂等落 sidecar。
	agentNativeConversationSessionIdentity?: RuntimeAgentNativeConversationSessionIdentity;
	// 资源占用采集：工具类事件的执行结果（已截断脱敏），服务端只写 journal。
	agentToolCallExecutionOutcome?: RuntimeAgentToolCallExecutionOutcome;
}

interface HookCommandMetadataOptionValues {
	notificationCandidateId?: string;
	source?: string;
	activityText?: string;
	toolName?: string;
	finalMessage?: string;
	hookEventName?: string;
	notificationType?: string;
	metadataBase64?: string;
}

interface CodexWrapperArgs {
	realBinary: string;
	agentArgs: string[];
}

function formatError(error: unknown): string {
	if (error instanceof TRPCClientError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, label: string): Promise<T> {
	const controller = new AbortController();
	let timeoutHandle: NodeJS.Timeout | null = null;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			controller.abort();
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([run(controller.signal), timeoutPromise]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

function parseHookEvent(value: string): RuntimeHookEvent {
	if (!VALID_EVENTS.has(value as RuntimeHookEvent)) {
		throw new Error(`Invalid event "${value}". Must be one of: ${[...VALID_EVENTS].join(", ")}`);
	}
	return value as RuntimeHookEvent;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
	try {
		return asRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function parseMetadataFromOptions(options: HookCommandMetadataOptionValues): Partial<RuntimeTaskHookActivity> {
	const metadata: Partial<RuntimeTaskHookActivity> = {};
	const activityText = options.activityText;
	const toolName = options.toolName;
	const finalMessage = options.finalMessage;
	const hookEventName = options.hookEventName;
	const notificationType = options.notificationType;
	const source = options.source;

	if (activityText) {
		metadata.activityText = normalizeWhitespace(activityText);
	}
	if (toolName) {
		metadata.toolName = normalizeWhitespace(toolName);
	}
	if (finalMessage) {
		metadata.finalMessage = normalizeWhitespace(finalMessage);
	}
	if (hookEventName) {
		metadata.hookEventName = normalizeWhitespace(hookEventName);
	}
	if (notificationType) {
		metadata.notificationType = normalizeWhitespace(notificationType);
	}
	if (source) {
		metadata.source = normalizeWhitespace(source);
	}

	return metadata;
}

function parseMetadataFromBase64(encoded: string | undefined): Record<string, unknown> | null {
	if (!encoded) {
		return null;
	}
	try {
		return asRecord(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
	} catch {
		return null;
	}
}

function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> | null {
	const direct = asRecord(payload.tool_input);
	if (direct) {
		return direct;
	}
	const directCamel = asRecord(payload.toolInput);
	if (directCamel) {
		return directCamel;
	}
	const preTool = asRecord(payload.preToolUse);
	const preParams = preTool ? asRecord(preTool.parameters) : null;
	if (preParams) {
		return preParams;
	}
	const preInput = preTool ? asRecord(preTool.input) : null;
	if (preInput) {
		return preInput;
	}
	const postTool = asRecord(payload.postToolUse);
	const postParams = postTool ? asRecord(postTool.parameters) : null;
	if (postParams) {
		return postParams;
	}
	const postInput = postTool ? asRecord(postTool.input) : null;
	if (postInput) {
		return postInput;
	}
	const output = asRecord(payload.output);
	const outputArgs = output ? asRecord(output.args) : null;
	return outputArgs;
}

function describeToolOperation(toolName: string | null, toolInput: Record<string, unknown> | null): string | null {
	if (!toolName || !toolInput) {
		return null;
	}

	const command =
		readStringField(toolInput, "command") ??
		readStringField(toolInput, "cmd") ??
		readStringField(toolInput, "query") ??
		readStringField(toolInput, "description");
	if (command) {
		return `${toolName}: ${command}`;
	}

	const filePath =
		readStringField(toolInput, "file_path") ??
		readStringField(toolInput, "filePath") ??
		readStringField(toolInput, "path");
	if (filePath) {
		return `${toolName}: ${filePath}`;
	}

	return toolName;
}

function inferActivityText(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	toolName: string | null,
	finalMessage: string | null,
	notificationType: string | null,
): string | null {
	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
		: null;
	const normalizedHookEvent = hookEventName?.toLowerCase() ?? "";
	const codexType = payload ? readStringField(payload, "type") : null;
	const normalizedCodexType = codexType?.toLowerCase() ?? "";
	const toolInput = payload ? extractToolInput(payload) : null;
	const toolOperation = describeToolOperation(toolName, toolInput);

	if (normalizedCodexType === "task_started") {
		return "Working on task";
	}
	if (normalizedCodexType === "exec_command_begin") {
		return "Running command";
	}
	if (normalizedCodexType.endsWith("_approval_request")) {
		return "Waiting for approval";
	}

	if (normalizedHookEvent === "pretooluse" || normalizedHookEvent === "beforetool") {
		return toolOperation ? `Using ${toolOperation}` : "Using tool";
	}
	if (normalizedHookEvent === "posttooluse" || normalizedHookEvent === "aftertool") {
		return toolOperation ? `Completed ${toolOperation}` : "Completed tool";
	}
	if (normalizedHookEvent === "posttoolusefailure") {
		const error = payload ? readStringField(payload, "error") : null;
		if (toolOperation && error) {
			return `Failed ${toolOperation}: ${error}`;
		}
		if (toolOperation) {
			return `Failed ${toolOperation}`;
		}
		return error ? `Tool failed: ${error}` : "Tool failed";
	}
	if (normalizedHookEvent === "permissionrequest") {
		return "Waiting for approval";
	}
	if (normalizedHookEvent === "userpromptsubmit" || normalizedHookEvent === "beforeagent") {
		return "Resumed after user input";
	}
	if (
		normalizedHookEvent === "stop" ||
		normalizedHookEvent === "subagentstop" ||
		normalizedHookEvent === "afteragent"
	) {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}
	if (normalizedHookEvent === "taskcomplete") {
		return finalMessage ? `Final: ${finalMessage}` : null;
	}

	if (notificationType === "permission_prompt" || notificationType === "permission.asked") {
		return "Waiting for approval";
	}
	if (notificationType === "user_attention") {
		return null;
	}

	if (event === "to_review") {
		return null;
	}
	if (event === "to_in_progress") {
		return "Agent active";
	}
	return null;
}

export function inferHookSourceFromPayload(payload: Record<string, unknown> | null): string | null {
	const transcriptPath = payload
		? (readStringField(payload, "transcript_path") ?? readStringField(payload, "transcriptPath"))
		: null;
	const normalizedTranscriptPath = transcriptPath?.replaceAll("\\", "/").toLowerCase() ?? null;
	if (normalizedTranscriptPath?.includes("/.claude/")) {
		return "claude";
	}
	if (normalizedTranscriptPath?.includes("/.kiro/")) {
		return "kiro";
	}
	if (normalizedTranscriptPath?.includes("/.factory/")) {
		return "droid";
	}
	if (payload && readStringField(payload, "type") === "agent-turn-complete") {
		return "codex";
	}
	return null;
}

function normalizeHookMetadata(
	event: RuntimeHookEvent,
	payload: Record<string, unknown> | null,
	flagMetadata: Partial<RuntimeTaskHookActivity>,
): Partial<RuntimeTaskHookActivity> | undefined {
	const inferredSource = inferHookSourceFromPayload(payload);
	const sourceHint = flagMetadata.source ?? inferredSource;
	if (sourceHint?.toLowerCase() === "kiro") {
		const kiroMetadata = normalizeKiroHookMetadata({
			event,
			payload,
			flagMetadata,
			sourceHint,
		});
		if (kiroMetadata) {
			return kiroMetadata;
		}
	}

	const hookEventName = payload
		? (readStringField(payload, "hook_event_name") ??
			readStringField(payload, "hookEventName") ??
			readStringField(payload, "hookName"))
		: null;
	const toolName = payload
		? (readStringField(payload, "tool_name") ??
			readStringField(payload, "toolName") ??
			readNestedString(payload, ["preToolUse", "tool"]) ??
			readNestedString(payload, ["preToolUse", "toolName"]) ??
			readNestedString(payload, ["postToolUse", "tool"]) ??
			readNestedString(payload, ["postToolUse", "toolName"]) ??
			readNestedString(payload, ["input", "tool"]) ??
			readNestedString(payload, ["input", "toolName"]))
		: null;
	const notificationType = payload
		? (readStringField(payload, "notification_type") ??
			readStringField(payload, "notificationType") ??
			readNestedString(payload, ["event", "type"]) ??
			readNestedString(payload, ["notification", "event"]))
		: null;
	const finalMessage = payload
		? (readStringField(payload, "last_assistant_message") ??
			readStringField(payload, "lastAssistantMessage") ??
			readStringField(payload, "last-assistant-message") ??
			readNestedString(payload, ["taskComplete", "taskMetadata", "result"]) ??
			readNestedString(payload, ["taskComplete", "result"]))
		: null;

	const activityText = inferActivityText(event, payload, toolName, finalMessage, notificationType);
	const merged: Partial<RuntimeTaskHookActivity> = {
		source: flagMetadata.source ?? inferredSource ?? null,
		hookEventName: flagMetadata.hookEventName ?? hookEventName ?? null,
		toolName: flagMetadata.toolName ?? toolName ?? null,
		notificationType: flagMetadata.notificationType ?? notificationType ?? null,
		finalMessage: flagMetadata.finalMessage ?? (finalMessage ? normalizeWhitespace(finalMessage) : null),
		activityText: flagMetadata.activityText ?? (activityText ? normalizeWhitespace(activityText) : null),
	};

	const hasValue = Object.values(merged).some((value) => typeof value === "string" && value.trim().length > 0);
	if (!hasValue) {
		return undefined;
	}

	return merged;
}

function parseHooksIngestArgs(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
	stdinPayload: string,
): HooksIngestArgs {
	const context = parseHookRuntimeContextFromEnv();
	const flagMetadata = parseMetadataFromOptions(options);
	const payloadFromBase64 = parseMetadataFromBase64(options.metadataBase64);
	const payloadFromStdin = parseJsonObject(stdinPayload.trim());
	const payloadFromArg = payloadArg ? parseJsonObject(payloadArg) : null;
	const originalPayload = payloadFromBase64 ?? payloadFromStdin ?? payloadFromArg;
	const payload =
		(flagMetadata.source ?? inferHookSourceFromPayload(originalPayload))?.trim().toLowerCase() === "kimi"
			? normalizeKimiNativeHookToolCallIdentity(originalPayload)
			: originalPayload;
	const metadata = normalizeHookMetadata(event, payload, flagMetadata);
	const agentNativeConversationSessionIdentity = extractAgentNativeConversationSessionIdentityFromHookPayload({
		payload,
		sourceAgentId: metadata?.source ?? inferHookSourceFromPayload(payload),
	});
	const agentToolCallExecutionOutcome = extractAgentToolCallExecutionOutcomeFromHookPayload({
		payload,
		hookEventName: metadata?.hookEventName,
		toolName: metadata?.toolName,
	});
	return {
		event: resolveKimiPrimaryConversationHookEvent(
			resolveCodexUserQuestionHookEvent(event, metadata),
			metadata,
			payload,
		),
		...(agentNativeConversationSessionIdentity?.sourceAgentId === "claude" &&
		/^task(create|update|list|get)$/iu.test(metadata?.toolName ?? "") &&
		metadata?.hookEventName?.toLowerCase() === "posttooluse"
			? {
					claudeNativeTaskListIdForPhaseGoalProjection:
						process.env.CLAUDE_CODE_TASK_LIST_ID?.trim() ||
						agentNativeConversationSessionIdentity.nativeSessionId,
				}
			: {}),
		taskId: context.taskId,
		workspaceId: context.workspaceId,
		metadata,
		payload,
		...(agentNativeConversationSessionIdentity ? { agentNativeConversationSessionIdentity } : {}),
		...(agentToolCallExecutionOutcome ? { agentToolCallExecutionOutcome } : {}),
		...buildAgentRaisedDecisionPayloads(payload, metadata),
		...(["userpromptsubmit", "beforeagent"].includes(metadata?.hookEventName?.trim().toLowerCase() ?? "") && payload
			? { submittedPromptText: readStringField(payload, "prompt") ?? undefined }
			: {}),
		...(payload &&
		readStringField(payload, "agent_id") &&
		!(metadata?.source === "kimi" && readStringField(payload, "agent_id") === "main")
			? { hookEventFiredInsideSubagentContext: true }
			: {}),
		...extractMainAgentConversationContextCompactionFactsFromHookPayload(event, payload),
	};
}

// Claude 原生「等人拍板」工具的名字判定。与 core/harness-user-turn-kind-collection.ts 的
// classifyHookUserTurnKind 同源同写法（含 snake_case 容错）：那条链路把同一批工具名映射成 userTurnKind，
// 本链路把它们映射成待答决策 payload，两处必须对同一个工具给出同一个语义，否则会出现「人轴标成
// plan_review、账本却记成 tool_permission_request」这种自相矛盾。
function isClaudePlanApprovalToolName(normalizedToolName: string | null): boolean {
	return normalizedToolName === "exitplanmode" || normalizedToolName === "exit_plan_mode";
}

function isClaudeUserQuestionToolName(normalizedToolName: string | null): boolean {
	return normalizedToolName === "askuserquestion" || normalizedToolName === "ask_user_question";
}

// 只在「agent 确实停下来等人拍板」的 hook 上采集：AskUserQuestion（普通提问）与权限请求（工具授权）。
// 计划审批（ExitPlanMode）刻意**不**采集——计划审批不做 durable carry-forward，且它在 store 的
// decisionKind 枚举里根本不存在。
//
// ⚠️ 判定顺序是承重的，必须**先按 toolName 分流、再落通用权限分支**：ExitPlanMode / AskUserQuestion 的
// 那个「批准计划 / 允许提问」对话框同样会 fire PermissionRequest（与
// core/harness-user-turn-kind-collection.ts 记录的是同一条不变量：PermissionRequest 会携带
// toolName=ExitPlanMode 抵达）。若不显式分流，一次计划审批会顺着通用权限分支被写进决策账本、
// decisionKind=tool_permission_request，并在会话被回收后被 UI 当成「工具授权请求」重现——恰好绕过
// store 里「decisionKind 枚举刻意不含 plan_review」所要表达的产品契约。
export function buildAgentRaisedDecisionPayloads(
	payload: Record<string, unknown> | null,
	metadata: Partial<RuntimeTaskHookActivity> | undefined,
): {
	agentRaisedUserQuestion?: RuntimeAgentRaisedUserQuestionPayload;
	agentRaisedToolPermission?: RuntimeAgentRaisedToolPermissionPayload;
	agentRaisedUserQuestionResolvedInAgentTerminal?: RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload;
} {
	if (!payload) {
		return {};
	}
	const toolUseId =
		readStringField(payload, "tool_use_id") ??
		readStringField(payload, "toolUseId") ??
		readNestedString(payload, ["preToolUse", "toolUseId"]);
	const toolName = metadata?.toolName ?? null;
	const normalizedToolName = toolName?.trim().toLowerCase() ?? null;
	const hookEventName = metadata?.hookEventName?.trim().toLowerCase() ?? null;
	// Kimi 本次只补原生终端的交互状态；它的选择器尚无安全的面板答案投递，不登记可作答表单。
	if (metadata?.source?.trim().toLowerCase() === "kimi") {
		return {};
	}
	if (metadata?.source === "codex" && toolName === "request_user_input" && toolUseId) {
		const question = extractCodexUserQuestionPayload({
			callId: toolUseId,
			toolInput: extractToolInput(payload),
			...(typeof payload.session_id === "string" ? { nativeConversationSessionId: payload.session_id } : {}),
		});
		if (!question) return {};
		if (hookEventName === "pretooluse") return { agentRaisedUserQuestion: question };
		if (hookEventName === "posttooluse")
			return {
				agentRaisedUserQuestionResolvedInAgentTerminal: extractCodexUserQuestionResolution({
					callId: toolUseId,
					payload: question,
					toolResponse: payload.tool_response,
				}),
			};
		return {};
	}
	if (isClaudeUserQuestionToolName(normalizedToolName)) {
		// 同一次 AskUserQuestion 会先后经过三个 hook，各自只承担一件事：
		//   - PreToolUse：提问的那一刻，落 durable 记录（唯一的提问采集点）；
		//   - PermissionRequest：「允许提问」对话框。它的 stdin **不带 tool_use_id**，若也采集，问题正文
		//     派生出的第二个 decisionId 会在 1–2 秒后把刚落库的那条顶成 superseded——实测每次提问都稳定
		//     落两条，面板持有的旧 id 随即 answer/dismiss 全部失败。故此处既不记提问、也不记工具授权；
		//   - PostToolUse / PostToolUseFailure：用户已在终端里作答或拒答，带回结局让账本了结这个问题。
		// hookEventName 缺失（非 Claude hook stdin 的调用路径）时保持旧行为：按提问采集。
		if (hookEventName === "posttooluse" || hookEventName === "posttoolusefailure") {
			const resolution = extractAgentRaisedUserQuestionResolvedInAgentTerminalPayload({
				toolUseId,
				toolInput: extractToolInput(payload),
				toolResponse: payload.tool_response ?? payload.toolResponse ?? null,
				toolExecutionFailed: hookEventName === "posttoolusefailure",
			});
			return resolution ? { agentRaisedUserQuestionResolvedInAgentTerminal: resolution } : {};
		}
		if (hookEventName !== null && hookEventName !== "pretooluse") {
			return {};
		}
		const question = extractAgentRaisedUserQuestionPayload({ toolUseId, toolInput: extractToolInput(payload) });
		return question ? { agentRaisedUserQuestion: question } : {};
	}
	// 计划审批：无论以 PreToolUse 还是 PermissionRequest 形态抵达，一律不采集（终止分流，绝不下落）。
	if (isClaudePlanApprovalToolName(normalizedToolName)) {
		return {};
	}
	const notificationType = metadata?.notificationType?.toLowerCase() ?? null;
	if (hookEventName === "permissionrequest" || notificationType === "permission_prompt") {
		const permission = extractAgentRaisedToolPermissionPayload({
			toolUseId,
			toolName,
			toolInputSummary: metadata?.toolInputSummary ?? null,
		});
		return permission ? { agentRaisedToolPermission: permission } : {};
	}
	return {};
}

// F2：单次投递的客户端超时（ms）。env 可调（过度指定命名），默认略宽于旧硬编码 3000——F1 落地后
// 服务端响应已降到亚秒级，这层超时只作上限兜底，留出余量给冷启动 manager 加载等慢路径。
const DEFAULT_HOOK_INGEST_TIMEOUT_MS = 3500;
// F2：投递最多尝试次数（含首次）。有界，使 codex 路径最坏总耗时落在 CODEX_HOOK_TIMEOUT_SECONDS（8s）
// 窗口内、不被 codex 先回收 hook 进程。按会话是否有 agent session PTY host 绑定分两条预算（默认值下）：
//   - 无 host 绑定：MAX_ATTEMPTS × timeoutMs + backoff = 2 × 3500 + 250 = 7250ms，走完重试即放弃。
//   - 有 host 绑定：任何传输失败都不重试（见 buildHookIngestStopRetryingAfterTransportErrorPredicateForHostedSessionBinding），
//     最坏 = 1 × timeoutMs + spool 期限 = 3500 + 1500（HOOK_SPOOL_APPEND_RESPONSE_DEADLINE_MS）= 5000ms。
//     若照样重试，最坏会变成 2 × 3500 + 250 + 1500 = 8750ms，spool 确认前 hook 进程就可能被回收。
// 2 次 = 首投 + 1 次重试；F1 落地后首投几乎必中，这次重试是给瞬时尖刺（daemon 忙 / .git/index.lock
// 争用 / 短暂不可达）的兜底。env 抬高 KANBAN_HOOK_INGEST_TIMEOUT_MS 时预算随之变大，由调整者自行负责。
const HOOK_INGEST_MAX_ATTEMPTS = 2;
const HOOK_INGEST_RETRY_BACKOFF_MS = 250;

// 有 host 绑定时：任何传输失败（拒连、超时、挂起、连接重置）都立即停止重试，转去存 host 的 spool。
// 不必靠重试兜底：spool 里的请求带同一个 hookEventDeliveryIdempotencyKey，直投若其实已被服务端应用
// （例如超时只是响应慢），重放时服务端按幂等 key 识别、不会重复应用。无 host 绑定时返回 undefined，
// 保持原有的有界重试。
export function buildHookIngestStopRetryingAfterTransportErrorPredicateForHostedSessionBinding(
	hostedSessionBinding: HostedSessionBindingToAgentSessionPtyHost | null,
): ((transportError: unknown) => boolean) | undefined {
	if (hostedSessionBinding === null) {
		return undefined;
	}
	return () => true;
}

function resolveHookIngestTimeoutMs(): number {
	const raw = process.env.KANBAN_HOOK_INGEST_TIMEOUT_MS;
	if (raw === undefined) {
		return DEFAULT_HOOK_INGEST_TIMEOUT_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_HOOK_INGEST_TIMEOUT_MS;
	}
	return parsed;
}

// F2 核心：把「有界重试 + 传输/业务失败分流」抽成纯函数（注入 mutate + 回调），使单测能在不起真实
// tRPC/网络的前提下锁住行为。分流判据天然干净：
//   - mutate 成功 resolve（HTTP 200，body 带逻辑结果）→ 看 .ok。{ok:false} 是 daemon **可达**但逻辑拒绝
//     （workspace/task not found 等），立即按 "rejected" 记录并抛，**不重试**；携带恢复 block 时保留
//     失败响应交给调用方序列化，不能让普通错误退出丢掉拦截指令。
//   - mutate / withTimeout **抛出** → 传输层故障（超时 / daemon 不可达 / 锁争用）→ 可重试；耗尽后按
//     "transport" 记录并抛。
// onFinalFailure 仅在「最终放弃」时触发一次（中途重试不触发），由调用方接 F3 的丢投记录。
export async function deliverHookIngestWithRetry(
	mutate: (signal: AbortSignal) => Promise<RuntimeHookIngestResponse>,
	options: {
		timeoutMs: number;
		maxAttempts: number;
		backoffMs: number;
		// 返回 true：这次传输失败不再重试，直接按最终失败处理（例如有 host spool 可存，存进去比再等一轮直投更稳）。
		shouldStopRetryingAfterTransportError?: (transportError: unknown) => boolean;
		onFinalFailure?: (info: {
			attempts: number;
			failureKind: HookDeliveryFailureKind;
			error: unknown;
		}) => Promise<void> | void;
	},
): Promise<RuntimeHookIngestResponse> {
	let lastTransportError: unknown = null;
	for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
		let ingestResponse: RuntimeHookIngestResponse;
		try {
			ingestResponse = await withTimeout((signal) => mutate(signal), options.timeoutMs, "kanban hooks ingest");
		} catch (transportError) {
			lastTransportError = transportError;
			if (
				attempt < options.maxAttempts &&
				options.shouldStopRetryingAfterTransportError?.(transportError) !== true
			) {
				await delay(options.backoffMs);
				continue;
			}
			await options.onFinalFailure?.({ attempts: attempt, failureKind: "transport", error: transportError });
			throw transportError;
		}
		if (ingestResponse.ok === false) {
			const businessError = new Error(ingestResponse.error ?? "Hook ingest failed");
			await options.onFinalFailure?.({ attempts: attempt, failureKind: "rejected", error: businessError });
			// 落盘失败必须上报，但不能丢掉恢复守卫的 block，让 Claude 因普通错误退出而 fail-open。
			if (
				ingestResponse.harnessUserPromptProcessingDirective?.processingDecision ===
				"block_and_defer_until_explicit_user_input"
			) {
				return ingestResponse;
			}
			throw businessError;
		}
		return ingestResponse;
	}
	// 不可达（循环每轮非 return 即 throw）；满足 TS 控制流分析的兜底。
	throw lastTransportError instanceof Error ? lastTransportError : new Error("kanban hooks ingest failed");
}

// F3：仅生命周期事件（非 activity）的最终失败才落丢投记录——activity 纯元数据、不改看板列，
// daemon 不可达时高频活动事件不该刷爆记录文件。
function recordIngestDropForLifecycleEvent(
	args: HooksIngestArgs,
	attempts: number,
	failureKind: HookDeliveryFailureKind,
	error: unknown,
): Promise<void> {
	if (args.event === "activity") {
		return Promise.resolve();
	}
	return recordHookDeliveryFailure({
		event: args.event,
		taskId: args.taskId,
		workspaceId: args.workspaceId,
		source: args.metadata?.source ?? null,
		attempts,
		failureKind,
		error: formatError(error),
	});
}

// hooks CLI 进程自身到「这一次发送」为止的开销。maxRSS 的峰值主要来自模块加载；发送之后那一小段测不到。
function captureHookCliProcessResourceUsage(hookIngestDeliveryAttempt: number): RuntimeHookCliProcessResourceUsage {
	const resourceUsage = process.resourceUsage();
	return {
		lifetimeMaximumResidentSetSizeKibibytes: resourceUsage.maxRSS,
		cumulativeUserCpuTimeSeconds: resourceUsage.userCPUTime / 1e6,
		cumulativeSystemCpuTimeSeconds: resourceUsage.systemCPUTime / 1e6,
		hookCliProcessUptimeMs: Math.round(process.uptime() * 1000),
		hookIngestDeliveryAttempt: Math.max(1, hookIngestDeliveryAttempt),
	};
}

// 一次 hooks CLI 调用的请求体：直投与存进 host spool 用同一份，服务端按同一个幂等 key 只应用一次。
function buildHookIngestRequest(
	args: HooksIngestArgs,
	hookEventCapturedAtEpochMs: number,
	hookEventDeliveryIdempotencyKey: string,
	hookIngestDeliveryAttempt: number,
): RuntimeHookIngestRequest {
	return {
		notificationCandidateId: args.notificationCandidateId,
		taskId: args.taskId,
		workspaceId: args.workspaceId,
		event: args.event,
		metadata: args.metadata,
		...(args.claudeNativeTaskListIdForPhaseGoalProjection !== undefined
			? { claudeNativeTaskListIdForPhaseGoalProjection: args.claudeNativeTaskListIdForPhaseGoalProjection }
			: {}),
		...(args.agentRaisedUserQuestion ? { agentRaisedUserQuestion: args.agentRaisedUserQuestion } : {}),
		...(args.agentRaisedToolPermission ? { agentRaisedToolPermission: args.agentRaisedToolPermission } : {}),
		...(args.agentRaisedUserQuestionResolvedInAgentTerminal
			? { agentRaisedUserQuestionResolvedInAgentTerminal: args.agentRaisedUserQuestionResolvedInAgentTerminal }
			: {}),
		...(args.submittedPromptText !== undefined ? { submittedPromptText: args.submittedPromptText } : {}),
		...(args.hookEventFiredInsideSubagentContext
			? { hookEventFiredInsideSubagentContext: args.hookEventFiredInsideSubagentContext }
			: {}),
		...(args.mainAgentConversationContextCompactionTriggerReportedByHarness
			? {
					mainAgentConversationContextCompactionTriggerReportedByHarness:
						args.mainAgentConversationContextCompactionTriggerReportedByHarness,
				}
			: {}),
		...(args.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness !== undefined
			? {
					mainAgentConversationContextTokenCountAfterCompactionReportedByHarness:
						args.mainAgentConversationContextTokenCountAfterCompactionReportedByHarness,
				}
			: {}),
		...(args.agentNativeConversationSessionIdentity
			? { agentNativeConversationSessionIdentity: args.agentNativeConversationSessionIdentity }
			: {}),
		...(args.agentToolCallExecutionOutcome
			? { agentToolCallExecutionOutcome: args.agentToolCallExecutionOutcome }
			: {}),
		// 每次发送前重新取值：重试之间的等待本身也是这个 hook 进程的开销。
		hookCliProcessResourceUsage: captureHookCliProcessResourceUsage(hookIngestDeliveryAttempt),
		hookEventCapturedAtEpochMs,
		hookEventDeliveryIdempotencyKey,
	};
}

// spool 里相邻的同类条目可合并为最后一条：只有不带任何决策 / 提交载荷的 activity。它推进的「对话上次推进」
// 与 Cache warm 起点都是单调量，中间值没有信息；生命周期事件与带载荷的事件一律逐条保留。
export function isHookEventCoalescibleInAgentSessionPtyHostSpool(args: HooksIngestArgs): boolean {
	return (
		args.event === "activity" &&
		args.agentRaisedUserQuestion === undefined &&
		args.agentRaisedToolPermission === undefined &&
		args.agentRaisedUserQuestionResolvedInAgentTerminal === undefined &&
		args.claudeNativeTaskListIdForPhaseGoalProjection === undefined &&
		args.submittedPromptText === undefined
	);
}

async function ingestHookEvent(args: HooksIngestArgs): Promise<RuntimeHookIngestResponse> {
	// 本进程启动那一刻即事件的捕获时刻（hook 进程由 agent 在事件发生时拉起）。runtime 缺席、事件晚送达时，
	// 服务端按它记停止 / 开始 / 对话推进等领域时刻。
	const hookEventCapturedAtEpochMs = Math.floor(performance.timeOrigin);
	// 一次调用一个：下面的直投（无 host 绑定时含一次重试）与 spool 复用它，服务端据此只应用一次。
	const hookEventDeliveryIdempotencyKey = randomUUID();
	// 会话由 agent session PTY host 托管时才有：runtime 不可达就把事件存进 host 的 spool，等 runtime 回来重放。
	const hostedSessionBinding = readHostedSessionBindingToAgentSessionPtyHostFromEnvironment(process.env);
	let attempt = 0;
	let finalTransportFailure: { attempts: number; error: unknown } | null = null;
	let response: RuntimeHookIngestResponse;
	try {
		response = await deliverHookIngestWithRetry(
			async (signal) => {
				await recordNotificationSignalDecision(args.notificationCandidateId, "hook_transport_attempt_started", {
					attempt: ++attempt,
				});
				const trpcClient = createTRPCProxyClient<RuntimeAppRouter>({
					links: [
						httpBatchLink({
							url: buildKanbanRuntimeUrl("/api/trpc"),
							maxItems: 1,
							fetch: async (url, options) => {
								const runtimeFetch = await getRuntimeFetch();
								const mergedSignal = mergeAbortSignals(signal, options?.signal);
								return runtimeFetch(url, { ...options, signal: mergedSignal });
							},
						}),
					],
				});
				return await trpcClient.hooks.ingest.mutate(
					buildHookIngestRequest(args, hookEventCapturedAtEpochMs, hookEventDeliveryIdempotencyKey, attempt),
				);
			},
			{
				timeoutMs: resolveHookIngestTimeoutMs(),
				maxAttempts: HOOK_INGEST_MAX_ATTEMPTS,
				backoffMs: HOOK_INGEST_RETRY_BACKOFF_MS,
				// 有 spool 可存时，任何传输失败都不再等一轮重试：立即存（预算见 HOOK_INGEST_MAX_ATTEMPTS）。
				shouldStopRetryingAfterTransportError:
					buildHookIngestStopRetryingAfterTransportErrorPredicateForHostedSessionBinding(hostedSessionBinding),
				onFinalFailure: async ({ attempts, failureKind, error }) => {
					if (failureKind === "transport" && hostedSessionBinding) {
						// 先试 spool，存不进去再记丢投（见下）。
						finalTransportFailure = { attempts, error };
						return;
					}
					await recordNotificationSignalDecision(
						args.notificationCandidateId,
						"hook_transport_failed",
						{ attempts, failureKind },
						true,
					);
					await recordIngestDropForLifecycleEvent(args, attempts, failureKind, error);
				},
			},
		);
	} catch (deliveryError) {
		const transportFailure = finalTransportFailure as { attempts: number; error: unknown } | null;
		if (transportFailure === null || hostedSessionBinding === null) {
			throw deliveryError;
		}
		return await spoolHookEventIntoAgentSessionPtyHostAfterTransportFailure({
			args,
			hostedSessionBinding,
			spooledHookIngestRequest: buildHookIngestRequest(
				args,
				hookEventCapturedAtEpochMs,
				hookEventDeliveryIdempotencyKey,
				transportFailure.attempts + 1,
			),
			transportFailure,
		});
	}
	if (response.ok) {
		await recordNotificationSignalDecision(args.notificationCandidateId, "hook_transport_accepted", {
			attempts: attempt,
		});
	}
	return response;
}

// 存进 spool 即视为送达：hook 退出码 0、没有 harness 指令（spool 的事件回不了指令，只能 fail-open）。
// 存不进去（旧 host 不认 / host 也不在 / 会话已不在 host 里 / spool 满）才按原样记丢投并报错。
async function spoolHookEventIntoAgentSessionPtyHostAfterTransportFailure(input: {
	args: HooksIngestArgs;
	hostedSessionBinding: HostedSessionBindingToAgentSessionPtyHost;
	spooledHookIngestRequest: RuntimeHookIngestRequest;
	transportFailure: { attempts: number; error: unknown };
}): Promise<RuntimeHookIngestResponse> {
	const { args, transportFailure } = input;
	const spoolOutcome = await appendHookEventToHostedSessionSpoolThroughAgentSessionPtyHost({
		hostedSessionBinding: input.hostedSessionBinding,
		spooledHookIngestRequest: input.spooledHookIngestRequest,
		coalescibleWithAdjacentCoalescibleHookSpoolEntry: isHookEventCoalescibleInAgentSessionPtyHostSpool(args),
	});
	if (spoolOutcome.kind === "spooled") {
		await recordNotificationSignalDecision(
			args.notificationCandidateId,
			"hook_transport_spooled_to_agent_session_pty_host",
			{
				attempts: transportFailure.attempts,
				hookSpoolEntrySequenceNumber: spoolOutcome.hookSpoolEntrySequenceNumber,
			},
		);
		return { ok: true };
	}
	await recordNotificationSignalDecision(
		args.notificationCandidateId,
		"hook_transport_failed",
		{
			attempts: transportFailure.attempts,
			failureKind: "transport",
			agentSessionPtyHostSpoolFailure:
				spoolOutcome.kind === "spool_rejected" ? spoolOutcome.reason : spoolOutcome.failureMessage,
		},
		true,
	);
	await recordIngestDropForLifecycleEvent(args, transportFailure.attempts, "transport", transportFailure.error);
	throw transportFailure.error;
}

export function serializeHarnessUserPromptProcessingDirective(
	directive: RuntimeHarnessUserPromptProcessingDirective | undefined,
): string | null {
	if (!directive) {
		return null;
	}
	if (directive.processingDecision === "block_and_defer_until_explicit_user_input") {
		return JSON.stringify({
			decision: "block",
			reason:
				directive.userVisibleReason ??
				"Kanban blocked a harness-generated prompt while restoring the prior conversation.",
		});
	}
	if (!directive.additionalContextMarkdown) {
		return null;
	}
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: directive.additionalContextMarkdown,
		},
	});
}

function spawnBackgroundKanban(args: string[]): void {
	try {
		const commandParts = buildKanbanAgentHookCommandParts(args[0] === "hooks" ? args.slice(1) : args);
		const child = spawn(commandParts[0], commandParts.slice(1), {
			detached: false,
			stdio: "ignore",
			env: process.env,
		});
		child.unref();
	} catch {
		// Best effort: hook notification failures should never block agents.
	}
}

function appendMetadataFlags(args: string[], metadata?: Partial<RuntimeTaskHookActivity>): string[] {
	if (!metadata) {
		return args;
	}
	if (metadata.source) {
		args.push("--source", metadata.source);
	}
	if (metadata.activityText) {
		args.push("--activity-text", metadata.activityText);
	}
	if (metadata.toolName) {
		args.push("--tool-name", metadata.toolName);
	}
	if (metadata.finalMessage) {
		args.push("--final-message", metadata.finalMessage);
	}
	if (metadata.hookEventName) {
		args.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata.notificationType) {
		args.push("--notification-type", metadata.notificationType);
	}
	return args;
}

function notifyCodexSessionWatcherEvent(mapped: CodexMappedHookEvent): void {
	spawnBackgroundKanban(appendMetadataFlags(["hooks", "notify", "--event", mapped.event], mapped.metadata));
}

async function enrichCodexReviewMetadata(args: HooksIngestArgs, cwd: string): Promise<HooksIngestArgs> {
	if (args.event !== "to_review" || args.agentRaisedUserQuestion) {
		return args;
	}
	const metadata = args.metadata ?? {};
	const source = metadata.source?.toLowerCase();
	if (source !== "codex") {
		return args;
	}
	const existingFinalMessage =
		typeof metadata.finalMessage === "string" && metadata.finalMessage.trim().length > 0
			? metadata.finalMessage
			: null;
	if (existingFinalMessage) {
		return {
			...args,
			metadata: {
				...metadata,
				activityText: metadata.activityText ?? `Final: ${existingFinalMessage}`,
			},
		};
	}

	const fallbackFinalMessage = await resolveCodexRolloutFinalMessageForCwd(cwd);
	if (!fallbackFinalMessage) {
		return {
			...args,
			metadata: {
				...metadata,
				activityText: metadata.activityText ?? "Waiting for review",
			},
		};
	}

	return {
		...args,
		metadata: {
			...metadata,
			finalMessage: fallbackFinalMessage,
			activityText: metadata.activityText ?? `Final: ${fallbackFinalMessage}`,
		},
	};
}

// exploration thread graph 维护作业分身的 hook 短路（判定与理由见 exploration-work-branch-job-hook-short-circuit.ts）。
// 必须在 parseHooksIngestArgs 之前调用：作业进程未必带 KANBAN_HOOK_* 身份 env。
function resolveExplorationWorkBranchJobHookDispositionForStdin(
	stdinPayload: string,
	optionHookEventName: string | undefined,
): ExplorationWorkBranchJobHookDisposition {
	const payload = parseJsonObject(stdinPayload.trim());
	const hookEventName =
		optionHookEventName ??
		(payload
			? (readStringField(payload, "hook_event_name") ??
				readStringField(payload, "hookEventName") ??
				readStringField(payload, "hookName"))
			: null);
	return resolveExplorationWorkBranchJobHookDisposition({ hookEventName });
}

async function runHooksNotify(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	let notificationCandidateId: string | null = null;
	try {
		const stdinPayload = await readStdinText();
		notificationCandidateId = await captureRawNotificationHook(event, stdinPayload, payloadArg, options);
		const jobDisposition = resolveExplorationWorkBranchJobHookDispositionForStdin(
			stdinPayload,
			options.hookEventName,
		);
		if (jobDisposition.kind !== "ingest_normally") {
			await recordNotificationSignalDecision(
				notificationCandidateId,
				"exploration_job_hook_excluded",
				{ disposition: jobDisposition.kind },
				true,
			);
			if (jobDisposition.kind === "short_circuit_with_pre_tool_use_deny") {
				process.stdout.write(`${jobDisposition.stdoutJson}\n`);
			}
			return;
		}
		const parsedArgs = {
			...parseHooksIngestArgs(event, options, payloadArg, stdinPayload),
			notificationCandidateId: notificationCandidateId ?? undefined,
		};
		const codexEnrichedArgs = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		const args = await enrichDroidReviewMetadata(codexEnrichedArgs);
		await ingestHookEvent(args);
	} catch {
		await recordNotificationSignalDecision(notificationCandidateId, "hook_cli_processing_failed", {}, true);
	}
}

async function readStdinText(): Promise<string> {
	if (process.stdin.isTTY) {
		return "";
	}
	const chunks: string[] = [];
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return chunks.join("");
}

function mapGeminiHookEvent(eventName: string): RuntimeHookEvent | null {
	if (eventName === "AfterAgent") {
		return "to_review";
	}
	if (eventName === "BeforeAgent") {
		return "to_in_progress";
	}
	if (eventName === "AfterTool" || eventName === "BeforeTool" || eventName === "Notification") {
		return "activity";
	}
	return null;
}

async function runCodexHookSubcommand(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	let payload = "";
	try {
		payload = await readStdinText();
	} catch {
		payload = "";
	}
	// 先隔离，再归档 / enrich / ingest：后台记忆作业连活动、通知与 checkpoint 都不能冒充主会话。
	const hookPayload =
		parseMetadataFromBase64(options.metadataBase64) ??
		parseJsonObject(payload.trim()) ??
		(payloadArg ? parseJsonObject(payloadArg) : null);
	if (
		isCodexConversationWithoutPersistedTranscript({
			sourceAgentId: options.source ?? "codex",
			transcriptPath: readAgentNativeConversationTranscriptPathFromHookPayload(hookPayload),
		})
	) {
		process.stdout.write("{}\n");
		return;
	}

	const notificationCandidateId = await captureRawNotificationHook(event, payload, payloadArg, options);
	const jobDisposition = resolveExplorationWorkBranchJobHookDispositionForStdin(payload, options.hookEventName);
	if (jobDisposition.kind !== "ingest_normally") {
		await recordNotificationSignalDecision(
			notificationCandidateId,
			"exploration_job_hook_excluded",
			{ disposition: jobDisposition.kind },
			true,
		);
		process.stdout.write(
			`${jobDisposition.kind === "short_circuit_with_pre_tool_use_deny" ? jobDisposition.stdoutJson : "{}"}\n`,
		);
		return;
	}

	process.stdout.write("{}\n");

	try {
		const parsedArgs = {
			...parseHooksIngestArgs(event, options, payloadArg, payload),
			notificationCandidateId: notificationCandidateId ?? undefined,
		};
		const codexEnrichedArgs = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		await ingestHookEvent(codexEnrichedArgs);
	} catch {
		await recordNotificationSignalDecision(notificationCandidateId, "hook_cli_processing_failed", {}, true);
	}
}

async function runGeminiHookSubcommand(): Promise<void> {
	let payload = "";
	try {
		payload = await readStdinText();
	} catch {
		payload = "";
	}

	const notificationCandidateId = await captureRawNotificationHook("activity", payload, undefined, {
		source: "gemini",
	});
	if (resolveExplorationWorkBranchJobHookDispositionForStdin(payload, undefined).kind !== "ingest_normally") {
		await recordNotificationSignalDecision(notificationCandidateId, "exploration_job_hook_excluded", {}, true);
		process.stdout.write("{}\n");
		return;
	}

	let hookEventName = "";
	let payloadRecord: Record<string, unknown> | null = null;
	try {
		const parsed = JSON.parse(payload || "{}") as { hook_event_name?: unknown };
		payloadRecord = asRecord(parsed);
		hookEventName =
			typeof parsed.hook_event_name === "string"
				? parsed.hook_event_name
				: payloadRecord && typeof payloadRecord.hookEventName === "string"
					? payloadRecord.hookEventName
					: "";
	} catch {
		hookEventName = "";
		payloadRecord = null;
	}

	process.stdout.write("{}\n");

	const mappedEvent = mapGeminiHookEvent(hookEventName);
	if (!mappedEvent) {
		return;
	}
	const metadata = normalizeHookMetadata(mappedEvent, payloadRecord, {
		source: "gemini",
		hookEventName: hookEventName || undefined,
	});
	spawnBackgroundKanban(
		appendMetadataFlags(
			[
				"hooks",
				"notify",
				"--event",
				mappedEvent,
				...(notificationCandidateId ? ["--notification-candidate-id", notificationCandidateId] : []),
			],
			metadata,
		),
	);
}

export function buildCodexWrapperChildArgs(agentArgs: string[]): string[] {
	return [...agentArgs];
}

export function buildCodexWrapperSpawn(
	realBinary: string,
	agentArgs: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { binary: string; args: string[] } {
	const childArgs = buildCodexWrapperChildArgs(agentArgs);
	if (!shouldUseWindowsCmdLaunch(realBinary, platform, env)) {
		return {
			binary: realBinary,
			args: childArgs,
		};
	}
	return {
		binary: resolveWindowsComSpec(env),
		args: buildWindowsCmdArgsArray(realBinary, childArgs),
	};
}

async function runCodexWrapperSubcommand(wrapperArgs: CodexWrapperArgs): Promise<void> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	let shuttingDown = false;
	let stopWatcher: () => Promise<void> = async () => {};
	let watcherStartPromise: Promise<void> | null = null;

	let shouldWatchSessionLog = false;
	try {
		parseHookRuntimeContextFromEnv(childEnv);
		shouldWatchSessionLog = true;
	} catch {
		shouldWatchSessionLog = false;
	}

	if (shouldWatchSessionLog) {
		childEnv.CODEX_TUI_RECORD_SESSION = "1";
		if (!childEnv.CODEX_TUI_SESSION_LOG_PATH) {
			childEnv.CODEX_TUI_SESSION_LOG_PATH = join(
				tmpdir(),
				`kanban-codex-session-${process.pid}_${Date.now()}.jsonl`,
			);
		}
		const sessionLogPath = childEnv.CODEX_TUI_SESSION_LOG_PATH;
		if (sessionLogPath) {
			watcherStartPromise = (async () => {
				const startedStopWatcher = await startCodexSessionWatcher(
					sessionLogPath,
					notifyCodexSessionWatcherEvent,
					undefined,
					{
						cwd: process.cwd(),
					},
				);
				if (shuttingDown) {
					await startedStopWatcher();
					return;
				}
				stopWatcher = startedStopWatcher;
			})().catch(() => {
				// Best effort only.
			});
		}
	}

	const childLaunch = buildCodexWrapperSpawn(wrapperArgs.realBinary, wrapperArgs.agentArgs);
	const child = spawn(childLaunch.binary, childLaunch.args, {
		stdio: "inherit",
		env: childEnv,
	});

	const forwardSignal = (signal: NodeJS.Signals) => {
		if (!child.killed) {
			child.kill(signal);
		}
	};

	const onSigint = () => {
		forwardSignal("SIGINT");
	};
	const onSigterm = () => {
		forwardSignal("SIGTERM");
	};

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	const cleanup = async () => {
		shuttingDown = true;
		await watcherStartPromise;
		await stopWatcher();
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	};

	await new Promise<void>((resolve) => {
		let finished = false;
		const finish = (exitCode: number) => {
			if (finished) {
				return;
			}
			finished = true;
			void (async () => {
				await cleanup();
				process.exitCode = exitCode;
				resolve();
			})();
		};

		child.on("error", () => {
			finish(1);
		});
		child.on("exit", (code) => {
			finish(code ?? 1);
		});
	});
}

async function runHooksIngest(
	event: RuntimeHookEvent,
	options: HookCommandMetadataOptionValues,
	payloadArg: string | undefined,
): Promise<void> {
	let args: HooksIngestArgs;
	try {
		const stdinPayload = await readStdinText();
		const notificationCandidateId = await captureRawNotificationHook(event, stdinPayload, payloadArg, options);
		const jobDisposition = resolveExplorationWorkBranchJobHookDispositionForStdin(
			stdinPayload,
			options.hookEventName,
		);
		if (jobDisposition.kind !== "ingest_normally") {
			await recordNotificationSignalDecision(
				notificationCandidateId,
				"exploration_job_hook_excluded",
				{ disposition: jobDisposition.kind },
				true,
			);
			if (jobDisposition.kind === "short_circuit_with_pre_tool_use_deny") {
				process.stdout.write(`${jobDisposition.stdoutJson}\n`);
			}
			return;
		}
		const parsedArgs = {
			...parseHooksIngestArgs(event, options, payloadArg, stdinPayload),
			notificationCandidateId: notificationCandidateId ?? undefined,
		};
		const codexEnrichedArgs = await enrichCodexReviewMetadata(parsedArgs, process.cwd());
		args = await enrichDroidReviewMetadata(codexEnrichedArgs);
	} catch (error) {
		process.stderr.write(`kanban hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
		return;
	}

	try {
		const response = await ingestHookEvent(args);
		const serializedDirective = serializeHarnessUserPromptProcessingDirective(
			response.harnessUserPromptProcessingDirective,
		);
		if (serializedDirective) {
			process.stdout.write(`${serializedDirective}\n`);
		}
	} catch (error) {
		process.stderr.write(`kanban hooks ingest: ${formatError(error)}\n`);
		process.exitCode = 1;
	}
}

export function registerHooksCommand(program: Command): void {
	const hooks = program.command("hooks").description("Runtime hook helpers for agent integrations.");

	hooks
		.command("ingest [payload]")
		.description("Ingest hook event into Kanban runtime.")
		.requiredOption(
			"--event <event>",
			"Event: to_review | to_in_progress | activity | agent_conversation_session_identity_observed | main_agent_conversation_context_compaction_completed.",
			parseHookEvent,
		)
		.option("--notification-candidate-id <id>", "Internal notification archive identity.")
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runHooksIngest(options.event, options, payload);
			},
		);

	hooks
		.command("notify [payload]")
		.description("Best-effort hook ingest that never throws.")
		.requiredOption(
			"--event <event>",
			"Event: to_review | to_in_progress | activity | agent_conversation_session_identity_observed | main_agent_conversation_context_compaction_completed.",
			parseHookEvent,
		)
		.option("--notification-candidate-id <id>", "Internal notification archive identity.")
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runHooksNotify(options.event, options, payload);
			},
		);

	hooks
		.command("gemini-hook")
		.description("Gemini hook entrypoint.")
		.action(async () => {
			await runGeminiHookSubcommand();
		});

	hooks
		.command("codex-hook [payload]")
		.description("Codex hook entrypoint.")
		.requiredOption(
			"--event <event>",
			"Event: to_review | to_in_progress | activity | agent_conversation_session_identity_observed | main_agent_conversation_context_compaction_completed.",
			parseHookEvent,
		)
		.option("--notification-candidate-id <id>", "Internal notification archive identity.")
		.option("--source <source>", "Hook source.")
		.option("--activity-text <text>", "Activity summary text.")
		.option("--tool-name <name>", "Tool name.")
		.option("--final-message <message>", "Final message.")
		.option("--hook-event-name <name>", "Original hook event name.")
		.option("--notification-type <type>", "Notification type.")
		.option("--metadata-base64 <base64>", "Base64-encoded JSON metadata payload.")
		.action(
			async (
				payload: string | undefined,
				options: HookCommandMetadataOptionValues & { event: RuntimeHookEvent },
			) => {
				await runCodexHookSubcommand(options.event, options, payload);
			},
		);

	hooks
		.command("codex-wrapper [agentArgs...]")
		.description("Codex wrapper that emits Kanban hook notifications.")
		.requiredOption("--real-binary <path>", "Path to the actual codex binary.")
		.allowUnknownOption(true)
		.action(async (agentArgs: string[] | undefined, options: { realBinary: string }) => {
			await runCodexWrapperSubcommand({
				realBinary: options.realBinary,
				agentArgs: agentArgs ?? [],
			});
		});
}

async function captureRawNotificationHook(
	event: RuntimeHookEvent,
	stdinPayload: string,
	payloadArg: string | undefined,
	options: HookCommandMetadataOptionValues,
): Promise<string | null> {
	if (options.notificationCandidateId) return options.notificationCandidateId;
	const payload = parseJsonObject(stdinPayload.trim());
	const hookEventName = options.hookEventName ?? (payload ? readStringField(payload, "hook_event_name") : null);
	if (event !== "to_review" && !/stop|afteragent|notification|permission|question/iu.test(hookEventName ?? ""))
		return null;
	return await captureNotificationSignal({
		workspaceId: process.env.KANBAN_HOOK_WORKSPACE_ID ?? "unresolved-workspace",
		taskId: process.env.KANBAN_HOOK_TASK_ID ?? "unresolved-task",
		sourceKind: "hook_cli_raw",
		rawPayload: { event, stdinPayload, payloadArg, options },
	});
}
