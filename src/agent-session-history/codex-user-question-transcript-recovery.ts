import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	extractCodexUserQuestionPayload,
	extractCodexUserQuestionResolution,
} from "../commands/codex-user-question-payload-extraction";
import { splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText } from "../core/agent-terminal-multi-select-answer-text-parsing";
import type {
	RuntimeAgentRaisedUserDecisionHistoryEntry,
	RuntimeAgentRaisedUserQuestionPayload,
	RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload,
} from "../core/api-contract";
import {
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
	readTranscriptRecord,
} from "./bounded-agent-transcript-reader";
import { listKnownCodexTranscriptSegmentPaths } from "./codex-native-conversation-transcript-location-for-resume";

export interface CodexUserQuestionTranscriptExchange {
	callId: string;
	askedAt: number;
	payload: RuntimeAgentRaisedUserQuestionPayload;
	resolution: RuntimeAgentRaisedUserQuestionResolvedInAgentTerminalPayload | null;
	resolvedAt: number | null;
}

export function projectCodexUserQuestionTranscriptLines(
	lines: readonly string[],
	nativeSessionId?: string,
): CodexUserQuestionTranscriptExchange[] {
	const exchanges = new Map<string, CodexUserQuestionTranscriptExchange>();
	for (const line of lines) {
		const record = parseTranscriptJsonRecord(line);
		if (!record) continue;
		const payload = readTranscriptRecord(record.payload);
		if (!payload) continue;
		const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
		// 新进程的 session_meta 是活体边界；旧工具调用不会因为旧画面的重播继续等待键盘输入。
		if (record.type === "session_meta") {
			for (const exchange of exchanges.values()) {
				if (exchange.resolution === null)
					exchange.resolution = {
						decisionSourceId: exchange.payload.decisionSourceId,
						sourceAgentId: "codex",
						...(nativeSessionId ? { nativeConversationSessionId: nativeSessionId } : {}),
						resolutionKind: "interrupted_without_answer",
						answersForQuestions: [],
					};
			}
			continue;
		}
		// 用户答案可能已被 verified_answer 持久化，而进程在 PostToolUse 结束前退出，尚未来得及写工具结果。
		// 只接受精确 call id、完整逐问数量与问题正文边界，绝不从 TUI 或普通用户消息猜答案。
		if (
			record.type === "retained_context" &&
			payload.type === "verified_answer" &&
			typeof payload.call_id === "string"
		) {
			const exchange = exchanges.get(payload.call_id);
			const verifiedQuestions = Array.isArray(payload.questions) ? payload.questions.map(readTranscriptRecord) : [];
			if (
				exchange &&
				exchange.resolution?.resolutionKind !== "answered_in_agent_terminal" &&
				verifiedQuestions.length === exchange.payload.orderedQuestions.length &&
				verifiedQuestions.every((entry, index) => {
					const questionText = exchange.payload.orderedQuestions[index]?.questionMarkdown;
					return (
						entry &&
						typeof entry.answer === "string" &&
						entry.answer.trim().length > 0 &&
						typeof entry.question === "string" &&
						(entry.question === questionText || entry.question.startsWith(`${questionText}\n`))
					);
				})
			) {
				const answers = Object.fromEntries(
					exchange.payload.orderedQuestions.map((question, index) => [
						question.decisionQuestionId,
						{ answers: [verifiedQuestions[index]?.answer] },
					]),
				);
				exchange.resolution = extractCodexUserQuestionResolution({
					callId: exchange.callId,
					payload: exchange.payload,
					toolResponse: { answers },
				});
				exchange.resolvedAt = Number.isFinite(timestamp) ? timestamp : null;
			}
			continue;
		}
		if (record.type !== "response_item") continue;
		if (
			payload.type === "function_call" &&
			payload.name === "request_user_input" &&
			typeof payload.call_id === "string" &&
			typeof payload.arguments === "string" &&
			Number.isFinite(timestamp)
		) {
			if (exchanges.has(payload.call_id)) continue;
			try {
				const question = extractCodexUserQuestionPayload({
					callId: payload.call_id,
					toolInput: readTranscriptRecord(JSON.parse(payload.arguments) as unknown),
					nativeConversationSessionId: nativeSessionId,
				});
				if (question)
					exchanges.set(payload.call_id, {
						callId: payload.call_id,
						askedAt: timestamp,
						payload: question,
						resolution: null,
						resolvedAt: null,
					});
			} catch {
				/* 不完整或非法参数不能补录为可作答问题。 */
			}
		} else if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
			const exchange = exchanges.get(payload.call_id);
			if (!exchange || exchange.resolution?.resolutionKind === "answered_in_agent_terminal") continue;
			exchange.resolution = extractCodexUserQuestionResolution({
				callId: exchange.callId,
				payload: exchange.payload,
				toolResponse: payload.output,
			});
			exchange.resolvedAt = Number.isFinite(timestamp) ? timestamp : null;
		}
	}
	return [...exchanges.values()];
}

