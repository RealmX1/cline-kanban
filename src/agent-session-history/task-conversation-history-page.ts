import { createHash } from "node:crypto";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
	inferCodexHomeDirectoryPathFromTranscriptPath,
	resolveMigratedCodexConversationHome,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import type {
	RuntimeBoardCard,
	RuntimeTaskChatMessage,
	RuntimeTaskConversationHistoryPageRequest,
	RuntimeTaskConversationHistoryPageResponse,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { doesConversationSessionBelongToTask } from "../core/task-main-conversation-session-binding";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";
import { listKnownCodexTranscriptSegmentPaths } from "./codex-native-conversation-transcript-location-for-resume";
import { transcriptMetadataMatchesNativeConversationIdentity } from "./persisted-agent-transcript-last-conversation-progress-probe";
import { extractSubmittedUserPromptFromTranscriptRecord } from "./submitted-user-prompt-transcript-record-parser";

const HISTORY_MESSAGES_PER_PAGE = 100;
const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
const MAXIMUM_TRANSCRIPT_RECORD_BYTES = 8 * 1024 * 1024;
const MAXIMUM_TRANSCRIPT_PAGE_READ_BYTES = 16 * 1024 * 1024;
const historyCursorSchema = z.object({
	sourceRevision: z.string(),
	beforeByteOffset: z.number().int().nonnegative(),
	branchTrackingEnabled: z.boolean(),
	expectedAncestorRecordId: z.string().nullable(),
	newerEnvelope: z.object({ kind: z.string(), fingerprint: z.string() }).nullable(),
	segmentThreadId: z.string().nullable(),
	segmentRevision: z.string().nullable(),
});
type HistoryCursor = z.infer<typeof historyCursorSchema>;
const retainedMessagesCursorSchema = z.object({
	retainedMessagesRevision: z.string(),
	beforeMessageIndex: z.number().int().nonnegative(),
});
const codexHistoryBaseSchema = z.object({
	thread_id: z.string().min(1),
	end_byte_offset: z.number().int().positive(),
	end_ordinal_exclusive: z.number().int().positive(),
});

function codexTranscriptSegmentSearchRoot(transcriptPath: string): string {
	let directory = dirname(transcriptPath);
	while (dirname(directory) !== directory) {
		if (basename(directory) === "sessions") return directory;
		directory = dirname(directory);
	}
	return dirname(transcriptPath);
}

function buildUnavailableTaskConversationHistoryPage(notice: string): RuntimeTaskConversationHistoryPageResponse {
	return { availability: "unavailable", messages: [], nextCursor: null, notice };
}

function readNativeTranscriptContentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value, null, 2);
	return value
		.flatMap((value) => {
			const block = readTranscriptRecord(value);
			if (!block) return [];
			if (["text", "input_text", "output_text", "summary_text", "thinking"].includes(String(block.type))) {
				return typeof (block.text ?? block.thinking) === "string" ? [String(block.text ?? block.thinking)] : [];
			}
			if (["image", "input_image", "document", "input_file"].includes(String(block.type))) {
				return ["[原始会话包含图片或文件附件]"];
			}
			return [];
		})
		.join("\n");
}

