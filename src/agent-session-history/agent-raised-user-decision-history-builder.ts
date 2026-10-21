// 构建某个 task 的「问答记录」：agent 问过的问题、用户的答案、终端作答时写下的备注，以及在哪答的、有没有送达。
//
// 为什么需要它：答案与备注在 TUI 里要么被折叠成 [Pasted text #N]（面板作答的投递），要么和选项、preview
// 混在一段文本里看不出结构（终端作答）。用户要回看「我当时怎么答的」时没有可靠的地方可看。
//
// 两个来源，按 tool_use_id 去重：
//   1. Kanban 决策账本——本功能上线后的所有提问；
//   2. Claude 转录回填——账本之外的问答：早于本功能、账本已按上限裁剪、或用户在终端作答时本功能尚未部署。
//      只认转录里 AskUserQuestion 的结构化作答结果（toolUseResult.answers / annotations），不从 TUI 文本里猜。
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { extractAgentRaisedUserQuestionPayload } from "../commands/agent-raised-decision-payload-extraction";
import { splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText } from "../core/agent-terminal-multi-select-answer-text-parsing";
import type {
	RuntimeAgentRaisedDecisionQuestion,
	RuntimeAgentRaisedUserDecisionHistoryEntry,
	RuntimeAgentRaisedUserDecisionHistoryQuestionAnswer,
} from "../core/api-contract";
import {
	type PersistedAgentRaisedPendingUserDecision,
	resolveAgentRaisedPendingUserDecisionOrderedQuestions,
} from "../state/agent-raised-pending-user-decision-store";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";

// 同一个 task 在 worktree 里可能累积很多次会话（重启、RVF 子会话）。只扫最近的这些文件：
// 问答记录是按需打开的面板，不值得为很久以前的会话付无界的 IO。
export const MAX_CLAUDE_TRANSCRIPT_FILES_SCANNED_FOR_USER_DECISION_HISTORY = 40;

// 一次问答记录查询累计最多读这么多转录字节（与 bounded-agent-transcript-reader.ts 的消费者同理：单个转录
// 可达上百 MB，而这条查询跑在用户等待的 tRPC 路径上）。提问可能出现在转录任意位置，所以不做头尾采样，
// 而是从最新的文件起、每个文件从末尾往前取，读「最近的这么多字节」——越新的问答越先被覆盖到。
// EXPERIMENT_NODE: 问答记录转录读取总预算取 32 MiB 是否合适，需按真实 task 转录体量与展开耗时校准
export const MAX_CLAUDE_TRANSCRIPT_BYTES_READ_PER_USER_DECISION_HISTORY_QUERY = 32 * 1024 * 1024;

function resolveLedgerRecordToolUseId(record: PersistedAgentRaisedPendingUserDecision): string {
	const prefix = `${record.taskId}:`;
	return record.decisionId.startsWith(prefix) ? record.decisionId.slice(prefix.length) : record.decisionId;
}