export function buildCodexUserQuestionTranscriptHistoryEntries(
	taskId: string,
	exchanges: readonly CodexUserQuestionTranscriptExchange[],
): RuntimeAgentRaisedUserDecisionHistoryEntry[] {
	return exchanges.flatMap((exchange, index) => {
		const answered = exchange.resolution?.resolutionKind === "answered_in_agent_terminal";
		const successor = exchanges[index + 1];
		const resolution = answered
			? "answered_in_agent_terminal"
			: successor
				? "superseded_by_later_question_without_answer"
				: exchange.resolution?.resolutionKind;
		if (!resolution) return [];
		return [
			{
				historyEntryId: `transcript:${exchange.payload.decisionSourceId}`,
				taskId,
				recordSource: "agent_conversation_transcript" as const,
				decisionKind: "ordinary_user_question" as const,
				askedAt: exchange.askedAt,
				resolvedAt: answered ? exchange.resolvedAt : (successor?.askedAt ?? null),
				resolution,
				orderedQuestions: exchange.payload.orderedQuestions,
				questionAnswers: exchange.payload.orderedQuestions.map((question, questionIndex) => {
					const text = exchange.resolution?.answersForQuestions[questionIndex]?.answerText;
					const parsed = text
						? splitAgentTerminalAnswerTextIntoSelectedOptionLabelsAndFreeformAnswerText(
								text,
								question.options.map((option) => option.label),
							)
						: { selectedOptionLabels: [], freeformAnswerText: null };
					return { decisionQuestionId: question.decisionQuestionId, ...parsed, notesText: null };
				}),
				answerDeliveryState: null,
			},
		];
	});
}

interface CodexTranscriptSegment {
	filePath: string;
	rolloutThreadId: string | null;
	byteLength: number;
	startedAt: number;
	metadata: Record<string, unknown>;
}

export interface RecoveredCodexUserQuestions {
	exchanges: CodexUserQuestionTranscriptExchange[];
	coverage: "complete" | "incomplete" | "unavailable";
}

