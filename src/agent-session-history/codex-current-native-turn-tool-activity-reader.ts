import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { CodexNativeAgentTurnExecutionObservation } from "../core/codex-native-agent-turn-execution-observation";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";
import type { NativeAgentConversationTranscriptActivityObservation } from "./native-agent-conversation-transcript-activity";
import { transcriptMetadataMatchesNativeConversationIdentity } from "./persisted-agent-transcript-last-conversation-progress-probe";

export interface CodexCurrentNativeTurnToolActivityReadCursor {
	fileIdentity: string;
	nextByteOffset: number;
	baselineByteOffset: number;
	baselineAtMs: number;
	lastObservedFileSize: number;
	verifiedSessionMetadata: boolean;
	transcriptNativeTurnId: string | null;
	seenToolEventIds: string[];
	oversizedTranscriptRecordNewlineScanInProgress?: boolean;
}

// 与消息接受游标分离：冷启动可分段补查回合边界，但绝不重报历史或从转录确认用户接受。
export async function readCodexCurrentNativeTurnToolActivity(input: {
	summary: RuntimeTaskSessionSummary;
	execution: CodexNativeAgentTurnExecutionObservation;
	cursor: CodexCurrentNativeTurnToolActivityReadCursor | null;
	observedAtMs: number;
	maximumReadBytes: number;
}): Promise<{
	events: NativeAgentConversationTranscriptActivityObservation[];
	cursor: CodexCurrentNativeTurnToolActivityReadCursor;
	moreAppendedTranscriptBytesRemain: boolean;
} | null> {
	const identity = input.summary.agentNativeConversationSessionIdentity;
	const path = identity?.transcriptPath;
	if (
		!path ||
		identity.sourceAgentId !== "codex" ||
		identity.nativeSessionId !== input.execution.nativeSessionId ||
		!input.execution.nativeTurnId ||
		input.execution.executionStatus === "unknown"
	)
		return null;
	const metadata = await stat(path);
	if (!metadata.isFile()) return null;
	const fileIdentity = `${metadata.dev}:${metadata.ino}`;
	const previous = input.cursor;
	const cursor: CodexCurrentNativeTurnToolActivityReadCursor =
		previous && previous.fileIdentity === fileIdentity && metadata.size >= previous.lastObservedFileSize
			? { ...previous }
			: {
					fileIdentity,
					nextByteOffset: 0,
					baselineByteOffset: metadata.size,
					baselineAtMs: input.observedAtMs,
					lastObservedFileSize: metadata.size,
					verifiedSessionMetadata: false,
					transcriptNativeTurnId: null,
					seenToolEventIds: [],
				};
	const remainingBytes = Math.max(0, metadata.size - cursor.nextByteOffset);
	const buffer = Buffer.allocUnsafe(Math.min(remainingBytes, input.maximumReadBytes));
	const handle = await open(path, "r");
	let bytesRead: number;
	try {
		({ bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.nextByteOffset));
	} finally {
		await handle.close();
	}
	const latestMetadata = await stat(path);
	if (`${latestMetadata.dev}:${latestMetadata.ino}` !== fileIdentity || latestMetadata.size < metadata.size)
		return null;
	const events: NativeAgentConversationTranscriptActivityObservation[] = [];
	const seen = new Set(cursor.seenToolEventIds);
	let oversizedTranscriptRecordNewlineScanInProgress = cursor.oversizedTranscriptRecordNewlineScanInProgress === true;
	let lineStart = 0;
	for (
		let lineEnd = buffer.subarray(0, bytesRead).indexOf(0x0a);
		lineEnd >= 0 && lineEnd < bytesRead;
		lineEnd = buffer.subarray(0, bytesRead).indexOf(0x0a, lineStart)
	) {
		const recordByteOffset = cursor.nextByteOffset + lineStart;
		if (oversizedTranscriptRecordNewlineScanInProgress) {
			oversizedTranscriptRecordNewlineScanInProgress = false;
			lineStart = lineEnd + 1;
			continue;
		}
		const serializedRecord = buffer.subarray(lineStart, lineEnd).toString("utf8").replace(/\r$/u, "");
		lineStart = lineEnd + 1;
		const record = parseTranscriptJsonRecord(serializedRecord);
		if (!record) continue;
		const payload = readTranscriptRecord(record.payload);
		if (!payload) continue;
		if (record.type === "session_meta") {
			if (
				!transcriptMetadataMatchesNativeConversationIdentity(identity, record) ||
				!["cli", "vscode"].includes(String(payload.source)) ||
				payload.cwd !== input.summary.workspacePath
			)
				return null;
			cursor.verifiedSessionMetadata = true;
			cursor.transcriptNativeTurnId = null;
			continue;
		}
		if (
			!cursor.verifiedSessionMetadata ||
			record.isSidechain === true ||
			record.synthetic === true ||
			record.isMeta === true ||
			payload.synthetic === true ||
			payload.isSidechain === true ||
			payload.isMeta === true
		)
			continue;
		if (record.type === "event_msg") {
			if (payload.type === "task_started")
				cursor.transcriptNativeTurnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
			else if (
				[
					"task_complete",
					"turn_aborted",
					"thread_rolled_back",
					"thread_reverted",
					"conversation_reverted",
				].includes(String(payload.type))
			)
				cursor.transcriptNativeTurnId = null;
			continue;
		}
		if (record.type === "turn_context") {
			// turn_context 只核对已经证明的 task_started，不把压缩或历史拷贝提升为新分支。
			if (payload.turn_id !== cursor.transcriptNativeTurnId) cursor.transcriptNativeTurnId = null;
			continue;
		}
		if (
			record.type !== "response_item" ||
			cursor.transcriptNativeTurnId !== input.execution.nativeTurnId ||
			(typeof payload.turn_id === "string" && payload.turn_id !== input.execution.nativeTurnId) ||
			!["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(
				String(payload.type),
			) ||
			typeof payload.call_id !== "string"
		)
			continue;
		const eventId = `codex:${identity.nativeSessionId}:${input.execution.nativeTurnId}:rollout-tool:${payload.call_id}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
		if (seen.has(eventId)) continue;
		seen.add(eventId);
		const observedAtMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
		if (
			recordByteOffset < cursor.baselineByteOffset ||
			!Number.isFinite(observedAtMs) ||
			observedAtMs < cursor.baselineAtMs
		)
			continue;
		// observer 的扫描起点可能早于本次追加；实际未来时间门禁仍由活动写入漏斗负责。
		events.push({
			observedAtMs,
			activityKind: "tool_activity",
			evidenceKind: "persisted_agent_transcript",
			eventId,
			nativeSessionId: identity.nativeSessionId,
		});
	}
	if (
		lineStart < bytesRead &&
		(oversizedTranscriptRecordNewlineScanInProgress || (lineStart === 0 && bytesRead === input.maximumReadBytes))
	) {
		// 长行可能包含 rewind 或 turn 边界；逐预算找换行，不缓存整行，也不沿用旧回合。
		oversizedTranscriptRecordNewlineScanInProgress = true;
		cursor.transcriptNativeTurnId = null;
		lineStart = bytesRead;
	}
	cursor.nextByteOffset += lineStart;
	cursor.lastObservedFileSize = latestMetadata.size;
	cursor.seenToolEventIds = [...seen].slice(-512);
	cursor.oversizedTranscriptRecordNewlineScanInProgress = oversizedTranscriptRecordNewlineScanInProgress;
	return {
		events,
		cursor,
		moreAppendedTranscriptBytesRemain: lineStart > 0 && cursor.nextByteOffset < latestMetadata.size,
	};
}