function buildQuestionAnswersFromLedgerRecord(
	record: PersistedAgentRaisedPendingUserDecision,
	orderedQuestions: readonly RuntimeAgentRaisedDecisionQuestion[],
): RuntimeAgentRaisedUserDecisionHistoryQuestionAnswer[] {
	const answer = record.answer;
	if (answer === null) {
		return [];
	}
	return orderedQuestions.map((question, questionIndex) => {
		const questionAnswer = answer.orderedQuestionAnswers?.find(
			(candidate) => candidate.decisionQuestionId === question.decisionQuestionId,
		);
		const terminalAnswerForQuestion = answer.agentTerminalAnswersForQuestions?.[questionIndex];
		// 终端作答：从落盘的 harness 原文重新解析，而不是采信落盘的 selectedOptionIds——早期版本的切分会把
		// 本身含「, 」的标签拆碎，重新解析让这些旧记录也按正确口径显示。写入侧用的是同一个解析函数。
		if (answer.answerSource === "agent_terminal" && typeof terminalAnswerForQuestion?.answerText === "string") {
			const reparsedTerminalAnswer = splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
				terminalAnswerForQuestion.answerText,
				question.options.map((option) => option.label),
			);
			return {
				decisionQuestionId: question.decisionQuestionId,
				selectedOptionLabels: reparsedTerminalAnswer.selectedOptionLabels,
				freeformAnswerText: reparsedTerminalAnswer.freeformAnswerText,
				notesText: terminalAnswerForQuestion.notesText ?? null,
			};
		}
		const selectedOptionIds =
			questionAnswer?.selectedOptionIds ?? (questionIndex === 0 ? answer.selectedOptionIds : []);
		const selectedOptionLabels = selectedOptionIds.map((optionId) => {
			const structuredLabel = question.options.find((option) => option.optionId === optionId)?.label;
			// 旧单问 payload 的顶层选项 id 是 option-N，与 orderedQuestions 的 question-0-option-N 不同。
			return structuredLabel ?? record.options.find((option) => option.optionId === optionId)?.label ?? optionId;
		});
		return {
			decisionQuestionId: question.decisionQuestionId,
			selectedOptionLabels,
			freeformAnswerText: questionAnswer?.freeformText ?? (questionIndex === 0 ? answer.freeformText : null),
			notesText: terminalAnswerForQuestion?.notesText ?? null,
		};
	});
}

function resolveLedgerRecordHistoryResolution(
	record: PersistedAgentRaisedPendingUserDecision,
): RuntimeAgentRaisedUserDecisionHistoryEntry["resolution"] | null {
	switch (record.status) {
		case "answered":
			return record.answer?.answerSource === "agent_terminal"
				? "answered_in_agent_terminal"
				: "answered_in_kanban_panel";
		case "dismissed":
			switch (record.dismissalSource) {
				case "agent_terminal":
					return "declined_in_agent_terminal";
				case "agent_session_transport_switch":
					return "cancelled_by_agent_session_transport_switch";
				default:
					// 缺省（早于 dismissalSource 字段的旧记录）即面板取消——那时只有面板能取消。
					return "dismissed_in_kanban_panel";
			}
		case "superseded":
			return "superseded_by_later_question_without_answer";
		default:
			if (record.status === "pending" && record.nativeToolCallOutcome) return record.nativeToolCallOutcome;
			// pending 仍在面板上等人答，不属于「记录」。
			return null;
	}
}

export function buildAgentRaisedUserDecisionHistoryEntriesFromDecisionLedger(
	records: readonly PersistedAgentRaisedPendingUserDecision[],
	taskId: string,
): RuntimeAgentRaisedUserDecisionHistoryEntry[] {
	const recordsByDecisionId = new Map(records.map((record) => [record.decisionId, record]));
	const entries: RuntimeAgentRaisedUserDecisionHistoryEntry[] = [];
	for (const record of records) {
		if (record.taskId !== taskId) {
			continue;
		}
		// 旧版本一问两记：被同正文后继顶掉的那条只是重复记录，不是一次「没被回答的提问」。
		if (record.status === "superseded" && record.supersededByDecisionId !== null) {
			const successor = recordsByDecisionId.get(record.supersededByDecisionId);
			if (
				record.agentId !== "codex" &&
				successor !== undefined &&
				successor.questionMarkdown === record.questionMarkdown
			) {
				continue;
			}
		}
		const resolution = resolveLedgerRecordHistoryResolution(record);
		if (resolution === null) {
			continue;
		}
		const orderedQuestions = resolveAgentRaisedPendingUserDecisionOrderedQuestions(record);
		entries.push({
			historyEntryId: `ledger:${record.decisionId}`,
			taskId: record.taskId,
			recordSource: "kanban_decision_ledger",
			decisionKind: record.decisionKind,
			askedAt: record.askedAt,
			resolvedAt:
				record.status === "pending"
					? null
					: record.status === "answered"
						? (record.answer?.answeredAt ?? record.updatedAt)
						: record.updatedAt,
			resolution,
			orderedQuestions,
			questionAnswers: buildQuestionAnswersFromLedgerRecord(record, orderedQuestions),
			answerDeliveryState:
				record.status === "answered" && record.answer?.answerSource !== "agent_terminal"
					? record.answerDeliveryState
					: null,
		});
	}
	return entries;
}

