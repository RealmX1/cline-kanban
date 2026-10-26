import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
} from "../agent-session-history/bounded-agent-transcript-reader";
import { listKnownCodexTranscriptSegmentPaths } from "../agent-session-history/codex-native-conversation-transcript-location-for-resume";
import {
	extractSubmittedUserPromptFromTranscriptRecord,
	isAcceptedNativeUserInputWithOnlyAttachments,
} from "../agent-session-history/submitted-user-prompt-transcript-record-parser";
import {
	countDailyWorkProgressCollectionCost,
	measureDailyWorkProgressAsynchronousStage,
	measureDailyWorkProgressSynchronousStage,
} from "../diagnostics/daily-work-progress-collection-cost-recorder";
import type { CodexStatisticsVerifiedHistoryReadCache } from "./codex-statistics-verified-history-read-cache";
import {
	createProgrammaticPromptReceiptTimeIndex,
	type ProgrammaticPromptReceiptTimeIndex,
} from "./programmatic-prompt-receipt-time-index";
import { readCountedTaskUserPromptStatisticsJsonLines as readAppendedCompleteJsonLines } from "./task-user-prompt-statistics-counted-json-lines-reader";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const EMPTY_PROGRAMMATIC_PROMPT_SHA256S: ReadonlySet<string> = new Set();
// EXPERIMENT_NODE: 原生提交标识可用时，用它替代正文与回执时间窗口的关联。
const PROGRAMMATIC_PROMPT_RECEIPT_MATCH_MAXIMUM_TIMESTAMP_DISTANCE_MS = 5_000;
const MAXIMUM_TRANSCRIPT_INCREMENT_BYTES = 256 * 1024;
const MAXIMUM_CODEX_HISTORY_SEGMENTS = 64;
const confirmedSubmissionSchema = z.object({ submissionId: z.string(), submittedAtEpochMs: z.number() });
const taskUserPromptStatisticsRecordFoldCursorSchema = z.object({
	nextByteOffset: z.number().int().nonnegative(),
	fileIdentity: z.string().nullable(),
	rejectedDescendantSession: z.boolean(),
	complete: z.boolean(),
	firstPromptAtEpochMs: z.number().nullable(),
	sourceIntegrityWarning: z.string().nullable().default(null),
	pendingCodexRepresentation: z
		.object({ kind: z.string(), textSha256: z.string(), submittedAtEpochMs: z.number() })
		.nullable(),
});
const codexHistorySegmentCursorSchema = taskUserPromptStatisticsRecordFoldCursorSchema.extend({
	readRecordCount: z.number().int().nonnegative(),
	boundedPrefixEndByteOffset: z.number().int().nonnegative().nullable(),
	boundedPrefixRecordCount: z.number().int().nonnegative().nullable(),
	fileModifiedAtMilliseconds: z.number(),
	stagedSubmissions: z.array(confirmedSubmissionSchema),
});
export const taskUserPromptStatisticsCursorSchema = taskUserPromptStatisticsRecordFoldCursorSchema.extend({
	codexHistorySegmentCursorsByTranscriptPath: z.record(z.string(), codexHistorySegmentCursorSchema).default({}),
	codexHistoryConfirmedSubmissionIds: z.array(z.string()).default([]),
});
export type TaskUserPromptStatisticsCursor = z.infer<typeof taskUserPromptStatisticsCursorSchema>;
export function createEmptyTaskUserPromptStatisticsCursor(): TaskUserPromptStatisticsCursor {
	return {
		nextByteOffset: 0,
		fileIdentity: null,
		rejectedDescendantSession: false,
		complete: false,
		firstPromptAtEpochMs: null,
		sourceIntegrityWarning: null,
		pendingCodexRepresentation: null,
		codexHistorySegmentCursorsByTranscriptPath: {},
		codexHistoryConfirmedSubmissionIds: [],
	};
}
export interface ConfirmedTaskUserPromptStatisticsSubmission {
	submissionId: string;
	submittedAtEpochMs: number;
}

