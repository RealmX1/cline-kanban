import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
} from "../agent-session-history/bounded-agent-transcript-reader";
import { projectCodexUserQuestionTranscriptLines } from "../agent-session-history/codex-user-question-transcript-recovery";
import { extractSubmittedUserPromptFromTranscriptRecord } from "../agent-session-history/task-user-prompt-history-for-draft-usage";

export interface IndependentTaskCreationContextMessage {
	role: "user" | "assistant" | "tool_reference";
	text: string;
	reference: string;
	submittedAt: number | null;
	nativeMessageId: string | null;
}
type ContextMessageInput = Pick<IndependentTaskCreationContextMessage, "role" | "text" | "reference">;

function textBlocks(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.flatMap((block) => {
			const part = readTranscriptRecord(block);
			return part &&
				["text", "input_text", "output_text"].includes(String(part.type)) &&
				typeof part.text === "string"
				? [part.text]
				: [];
		})
		.join("\n");
}

function parseObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "string") return readTranscriptRecord(value);
	try {
		return readTranscriptRecord(JSON.parse(value));
	} catch {
		return null;
	}
}

function submittedQuestionAnswers(result: Record<string, unknown> | null) {
	if (!result || result.aborted === true || result.cancelled === true) return null;
	const answers = readTranscriptRecord(result.answers);
	const hasText = (value: unknown) => typeof value === "string" && value.trim().length > 0;
	return answers &&
		Object.values(answers).some((value) => {
			const strings = readTranscriptRecord(value)?.answers;
			return hasText(value) || (Array.isArray(strings) && strings.some(hasText));
		})
		? answers
		: null;
}

/** 保留真人决定；普通工具输出只保留能回到原始转录的引用。 */
export function projectIndependentTaskCreationTranscript(
	agentId: string,
	records: readonly Record<string, unknown>[],
	referencePrefix = "transcript",
	sourceLineNumbers?: readonly number[],
): IndependentTaskCreationContextMessage[] {
	const messages: IndependentTaskCreationContextMessage[] = [];
	const questionCallIds = new Set<string>();
	const claudePlanApprovalCallIds = new Set<string>();
	const answeredDecisionCallIds = new Set<string>();
	const codexQuestionCallIds = new Set(
		records.flatMap((record) => {
			const payload = readTranscriptRecord(record.payload);
			return payload?.type === "function_call" &&
				payload.name === "request_user_input" &&
				typeof payload.call_id === "string"
				? [payload.call_id]
				: [];
		}),
	);
	const recoveredCodexQuestions = new Map(
		(agentId === "codex"
			? projectCodexUserQuestionTranscriptLines(
					records
						.filter((record) => {
							const payload = readTranscriptRecord(record.payload);
							return (
								record.type === "session_meta" ||
								(typeof payload?.call_id === "string" && codexQuestionCallIds.has(payload.call_id))
							);
						})
						.map((record) => JSON.stringify(record)),
				)
			: []
		).map((exchange) => [exchange.callId, exchange]),
	);
	let lastEnvelopeKind = "";
	for (const [index, record] of records.entries()) {
		if (record.isSidechain === true) continue;
		const payload = readTranscriptRecord(record.payload) ?? record;
		const message = readTranscriptRecord(payload.message) ?? payload;
		const reference = `${referencePrefix}:${sourceLineNumbers?.[index] ?? index + 1}`;
		const rawTime = record.timestamp ?? record.createdAt;
		const timestamp =
			typeof rawTime === "number" ? rawTime : typeof rawTime === "string" ? Date.parse(rawTime) : Number.NaN;
		const nativeMessageId =
			typeof record.uuid === "string" ? record.uuid : typeof payload.id === "string" ? payload.id : null;
		const append = (role: IndependentTaskCreationContextMessage["role"], text: string) => {
			if (!text.trim()) return;
			const previous = messages.at(-1);
			// Codex 同一次消息可同时存在 event_msg 和 response_item；不合并真人重复提交的不同消息。
			if (
				agentId === "codex" &&
				previous?.role === role &&
				previous.text === text &&
				lastEnvelopeKind !== record.type &&
				["event_msg", "response_item"].includes(String(record.type))
			) {
				lastEnvelopeKind = String(record.type);
				return;
			}
			messages.push({
				role,
				text,
				reference,
				submittedAt: Number.isFinite(timestamp) ? timestamp : null,
				nativeMessageId,
			});
			lastEnvelopeKind = String(record.type ?? "");
		};
		const user = extractSubmittedUserPromptFromTranscriptRecord(agentId, record);
		if (user) append("user", user.text);
		if (message.role === "assistant" || (record.type === "event_msg" && payload.type === "agent_message")) {
			append("assistant", textBlocks(message.content ?? payload.message));
		}
		const blocks = Array.isArray(message.content) ? message.content : [payload];
		for (const block of blocks) {
			const tool = readTranscriptRecord(block);
			if (!tool) continue;
			const callId = String(tool.call_id ?? tool.id ?? tool.tool_use_id ?? "");
			if (["function_call", "tool_use"].includes(String(tool.type))) {
				if (["request_user_input", "AskUserQuestion"].includes(String(tool.name))) {
					questionCallIds.add(callId);
					append("assistant", JSON.stringify(parseObject(tool.arguments ?? tool.input) ?? {}));
				} else if (
					agentId === "claude" &&
					record.type === "assistant" &&
					tool.type === "tool_use" &&
					tool.name === "ExitPlanMode" &&
					callId
				) {
					claudePlanApprovalCallIds.add(callId);
					append("assistant", JSON.stringify(parseObject(tool.input) ?? {}));
				} else append("tool_reference", `工具调用 ${String(tool.name ?? "")}；原文引用 ${reference}`);
			}
			if (["function_call_output", "tool_result"].includes(String(tool.type))) {
				const result = parseObject(tool.output ?? tool.content);
				const answers = submittedQuestionAnswers(result);
				// 沿用 Claude 计划状态探针的判据：已配对的主链 ExitPlanMode 用户回执没有 is_error 才代表批准。
				if (
					agentId === "claude" &&
					record.type === "user" &&
					message.role === "user" &&
					tool.type === "tool_result" &&
					claudePlanApprovalCallIds.has(callId) &&
					tool.is_error !== true &&
					!answeredDecisionCallIds.has(callId)
				) {
					append("user", textBlocks(tool.content) || "用户已批准计划（Claude ExitPlanMode 成功回执）。");
					answeredDecisionCallIds.add(callId);
				} else if (questionCallIds.has(callId) && answers && !answeredDecisionCallIds.has(callId)) {
					append("user", JSON.stringify(answers));
					answeredDecisionCallIds.add(callId);
				} else append("tool_reference", `工具结果原文引用 ${reference}`);
			}
		}
		const userDecision = readTranscriptRecord(record.toolUseResult);
		const decisionCallId = blocks.flatMap((block) => {
			const result = readTranscriptRecord(block);
			return result?.type === "tool_result" && questionCallIds.has(String(result.tool_use_id ?? ""))
				? [String(result.tool_use_id)]
				: [];
		})[0];
		const decisionAnswers = submittedQuestionAnswers(userDecision);
		if (decisionCallId && decisionAnswers && !answeredDecisionCallIds.has(decisionCallId)) {
			append("user", JSON.stringify(decisionAnswers));
			answeredDecisionCallIds.add(decisionCallId);
		}
		if (
			record.type === "retained_context" &&
			payload.type === "verified_answer" &&
			typeof payload.call_id === "string" &&
			!answeredDecisionCallIds.has(payload.call_id)
		) {
			const exchange = recoveredCodexQuestions.get(payload.call_id);
			if (
				exchange?.resolution?.resolutionKind === "answered_in_agent_terminal" &&
				exchange.resolvedAt === timestamp
			) {
				append("user", JSON.stringify(exchange.resolution.answersForQuestions));
				answeredDecisionCallIds.add(payload.call_id);
			}
		}
	}
	return messages;
}

