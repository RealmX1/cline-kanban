import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type { RvfCloseoutDeliveryAttempt } from "../core/rvf-automatic-closeout-recovery-contract";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import {
	parseCodexNativeCloseoutUserMessageContent,
	readCodexNativeCloseoutCandidateText,
} from "./codex-native-closeout-user-message-content";
import {
	assertCodexNativeConversationLoadedByCurrentHost,
	readCodexConversationTurns,
} from "./codex-native-conversation-prefix";
import { readCodexNativeCloseoutPromptAcceptanceEvidence } from "./read-codex-native-closeout-prompt-acceptance-evidence";
import { readRvfCloseoutSkillSnapshots } from "./rvf-closeout-skill-attachment-snapshot-store";
import { verifyCodexNativeCloseoutSkillAttachmentEvidence } from "./verify-codex-native-closeout-skill-attachment-evidence";

function serializeContinuationNativeExecutionIdentity(summary: RuntimeTaskSessionSummary) {
	return JSON.stringify([
		summary.taskId,
		summary.workspacePath,
		summary.startedAt,
		summary.runtimeSessionIncarnationId,
		summary.agentNativeConversationSessionIdentity
			? [
					summary.agentNativeConversationSessionIdentity.sourceAgentId,
					summary.agentNativeConversationSessionIdentity.nativeSessionId,
					summary.agentNativeConversationSessionIdentity.transcriptPath,
				]
			: null,
		summary.codexNativeSessionControlEndpoint,
	]);
}

export async function verifyRvfCloseoutContinuationNativeAcceptance(input: {
	record: RvfAutomaticCloseoutRecord;
	attempt: RvfCloseoutDeliveryAttempt;
	summary: RuntimeTaskSessionSummary;
	getMainSummary: () => Promise<RuntimeTaskSessionSummary>;
}) {
	const { record, attempt, summary } = input;
	const identityBeforeVerification = serializeContinuationNativeExecutionIdentity(summary);
	const endpoint = summary.codexNativeSessionControlEndpoint ? { ...summary.codexNativeSessionControlEndpoint } : null;
	if (
		!endpoint ||
		endpoint.workspaceId !== record.workspaceId ||
		endpoint.conversationSessionId !== attempt.conversationSessionId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
		summary.taskId !== attempt.conversationSessionId ||
		summary.agentNativeConversationSessionIdentity?.nativeSessionId !== attempt.nativeSessionId
	)
		throw new Error("续验缺少属于当前执行会话的原生控制面。");
	const readerInput = {
		transcriptPath: summary.agentNativeConversationSessionIdentity?.transcriptPath ?? "",
		nativeSessionId: attempt.nativeSessionId,
		worktree: record.receipt.worktree,
		promptSha256: attempt.promptSha256,
		deliveryCreatedAt: new Date(attempt.createdAt).toISOString(),
		decisionToken: record.receipt.decision_token,
		runId: record.runId ?? "",
		handoffSha256: record.handoffSha256 ?? "",
		handoffPath: record.handoffPath ?? "",
	};
	const acceptedSnapshots = (await readRvfCloseoutSkillSnapshots(record)).filter(
		(snapshot) =>
			snapshot.phase === "accepted_native_expansion" &&
			snapshot.promptDeliveryIdempotencyKey === attempt.idempotencyKey &&
			snapshot.promptSha256 === attempt.promptSha256,
	);
	let previousAcceptedTranscriptSnapshot: { transcriptByteLength: number; transcriptSha256: string } | undefined;
	if (acceptedSnapshots.some((snapshot) => snapshot.nativeSessionId !== attempt.nativeSessionId))
		throw new Error("同一续验的历史原生身份互相矛盾。");
	if (acceptedSnapshots.length) {
		const rawTranscript = await readFile(readerInput.transcriptPath);
		for (const snapshot of acceptedSnapshots) {
			if (snapshot.transcriptByteLength === undefined || !snapshot.transcriptSha256) continue;
			if (
				rawTranscript.length < snapshot.transcriptByteLength ||
				computeRvfTextSha256(rawTranscript.subarray(0, snapshot.transcriptByteLength)) !== snapshot.transcriptSha256
			)
				throw new Error("续验转录已改写先前核验的前缀。");
			if (
				!previousAcceptedTranscriptSnapshot ||
				snapshot.transcriptByteLength > previousAcceptedTranscriptSnapshot.transcriptByteLength
			)
				previousAcceptedTranscriptSnapshot = {
					transcriptByteLength: snapshot.transcriptByteLength,
					transcriptSha256: snapshot.transcriptSha256,
				};
		}
	}
	const evidence = await readCodexNativeCloseoutPromptAcceptanceEvidence({
		...readerInput,
		previousTranscriptSnapshot: previousAcceptedTranscriptSnapshot,
	});
	await withRunningCodexAppServerControlSocketConnection(
		async (port) => {
			await assertCodexNativeConversationLoadedByCurrentHost(port, attempt.nativeSessionId);
			const turns = await readCodexConversationTurns(port, attempt.nativeSessionId);
			const matches = turns.flatMap((turn) =>
				turn.items
					.filter(
						(item) =>
							item.type === "userMessage" &&
							computeRvfTextSha256(readCodexNativeCloseoutCandidateText(item.content ?? [])) ===
								attempt.promptSha256,
					)
					.map((item) => ({ turn: turn.id, message: item.id, content: item.content ?? [] })),
			);
			if (
				matches.length !== 1 ||
				matches[0]?.turn !== evidence.nativeTurnId ||
				matches[0]?.message !== evidence.nativeUserMessageId
			)
				throw new Error("新续验不在唯一活动分支。");
			if (
				JSON.stringify(parseCodexNativeCloseoutUserMessageContent(matches[0]?.content ?? []).skillReferences) !==
				JSON.stringify(evidence.skillReferences)
			)
				throw new Error("新续验的活动分支附件与可信原生记录不符。");
			await verifyCodexNativeCloseoutSkillAttachmentEvidence({
				port,
				worktree: record.receipt.worktree,
				...evidence,
				historicalSnapshots: (
					await readRvfCloseoutSkillSnapshots(record, evidence.nativeSkillExpansionTexts)
				).filter(
					(snapshot) =>
						snapshot.promptDeliveryIdempotencyKey === attempt.idempotencyKey &&
						snapshot.promptSha256 === attempt.promptSha256,
				),
			});
		},
		{ socketPath: endpoint.socketPath },
	);
	await readCodexNativeCloseoutPromptAcceptanceEvidence({ ...readerInput, previousTranscriptSnapshot: evidence });
	const latest = await input.getMainSummary();
	if (
		serializeContinuationNativeExecutionIdentity(latest) !== identityBeforeVerification ||
		latest.taskId !== summary.taskId ||
		latest.workspacePath !== summary.workspacePath ||
		latest.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId ||
		latest.agentNativeConversationSessionIdentity?.nativeSessionId !== attempt.nativeSessionId ||
		latest.agentNativeConversationSessionIdentity?.transcriptPath !== readerInput.transcriptPath ||
		JSON.stringify(latest.codexNativeSessionControlEndpoint) !== JSON.stringify(endpoint)
	)
		throw new Error("核验期间原生执行会话换代。");
	return evidence;
}

import { readFile } from "node:fs/promises";