/** 只保存提交身份与时间。正文只在内存中判断来源，不进入统计持久文件。 */
export function foldTaskUserPromptStatisticsRecord(input: {
	sourceAgentId: string;
	record: Record<string, unknown>;
	serializedRecord: string;
	cursor: z.infer<typeof taskUserPromptStatisticsRecordFoldCursorSchema>;
	programmaticPromptSha256s: ReadonlySet<string>;
	matchesProgrammaticPromptSha256AtRecordTimestamp?: (promptSha256: string) => boolean;
}): ConfirmedTaskUserPromptStatisticsSubmission | null {
	const { sourceAgentId, record, cursor } = input;
	const payload = readTranscriptRecord(record.payload);
	if (sourceAgentId === "codex" && record.type === "session_meta") {
		const source = readTranscriptRecord(payload?.source);
		if ((payload?.thread_source !== undefined && payload.thread_source !== "user") || source?.subagent !== undefined)
			cursor.rejectedDescendantSession = true;
	}
	if (cursor.rejectedDescendantSession || record.isSidechain === true) return null;
	const prompt = extractSubmittedUserPromptFromTranscriptRecord(sourceAgentId, record);
	const attachmentsOnly = isAcceptedNativeUserInputWithOnlyAttachments(sourceAgentId, record);
	if (!prompt && !attachmentsOnly) return null;
	const timestamp =
		prompt?.submittedAtEpochMs ??
		(typeof record.timestamp === "string" ? Date.parse(record.timestamp) : record.timestamp);
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
	const text = prompt?.text ?? "";
	if (
		/^# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>/u.test(text.trimStart()) ||
		text.trimStart().startsWith("<environment_context>")
	)
		return null;
	const textSha256 = sha256(text);
	if (input.programmaticPromptSha256s.has(textSha256)) return null;
	// 程序化投递会附上来源块；只识别该显式机器来源，不把普通谈论此术语的正文排除。
	if (
		/^\s*<kanban[^>]*(?:programmatic|injection)/u.test(text) ||
		/^\s*<[^>]*provenance[^>]*>[\s\S]*?context_only_never_quote_as_user_statement/u.test(text)
	)
		return null;
	if (input.matchesProgrammaticPromptSha256AtRecordTimestamp?.(textSha256)) return null;
	if (sourceAgentId === "codex") {
		const kind = String(record.type);
		const previous = cursor.pendingCodexRepresentation;
		if (
			previous &&
			previous.kind !== kind &&
			previous.textSha256 === textSha256 &&
			Math.abs(previous.submittedAtEpochMs - timestamp) <= 1_000
		) {
			cursor.pendingCodexRepresentation = null;
			return null;
		}
		cursor.pendingCodexRepresentation = { kind, textSha256, submittedAtEpochMs: timestamp };
	}
	cursor.firstPromptAtEpochMs = Math.min(cursor.firstPromptAtEpochMs ?? timestamp, timestamp);
	// UUID 或原始记录内容在 fork 的继承副本中保持一致；不能把新 native session id 拼进身份。
	const identity = prompt?.messageId ?? sha256(input.serializedRecord);
	return { submissionId: `${sourceAgentId}:${identity}`, submittedAtEpochMs: timestamp };
}

