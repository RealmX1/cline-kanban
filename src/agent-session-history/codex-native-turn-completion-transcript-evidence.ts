import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type CodexNativeAgentTurnExecutionObservation,
	isCodexNativeTerminalOutcomeForCurrentTurn,
} from "../core/codex-native-agent-turn-execution-observation";
import {
	parseTranscriptJsonRecord,
	readTranscriptRecord,
	splitCompleteJsonLines,
} from "./bounded-agent-transcript-reader";
import {
	openCodexTranscriptReadSource,
	readCodexTranscriptSessionMetadata,
	statCodexTranscriptReadSource,
} from "./codex-transcript-read-source";
import { transcriptMetadataMatchesNativeConversationIdentity } from "./persisted-agent-transcript-last-conversation-progress-probe";

// shortcut: 长回合起点可能超出尾部预算。终态仍待证时由控制面复核，若此类回合常见再扩展游标。
const MAXIMUM_CODEX_TERMINAL_EVIDENCE_TAIL_BYTES = 512 * 1024;

export async function readCodexNativeTurnCompletionTranscriptEvidence(input: {
	summary: RuntimeTaskSessionSummary;
	workspaceId: string;
	observedAtMs: number;
	requiredNativeTurnId?: string;
}): Promise<CodexNativeAgentTurnExecutionObservation | null> {
	const { summary } = input;
	const identity = summary.agentNativeConversationSessionIdentity;
	const path = identity?.transcriptPath;
	const incarnationId = summary.runtimeSessionIncarnationId;
	if (!path || identity.sourceAgentId !== "codex" || !incarnationId) return null;
	const handle = await openCodexTranscriptReadSource(path, identity.nativeSessionId);
	try {
		const metadata = await handle.stat();
		const { record: session } = await readCodexTranscriptSessionMetadata(handle);
		const sessionPayload = readTranscriptRecord(session.payload);
		if (
			!transcriptMetadataMatchesNativeConversationIdentity(identity, session) ||
			sessionPayload?.cwd !== summary.workspacePath ||
			!["cli", "vscode"].includes(String(sessionPayload.source))
		)
			return null;
		const offset = Math.max(0, metadata.size - MAXIMUM_CODEX_TERMINAL_EVIDENCE_TAIL_BYTES);
		const buffer = Buffer.allocUnsafe(metadata.size - offset);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		// 读取期间追加、换文件或尾部未写完都可能藏有更新的输入或 Rewind。
		const latest = await statCodexTranscriptReadSource(path, identity.nativeSessionId);
		if (
			latest.dev !== metadata.dev ||
			latest.ino !== metadata.ino ||
			latest.size !== metadata.size ||
			latest.mtimeMs !== metadata.mtimeMs ||
			bytesRead === 0 ||
			buffer[bytesRead - 1] !== 10
		)
			return null;
		let completion: { turnId: string; finishedAtMs: number; error: string | null } | null = null;
		let legacyTurnErrorMessage: string | null | undefined;
		for (const line of splitCompleteJsonLines(
			buffer.subarray(0, bytesRead),
			offset === 0 ? "file_start" : "file_end",
		).reverse()) {
			const record = parseTranscriptJsonRecord(line);
			if (!record) return null;
			const payload = readTranscriptRecord(record.payload);
			if (!payload) continue;
			if (
				record.synthetic ||
				record.isSidechain ||
				record.isMeta ||
				payload.synthetic ||
				payload.isSidechain ||
				payload.isMeta
			)
				continue;
			if (!completion && record.type === "response_item" && payload.type === "message" && payload.role === "user")
				return null;
			if (record.type !== "event_msg") continue;
			const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
			if (
				["turn_aborted", "thread_rolled_back", "thread_reverted", "conversation_reverted"].includes(
					String(payload.type),
				)
			)
				return null;
			if (payload.type === "task_complete") {
				if (
					completion ||
					typeof payload.turn_id !== "string" ||
					!Number.isFinite(timestamp) ||
					timestamp > input.observedAtMs ||
					(input.requiredNativeTurnId && payload.turn_id !== input.requiredNativeTurnId)
				)
					return null;
				const error = readTranscriptRecord(payload.error);
				if (payload.error != null && typeof error?.message !== "string") return null;
				completion = {
					turnId: payload.turn_id,
					finishedAtMs: timestamp,
					error: typeof error?.message === "string" ? error.message : null,
				};
			} else if (payload.type === "error" && completion && legacyTurnErrorMessage === undefined) {
				const errorKind = payload.codex_error_info;
				const nonTerminal = readTranscriptRecord(errorKind);
				// 旧原生回放只接受会影响当前回合状态的 ErrorEvent。
				if (
					errorKind === "thread_rollback_failed" ||
					nonTerminal?.active_turn_not_steerable != null ||
					payload.will_retry === true ||
					(payload.turn_id != null && payload.turn_id !== completion.turnId)
				)
					continue;
				if (!Number.isFinite(timestamp) || timestamp > completion.finishedAtMs) return null;
				legacyTurnErrorMessage = typeof payload.message === "string" ? payload.message : null;
			} else if (payload.type === "task_started") {
				if (
					!completion ||
					payload.turn_id !== completion.turnId ||
					!Number.isFinite(timestamp) ||
					timestamp > completion.finishedAtMs ||
					timestamp < (summary.startedAt ?? 0)
				)
					return null;
				return {
					workspaceId: input.workspaceId,
					conversationSessionId: summary.taskId,
					runtimeSessionIncarnationId: incarnationId,
					nativeSessionId: identity.nativeSessionId,
					nativeTurnId: completion.turnId,
					nativeTurnStartedAtMs: timestamp,
					nativeTurnFinishedAtMs: completion.finishedAtMs,
					observedAtMs: input.observedAtMs,
					threadStatus: "unknown",
					nativeTurnStatus:
						completion.error === null && legacyTurnErrorMessage === undefined ? "completed" : "failed",
					nativeTurnErrorMessage: completion.error ?? legacyTurnErrorMessage ?? null,
					activeFlags: [],
					canAcceptDirectInput: null,
					executionStatus: "finished",
					source: "persisted_codex_turn_completion",
				};
			} else if (payload.type === "user_message" && !completion) return null;
		}
		return null;
	} finally {
		await handle.close();
	}
}

