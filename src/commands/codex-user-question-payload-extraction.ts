import type {
	RuntimeAgentRaisedUserQuestionPayload,
	RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload,
	RuntimeHookEvent,
	RuntimeTaskHookActivity,
} from "../core/api-contract";
import { extractAgentRaisedUserQuestionPayload } from "./agent-raised-decision-payload-extraction";

function readRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function extractCodexUserQuestionPayload(input: {
	callId: string;
	toolInput: Record<string, unknown> | null;
	nativeConversationSessionId?: string;
}): RuntimeAgentRaisedUserQuestionPayload | null {
	const questions = input.toolInput?.questions;
	if (!Array.isArray(questions) || questions.length === 0) return null;
	const nativeQuestionIds = questions.map((question) => readRecord(question)?.id);
	if (
		nativeQuestionIds.some((id) => typeof id !== "string" || id.trim().length === 0) ||
		new Set(nativeQuestionIds).size !== nativeQuestionIds.length
	)
		return null;
	const payload = extractAgentRaisedUserQuestionPayload({ toolUseId: input.callId, toolInput: input.toolInput });
	if (!payload || payload.orderedQuestions.length !== questions.length) return null;
	return {
		...payload,
		decisionSourceId: input.nativeConversationSessionId
			? `${input.nativeConversationSessionId}:${input.callId}`
			: input.callId,
		...(input.nativeConversationSessionId ? { nativeConversationSessionId: input.nativeConversationSessionId } : {}),
		orderedQuestions: payload.orderedQuestions.map((question, index) => ({
			...question,
			decisionQuestionId: nativeQuestionIds[index] as string,
		})),
	};
}

// Codex 的 answers 以原生 question.id 为键，值为 { answers: string[] }；Claude 则以问题正文为键。
// 无答案的工具返回绝不是「用户拒答」。保留部分答案，但只有全部问题都有有效答案才了结整组提问。
export function extractCodexUserQuestionResolution(input: {
	callId: string;
	payload: RuntimeAgentRaisedUserQuestionPayload;
	toolResponse: unknown;
}): RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload {
	let response: unknown = input.toolResponse;
	if (typeof response === "string") {
		try {
			response = JSON.parse(response) as unknown;
		} catch {
			/* 文本错误按无答案处理。 */
		}
	}
	const answers = readRecord(readRecord(response)?.answers);
	const answersForQuestions = input.payload.orderedQuestions.map((question) => {
		const values = readRecord(answers?.[question.decisionQuestionId])?.answers;
		const answerStrings =
			Array.isArray(values) && values.every((value) => typeof value === "string")
				? values.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
				: [];
		return {
			questionText: question.questionMarkdown,
			answerText: answerStrings.length > 0 ? answerStrings.join(", ") : null,
			notesText: null,
		};
	});
	const hasAllAnswers = answersForQuestions.every((answer) => answer.answerText !== null);
	const responseText = typeof input.toolResponse === "string" ? input.toolResponse.trim() : "";
	const wasInterrupted = /^(aborted|cancelled|canceled|interrupted)$/iu.test(responseText);
	return {
		decisionSourceId: input.payload.decisionSourceId,
		sourceAgentId: "codex",
		...(input.payload.nativeConversationSessionId
			? { nativeConversationSessionId: input.payload.nativeConversationSessionId }
			: {}),
		resolutionKind: hasAllAnswers
			? "answered_in_agent_terminal"
			: wasInterrupted || answers !== null
				? "interrupted_without_answer"
				: "failed_without_answer",
		answersForQuestions,
	};
}

export function resolveCodexUserQuestionHookEvent(
	event: RuntimeHookEvent,
	metadata: Partial<RuntimeTaskHookActivity> | null | undefined,
): RuntimeHookEvent {
	if (metadata?.source !== "codex" || metadata.toolName !== "request_user_input") return event;
	if (metadata.hookEventName === "PreToolUse") return "to_review";
	if (metadata.hookEventName === "PostToolUse") return "to_in_progress";
	return event;
}