interface TaskUserPromptStatisticsTranscriptIncrementInput {
	sourceAgentId: string;
	nativeSessionId: string;
	transcriptPath: string;
	cursor: TaskUserPromptStatisticsCursor;
	programmaticSubmissionReceipts: readonly { promptSha256: string; confirmedAtEpochMs: number }[];
	programmaticReceiptTimeIndex?: ProgrammaticPromptReceiptTimeIndex;
	codexHistoryReadCache?: CodexStatisticsVerifiedHistoryReadCache;
	codexTranscriptPathsRewrittenWithoutAppend?: ReadonlySet<string>;
}
interface TaskUserPromptStatisticsTranscriptIncrementResult {
	cursor: TaskUserPromptStatisticsCursor;
	submissions: ConfirmedTaskUserPromptStatisticsSubmission[];
	warning: string | null;
}
function foldTaskUserPromptStatisticsParsedRecord(
	input: TaskUserPromptStatisticsTranscriptIncrementInput,
	cursor: z.infer<typeof taskUserPromptStatisticsRecordFoldCursorSchema>,
	record: Record<string, unknown>,
	serializedRecord: string,
): ConfirmedTaskUserPromptStatisticsSubmission | null {
	countDailyWorkProgressCollectionCost("transcript_records");
	const timestamp = record.timestamp ?? record.createdAt;
	const recordTimestamp = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
	// 同文的后续真人输入仍需计数，不能把正文哈希做成永久黑名单。
	const receiptTimeIndex = input.programmaticReceiptTimeIndex;
	const programmaticPromptSha256s = receiptTimeIndex
		? EMPTY_PROGRAMMATIC_PROMPT_SHA256S
		: measureDailyWorkProgressSynchronousStage("receipt_match", () => {
				countDailyWorkProgressCollectionCost("receipt_comparisons", input.programmaticSubmissionReceipts.length);
				return new Set(
					input.programmaticSubmissionReceipts
						.filter(
							(receipt) =>
								typeof recordTimestamp === "number" &&
								Math.abs(receipt.confirmedAtEpochMs - recordTimestamp) <=
									PROGRAMMATIC_PROMPT_RECEIPT_MATCH_MAXIMUM_TIMESTAMP_DISTANCE_MS,
						)
						.map((receipt) => receipt.promptSha256),
				);
			});
	const submission = foldTaskUserPromptStatisticsRecord({
		...input,
		programmaticPromptSha256s,
		matchesProgrammaticPromptSha256AtRecordTimestamp:
			receiptTimeIndex && typeof recordTimestamp === "number"
				? (promptSha256) =>
						measureDailyWorkProgressSynchronousStage("receipt_match", () =>
							receiptTimeIndex.containsWithinTimestampWindow(
								promptSha256,
								recordTimestamp,
								PROGRAMMATIC_PROMPT_RECEIPT_MATCH_MAXIMUM_TIMESTAMP_DISTANCE_MS,
							),
						)
				: undefined,
		record,
		serializedRecord,
		cursor,
	});
	if (!submission) {
		const prompt = extractSubmittedUserPromptFromTranscriptRecord(input.sourceAgentId, record);
		if (prompt && prompt.submittedAtEpochMs === null)
			cursor.sourceIntegrityWarning = "部分人工输入缺少可确认的提交时间";
	}
	return submission;
}

function codexRolloutThreadIdFromTranscriptPath(path: string, nativeSessionId: string): string | null {
	const fileName = basename(path);
	if (fileName.endsWith(`-${nativeSessionId}.jsonl`)) return nativeSessionId;
	const resumedMarker = `-${nativeSessionId}_`;
	const markerIndex = fileName.lastIndexOf(resumedMarker);
	const rolloutThreadId = markerIndex >= 0 ? fileName.slice(markerIndex + resumedMarker.length, -6) : "";
	return fileName.endsWith(".jsonl") && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(rolloutThreadId)
		? rolloutThreadId
		: null;
}

function codexSessionsDirectoryForKnownTranscript(path: string): string {
	const containingDirectory = dirname(resolve(path));
	for (let directory = containingDirectory; ; directory = dirname(directory)) {
		if (basename(directory) === "sessions") return directory;
		if (dirname(directory) === directory) return containingDirectory;
	}
}

interface CodexTaskUserPromptHistorySegment {
	transcriptPath: string;
	fileIdentity: string;
	fileModifiedAtMilliseconds: number;
	fileSizeBytes: number;
	rewrittenWithoutAppend: boolean;
	endByteOffset: number;
	expectedLocalRecordCount: number | null;
}

