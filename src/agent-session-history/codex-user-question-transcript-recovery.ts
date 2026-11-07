import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	inferCodexHomeDirectoryPathFromTranscriptPath,
	resolveMigratedCodexConversationHome,
	resolveRecordedCodexConversationHome,
} from "../codex-conversation-storage/codex-conversation-storage-home";
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
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";
import { listKnownCodexTranscriptSegmentPaths } from "./codex-native-conversation-transcript-location-for-resume";
import {
	codexTranscriptJsonlPath,
	openCodexTranscriptReadSource,
	readCodexTranscriptSessionMetadata,
} from "./codex-transcript-read-source";
import { transcriptMetadataMatchesNativeConversationIdentity } from "./persisted-agent-transcript-last-conversation-progress-probe";

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

export interface CodexUserQuestionTranscriptRecoveryInput {
	sessionId: string;
	transcriptPath?: string | null;
	homeDirectoryPath?: string;
	maximumTranscriptBytesToRead?: number;
}

export async function resolveCodexUserQuestionTranscriptRecoveryStorageBinding(
	input: CodexUserQuestionTranscriptRecoveryInput,
) {
	const recordedHomeDirectoryPath = resolve(input.homeDirectoryPath ?? resolveRecordedCodexConversationHome(input));
	const homeDirectoryPath = await resolveMigratedCodexConversationHome(recordedHomeDirectoryPath, input.sessionId);
	const transcriptHomeDirectoryPath = inferCodexHomeDirectoryPathFromTranscriptPath(input.transcriptPath);
	// 正式绑定改变后，旧目录的分片提示不再代表当前分片，也不能重新读入已经归档的旧副本。
	const transcriptPath =
		resolve(homeDirectoryPath) !== recordedHomeDirectoryPath ||
		(transcriptHomeDirectoryPath && resolve(transcriptHomeDirectoryPath) !== resolve(homeDirectoryPath))
			? undefined
			: input.transcriptPath;
	return { ...input, homeDirectoryPath, transcriptPath };
}

export async function recoverCodexUserQuestionsFromKnownConversation(
	input: CodexUserQuestionTranscriptRecoveryInput,
): Promise<RecoveredCodexUserQuestions> {
	const storageBinding = await resolveCodexUserQuestionTranscriptRecoveryStorageBinding(input);
	input = storageBinding;
	let root = join(storageBinding.homeDirectoryPath, "sessions");
	if (input.transcriptPath) {
		try {
			const source = await openCodexTranscriptReadSource(input.transcriptPath, input.sessionId);
			input = { ...input, transcriptPath: source.nativePath };
			await source.close();
		} catch {
			return { exchanges: [], coverage: "unavailable" };
		}
		const selectedStorageRoot = [root, join(storageBinding.homeDirectoryPath, "archived_sessions")].find(
			(candidateRoot) => {
				const location = relative(candidateRoot, resolve(input.transcriptPath as string));
				return !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
			},
		);
		if (!selectedStorageRoot) return { exchanges: [], coverage: "unavailable" };
		root = selectedStorageRoot;
	}
	const paths = new Map(
		(await listKnownCodexTranscriptSegmentPaths(root, input.sessionId, { includeCompressedTranscripts: true })).map(
			(path) => [codexTranscriptJsonlPath(resolve(path)), path],
		),
	);
	if (input.transcriptPath) {
		const key = codexTranscriptJsonlPath(resolve(input.transcriptPath));
		paths.set(key, resolve(input.transcriptPath));
	}
	const segments: CodexTranscriptSegment[] = [];
	for (const filePath of paths.values()) {
		let source: Awaited<ReturnType<typeof openCodexTranscriptReadSource>> | null = null;
		try {
			source = await openCodexTranscriptReadSource(filePath);
			const byteLength = (await source.stat()).size;
			const first = (await readCodexTranscriptSessionMetadata(source)).record;
			const metadata = readTranscriptRecord(first?.payload);
			if (
				first?.type !== "session_meta" ||
				!transcriptMetadataMatchesNativeConversationIdentity(
					{ sourceAgentId: "codex", nativeSessionId: input.sessionId },
					first,
				) ||
				!metadata ||
				metadata.id !== input.sessionId ||
				(metadata.session_id !== undefined && metadata.session_id !== input.sessionId)
			)
				continue;
			const startedAt = Date.parse(
				typeof metadata.timestamp === "string" ? metadata.timestamp : String(first.timestamp),
			);
			const fileName = basename(codexTranscriptJsonlPath(filePath));
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
			if (Number.isFinite(startedAt))
				segments.push({ filePath: source.nativePath, rolloutThreadId, byteLength, startedAt, metadata });
		} catch {
			/* 身份或文件不可验证时不猜测归属。 */
		} finally {
			await source?.close();
		}
	}
	segments.sort(
		(left, right) =>
			left.startedAt - right.startedAt || basename(left.filePath).localeCompare(basename(right.filePath)),
	);
	const current = input.transcriptPath
		? segments.find(
				(segment) =>
					codexTranscriptJsonlPath(resolve(segment.filePath)) ===
					codexTranscriptJsonlPath(resolve(input.transcriptPath as string)),
			)
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
		const transcriptFileHandle = await openCodexTranscriptReadSource(segment.filePath);
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
