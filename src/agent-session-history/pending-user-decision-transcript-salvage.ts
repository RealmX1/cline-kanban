// 旧版本 Kanban 可能漏掉已经写进 agent 转录、却尚未得到回答的问题。这个模块只做按**已知任务路径 /
// 已知 session id**的按需保守补录：不跑周期性全盘内容扫描；无法证明「无结果且之后无人类输入」就返回 null。
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { extractAgentRaisedUserQuestionPayload } from "../commands/agent-raised-decision-payload-extraction";
import type { RuntimeAgentRaisedUserQuestionPayload } from "../core/api-contract";
import {
	encodeClaudeProjectDirectoryName,
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
	readTranscriptRecord,
} from "./bounded-agent-transcript-reader";

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
			if (latestCandidate && block.type === "tool_result" && block.tool_use_id === latestCandidate.toolUseId) {
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

function isLikelyHumanCodexRecord(record: Record<string, unknown>): boolean {
	const payload = readTranscriptRecord(record.payload);
	return (
		(record.type === "event_msg" && payload?.type === "user_message") ||
		(record.type === "response_item" && payload?.type === "message" && payload.role === "user")
	);
}

export function salvageLatestUnansweredCodexUserQuestionFromTranscriptLines(
	lines: readonly string[],
): SalvagedPendingUserDecisionFromTranscript | null {
	let latestCandidate: {
		callId: string;
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
		if (latestCandidate && isLikelyHumanCodexRecord(record)) {
			latestCandidate.hasLaterHumanInput = true;
		}
		const payload = readTranscriptRecord(record.payload);
		if (!payload || record.type !== "response_item") {
			continue;
		}
		if (
			payload.type === "function_call" &&
			payload.name === "request_user_input" &&
			typeof payload.call_id === "string" &&
			typeof payload.arguments === "string"
		) {
			const askedAt = parseTimestamp(record.timestamp);
			try {
				const toolInput = readTranscriptRecord(JSON.parse(payload.arguments) as unknown);
				if (askedAt !== null && toolInput) {
					latestCandidate = {
						callId: payload.call_id,
						toolInput,
						askedAt,
						resolved: false,
						hasLaterHumanInput: false,
					};
				}
			} catch {
				// 非法 arguments 不能补录。
			}
		} else if (
			latestCandidate &&
			payload.type === "function_call_output" &&
			payload.call_id === latestCandidate.callId
		) {
			latestCandidate.resolved = true;
		}
	}
	if (!latestCandidate || latestCandidate.resolved || latestCandidate.hasLaterHumanInput) {
		return null;
	}
	const payload = extractAgentRaisedUserQuestionPayload({
		toolUseId: latestCandidate.callId,
		toolInput: latestCandidate.toolInput,
	});
	return payload
		? {
				payload,
				askedAt: latestCandidate.askedAt,
				sourceHarnessSignal: "codex:request_user_input:transcript_salvage",
			}
		: null;
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

async function resolveCodexTranscriptPathByKnownSessionId(
	sessionId: string,
	homeDirectoryPath: string | undefined,
): Promise<string | null> {
	const codexSessionsRoot = join(
		homeDirectoryPath ?? process.env.CODEX_HOME?.trim() ?? join(homedir(), ".codex"),
		"sessions",
	);
	let years: string[];
	try {
		years = await readdir(codexSessionsRoot);
	} catch {
		return null;
	}
	for (const year of years.sort().reverse()) {
		let months: string[];
		try {
			months = await readdir(join(codexSessionsRoot, year));
		} catch {
			continue;
		}
		for (const month of months.sort().reverse()) {
			let days: string[];
			try {
				days = await readdir(join(codexSessionsRoot, year, month));
			} catch {
				continue;
			}
			for (const day of days.sort().reverse()) {
				let files: string[];
				try {
					files = await readdir(join(codexSessionsRoot, year, month, day));
				} catch {
					continue;
				}
				const exactFileName = files.find(
					(fileName) => fileName.endsWith(`${sessionId}.jsonl`) || basename(fileName, ".jsonl") === sessionId,
				);
				if (exactFileName) {
					return join(codexSessionsRoot, year, month, day, exactFileName);
				}
			}
		}
	}
	return null;
}

export async function salvageLatestUnansweredCodexUserQuestionForKnownSession(input: {
	sessionId: string;
	homeDirectoryPath?: string;
}): Promise<SalvagedPendingUserDecisionFromTranscript | null> {
	const transcriptPath = await resolveCodexTranscriptPathByKnownSessionId(input.sessionId, input.homeDirectoryPath);
	if (!transcriptPath) {
		return null;
	}
	const lines = await readCompleteTranscriptLines(transcriptPath);
	return lines ? salvageLatestUnansweredCodexUserQuestionFromTranscriptLines(lines) : null;
}
