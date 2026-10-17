// 按已知任务路径 / 原生 session id 补录。Claude 沿用保守的后续人类输入门槛；Codex 由专用投影
// 区分真实答案与中断 / 失败，环境注入和用户请求恢复都不能冒充作答或跳过。
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractAgentRaisedUserQuestionPayload } from "../commands/agent-raised-decision-payload-extraction";
import type { RuntimeAgentRaisedUserQuestionPayload } from "../core/api-contract";
import {
	encodeClaudeProjectDirectoryName,
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
	readTranscriptRecord,
} from "./bounded-agent-transcript-reader";
import {
	projectCodexUserQuestionTranscriptLines,
	recoverCodexUserQuestionsFromKnownConversation,
} from "./codex-user-question-transcript-recovery";

const MAX_TRANSCRIPT_BYTES_FOR_PENDING_DECISION_SALVAGE = 4 * 1024 * 1024;

export interface SalvagedPendingUserDecisionFromTranscript {
	payload: RuntimeAgentRaisedUserQuestionPayload;
	askedAt: number;
	sourceHarnessSignal: "claude:AskUserQuestion:transcript_salvage" | "codex:request_user_input:transcript_salvage";
}

function parseTimestamp(timestamp: unknown): number | null {
	if (typeof timestamp !== "string") {
		return null;
	}
	const timestampMs = Date.parse(timestamp);
	return Number.isFinite(timestampMs) ? timestampMs : null;
}

function asContentBlocks(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		: [];
}

function isLikelyHumanClaudeUserRecord(record: Record<string, unknown>): boolean {
	if (record.type !== "user") {
		return false;
	}
	const message = readTranscriptRecord(record.message);
	const content = message?.content;
	if (typeof content !== "string") {
		return false;
	}
	const origin = readTranscriptRecord(record.origin);
	if (origin?.kind === "task-notification" || record.promptSource === "system") {
		return false;
	}
	if (record.isCompactSummary === true || content.trim().startsWith("<task-notification>")) {
		return false;
	}
	// origin.kind=human 是最强信号；旧转录没有 origin 时，把普通字符串 user 消息也当人类输入，
	// 选择保守漏补而不是把已经被用户越过的问题重新弹出来。
	return origin?.kind === "human" || content.trim().length > 0;
}

// 被拒绝的提问不算「已解决」：Kanban 或系统重启后 resume，原选择器已不在，而用户从未作答——这正是
// 需要把问题重新摆到面板上的情形。拒绝的 tool_result 形如 is_error=true，记录级
// toolUseResult="User rejected tool use"（正文为「The user doesn't want to proceed…」）。
// 真正的作答、以及校验错误等其它失败，仍按已解决处理（后者不是「用户没答」）。
function isClaudeUserQuestionToolResultRejectedWithoutAnswer(
	record: Record<string, unknown>,
	toolResultBlock: Record<string, unknown>,
): boolean {
	if (toolResultBlock.is_error !== true) {
		return false;
	}
	if (record.toolUseResult === "User rejected tool use") {
		return true;
	}
	const content = toolResultBlock.content;
	const contentText =
		typeof content === "string"
			? content
			: asContentBlocks(content)
					.map((entry) => (typeof entry.text === "string" ? entry.text : ""))
					.join("\n");
	return contentText.includes("doesn't want to proceed with this tool use");
}

