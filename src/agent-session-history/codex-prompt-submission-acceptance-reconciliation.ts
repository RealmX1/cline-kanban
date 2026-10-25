import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type {
	RuntimeAgentConversationPromptSubmissionAcceptance,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { parseTranscriptJsonRecord, readTranscriptRecord } from "./bounded-agent-transcript-reader";
import { transcriptMetadataMatchesNativeConversationIdentity } from "./persisted-agent-transcript-last-conversation-progress-probe";
import { extractSubmittedUserPromptFromTranscriptRecord } from "./submitted-user-prompt-transcript-record-parser";

type PromptSubmissionAcceptanceVerificationProgress = NonNullable<
	RuntimeAgentConversationPromptSubmissionAcceptance["verification"]
>;
const maximumNativeMessageTimestampRecheckDelayMs = 2_147_483_647;
export interface CodexPromptSubmissionAcceptanceReconciliation {
	attemptedAtMs: number;
	submissionId?: string;
	nativeSessionId: string;
	runtimeSessionIncarnationId: string;
	verification: PromptSubmissionAcceptanceVerificationProgress;
	accepted?: { eventId: string; acceptedAtMs: number };
}

export function submittedPromptSha256(text: string): string {
	return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
}

// 仅修复持久标记，不发布新输入边沿。每次最多读一个字节窗口，重启后沿持久游标继续。
export async function reconcileCodexPromptSubmissionAcceptance(input: {
	summary: RuntimeTaskSessionSummary;
	observedAtMs: number;
	maximumReadBytes?: number;
	force?: boolean;
}): Promise<CodexPromptSubmissionAcceptanceReconciliation | null> {
	const { summary, observedAtMs } = input;
	const candidate = summary.agentConversationPromptSubmissionAcceptance;
	const identity = summary.agentNativeConversationSessionIdentity;
	if (
		!candidate ||
		candidate.status === "accepted" ||
		!identity ||
		!summary.runtimeSessionIncarnationId ||
		candidate.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
		(!input.force &&
			candidate.verification?.nextCheckAtMs !== undefined &&
			candidate.verification.nextCheckAtMs !== null &&
			observedAtMs < candidate.verification.nextCheckAtMs)
	)
		return null;
	const verification: PromptSubmissionAcceptanceVerificationProgress = {
		...candidate.verification,
		checkedAtMs: observedAtMs,
		nextCheckAtMs: null,
		consecutiveUnchangedCheckCount: input.force ? 0 : (candidate.verification?.consecutiveUnchangedCheckCount ?? 0),
		reason: "native_evidence_unavailable",
	};
	const result: CodexPromptSubmissionAcceptanceReconciliation = {
		attemptedAtMs: candidate.attemptedAtMs,
		submissionId: candidate.submissionId,
		nativeSessionId: identity.nativeSessionId,
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
		verification,
	};
	const defer = (reason: PromptSubmissionAcceptanceVerificationProgress["reason"], madeProgress = false) => {
		verification.reason = reason;
		verification.consecutiveUnchangedCheckCount = madeProgress ? 0 : verification.consecutiveUnchangedCheckCount + 1;
		// 无变化三次后等待新的摘要/输入/转录追加；持续推进的分页不消耗故障重试预算。
		verification.nextCheckAtMs = madeProgress
			? observedAtMs + 250
			: verification.consecutiveUnchangedCheckCount <= 3
				? observedAtMs + [15_000, 30_000, 60_000][verification.consecutiveUnchangedCheckCount - 1]
				: null;
		return result;
	};
	if (candidate.nativeSessionId && candidate.nativeSessionId !== identity.nativeSessionId)
		return defer("native_identity_changed");
	try {
		const path = identity.transcriptPath;
		if (!path) return defer("native_evidence_unavailable");
		const metadata = await stat(path);
		if (!metadata.isFile()) return defer("native_evidence_unavailable");
		const fileIdentity = `${metadata.dev}:${metadata.ino}`;
		let cursor = verification.transcriptCursor;
		if (!cursor || cursor.fileIdentity !== fileIdentity || metadata.size < cursor.lastObservedFileSize) {
			cursor = {
				fileIdentity,
				nextByteOffset: 0,
				lastObservedFileSize: metadata.size,
				verifiedSessionMetadata: false,
				skippingOversizedRecord: false,
			};
			verification.matchingNativeMessages = [];
		}
		cursor = { ...cursor };
		const maximumReadBytes = input.maximumReadBytes ?? 256 * 1024;
		const buffer = Buffer.allocUnsafe(Math.min(maximumReadBytes, Math.max(0, metadata.size - cursor.nextByteOffset)));
		const handle = await open(path, "r");
		let bytesRead: number;
		try {
			({ bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.nextByteOffset));
		} finally {
			await handle.close();
		}
		const latest = await stat(path);
		if (`${latest.dev}:${latest.ino}` !== fileIdentity || latest.size < metadata.size)
			return defer("native_evidence_unavailable");
		const matches = [...(verification.matchingNativeMessages ?? [])];
		let lineStart = 0;
		for (
			let lineEnd = buffer.indexOf(0x0a);
			lineEnd >= 0 && lineEnd < bytesRead;
			lineEnd = buffer.indexOf(0x0a, lineStart)
		) {
			const record = cursor.skippingOversizedRecord
				? null
				: parseTranscriptJsonRecord(buffer.subarray(lineStart, lineEnd).toString("utf8"));
			lineStart = lineEnd + 1;
			cursor.skippingOversizedRecord = false;
			if (!record) continue;
			const payload = readTranscriptRecord(record.payload);
			if (!payload) continue;
			if (record.type === "session_meta") {
				if (
					!transcriptMetadataMatchesNativeConversationIdentity(identity, record) ||
					payload.cwd !== summary.workspacePath ||
					!["cli", "vscode"].includes(String(payload.source))
				)
					return defer("native_identity_changed");
				cursor.verifiedSessionMetadata = true;
			}
			const item = readTranscriptRecord(payload.item);
			const acceptedAtMs = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
			if (
				!cursor.verifiedSessionMetadata ||
				record.type !== "event_msg" ||
				payload.type !== "item_completed" ||
				payload.thread_id !== identity.nativeSessionId ||
				typeof payload.turn_id !== "string" ||
				item?.type !== "UserMessage" ||
				typeof item.id !== "string" ||
				record.synthetic === true ||
				payload.synthetic === true ||
				item.synthetic === true ||
				record.isSidechain === true ||
				record.isMeta === true ||
				!Number.isFinite(acceptedAtMs) ||
				acceptedAtMs < candidate.attemptedAtMs
			)
				continue;
			// 旧标记没有正文/前驱，只允许紧邻提交时刻且唯一的原生接受记录；不能拿更早的记录冒领。
			if (!candidate.submittedPromptSha256 && acceptedAtMs > candidate.attemptedAtMs + 15_000) continue;
			const eventId = `codex:${identity.nativeSessionId}:${payload.turn_id}:${item.id}`;
			if (eventId === candidate.predecessorAcceptedEventId || matches.some((match) => match.eventId === eventId))
				continue;
			if (candidate.submittedPromptSha256) {
				const prompt = extractSubmittedUserPromptFromTranscriptRecord("codex", {
					type: "response_item",
					payload: { type: "message", role: "user", content: item.content },
				});
				if (!prompt || submittedPromptSha256(prompt.text) !== candidate.submittedPromptSha256) continue;
			}
			// 先持久保存合格记录；晚于观察起点的事件时间在接受出口重验，不能随 EOF 游标丢失。
			if (matches.length < 2)
				matches.push({ eventId, nativeTurnId: payload.turn_id, nativeItemId: item.id, acceptedAtMs });
		}
		if (lineStart === 0 && bytesRead === maximumReadBytes) {
			// 超长工具记录也不能堵住后续用户消息；只保存找换行的状态，不缓存整行。
			cursor.skippingOversizedRecord = true;
			lineStart = bytesRead;
		}
		cursor.nextByteOffset += lineStart;
		cursor.lastObservedFileSize = latest.size;
		verification.transcriptCursor = cursor;
		verification.matchingNativeMessages = matches;
		if (cursor.nextByteOffset < latest.size) return defer("scanning_native_transcript", lineStart > 0);
		if (!cursor.verifiedSessionMetadata) return defer("native_evidence_unavailable");
		if (matches.length !== 1)
			return defer(matches.length ? "ambiguous_native_messages" : "no_matching_native_message");
		const match = matches[0];
		if (match.acceptedAtMs > observedAtMs) {
			verification.reason = "no_matching_native_message";
			// 已有证据只等待原事件时刻，不消耗缺证重试；单次延迟保持在 Node 定时器有效范围。
			verification.consecutiveUnchangedCheckCount = 0;
			verification.nextCheckAtMs = Math.min(
				match.acceptedAtMs,
				observedAtMs + maximumNativeMessageTimestampRecheckDelayMs,
			);
			return result;
		}
		// 与事件绑定的原生 item_completed 是历史接受事实；退出进程或后续 rewind 不撤销这项事实。
		// 此出口不发布 live 输入边沿，因此不把历史接受提升为当前分支的执行资格。
		verification.reason = "native_acceptance_verified";
		verification.nextCheckAtMs = null;
		result.accepted = { eventId: match.eventId, acceptedAtMs: match.acceptedAtMs };
		return result;
	} catch {
		return defer("native_evidence_unavailable");
	}
}