function projectNativeHistoryRecord(
	record: Record<string, unknown>,
	agentId: string,
	conversationSessionId: string,
	byteOffset: number,
): RuntimeTaskChatMessage[] {
	if (record.isSidechain === true) return [];
	const payload = readTranscriptRecord(record.payload) ?? record;
	const message = readTranscriptRecord(payload.message) ?? payload;
	const rawTimestamp = record.timestamp ?? message.timestamp;
	const timestamp = typeof rawTimestamp === "number" ? rawTimestamp : Date.parse(String(rawTimestamp ?? ""));
	const messages: RuntimeTaskChatMessage[] = [];
	const append = (role: RuntimeTaskChatMessage["role"], content: string, toolName?: string, toolCallId?: string) => {
		if (!content.trim()) return;
		const previousMessage = messages.at(-1);
		if (role === "assistant" && previousMessage?.role === "assistant") {
			previousMessage.content += `\n${content}`;
			return;
		}
		messages.push({
			id: `${conversationSessionId}:${byteOffset}:${messages.length}`,
			role,
			content,
			createdAt: Number.isFinite(timestamp) ? timestamp : 0,
			meta: { toolName, toolCallId },
		});
	};
	const user = extractSubmittedUserPromptFromTranscriptRecord(agentId, record);
	if (user) append("user", user.text);
	else if (
		agentId === "claude" &&
		message.role === "user" &&
		readNativeTranscriptContentText(message.content).trim()
	) {
		// turn 起点分类器拒绝把旧版无来源记录当成人类输入证据；历史阅读仍保留这些正文。
		append("system", readNativeTranscriptContentText(message.content));
	} else if (
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.some((block) => {
			const type = readTranscriptRecord(block)?.type;
			return type === "image" || type === "input_image" || type === "document";
		})
	)
		append("user", readNativeTranscriptContentText(message.content));
	if (message.role === "assistant" && !Array.isArray(message.content))
		append("assistant", readNativeTranscriptContentText(message.content));
	if (record.type === "event_msg" && payload.type === "agent_message")
		append("assistant", readNativeTranscriptContentText(payload.message));
	if (message.role === "toolResult" || message.role === "tool") {
		append(
			"tool",
			readNativeTranscriptContentText(message.content),
			String(message.toolName ?? "工具结果"),
			String(message.toolCallId ?? ""),
		);
	}
	for (const value of Array.isArray(message.content) ? message.content : [payload]) {
		const block = readTranscriptRecord(value);
		if (!block) continue;
		const type = String(block.type);
		const toolCallId = String(block.call_id ?? block.tool_use_id ?? block.id ?? "");
		if (["tool_use", "toolCall", "function_call", "custom_tool_call"].includes(type)) {
			const argumentsValue = block.input ?? block.arguments;
			append(
				"tool",
				typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue ?? {}, null, 2),
				String(block.name ?? "工具调用"),
				toolCallId,
			);
		} else if (["tool_result", "function_call_output", "custom_tool_call_output"].includes(type)) {
			append("tool", readNativeTranscriptContentText(block.content ?? block.output), "工具结果", toolCallId);
		} else if (type === "reasoning" || type === "thinking") {
			append("reasoning", readNativeTranscriptContentText(block.summary ?? block.content ?? block.thinking));
		} else if (message.role === "assistant") {
			append("assistant", readNativeTranscriptContentText([block]));
		}
	}
	return messages;
}

// 按 LF 的字节边界倒读，U+2028/U+2029 只是 JSON 正文，不能被 readline 当成换行。
async function* readCompleteTranscriptLinesBackwards(handle: FileHandle, beforeByteOffset: number) {
	let endOffset = beforeByteOffset;
	let incompletePrefix = Buffer.alloc(0);
	let bytesReadForPage = 0;
	while (endOffset > 0 && bytesReadForPage < MAXIMUM_TRANSCRIPT_PAGE_READ_BYTES) {
		const startOffset = Math.max(0, endOffset - TRANSCRIPT_READ_CHUNK_BYTES);
		const chunk = Buffer.alloc(endOffset - startOffset);
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, startOffset);
		if (bytesRead !== chunk.length) throw new Error("会话记录读取期间发生变化，请刷新后重试。");
		bytesReadForPage += bytesRead;
		const combined = Buffer.concat([chunk, incompletePrefix]);
		let lineEnd = combined.length;
		for (let index = combined.length - 1; index >= 0; index--) {
			if (combined[index] !== 10) continue;
			if (lineEnd > index + 1) {
				const line = combined.subarray(index + 1, lineEnd);
				if (line.length > MAXIMUM_TRANSCRIPT_RECORD_BYTES)
					throw new Error("单条会话记录过大，无法完整展示这一页。");
				yield { text: line.toString("utf8"), startOffset: startOffset + index + 1 };
			}
			lineEnd = index;
		}
		incompletePrefix = combined.subarray(0, lineEnd);
		if (incompletePrefix.length > MAXIMUM_TRANSCRIPT_RECORD_BYTES)
			throw new Error("单条会话记录过大，无法完整展示这一页。");
		endOffset = startOffset;
		if (startOffset === 0 && incompletePrefix.length > 0)
			yield { text: incompletePrefix.toString("utf8"), startOffset: 0 };
	}
}

