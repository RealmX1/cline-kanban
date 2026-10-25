// Kimi 2.x wire 1.5 的主会话接受证据；路径只用于读取，绝不反向生成原生会话身份。
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readAppendedCompleteJsonLines } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { getKanbanManagedKimiCodeHome } from "../terminal/kimi-hook-config";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
	splitCompleteJsonLines,
} from "./bounded-agent-transcript-reader";
import type {
	NativeAgentConversationActivityReadResult,
	ReadNativeAgentConversationActivityInput,
} from "./native-agent-conversation-activity-reader";
import type { NativeAgentConversationTranscriptActivityObservation } from "./native-agent-conversation-transcript-activity";

const MAX_KIMI_WIRE_READ_BYTES = 256 * 1024;
const MAX_KIMI_SESSION_INDEX_READ_BYTES = 1024 * 1024;
const MAX_KIMI_STATE_READ_BYTES = 1024 * 1024;
const MAX_KIMI_REMEMBERED_MESSAGE_IDS = 512;

export interface KimiNativeConversationActivityReadCursor {
	transport: "kimi_wire";
	transcriptPath: string;
	fileIdentity: string;
	nextByteOffset: number;
	baselineAtMs: number;
	seenEventIds: string[];
	baselineIgnoredEventIds: string[];
	lastLookedBackPendingAttemptAtMs: number | null;
	promptTurnIds: Array<{ messageId: string; turnId: number }>;
	endedTurnIds: number[];
}

async function readBoundedCompleteTail(path: string, maximumBytes: number) {
	const handle = await open(path, "r");
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile()) return null;
		const offset = Math.max(0, metadata.size - maximumBytes);
		const buffer = Buffer.alloc(Math.min(metadata.size, maximumBytes));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		const completeByteLength = buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1;
		return {
			lines: splitCompleteJsonLines(
				buffer.subarray(0, completeByteLength),
				offset === 0 ? "file_start" : "file_end",
			),
			nextByteOffset: offset + completeByteLength,
			fileIdentity: `${metadata.dev}:${metadata.ino}`,
		};
	} finally {
		await handle.close();
	}
}

async function readBoundedJsonObject(path: string): Promise<Record<string, unknown> | null> {
	const handle = await open(path, "r");
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > MAX_KIMI_STATE_READ_BYTES) return null;
		const buffer = Buffer.alloc(metadata.size);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return parseTranscriptJsonRecord(buffer.subarray(0, bytesRead).toString("utf8"));
	} finally {
		await handle.close();
	}
}

export async function resolveExactKimiMainWirePath(
	input: Pick<ReadNativeAgentConversationActivityInput, "summary">,
): Promise<string | null> {
	const identity = input.summary.agentNativeConversationSessionIdentity;
	const cwd = input.summary.workspacePath;
	if (identity?.sourceAgentId !== "kimi" || !identity.nativeSessionId || input.summary.agentId !== "kimi" || !cwd)
		return null;
	const home = getKanbanManagedKimiCodeHome();
	const index = await readBoundedCompleteTail(join(home, "session_index.jsonl"), MAX_KIMI_SESSION_INDEX_READ_BYTES);
	if (!index) return null;
	const matchingDirectories = new Set<string>();
	for (const line of index.lines) {
		const record = parseTranscriptJsonRecord(line);
		if (
			record?.sessionId === identity.nativeSessionId &&
			typeof record.workDir === "string" &&
			resolve(record.workDir) === resolve(cwd) &&
			typeof record.sessionDir === "string" &&
			isAbsolute(record.sessionDir)
		)
			matchingDirectories.add(record.sessionDir);
	}
	if (matchingDirectories.size !== 1) return null;
	const directory = await realpath([...matchingDirectories][0]);
	const sessionsRoot = await realpath(join(home, "sessions"));
	const relativeDirectory = relative(sessionsRoot, directory);
	if (!relativeDirectory || relativeDirectory.startsWith("..") || isAbsolute(relativeDirectory)) return null;
	const state = await readBoundedJsonObject(join(directory, "state.json"));
	if (
		state?.version !== 2 ||
		state.id !== identity.nativeSessionId ||
		typeof state.cwd !== "string" ||
		resolve(state.cwd) !== resolve(cwd)
	)
		return null;
	const path = await realpath(join(directory, "agents", "main", "wire.jsonl"));
	if (relative(directory, path) !== join("agents", "main", "wire.jsonl")) return null;
	// 每次读取核实协议头，不能用未知协议中的相似字段推断接受。
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLf = buffer.subarray(0, bytesRead).indexOf(0x0a);
		if (firstLf < 0) return null;
		const header = parseTranscriptJsonRecord(buffer.subarray(0, firstLf).toString("utf8"));
		return header?.type === "metadata" && header.protocol_version === "1.5" ? path : null;
	} finally {
		await handle.close();
	}
}