export async function readIndependentTaskCreationTranscript(path: string, agentId: string) {
	const records: Record<string, unknown>[] = [];
	const lineNumbers: number[] = [];
	let lineNumber = 0;
	const reader = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of reader) {
		lineNumber++;
		if (!line.trim()) continue;
		const record = parseTranscriptJsonRecord(line);
		if (!record) throw new Error("来源转录含不完整或损坏记录，请等当前回答完成后重试。");
		records.push(record);
		lineNumbers.push(lineNumber);
	}
	return projectIndependentTaskCreationTranscript(agentId, records, path, lineNumbers);
}

// 前段提供接口将来可由 Intention System 替换；后段始终保留逐条正文。
// EXPERIMENT_NODE: Intention System 接入后实验起点前意图摘要与原文要求的组合方式。
export function projectIndependentTaskContextBeforeSideSession(messages: readonly ContextMessageInput[]) {
	const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
	return messages.filter((message) => message.role === "user" || message === lastAssistant);
}

export function renderIndependentTaskCreationContextSegment(messages: readonly ContextMessageInput[]) {
	return messages.map((message) => `[${message.role}; ${message.reference}]\n${message.text}`).join("\n\n");
}

export function buildIndependentTaskCreationGenerationContext(input: {
	beforeSideSession: readonly ContextMessageInput[];
	afterSideSession: readonly ContextMessageInput[];
	userTaskDescription: string;
}): string {
	return `## 侧会话开始之前\n${renderIndependentTaskCreationContextSegment(projectIndependentTaskContextBeforeSideSession(input.beforeSideSession))}\n\n## 所选侧会话开始之后\n${renderIndependentTaskCreationContextSegment(input.afterSideSession)}\n\n## 用户本次分出说明\n${input.userTaskDescription}`;
}