export function collectToolUseIdsAlreadyRecordedInDecisionLedger(
	records: readonly PersistedAgentRaisedPendingUserDecision[],
	taskId: string,
): Set<string> {
	return new Set(
		records.filter((record) => record.taskId === taskId).map((record) => resolveLedgerRecordToolUseId(record)),
	);
}

function parseTranscriptTimestamp(value: unknown): number | null {
	if (typeof value !== "string") {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function asContentBlocks(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		: [];
}

// 只有这两类行可能是问答记录的组成部分；其余行（绝大多数）连 JSON.parse 都不做。
function isTranscriptLinePossiblyPartOfClaudeUserQuestionExchange(line: string): boolean {
	return (
		line.includes('"AskUserQuestion"') ||
		(line.includes('"toolUseResult"') && (line.includes('"answers"') || line.includes("User rejected tool use")))
	);
}

interface ClaudeUserQuestionExchangeFromTranscript {
	toolUseId: string;
	askedAt: number;
	toolInput: Record<string, unknown>;
	resolution: "answered_in_agent_terminal" | "declined_in_agent_terminal" | null;
	resolvedAt: number | null;
	answersByQuestionText: Record<string, unknown> | null;
	annotationsByQuestionText: Record<string, unknown> | null;
}

export function createClaudeUserQuestionExchangeTranscriptAccumulator() {
	const exchangesByToolUseId = new Map<string, ClaudeUserQuestionExchangeFromTranscript>();
	return {
		acceptTranscriptLine(line: string): void {
			if (!isTranscriptLinePossiblyPartOfClaudeUserQuestionExchange(line)) {
				return;
			}
			const record = parseTranscriptJsonRecord(line);
			if (!record) {
				return;
			}
			const message = readTranscriptRecord(record.message);
			for (const block of asContentBlocks(message?.content)) {
				if (
					record.type === "assistant" &&
					block.type === "tool_use" &&
					block.name === "AskUserQuestion" &&
					typeof block.id === "string"
				) {
					const toolInput = readTranscriptRecord(block.input);
					const askedAt = parseTranscriptTimestamp(record.timestamp);
					if (toolInput && askedAt !== null && !exchangesByToolUseId.has(block.id)) {
						exchangesByToolUseId.set(block.id, {
							toolUseId: block.id,
							askedAt,
							toolInput,
							resolution: null,
							resolvedAt: null,
							answersByQuestionText: null,
							annotationsByQuestionText: null,
						});
					}
					continue;
				}
				if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
					continue;
				}
				const exchange = exchangesByToolUseId.get(block.tool_use_id);
				if (!exchange) {
					continue;
				}
				const toolUseResult = readTranscriptRecord(record.toolUseResult);
				const answersByQuestionText = toolUseResult ? readTranscriptRecord(toolUseResult.answers) : null;
				if (answersByQuestionText) {
					exchange.resolution = "answered_in_agent_terminal";
					exchange.answersByQuestionText = answersByQuestionText;
					exchange.annotationsByQuestionText = toolUseResult
						? readTranscriptRecord(toolUseResult.annotations)
						: null;
				} else if (record.toolUseResult === "User rejected tool use") {
					exchange.resolution = "declined_in_agent_terminal";
				}
				exchange.resolvedAt = parseTranscriptTimestamp(record.timestamp);
			}
		},
		buildHistoryEntries(taskId: string): RuntimeAgentRaisedUserDecisionHistoryEntry[] {
			const entries: RuntimeAgentRaisedUserDecisionHistoryEntry[] = [];
			for (const exchange of exchangesByToolUseId.values()) {
				if (exchange.resolution === null) {
					// 没有结局 = 仍在等答（由面板负责呈现）或转录被截断，不算记录。
					continue;
				}
				const payload = extractAgentRaisedUserQuestionPayload({
					toolUseId: exchange.toolUseId,
					toolInput: exchange.toolInput,
				});
				if (!payload) {
					continue;
				}
				const questionAnswers = payload.orderedQuestions.map((question) => {
					const answerValue = exchange.answersByQuestionText?.[question.questionMarkdown];
					const answerText = typeof answerValue === "string" && answerValue.trim().length > 0 ? answerValue : null;
					const annotation = exchange.annotationsByQuestionText
						? readTranscriptRecord(exchange.annotationsByQuestionText[question.questionMarkdown])
						: null;
					const notesValue = annotation?.notes;
					const parsedTerminalAnswer =
						answerText === null
							? { selectedOptionLabels: [], freeformAnswerText: null }
							: splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
									answerText,
									question.options.map((option) => option.label),
								);
					return {
						decisionQuestionId: question.decisionQuestionId,
						selectedOptionLabels: parsedTerminalAnswer.selectedOptionLabels,
						freeformAnswerText: parsedTerminalAnswer.freeformAnswerText,
						notesText: typeof notesValue === "string" && notesValue.trim().length > 0 ? notesValue : null,
					};
				});
				entries.push({
					historyEntryId: `transcript:${exchange.toolUseId}`,
					taskId,
					recordSource: "agent_conversation_transcript",
					decisionKind: "ordinary_user_question",
					askedAt: exchange.askedAt,
					resolvedAt: exchange.resolvedAt,
					resolution: exchange.resolution,
					orderedQuestions: payload.orderedQuestions,
					questionAnswers: exchange.resolution === "answered_in_agent_terminal" ? questionAnswers : [],
					answerDeliveryState: null,
				});
			}
			return entries;
		},
		getRecordedToolUseIds(): string[] {
			return [...exchangesByToolUseId.keys()];
		},
	};
}