async function readCodexTaskUserPromptHistoryIncrement(
	input: TaskUserPromptStatisticsTranscriptIncrementInput,
): Promise<TaskUserPromptStatisticsTranscriptIncrementResult> {
	const cursor: TaskUserPromptStatisticsCursor = {
		...input.cursor,
		complete: false,
		codexHistorySegmentCursorsByTranscriptPath: { ...input.cursor.codexHistorySegmentCursorsByTranscriptPath },
		codexHistoryConfirmedSubmissionIds: [...input.cursor.codexHistoryConfirmedSubmissionIds],
	};
	const submissions: ConfirmedTaskUserPromptStatisticsSubmission[] = [];
	const segmentPaths = await measureDailyWorkProgressAsynchronousStage("codex_directory_discovery", () =>
		(
			input.codexHistoryReadCache?.listSegmentPaths.bind(input.codexHistoryReadCache) ??
			listKnownCodexTranscriptSegmentPaths
		)(codexSessionsDirectoryForKnownTranscript(input.transcriptPath), input.nativeSessionId),
	);
	const segments: CodexTaskUserPromptHistorySegment[] = [];
	const visitedPaths = new Set<string>();
	const appendVerifiedSegmentPlan = async (
		transcriptPath: string,
		endByteOffset: number | null,
		expectedTotalRecordCount: number | null,
	): Promise<void> => {
		const path = resolve(transcriptPath);
		if (visitedPaths.has(path) || visitedPaths.size >= MAXIMUM_CODEX_HISTORY_SEGMENTS)
			throw new Error("Codex 历史分段有循环或超过续接预算");
		visitedPaths.add(path);
		const metadata = await stat(path);
		const cachedHeader = input.codexHistoryReadCache
			? await input.codexHistoryReadCache.readPrefix(path, input.nativeSessionId, MAXIMUM_TRANSCRIPT_INCREMENT_BYTES)
			: null;
		const prefix = cachedHeader
			? null
			: await readAppendedCompleteJsonLines(path, 0, MAXIMUM_TRANSCRIPT_INCREMENT_BYTES, "codex_prefix_validation");
		const first =
			cachedHeader?.firstRecord ??
			(prefix?.completeLines[0] ? parseTranscriptJsonRecord(prefix.completeLines[0]) : null);
		const payload = readTranscriptRecord(first?.payload);
		if (
			first?.type !== "session_meta" ||
			payload?.id !== input.nativeSessionId ||
			(payload.session_id !== undefined && payload.session_id !== input.nativeSessionId)
		)
			throw new Error("Codex 历史分段身份不可验证");
		const byteBoundary = endByteOffset ?? metadata.size;
		if (byteBoundary <= 0 || byteBoundary > metadata.size) throw new Error("Codex 父分段字节边界不可验证");
		let inheritedRecordCount = 0;
		if (payload.history_base != null) {
			const base = readTranscriptRecord(payload.history_base);
			if (
				payload.history_mode !== "paginated" ||
				!base ||
				typeof base.thread_id !== "string" ||
				!Number.isSafeInteger(base.end_byte_offset) ||
				(base.end_byte_offset as number) <= 0 ||
				!Number.isSafeInteger(base.end_ordinal_exclusive) ||
				(base.end_ordinal_exclusive as number) <= 0
			)
				throw new Error("Codex 父分段引用不可验证");
			const parentPaths = segmentPaths.filter(
				(candidate) => codexRolloutThreadIdFromTranscriptPath(candidate, input.nativeSessionId) === base.thread_id,
			);
			if (parentPaths.length !== 1) throw new Error("Codex 父分段缺失或身份不唯一");
			inheritedRecordCount = base.end_ordinal_exclusive as number;
			await appendVerifiedSegmentPlan(
				parentPaths[0] as string,
				base.end_byte_offset as number,
				inheritedRecordCount,
			);
		}
		const expectedLocalRecordCount =
			expectedTotalRecordCount === null ? null : expectedTotalRecordCount - inheritedRecordCount;
		if (expectedLocalRecordCount !== null && expectedLocalRecordCount <= 0)
			throw new Error("Codex 父分段累计记录边界不可验证");
		segments.push({
			transcriptPath: path,
			fileIdentity: `${String(metadata.dev)}:${String(metadata.ino)}`,
			fileModifiedAtMilliseconds: metadata.mtimeMs,
			fileSizeBytes: metadata.size,
			rewrittenWithoutAppend:
				cachedHeader?.rewrittenWithoutAppend === true ||
				input.codexTranscriptPathsRewrittenWithoutAppend?.has(path) === true,
			endByteOffset: byteBoundary,
			expectedLocalRecordCount,
		});
	};
	try {
		await appendVerifiedSegmentPlan(input.transcriptPath, null, null);
	} catch (error) {
		return { cursor, submissions, warning: error instanceof Error ? error.message : "Codex 历史分段暂时不可读" };
	}
	let remainingBytes = MAXIMUM_TRANSCRIPT_INCREMENT_BYTES;
	let precedingPendingRepresentation: TaskUserPromptStatisticsCursor["pendingCodexRepresentation"] = null;
	let precedingDescendantSessionWasRejected = false;
	const confirmedSubmissionIds = new Set(cursor.codexHistoryConfirmedSubmissionIds);
	for (const segment of segments) {
		const previous = cursor.codexHistorySegmentCursorsByTranscriptPath[segment.transcriptPath];
		const boundedPrefixEndByteOffset = segment.expectedLocalRecordCount === null ? null : segment.endByteOffset;
		const segmentCursor: z.infer<typeof codexHistorySegmentCursorSchema> =
			previous &&
			previous.fileIdentity === segment.fileIdentity &&
			!segment.rewrittenWithoutAppend &&
			!(
				previous.complete &&
				previous.fileModifiedAtMilliseconds !== segment.fileModifiedAtMilliseconds &&
				segment.fileSizeBytes <= previous.nextByteOffset
			) &&
			previous.nextByteOffset <= segment.endByteOffset &&
			previous.boundedPrefixEndByteOffset === boundedPrefixEndByteOffset &&
			previous.boundedPrefixRecordCount === segment.expectedLocalRecordCount &&
			!(
				previous.sourceIntegrityWarning &&
				previous.fileModifiedAtMilliseconds !== segment.fileModifiedAtMilliseconds
			)
				? { ...previous, stagedSubmissions: [...previous.stagedSubmissions] }
				: {
						...taskUserPromptStatisticsRecordFoldCursorSchema.parse(createEmptyTaskUserPromptStatisticsCursor()),
						pendingCodexRepresentation: precedingPendingRepresentation,
						rejectedDescendantSession: precedingDescendantSessionWasRejected,
						readRecordCount: 0,
						boundedPrefixEndByteOffset,
						boundedPrefixRecordCount: segment.expectedLocalRecordCount,
						fileModifiedAtMilliseconds: segment.fileModifiedAtMilliseconds,
						stagedSubmissions: [],
					};
		segmentCursor.fileIdentity = segment.fileIdentity;
		segmentCursor.fileModifiedAtMilliseconds = segment.fileModifiedAtMilliseconds;
		cursor.codexHistorySegmentCursorsByTranscriptPath[segment.transcriptPath] = segmentCursor;
		if (segmentCursor.nextByteOffset < segment.endByteOffset) {
			if (remainingBytes <= 0) return { cursor, submissions, warning: null };
			const previousByteOffset = segmentCursor.nextByteOffset;
			const maximumBytes = Math.min(remainingBytes, segment.endByteOffset - previousByteOffset);
			const chunk = await readAppendedCompleteJsonLines(segment.transcriptPath, previousByteOffset, maximumBytes);
			remainingBytes -= maximumBytes;
			for (const line of chunk.completeLines) {
				segmentCursor.readRecordCount += 1;
				const record = parseTranscriptJsonRecord(line);
				const payload = readTranscriptRecord(record?.payload);
				if (!record) segmentCursor.sourceIntegrityWarning = "部分转录记录格式无法识别";
				else if (
					(record.type === "session_meta" &&
						(payload?.id !== input.nativeSessionId ||
							(payload.session_id !== undefined && payload.session_id !== input.nativeSessionId))) ||
					(typeof record.sessionId === "string" && record.sessionId !== input.nativeSessionId)
				) {
					if (previous) cursor.codexHistorySegmentCursorsByTranscriptPath[segment.transcriptPath] = previous;
					else delete cursor.codexHistorySegmentCursorsByTranscriptPath[segment.transcriptPath];
					return { cursor, submissions, warning: "原生会话身份与转录不匹配" };
				} else {
					const submission = measureDailyWorkProgressSynchronousStage("transcript_record_fold", () =>
						foldTaskUserPromptStatisticsParsedRecord(input, segmentCursor, record, line),
					);
					if (submission) segmentCursor.stagedSubmissions.push(submission);
				}
			}
			segmentCursor.nextByteOffset = chunk.nextByteOffset;
			if (chunk.nextByteOffset === previousByteOffset) {
				const warning =
					maximumBytes === MAXIMUM_TRANSCRIPT_INCREMENT_BYTES
						? "转录单行超过读取预算"
						: boundedPrefixEndByteOffset !== null && maximumBytes === segment.endByteOffset - previousByteOffset
							? "Codex 父分段字节边界不是完整记录"
							: null;
				return { cursor, submissions, warning };
			}
		}
		const reachedSegmentBoundary = segmentCursor.nextByteOffset === segment.endByteOffset;
		if (boundedPrefixEndByteOffset !== null) {
			if (segmentCursor.sourceIntegrityWarning)
				return { cursor, submissions, warning: segmentCursor.sourceIntegrityWarning };
			if (!reachedSegmentBoundary) return { cursor, submissions, warning: null };
			if (segmentCursor.readRecordCount !== segment.expectedLocalRecordCount) {
				segmentCursor.sourceIntegrityWarning = "Codex 父分段累计记录边界不匹配";
				return { cursor, submissions, warning: segmentCursor.sourceIntegrityWarning };
			}
		}
		// 父前缀的身份、字节和累计 ordinal 全部核对后，才发布暂存的提交；只持久化身份与时间。
		for (const submission of segmentCursor.stagedSubmissions) {
			if (confirmedSubmissionIds.has(submission.submissionId)) continue;
			confirmedSubmissionIds.add(submission.submissionId);
			cursor.codexHistoryConfirmedSubmissionIds.push(submission.submissionId);
			submissions.push(submission);
		}
		segmentCursor.stagedSubmissions = [];
		precedingPendingRepresentation = segmentCursor.pendingCodexRepresentation;
		precedingDescendantSessionWasRejected = segmentCursor.rejectedDescendantSession;
		cursor.pendingCodexRepresentation = precedingPendingRepresentation;
		cursor.rejectedDescendantSession = precedingDescendantSessionWasRejected;
		if (segmentCursor.firstPromptAtEpochMs !== null)
			cursor.firstPromptAtEpochMs = Math.min(
				cursor.firstPromptAtEpochMs ?? Infinity,
				segmentCursor.firstPromptAtEpochMs,
			);
		segmentCursor.complete = reachedSegmentBoundary;
		if (segment.expectedLocalRecordCount === null) {
			cursor.nextByteOffset = segmentCursor.nextByteOffset;
			cursor.fileIdentity = segment.fileIdentity;
			cursor.sourceIntegrityWarning = segmentCursor.sourceIntegrityWarning;
			const warning =
				cursor.sourceIntegrityWarning ?? (cursor.rejectedDescendantSession ? "已排除 agent 分身会话" : null);
			cursor.complete = reachedSegmentBoundary && warning === null;
			return { cursor, submissions, warning };
		}
	}
	return { cursor, submissions, warning: null };
}