export function parseAcceptedKimiMainUserMessage(
	record: Record<string, unknown>,
	nativeSessionId: string,
): NativeAgentConversationTranscriptActivityObservation | null {
	if (
		record.type !== "context.append_message" ||
		record.agentId !== "main" ||
		record.synthetic === true ||
		record.isCompactSummary === true
	)
		return null;
	const message = readTranscriptRecord(record.message);
	if (
		message?.role !== "user" ||
		message.isCompactSummary === true ||
		readTranscriptRecord(message.origin)?.kind !== "user" ||
		typeof message.id !== "string" ||
		!message.id ||
		!Array.isArray(message.content) ||
		typeof record.time !== "number" ||
		!Number.isFinite(record.time)
	)
		return null;
	const userParts = message.content.map(readTranscriptRecord).filter((part) => {
		const metadata = readTranscriptRecord(part?.meta);
		return part && metadata?.source !== "user prompt submit hook";
	});
	const text = userParts
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part?.text as string)
		.join("\n");
	const hasNativeMediaWithUrl = userParts.some((part) => {
		let mediaUrlPayload: Record<string, unknown> | null;
		switch (part?.type) {
			case "image_url":
				mediaUrlPayload = readTranscriptRecord(part.imageUrl);
				break;
			case "audio_url":
				mediaUrlPayload = readTranscriptRecord(part.audioUrl);
				break;
			case "video_url":
				mediaUrlPayload = readTranscriptRecord(part.videoUrl);
				break;
			default:
				return false;
		}
		return typeof mediaUrlPayload?.url === "string" && mediaUrlPayload.url.trim().length > 0;
	});
	if (!text.trim() && !hasNativeMediaWithUrl) return null;
	return {
		observedAtMs: record.time,
		activityKind: "accepted_user_input",
		evidenceKind: "native_user_prompt_acceptance",
		eventId: `kimi:${nativeSessionId}:${message.id}`,
		nativeSessionId,
		...(text.trim() ? { submittedPromptText: text } : {}),
	};
}