// 流式读 [startByteOffset, endByteOffsetInclusive] 这一段。从文件中间切入时首行可能是半行，无条件丢弃
// （与 splitCompleteJsonLines 的 "file_end" 约定一致）；读到 stat 时的大小为止，不追正在增长的活跃会话。
async function streamTranscriptByteRangeLinesInto(
	input: { filePath: string; startByteOffset: number; endByteOffsetInclusive: number },
	acceptLine: (line: string) => void,
): Promise<void> {
	const lineReader = createInterface({
		input: createReadStream(input.filePath, {
			encoding: "utf8",
			start: input.startByteOffset,
			end: input.endByteOffsetInclusive,
		}),
		crlfDelay: Infinity,
	});
	let shouldDiscardPossiblyTruncatedFirstLine = input.startByteOffset > 0;
	try {
		for await (const line of lineReader) {
			if (shouldDiscardPossiblyTruncatedFirstLine) {
				shouldDiscardPossiblyTruncatedFirstLine = false;
				continue;
			}
			acceptLine(line);
		}
	} finally {
		lineReader.close();
	}
}

// 列出候选转录：显式给出的文件 + 仅属于该 task 的 Claude 项目目录下的全部会话（按修改时间取最近 N 个）。
// 只有 task 独占的 worktree 目录才允许整目录扫描——home / inplace 任务与别的会话共用 cwd，整目录扫
// 会把不相干会话的问答混进来，那种情形只收显式给出的当前会话转录。
export async function listClaudeTranscriptFilesForTaskUserDecisionHistory(input: {
	explicitTranscriptFilePaths: readonly string[];
	claudeProjectDirectoryOwnedExclusivelyByTask: string | null;
}): Promise<string[]> {
	const candidateFilePaths = new Set(input.explicitTranscriptFilePaths);
	if (input.claudeProjectDirectoryOwnedExclusivelyByTask !== null) {
		try {
			const directoryEntries = await readdir(input.claudeProjectDirectoryOwnedExclusivelyByTask);
			for (const fileName of directoryEntries) {
				if (fileName.endsWith(".jsonl")) {
					candidateFilePaths.add(join(input.claudeProjectDirectoryOwnedExclusivelyByTask, fileName));
				}
			}
		} catch {
			// 目录不存在（task 从未跑过 Claude）即无可回填。
		}
	}
	const filesWithModifiedAt: Array<{ filePath: string; modifiedAtMs: number }> = [];
	for (const filePath of candidateFilePaths) {
		try {
			const fileStats = await stat(filePath);
			if (fileStats.isFile()) {
				filesWithModifiedAt.push({ filePath, modifiedAtMs: fileStats.mtimeMs });
			}
		} catch {
			// 已被清理的转录直接跳过。
		}
	}
	return filesWithModifiedAt
		.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
		.slice(0, MAX_CLAUDE_TRANSCRIPT_FILES_SCANNED_FOR_USER_DECISION_HISTORY)
		.map((entry) => entry.filePath);
}