export function salvageLatestUnansweredClaudeUserQuestionFromTranscriptLines(
	lines: readonly string[],
): SalvagedPendingUserDecisionFromTranscript | null {
	let latestCandidate: {
		toolUseId: string;
		toolInput: Record<string, unknown>;
		askedAt: number;
		resolved: boolean;
		hasLaterHumanInput: boolean;
	} | null = null;
	for (const line of lines) {
		const record = parseTranscriptJsonRecord(line);
		if (!record) {
			continue;
		}
		if (latestCandidate && isLikelyHumanClaudeUserRecord(record)) {
			latestCandidate.hasLaterHumanInput = true;
		}
		const message = readTranscriptRecord(record.message);
		for (const block of asContentBlocks(message?.content)) {
			if (
				record.type === "assistant" &&
				block.type === "tool_use" &&
				block.name === "AskUserQuestion" &&
				typeof block.id === "string" &&
				readTranscriptRecord(block.input)
			) {
				const askedAt = parseTimestamp(record.timestamp);
				if (askedAt !== null) {
					latestCandidate = {
						toolUseId: block.id,
						toolInput: readTranscriptRecord(block.input) as Record<string, unknown>,
						askedAt,
						resolved: false,
						hasLaterHumanInput: false,
					};
				}
				continue;
			}
			if (
				latestCandidate &&
				block.type === "tool_result" &&
				block.tool_use_id === latestCandidate.toolUseId &&
				!isClaudeUserQuestionToolResultRejectedWithoutAnswer(record, block)
			) {
				latestCandidate.resolved = true;
			}
		}
	}
	if (!latestCandidate || latestCandidate.resolved || latestCandidate.hasLaterHumanInput) {
		return null;
	}
	const payload = extractAgentRaisedUserQuestionPayload({
		toolUseId: latestCandidate.toolUseId,
		toolInput: latestCandidate.toolInput,
	});
	return payload
		? {
				payload,
				askedAt: latestCandidate.askedAt,
				sourceHarnessSignal: "claude:AskUserQuestion:transcript_salvage",
			}
		: null;
}

export function salvageLatestUnansweredCodexUserQuestionFromTranscriptLines(
	lines: readonly string[],
): SalvagedPendingUserDecisionFromTranscript | null {
	const latest = projectCodexUserQuestionTranscriptLines(lines).at(-1);
	if (!latest || latest.resolution?.resolutionKind === "answered_in_agent_terminal") return null;
	return {
		payload: latest.payload,
		askedAt: latest.askedAt,
		sourceHarnessSignal: "codex:request_user_input:transcript_salvage",
	};
}

async function readCompleteTranscriptLines(filePath: string): Promise<string[] | null> {
	try {
		const fileStats = await stat(filePath);
		if (!fileStats.isFile() || fileStats.size > MAX_TRANSCRIPT_BYTES_FOR_PENDING_DECISION_SALVAGE) {
			return null;
		}
		const result = await readBoundedJsonLines(
			filePath,
			fileStats.size,
			MAX_TRANSCRIPT_BYTES_FOR_PENDING_DECISION_SALVAGE,
		);
		return result.transcriptWasTruncated ? null : result.lines;
	} catch {
		return null;
	}
}

export async function salvageLatestUnansweredClaudeUserQuestionForTask(input: {
	workspacePath: string;
	knownSessionId?: string;
	homeDirectoryPath?: string;
}): Promise<SalvagedPendingUserDecisionFromTranscript | null> {
	const knownSessionId = input.knownSessionId?.trim();
	if (!knownSessionId) {
		// 同一个 cwd 可以有多个互不相关的 Claude 会话；runtime summary 的活体 id 也不是 Claude
		// session id。没有卡片持久化的精确 session id 时无法证明转录属于当前 task，必须保守漏补。
		return null;
	}
	const projectDirectory = join(
		input.homeDirectoryPath ?? homedir(),
		".claude",
		"projects",
		encodeClaudeProjectDirectoryName(input.workspacePath),
	);
	const lines = await readCompleteTranscriptLines(join(projectDirectory, `${knownSessionId}.jsonl`));
	return lines ? salvageLatestUnansweredClaudeUserQuestionFromTranscriptLines(lines) : null;
}

export async function salvageLatestUnansweredCodexUserQuestionForKnownSession(input: {
	sessionId: string;
	homeDirectoryPath?: string;
}): Promise<SalvagedPendingUserDecisionFromTranscript | null> {
	const recovered = await recoverCodexUserQuestionsFromKnownConversation(input);
	const latest = recovered.exchanges.at(-1);
	if (
		recovered.coverage !== "complete" ||
		!latest ||
		latest.resolution?.resolutionKind === "answered_in_agent_terminal"
	)
		return null;
	return {
		payload: latest.payload,
		askedAt: latest.askedAt,
		sourceHarnessSignal: "codex:request_user_input:transcript_salvage",
	};
}