export async function readTaskUserPromptStatisticsTranscriptIncrement(
	input: TaskUserPromptStatisticsTranscriptIncrementInput,
): Promise<TaskUserPromptStatisticsTranscriptIncrementResult> {
	if (!input.programmaticReceiptTimeIndex && process.env.KANBAN_DAILY_WORK_PROGRESS_RECEIPT_INDEX_DISABLED !== "1")
		input = {
			...input,
			programmaticReceiptTimeIndex: createProgrammaticPromptReceiptTimeIndex(input.programmaticSubmissionReceipts),
		};
	let cursor = { ...input.cursor };
	const submissions: ConfirmedTaskUserPromptStatisticsSubmission[] = [];
	try {
		if (input.sourceAgentId === "codex") {
			const cachedHeader = input.codexHistoryReadCache
				? await input.codexHistoryReadCache.readPrefix(
						input.transcriptPath,
						input.nativeSessionId,
						MAXIMUM_TRANSCRIPT_INCREMENT_BYTES,
					)
				: null;
			const prefix = cachedHeader
				? null
				: await readAppendedCompleteJsonLines(
						input.transcriptPath,
						0,
						MAXIMUM_TRANSCRIPT_INCREMENT_BYTES,
						"codex_prefix_validation",
					);
			const first =
				cachedHeader?.firstRecord ??
				(prefix?.completeLines[0] ? parseTranscriptJsonRecord(prefix.completeLines[0]) : null);
			if (cachedHeader?.rewrittenWithoutAppend) {
				input = { ...input, codexTranscriptPathsRewrittenWithoutAppend: new Set([resolve(input.transcriptPath)]) };
				if (Object.keys(cursor.codexHistorySegmentCursorsByTranscriptPath).length === 0)
					cursor = createEmptyTaskUserPromptStatisticsCursor();
			}
			if (
				(first?.type === "session_meta" && readTranscriptRecord(first.payload)?.history_base != null) ||
				Object.keys(cursor.codexHistorySegmentCursorsByTranscriptPath).length > 0
			) {
				const result = await readCodexTaskUserPromptHistoryIncrement(input);
				if (result.warning) input.codexHistoryReadCache?.invalidateSession(input.nativeSessionId);
				return result;
			}
		}
		const metadata = await stat(input.transcriptPath);
		const fileIdentity = `${String(metadata.dev)}:${String(metadata.ino)}`;
		if (cursor.fileIdentity !== fileIdentity || metadata.size < cursor.nextByteOffset)
			cursor = createEmptyTaskUserPromptStatisticsCursor();
		cursor.fileIdentity = fileIdentity;
		const chunk = await readAppendedCompleteJsonLines(
			input.transcriptPath,
			cursor.nextByteOffset,
			MAXIMUM_TRANSCRIPT_INCREMENT_BYTES,
		);
		for (const line of chunk.completeLines) {
			const record = parseTranscriptJsonRecord(line);
			if (!record) {
				cursor.sourceIntegrityWarning = "部分转录记录格式无法识别";
				continue;
			}
			const payload = readTranscriptRecord(record.payload);
			if (
				(input.sourceAgentId === "codex" &&
					record.type === "session_meta" &&
					payload?.id !== input.nativeSessionId) ||
				(typeof record.sessionId === "string" && record.sessionId !== input.nativeSessionId)
			) {
				return { cursor: input.cursor, submissions: [], warning: "原生会话身份与转录不匹配" };
			}
			const submission = measureDailyWorkProgressSynchronousStage("transcript_record_fold", () =>
				foldTaskUserPromptStatisticsParsedRecord(input, cursor, record, line),
			);
			if (submission) submissions.push(submission);
		}
		cursor.nextByteOffset = chunk.nextByteOffset;
		cursor.complete = !chunk.appendedBytesRemainBeyondIncrementalReadBudget && chunk.nextByteOffset === metadata.size;
		const unreadableLine =
			chunk.nextByteOffset === input.cursor.nextByteOffset && chunk.appendedBytesRemainBeyondIncrementalReadBudget;
		return {
			cursor,
			submissions,
			warning:
				cursor.sourceIntegrityWarning ??
				(cursor.rejectedDescendantSession
					? "已排除 agent 分身会话"
					: unreadableLine
						? "转录单行超过读取预算"
						: null),
		};
	} catch {
		input.codexHistoryReadCache?.invalidateSession(input.nativeSessionId);
		cursor.complete = false;
		return { cursor, submissions: [], warning: "部分任务转录暂时不可读" };
	}
}