export async function recoverCodexUserQuestionsFromKnownConversation(input: {
	sessionId: string;
	transcriptPath?: string | null;
	homeDirectoryPath?: string;
	maximumTranscriptBytesToRead?: number;
}): Promise<RecoveredCodexUserQuestions> {
	const root = join(
		input.homeDirectoryPath ?? process.env.CODEX_HOME?.trim() ?? join(homedir(), ".codex"),
		"sessions",
	);
	const paths = new Set(
		(await listKnownCodexTranscriptSegmentPaths(root, input.sessionId)).map((path) => resolve(path)),
	);
	if (input.transcriptPath) paths.add(resolve(input.transcriptPath));
	const segments: CodexTranscriptSegment[] = [];
	for (const filePath of paths) {
		try {
			const byteLength = (await stat(filePath)).size;
			const prefix = await readBoundedJsonLines(filePath, Math.min(byteLength, 256 * 1024), 256 * 1024);
			const first = prefix.lines[0] ? parseTranscriptJsonRecord(prefix.lines[0]) : null;
			const metadata = readTranscriptRecord(first?.payload);
			if (
				first?.type !== "session_meta" ||
				!metadata ||
				metadata.id !== input.sessionId ||
				(metadata.session_id !== undefined && metadata.session_id !== input.sessionId)
			)
				continue;
			const startedAt = Date.parse(
				typeof metadata.timestamp === "string" ? metadata.timestamp : String(first.timestamp),
			);
			const fileName = basename(filePath);
			const resumedRolloutMarker = `-${input.sessionId}_`;
			const resumedRolloutMarkerIndex = fileName.lastIndexOf(resumedRolloutMarker);
			const resumedRolloutThreadId =
				resumedRolloutMarkerIndex >= 0
					? fileName.slice(resumedRolloutMarkerIndex + resumedRolloutMarker.length, -6)
					: null;
			// 原生会话 id 在恢复后保持不变；history_base 引用的是父文件名中的 rollout 身份。
			const rolloutThreadId = fileName.endsWith(`-${input.sessionId}.jsonl`)
				? input.sessionId
				: resumedRolloutThreadId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(resumedRolloutThreadId)
					? resumedRolloutThreadId
					: null;
			if (Number.isFinite(startedAt)) segments.push({ filePath, rolloutThreadId, byteLength, startedAt, metadata });
		} catch {
			/* 身份或文件不可验证时不猜测归属。 */
		}
	}
	segments.sort(
		(left, right) =>
			left.startedAt - right.startedAt || basename(left.filePath).localeCompare(basename(right.filePath)),
	);
	const current = input.transcriptPath
		? segments.find((segment) => resolve(segment.filePath) === resolve(input.transcriptPath as string))
		: segments.at(-1);
	if (!current) return { exchanges: [], coverage: "unavailable" };
	// EXPERIMENT_NODE: 32 MiB 按需恢复预算需结合真实长会话体量和查询耗时校准；超预算必须如实返回覆盖不足。
	let remainingBytes = input.maximumTranscriptBytesToRead ?? 32 * 1024 * 1024;
	const visited = new Set<string>();
	const readSegment = async (
		segment: CodexTranscriptSegment,
		endByteOffset: number,
	): Promise<{ lines: string[]; complete: boolean }> => {
		if (
			visited.has(segment.filePath) ||
			endByteOffset > segment.byteLength ||
			endByteOffset > remainingBytes ||
			endByteOffset <= 0
		)
			return { lines: [], complete: false };
		visited.add(segment.filePath);
		remainingBytes -= endByteOffset;
		const transcriptFileHandle = await open(segment.filePath, "r");
		let transcriptPrefixBuffer: Buffer;
		try {
			transcriptPrefixBuffer = Buffer.allocUnsafe(endByteOffset);
			const { bytesRead } = await transcriptFileHandle.read(transcriptPrefixBuffer, 0, endByteOffset, 0);
			// 分页字节边界必须落在整条 JSONL 记录之后，不能碰巧截出一段合法 JSON。
			if (
				bytesRead !== endByteOffset ||
				(endByteOffset < segment.byteLength && transcriptPrefixBuffer[endByteOffset - 1] !== 0x0a)
			)
				return { lines: [], complete: false };
		} finally {
			await transcriptFileHandle.close();
		}
		const lines = transcriptPrefixBuffer.toString("utf8").split(/\r?\n/u).filter(Boolean);
		let complete = lines.every((line) => parseTranscriptJsonRecord(line) !== null);
		let prefix: string[] = [];
		if (segment.metadata.history_mode === "paginated" && segment.metadata.history_base != null) {
			const base = readTranscriptRecord(segment.metadata.history_base);
			const matchingParentSegments = segments.filter((candidate) => candidate.rolloutThreadId === base?.thread_id);
			const parentSegment = matchingParentSegments.length === 1 ? matchingParentSegments[0] : null;
			if (
				!base ||
				typeof base.thread_id !== "string" ||
				!Number.isSafeInteger(base.end_byte_offset) ||
				!Number.isSafeInteger(base.end_ordinal_exclusive) ||
				!parentSegment
			)
				complete = false;
			else {
				const recoveredParentPrefix = await readSegment(parentSegment, base.end_byte_offset as number);
				if (recoveredParentPrefix.complete && recoveredParentPrefix.lines.length === base.end_ordinal_exclusive)
					prefix = recoveredParentPrefix.lines;
				else complete = false;
			}
		}
		return { lines: [...prefix, ...lines], complete };
	};
	try {
		const recoveredCurrentSegment = await readSegment(current, current.byteLength);
		const lines = recoveredCurrentSegment.lines;
		let complete = recoveredCurrentSegment.complete;
		const exchanges = projectCodexUserQuestionTranscriptLines(lines, input.sessionId);
		for (const line of lines) {
			const record = parseTranscriptJsonRecord(line);
			const payload = readTranscriptRecord(record?.payload);
			if (
				payload?.name === "request_user_input" &&
				(!exchanges.some((exchange) => exchange.callId === payload.call_id) || payload.type !== "function_call")
			)
				complete = false;
		}
		return {
			exchanges,
			coverage: complete ? "complete" : "incomplete",
		};
	} catch {
		return { exchanges: [], coverage: "incomplete" };
	}
}