async function assertNativeTranscriptIdentity(
	handle: FileHandle,
	summary: RuntimeTaskSessionSummary,
): Promise<Record<string, unknown> | null> {
	const identity = summary.agentNativeConversationSessionIdentity;
	if (!identity) throw new Error("缺少可信原生会话身份，无法读取历史。");
	let prefix = Buffer.alloc(0);
	let position = 0;
	while (position < MAXIMUM_TRANSCRIPT_PAGE_READ_BYTES) {
		const chunk = Buffer.alloc(TRANSCRIPT_READ_CHUNK_BYTES);
		const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
		if (bytesRead === 0) break;
		position += bytesRead;
		prefix = Buffer.concat([prefix, chunk.subarray(0, bytesRead)]);
		let start = 0;
		for (let index = 0; index < prefix.length; index++) {
			if (prefix[index] !== 10) continue;
			const record = parseTranscriptJsonRecord(prefix.subarray(start, index).toString("utf8"));
			start = index + 1;
			if (!record) continue;
			if (!transcriptMetadataMatchesNativeConversationIdentity(identity, record))
				throw new Error("原生会话身份与记录不匹配。");
			const payload = readTranscriptRecord(record.payload);
			if (identity.sourceAgentId === "codex" && record.type === "session_meta") {
				const source = readTranscriptRecord(payload?.source);
				if (source?.internal || ["memory_consolidation", "guardian_review"].includes(String(payload?.source)))
					throw new Error("该记录属于后台作业，不能作为任务会话历史。");
				return payload;
			}
			if (
				(identity.sourceAgentId === "claude" && record.sessionId === identity.nativeSessionId) ||
				(identity.sourceAgentId === "omp" && record.type === "session" && record.id === identity.nativeSessionId)
			)
				return null;
		}
		prefix = prefix.subarray(start);
		if (prefix.length > MAXIMUM_TRANSCRIPT_RECORD_BYTES) break;
	}
	throw new Error("无法核实这份记录的原生会话身份。");
}

function decodeTaskConversationHistoryCursor(cursor: string | null | undefined): HistoryCursor | null {
	if (!cursor) return null;
	try {
		return historyCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
	} catch {
		throw new Error("历史分页标记无效，请刷新后重试。");
	}
}