export async function readKimiNativeConversationActivity(
	input: ReadNativeAgentConversationActivityInput,
): Promise<NativeAgentConversationActivityReadResult | null> {
	const path = await resolveExactKimiMainWirePath(input);
	if (!path || input.signal?.aborted) return null;
	const metadata = await stat(path);
	const fileIdentity = `${metadata.dev}:${metadata.ino}`;
	const previous = input.cursor?.transport === "kimi_wire" ? input.cursor : null;
	const cursor =
		previous?.transcriptPath === path &&
		previous.fileIdentity === fileIdentity &&
		metadata.size >= previous.nextByteOffset
			? previous
			: null;
	const acceptance = input.summary.agentConversationPromptSubmissionAcceptance;
	const pendingAttemptAtMs =
		acceptance &&
		acceptance.status !== "accepted" &&
		acceptance.runtimeSessionIncarnationId === input.summary.runtimeSessionIncarnationId &&
		acceptance.attemptedAtMs >= (input.summary.startedAt ?? Number.POSITIVE_INFINITY)
			? acceptance.attemptedAtMs
			: null;
	const lookBackForPendingAttempt =
		pendingAttemptAtMs !== null && pendingAttemptAtMs !== cursor?.lastLookedBackPendingAttemptAtMs;
	const isBaseline = cursor === null;
	let lines: string[];
	let nextByteOffset: number;
	let completeReadWindowEndByteOffset: number;
	let moreAppendedTranscriptBytesRemain = false;
	if (isBaseline || lookBackForPendingAttempt) {
		const tail = await readBoundedCompleteTail(path, MAX_KIMI_WIRE_READ_BYTES);
		if (!tail || tail.fileIdentity !== fileIdentity) return null;
		lines = tail.lines;
		completeReadWindowEndByteOffset = tail.nextByteOffset;
		// 候选回查只补恢复证据，已有游标仍须连续消费尾部预算之前的未读增量。
		nextByteOffset = cursor?.nextByteOffset ?? tail.nextByteOffset;
		moreAppendedTranscriptBytesRemain = cursor !== null && tail.nextByteOffset > cursor.nextByteOffset;
	} else {
		const appended = await readAppendedCompleteJsonLines(path, cursor.nextByteOffset, MAX_KIMI_WIRE_READ_BYTES);
		if (appended.fileWasTruncated) return null;
		lines = appended.completeLines;
		nextByteOffset = appended.nextByteOffset;
		completeReadWindowEndByteOffset = appended.nextByteOffset;
		moreAppendedTranscriptBytesRemain = appended.appendedBytesRemainBeyondIncrementalReadBudget;
	}
	const latestMetadata = await stat(path);
	if (`${latestMetadata.dev}:${latestMetadata.ino}` !== fileIdentity || latestMetadata.size < nextByteOffset)
		return null;
	const records = lines.map(parseTranscriptJsonRecord).filter((record) => record !== null);
	const promptTurnIds = new Map(cursor?.promptTurnIds.map(({ messageId, turnId }) => [messageId, turnId]));
	const endedTurnIds = new Set(cursor?.endedTurnIds ?? []);
	for (const record of records) {
		if (
			record.type === "turn.prompt" &&
			record.agentId === "main" &&
			typeof record.promptId === "string" &&
			typeof record.turnId === "number"
		)
			promptTurnIds.set(record.promptId, record.turnId);
		if (record.type === "turn.ended" && record.agentId === "main" && typeof record.turnId === "number")
			endedTurnIds.add(record.turnId);
	}
	const seen = new Set(cursor?.seenEventIds ?? []);
	const baselineIgnored = new Set(cursor?.baselineIgnoredEventIds ?? []);
	const events: NativeAgentConversationTranscriptActivityObservation[] = [];
	const lastConfirmedAtMs =
		acceptance?.status === "accepted" &&
		acceptance.runtimeSessionIncarnationId === input.summary.runtimeSessionIncarnationId &&
		acceptance.nativeSessionId === input.summary.agentNativeConversationSessionIdentity?.nativeSessionId
			? (acceptance.confirmedAtMs ?? 0)
			: 0;
	// compact / hook 期间可能延迟落盘：候选仍待确认时以提交时刻为界，不能被较晚的基线时间挡掉。
	let acceptanceCutoffAtMs =
		pendingAttemptAtMs ?? Math.max(cursor?.baselineAtMs ?? input.observedAtMs, lastConfirmedAtMs);
	for (const record of records) {
		const event = parseAcceptedKimiMainUserMessage(
			record,
			input.summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? "",
		);
		if (!event?.eventId) continue;
		const wasSeen = seen.has(event.eventId);
		seen.add(event.eventId);
		const mayRecoverBaselineAcceptance = lookBackForPendingAttempt && baselineIgnored.has(event.eventId);
		if (wasSeen && !mayRecoverBaselineAcceptance) continue;
		if ((isBaseline && !lookBackForPendingAttempt) || event.observedAtMs < acceptanceCutoffAtMs) {
			if (isBaseline) baselineIgnored.add(event.eventId);
			continue;
		}
		baselineIgnored.delete(event.eventId);
		acceptanceCutoffAtMs = event.observedAtMs;
		const messageId = readTranscriptRecord(record.message)?.id;
		const turnId = typeof messageId === "string" ? promptTurnIds.get(messageId) : undefined;
		// 实际读取窗口未完整到达 EOF 时，结束记录可能仍未读到；只确认接受事实，不能重开回合。
		events.push({
			...event,
			acceptedNativeAgentTurnIsInProgress:
				turnId !== undefined &&
				completeReadWindowEndByteOffset === latestMetadata.size &&
				!endedTurnIds.has(turnId),
		});
	}
	return {
		events,
		cursor: {
			transport: "kimi_wire",
			transcriptPath: path,
			fileIdentity,
			nextByteOffset,
			baselineAtMs: cursor?.baselineAtMs ?? input.observedAtMs,
			seenEventIds: [...seen].slice(-MAX_KIMI_REMEMBERED_MESSAGE_IDS),
			baselineIgnoredEventIds: [...baselineIgnored].slice(-MAX_KIMI_REMEMBERED_MESSAGE_IDS),
			lastLookedBackPendingAttemptAtMs: pendingAttemptAtMs,
			promptTurnIds: [...promptTurnIds]
				.slice(-MAX_KIMI_REMEMBERED_MESSAGE_IDS)
				.map(([messageId, turnId]) => ({ messageId, turnId })),
			endedTurnIds: [...endedTurnIds].slice(-MAX_KIMI_REMEMBERED_MESSAGE_IDS),
		},
		moreAppendedTranscriptBytesRemain,
	};
}
