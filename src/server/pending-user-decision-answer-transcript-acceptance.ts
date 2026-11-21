import { open, stat } from "node:fs/promises";
import { parseTranscriptJsonRecord } from "../agent-session-history/bounded-agent-transcript-reader";
import { extractSubmittedUserPromptFromTranscriptRecord } from "../agent-session-history/submitted-user-prompt-transcript-record-parser";
import type { AgentRaisedPendingUserDecisionAnswerDeliveryAttempt } from "../state/agent-raised-pending-user-decision-store";
import type { PendingUserDecisionAnswerDeliveryEvidence } from "./agent-raised-pending-user-decision-answer-delivery-reconciliation";

// 复用原生用户记录解析器，从本次提交前的文件位置开始；不把重绘或同文旧调用当作接受。
export async function reconcileClaudePendingUserDecisionAnswerTranscriptAcceptance(
	attempt: AgentRaisedPendingUserDecisionAnswerDeliveryAttempt,
	text: string,
	now: number,
): Promise<PendingUserDecisionAnswerDeliveryEvidence> {
	if (
		!attempt.transcriptPath ||
		!attempt.targetNativeSessionId ||
		attempt.preSubmissionTranscriptByteOffset === undefined ||
		!attempt.preSubmissionTranscriptFileIdentity
	)
		return { state: "delivery_unconfirmed", reason: "submission_position_unavailable" };
	const metadata = await stat(attempt.transcriptPath);
	const fileIdentity = `${metadata.dev}:${metadata.ino}`;
	if (
		fileIdentity !== attempt.preSubmissionTranscriptFileIdentity ||
		metadata.size < attempt.preSubmissionTranscriptByteOffset
	)
		return { state: "delivery_unconfirmed", reason: "native_transcript_replaced" };
	const progress = attempt.acceptanceVerification;
	const cursor = progress?.transcriptCursor ?? {
		fileIdentity,
		nextByteOffset: attempt.preSubmissionTranscriptByteOffset,
		lastObservedFileSize: metadata.size,
		verifiedSessionMetadata: false,
		skippingOversizedRecord: false,
	};
	if (cursor.fileIdentity !== fileIdentity || metadata.size < cursor.lastObservedFileSize)
		return { state: "delivery_unconfirmed", reason: "native_transcript_replaced" };
	const matches = [...(progress?.matchingNativeMessages ?? [])];
	const buffer = Buffer.alloc(Math.min(256 * 1024, metadata.size - cursor.nextByteOffset));
	const file = await open(attempt.transcriptPath, "r");
	let bytesRead: number;
	try {
		({ bytesRead } = await file.read(buffer, 0, buffer.length, cursor.nextByteOffset));
	} finally {
		await file.close();
	}
	let start = 0;
	for (let end = buffer.indexOf(10); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
		const record = cursor.skippingOversizedRecord
			? null
			: parseTranscriptJsonRecord(buffer.subarray(start, end).toString("utf8"));
		start = end + 1;
		cursor.skippingOversizedRecord = false;
		if (!record || record.sessionId !== attempt.targetNativeSessionId || record.cwd !== attempt.workingDirectoryPath)
			continue;
		const message = extractSubmittedUserPromptFromTranscriptRecord("claude", record);
		if (
			!message ||
			!message.messageId ||
			message.submittedAtEpochMs === null ||
			message.submittedAtEpochMs < attempt.startedAt ||
			message.submittedAtEpochMs > now ||
			message.text.replace(/\r\n/g, "\n").trim() !== text.replace(/\r\n/g, "\n").trim()
		)
			continue;
		if (matches.length < 2 && !matches.some((match) => match.nativeItemId === message.messageId))
			matches.push({
				eventId: `claude:${attempt.targetNativeSessionId}:${message.messageId}`,
				nativeTurnId: message.messageId,
				nativeItemId: message.messageId,
				acceptedAtMs: message.submittedAtEpochMs,
			});
	}
	if (start === 0 && bytesRead === buffer.length && buffer.length === 256 * 1024) {
		cursor.skippingOversizedRecord = true;
		start = bytesRead;
	}
	cursor.nextByteOffset += start;
	cursor.lastObservedFileSize = metadata.size;
	const scanning = cursor.nextByteOffset < metadata.size;
	return {
		state: !scanning && matches.length === 1 ? "delivered" : "delivery_unconfirmed",
		reason: scanning
			? "scanning_native_transcript"
			: matches.length > 1
				? "ambiguous_native_messages"
				: matches.length === 1
					? "native_acceptance_verified"
					: "no_matching_native_message",
		acceptanceVerification: {
			checkedAtMs: now,
			nextCheckAtMs: null,
			consecutiveUnchangedCheckCount: 0,
			reason: scanning
				? "scanning_native_transcript"
				: matches.length === 1
					? "native_acceptance_verified"
					: matches.length > 1
						? "ambiguous_native_messages"
						: "no_matching_native_message",
			transcriptCursor: cursor,
			matchingNativeMessages: matches,
		},
	};
}