function encodeTaskConversationHistoryCursor(cursor: HistoryCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function loadRetainedMessagesPage(
	request: RuntimeTaskConversationHistoryPageRequest,
	summary: RuntimeTaskSessionSummary,
	messages: readonly RuntimeTaskChatMessage[],
): RuntimeTaskConversationHistoryPageResponse {
	const retainedMessagesRevision = createHash("sha256")
		.update(JSON.stringify([summary.taskId, messages]))
		.digest("hex");
	let beforeMessageIndex = messages.length;
	if (request.cursor) {
		const cursor = retainedMessagesCursorSchema.safeParse(
			JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")),
		);
		if (
			!cursor.success ||
			cursor.data.retainedMessagesRevision !== retainedMessagesRevision ||
			cursor.data.beforeMessageIndex > messages.length
		)
			return buildUnavailableTaskConversationHistoryPage("运行实例保留的消息已变化，或分页标记无效，请刷新后重试。");
		beforeMessageIndex = cursor.data.beforeMessageIndex;
	}
	const firstMessageIndex = Math.max(0, beforeMessageIndex - HISTORY_MESSAGES_PER_PAGE);
	return {
		availability: "partially_available",
		messages: messages.slice(firstMessageIndex, beforeMessageIndex),
		nextCursor:
			firstMessageIndex > 0
				? Buffer.from(JSON.stringify({ retainedMessagesRevision, beforeMessageIndex: firstMessageIndex })).toString(
						"base64url",
					)
				: null,
		notice: "显示当前运行实例保留的消息，持久会话记录暂不可用。",
	};
}

export interface LoadTaskConversationHistoryPageInput {
	request: RuntimeTaskConversationHistoryPageRequest;
	card: RuntimeBoardCard | null;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	retainedMessages?: readonly RuntimeTaskChatMessage[];
}

async function resolveTaskConversationHistorySummaryForCodexStorageBinding(summary: RuntimeTaskSessionSummary) {
	const nativeConversationIdentity = summary.agentNativeConversationSessionIdentity;
	if (nativeConversationIdentity?.sourceAgentId !== "codex" || resolveSessionFacets(summary).liveness === "live")
		return summary;
	const recordedCodexConversationStorageHomeDirectoryPath =
		inferCodexHomeDirectoryPathFromTranscriptPath(nativeConversationIdentity.transcriptPath) ??
		summary.codexConversationStorageHomeDirectoryPath;
	if (!recordedCodexConversationStorageHomeDirectoryPath) return summary;
	const authoritativeCodexConversationStorageHomeDirectoryPath = await resolveMigratedCodexConversationHome(
		recordedCodexConversationStorageHomeDirectoryPath,
		nativeConversationIdentity.nativeSessionId,
	);
	if (
		resolve(authoritativeCodexConversationStorageHomeDirectoryPath) ===
		resolve(recordedCodexConversationStorageHomeDirectoryPath)
	)
		return summary;
	// 正式迁移或回退后，旧 summary 的路径可以已归档或过期；只读原生当前指针，不启动 agent 或猜选分片。
	const nativeCodexStateDatabase = new Database(
		join(authoritativeCodexConversationStorageHomeDirectoryPath, "state_5.sqlite"),
		{ readonly: true, fileMustExist: true },
	);
	let authoritativeTranscriptPath: string;
	try {
		authoritativeTranscriptPath = z
			.object({ rollout_path: z.string() })
			.parse(
				nativeCodexStateDatabase
					.prepare("SELECT rollout_path FROM threads WHERE id = ?")
					.get(nativeConversationIdentity.nativeSessionId),
			).rollout_path;
	} finally {
		nativeCodexStateDatabase.close();
	}
	const transcriptPathRelativeToAuthoritativeHome = relative(
		await realpath(authoritativeCodexConversationStorageHomeDirectoryPath),
		await realpath(authoritativeTranscriptPath),
	);
	if (
		isAbsolute(transcriptPathRelativeToAuthoritativeHome) ||
		transcriptPathRelativeToAuthoritativeHome === ".." ||
		transcriptPathRelativeToAuthoritativeHome.startsWith(`..${sep}`)
	)
		throw new Error("原生历史指针超出已绑定存储目录，未读取其他来源。");
	return {
		...summary,
		agentNativeConversationSessionIdentity: {
			...nativeConversationIdentity,
			transcriptPath: authoritativeTranscriptPath,
		},
	};
}

export async function loadTaskConversationHistoryPage(
	input: LoadTaskConversationHistoryPageInput,
): Promise<RuntimeTaskConversationHistoryPageResponse> {
	const { request, card, sessions } = input;
	let summary = sessions[request.taskConversationSessionId];
	if (
		!card ||
		card.id !== request.workspaceTaskId ||
		!summary ||
		!doesConversationSessionBelongToTask(summary, card.id)
	)
		return buildUnavailableTaskConversationHistoryPage("找不到归属于此任务的会话历史。");
	if (request.cursor) {
		try {
			const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
			if (retainedMessagesCursorSchema.safeParse(cursor).success)
				return loadRetainedMessagesPage(request, summary, input.retainedMessages ?? []);
		} catch {
			return buildUnavailableTaskConversationHistoryPage("历史分页标记无效，请刷新后重试。");
		}
	}
	const identity = summary.agentNativeConversationSessionIdentity;
	if (
		!identity?.transcriptPath ||
		identity.sourceAgentId !== summary.agentId ||
		!["claude", "codex", "omp"].includes(identity.sourceAgentId)
	) {
		if (input.retainedMessages?.length) {
			try {
				return loadRetainedMessagesPage(request, summary, input.retainedMessages);
			} catch {
				return buildUnavailableTaskConversationHistoryPage("历史分页标记无效，请刷新后重试。");
			}
		}
		return buildUnavailableTaskConversationHistoryPage(
			"此会话缺少可读取的可信持久记录；任务工作台的其他信息仍然可用。",
		);
	}
	let handle: FileHandle | null = null;
	try {
		summary = await resolveTaskConversationHistorySummaryForCodexStorageBinding(summary);
		const identity = summary.agentNativeConversationSessionIdentity;
		if (!identity?.transcriptPath) return buildUnavailableTaskConversationHistoryPage("缺少当前绑定的会话记录。");
		try {
			handle = await open(identity.transcriptPath, "r");
		} catch (error) {
			if (
				!request.cursor &&
				input.retainedMessages?.length &&
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			)
				return loadRetainedMessagesPage(request, summary, input.retainedMessages);
			throw error;
		}
		let metadata = await handle.stat();
		if (!metadata.isFile()) return buildUnavailableTaskConversationHistoryPage("会话记录不是可读取的文件。");
		const rootMetadata = metadata;
		const sourceRevision = createHash("sha256")
			.update(
				JSON.stringify([
					card.id,
					summary.taskId,
					identity,
					metadata.dev,
					metadata.ino,
					metadata.size,
					metadata.mtimeMs,
				]),
			)
			.digest("hex");
		const decodedCursor = decodeTaskConversationHistoryCursor(request.cursor);
		if (decodedCursor && decodedCursor.sourceRevision !== sourceRevision)
			return buildUnavailableTaskConversationHistoryPage("会话记录已变化，请刷新后重新加载历史。");
		let segmentMetadata = await assertNativeTranscriptIdentity(handle, summary);
		const cursor: HistoryCursor = decodedCursor ?? {
			sourceRevision,
			beforeByteOffset: metadata.size,
			branchTrackingEnabled: false,
			expectedAncestorRecordId: null,
			newerEnvelope: null,
			segmentThreadId: null,
			segmentRevision: null,
		};
		let knownCodexSegmentPaths: string[] | null = null;
		const findParentSegment = async (threadId: string): Promise<string | null> => {
			knownCodexSegmentPaths ??= await listKnownCodexTranscriptSegmentPaths(
				codexTranscriptSegmentSearchRoot(identity.transcriptPath as string),
				identity.nativeSessionId,
			);
			const matching = knownCodexSegmentPaths.filter((path) =>
				basename(path).endsWith(
					threadId === identity.nativeSessionId
						? `-${identity.nativeSessionId}.jsonl`
						: `${identity.nativeSessionId}_${threadId}.jsonl`,
				),
			);
			return matching.length === 1 ? (matching[0] ?? null) : null;
		};
		let selectedSegmentThreadId: string | null = null;
		let selectedSegmentEndByteOffset = metadata.size;
		const visitedSegmentPaths = new Set([identity.transcriptPath]);
		while (selectedSegmentThreadId !== cursor.segmentThreadId) {
			const base = codexHistoryBaseSchema.safeParse(segmentMetadata?.history_base);
			if (
				identity.sourceAgentId !== "codex" ||
				segmentMetadata?.history_mode !== "paginated" ||
				!base.success ||
				visitedSegmentPaths.size >= 32
			)
				return buildUnavailableTaskConversationHistoryPage("更早的会话分段链无法核实，请刷新后重试。");
			const parentPath = await findParentSegment(base.data.thread_id);
			if (!parentPath || visitedSegmentPaths.has(parentPath))
				return buildUnavailableTaskConversationHistoryPage("更早的会话分段缺失或归属不唯一。");
			visitedSegmentPaths.add(parentPath);
			await handle.close();
			handle = null;
			handle = await open(parentPath, "r");
			metadata = await handle.stat();
			segmentMetadata = await assertNativeTranscriptIdentity(handle, summary);
			selectedSegmentThreadId = base.data.thread_id;
			selectedSegmentEndByteOffset = base.data.end_byte_offset;
			if (selectedSegmentEndByteOffset > metadata.size)
				return buildUnavailableTaskConversationHistoryPage("更早的会话分段已截断，请刷新后重试。");
			const boundary = Buffer.alloc(1);
			await handle.read(boundary, 0, 1, selectedSegmentEndByteOffset - 1);
			if (boundary[0] !== 10)
				return buildUnavailableTaskConversationHistoryPage("更早的会话分段截点不是完整记录边界。");
		}
		if (cursor.beforeByteOffset > selectedSegmentEndByteOffset)
			return buildUnavailableTaskConversationHistoryPage("历史分页位置超过该分段的有效范围。");
		const segmentRevision = createHash("sha256")
			.update(
				JSON.stringify([metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, selectedSegmentEndByteOffset]),
			)
			.digest("hex");
		if (cursor.segmentRevision !== null && cursor.segmentRevision !== segmentRevision)
			return buildUnavailableTaskConversationHistoryPage("更早的会话记录已变化，请刷新后重试。");
		cursor.segmentRevision = segmentRevision;
		const newestMessagesFirst: RuntimeTaskChatMessage[] = [];
		let notice: string | null = null;
		for await (const line of readCompleteTranscriptLinesBackwards(handle, cursor.beforeByteOffset)) {
			cursor.beforeByteOffset = line.startOffset;
			if (!line.text.trim()) continue;
			const record = parseTranscriptJsonRecord(line.text);
			if (!record) {
				notice = "部分会话记录损坏，已展示可读取的内容。";
				continue;
			}
			if (record.isSidechain === true) continue;
			if (!transcriptMetadataMatchesNativeConversationIdentity(identity, record))
				return buildUnavailableTaskConversationHistoryPage("原生会话身份与记录不匹配。");
			const parentField =
				identity.sourceAgentId === "claude" ? "parentUuid" : identity.sourceAgentId === "omp" ? "parentId" : null;
			const recordId = identity.sourceAgentId === "claude" ? record.uuid : record.id;
			if (parentField && parentField in record && typeof recordId === "string") {
				if (cursor.branchTrackingEnabled && cursor.expectedAncestorRecordId !== recordId) continue;
				cursor.branchTrackingEnabled = true;
				cursor.expectedAncestorRecordId = typeof record[parentField] === "string" ? record[parentField] : null;
			}
			const projected = projectNativeHistoryRecord(
				record,
				identity.sourceAgentId,
				JSON.stringify([summary.taskId, selectedSegmentThreadId]),
				line.startOffset,
			);
			if (projected.length === 0) continue;
			if (identity.sourceAgentId === "codex") {
				const fingerprint = createHash("sha256")
					.update(JSON.stringify(projected.map(({ role, content }) => [role, content])))
					.digest("hex");
				const kind = String(record.type);
				if (
					cursor.newerEnvelope?.fingerprint === fingerprint &&
					cursor.newerEnvelope.kind !== kind &&
					["event_msg", "response_item"].includes(kind) &&
					["event_msg", "response_item"].includes(cursor.newerEnvelope.kind)
				) {
					cursor.newerEnvelope = null;
					continue;
				}
				cursor.newerEnvelope = { kind, fingerprint };
			}
			newestMessagesFirst.push(...projected.reverse());
			if (newestMessagesFirst.length >= HISTORY_MESSAGES_PER_PAGE) break;
		}
		if (cursor.beforeByteOffset === 0 && cursor.branchTrackingEnabled && cursor.expectedAncestorRecordId !== null)
			notice = "会话分支的部分祖先记录不可用，已展示可确认的内容。";
		if (
			cursor.beforeByteOffset === 0 &&
			identity.sourceAgentId === "codex" &&
			segmentMetadata?.history_mode === "paginated" &&
			segmentMetadata.history_base != null
		) {
			const base = codexHistoryBaseSchema.safeParse(segmentMetadata.history_base);
			const parentPath = base.success ? await findParentSegment(base.data.thread_id) : null;
			if (base.success && parentPath && !visitedSegmentPaths.has(parentPath)) {
				cursor.segmentThreadId = base.data.thread_id;
				cursor.segmentRevision = null;
				cursor.beforeByteOffset = base.data.end_byte_offset;
			} else notice = "更早的会话分段不可用，当前展示的历史尚不完整。";
		}
		const latestMetadata = await handle.stat();
		const latestRootMetadata = await stat(identity.transcriptPath);
		if (
			latestMetadata.size !== metadata.size ||
			latestMetadata.mtimeMs !== metadata.mtimeMs ||
			latestRootMetadata.dev !== rootMetadata.dev ||
			latestRootMetadata.ino !== rootMetadata.ino ||
			latestRootMetadata.size !== rootMetadata.size ||
			latestRootMetadata.mtimeMs !== rootMetadata.mtimeMs
		)
			return buildUnavailableTaskConversationHistoryPage("会话记录读取期间发生变化，请刷新后重试。");
		return {
			availability: notice ? "partially_available" : "available",
			messages: newestMessagesFirst.reverse(),
			nextCursor: cursor.beforeByteOffset > 0 ? encodeTaskConversationHistoryCursor(cursor) : null,
			notice,
		};
	} catch (error) {
		return buildUnavailableTaskConversationHistoryPage(
			error instanceof Error && !String(error.message).includes("ENOENT")
				? error.message
				: "会话记录不存在或已被移走。",
		);
	} finally {
		await handle?.close();
	}
}