/** 控制面仍提供输入门禁，转录只补终态及其归属。 */
export async function supplementCodexNativeTurnExecutionWithTranscriptEvidence(input: {
	summary: RuntimeTaskSessionSummary;
	workspaceId: string;
	observedAtMs: number;
	control: CodexNativeAgentTurnExecutionObservation | null;
	requiredNativeTurnId?: string;
}): Promise<CodexNativeAgentTurnExecutionObservation | null> {
	const { control, requiredNativeTurnId } = input;
	if (control && requiredNativeTurnId && control.nativeTurnId && control.nativeTurnId !== requiredNativeTurnId)
		return control;
	if (
		control &&
		(control.nativeTurnStatus === "inProgress" ||
			(control.activeFlags?.length ?? 0) > 0 ||
			control.executionStatus === "running" ||
			control.executionStatus === "waiting_for_user")
	)
		return control;
	const missingTerminalOwnership =
		control?.executionStatus === "finished" &&
		(requiredNativeTurnId
			? !control.nativeTurnId || control.nativeTurnStartedAtMs === null
			: !isCodexNativeTerminalOutcomeForCurrentTurn(input.summary, control));
	const missingFailureReason = control?.nativeTurnStatus === "failed" && !control.nativeTurnErrorMessage;
	if (control && control.executionStatus !== "unknown" && !missingTerminalOwnership && !missingFailureReason)
		return control;
	const transcript = await readCodexNativeTurnCompletionTranscriptEvidence({
		...input,
		requiredNativeTurnId: requiredNativeTurnId ?? control?.nativeTurnId ?? undefined,
	}).catch(() => null);
	if (
		!transcript ||
		(control?.executionStatus === "finished" && control.nativeTurnStatus !== transcript.nativeTurnStatus)
	)
		return control;
	if (control?.executionStatus === "finished") {
		return {
			...control,
			nativeTurnId: transcript.nativeTurnId,
			nativeTurnStartedAtMs: transcript.nativeTurnStartedAtMs,
			nativeTurnFinishedAtMs: transcript.nativeTurnFinishedAtMs,
			nativeTurnErrorMessage: control.nativeTurnErrorMessage || transcript.nativeTurnErrorMessage,
			source: transcript.source,
		};
	}
	return transcript;
}