// transcriptFilePaths 须按修改时间新→旧排列（listClaudeTranscriptFilesForTaskUserDecisionHistory 的输出即是），
// 读取预算按这个顺序分配。
export async function buildAgentRaisedUserDecisionHistoryEntriesFromClaudeTranscripts(input: {
	taskId: string;
	transcriptFilePaths: readonly string[];
	maximumTranscriptBytesToRead?: number;
}): Promise<RuntimeAgentRaisedUserDecisionHistoryEntry[]> {
	const accumulator = createClaudeUserQuestionExchangeTranscriptAccumulator();
	let remainingTranscriptReadByteBudget =
		input.maximumTranscriptBytesToRead ?? MAX_CLAUDE_TRANSCRIPT_BYTES_READ_PER_USER_DECISION_HISTORY_QUERY;
	for (const filePath of input.transcriptFilePaths) {
		if (remainingTranscriptReadByteBudget <= 0) {
			break;
		}
		try {
			const fileSize = (await stat(filePath)).size;
			if (fileSize === 0) {
				continue;
			}
			const bytesToReadFromFileEnd = Math.min(fileSize, remainingTranscriptReadByteBudget);
			remainingTranscriptReadByteBudget -= bytesToReadFromFileEnd;
			await streamTranscriptByteRangeLinesInto(
				{
					filePath,
					startByteOffset: fileSize - bytesToReadFromFileEnd,
					endByteOffsetInclusive: fileSize - 1,
				},
				(line) => accumulator.acceptTranscriptLine(line),
			);
		} catch {
			// 单个转录读失败不影响其它来源。
		}
	}
	return accumulator.buildHistoryEntries(input.taskId);
}

// 旧版本一问两记时，正文派生记录（PermissionRequest，不带 tool_use_id）紧跟在对应的 AskUserQuestion
// tool_use 之后 1–2 秒落库。超过这个窗口的同文转录问答视为另一次真实提问（agent 用新 tool_use_id 重问）。
// EXPERIMENT_NODE: 一问两记配对窗口取 60 秒是否过宽/过窄，需按真实旧账本数据的时间差分布校准
export const MAX_MILLISECONDS_BETWEEN_TRANSCRIPT_TOOL_USE_AND_QUESTION_TEXT_DERIVED_LEDGER_RECORD = 60_000;

const QUESTION_TEXT_DERIVED_LEDGER_DECISION_SOURCE_ID_PREFIX = "ask-user-question:";

function joinHistoryEntryQuestionMarkdowns(entry: RuntimeAgentRaisedUserDecisionHistoryEntry): string {
	return entry.orderedQuestions.map((question) => question.questionMarkdown).join("\n");
}

// 合并两个来源并按提问时间倒序。转录里与账本同一个 tool_use_id 的问答以账本为准：账本知道答案是在
// 面板还是终端给的、有没有送达，转录只知道 harness 那一侧看到了什么（面板作答在转录里表现为一次拒绝）。
//
// 正文去重只为旧版本一问两记兜底：账本里只剩正文派生 id 的那条（它的 toolu 记录已被裁剪、或来自只有
// PermissionRequest 入账的时期）时，转录里对应的那次 tool_use 按 id 对不上。收窄为「正文派生的已了结账本
// 条目 × 同正文 × 提问时间相近」、且每条账本条目只吸收时间最近的一条转录——否则同一 task 上用新
// tool_use_id 重问的相同问题、或仍在等答的同文问题，会把更早一次在终端里的真实作答从记录里抹掉。
export function mergeAgentRaisedUserDecisionHistoryEntries(input: {
	ledgerEntries: readonly RuntimeAgentRaisedUserDecisionHistoryEntry[];
	transcriptEntries: readonly RuntimeAgentRaisedUserDecisionHistoryEntry[];
	toolUseIdsAlreadyRecordedInDecisionLedger: ReadonlySet<string>;
	// 仅为调用方兼容保留、不再参与去重：整段正文命中即丢弃会误删重问的真实作答（见上方说明）。
	ledgerQuestionMarkdownsForTask?: ReadonlySet<string>;
}): RuntimeAgentRaisedUserDecisionHistoryEntry[] {
	const transcriptEntriesNotRecordedByToolUseId = input.transcriptEntries.filter(
		(entry) => !input.toolUseIdsAlreadyRecordedInDecisionLedger.has(entry.historyEntryId.slice("transcript:".length)),
	);
	const transcriptHistoryEntryIdsDuplicatedByQuestionTextDerivedLedgerEntry = new Set<string>();
	for (const ledgerEntry of input.ledgerEntries) {
		if (
			!ledgerEntry.historyEntryId.startsWith(
				`ledger:${ledgerEntry.taskId}:${QUESTION_TEXT_DERIVED_LEDGER_DECISION_SOURCE_ID_PREFIX}`,
			)
		) {
			continue;
		}
		const ledgerQuestionMarkdowns = joinHistoryEntryQuestionMarkdowns(ledgerEntry);
		let closestTranscriptEntry: RuntimeAgentRaisedUserDecisionHistoryEntry | null = null;
		for (const transcriptEntry of transcriptEntriesNotRecordedByToolUseId) {
			const millisecondsBetweenAskedAt = Math.abs(transcriptEntry.askedAt - ledgerEntry.askedAt);
			if (
				transcriptHistoryEntryIdsDuplicatedByQuestionTextDerivedLedgerEntry.has(transcriptEntry.historyEntryId) ||
				millisecondsBetweenAskedAt >
					MAX_MILLISECONDS_BETWEEN_TRANSCRIPT_TOOL_USE_AND_QUESTION_TEXT_DERIVED_LEDGER_RECORD ||
				joinHistoryEntryQuestionMarkdowns(transcriptEntry) !== ledgerQuestionMarkdowns
			) {
				continue;
			}
			if (
				closestTranscriptEntry === null ||
				millisecondsBetweenAskedAt < Math.abs(closestTranscriptEntry.askedAt - ledgerEntry.askedAt)
			) {
				closestTranscriptEntry = transcriptEntry;
			}
		}
		if (closestTranscriptEntry !== null) {
			transcriptHistoryEntryIdsDuplicatedByQuestionTextDerivedLedgerEntry.add(closestTranscriptEntry.historyEntryId);
		}
	}
	const transcriptEntriesNotInLedger = transcriptEntriesNotRecordedByToolUseId.filter(
		(entry) => !transcriptHistoryEntryIdsDuplicatedByQuestionTextDerivedLedgerEntry.has(entry.historyEntryId),
	);
	return [...input.ledgerEntries, ...transcriptEntriesNotInLedger].sort((left, right) => right.askedAt - left.askedAt);
}
