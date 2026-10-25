import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type { TaskMessageInjectionRecord } from "../core/task-message-injection-ledger";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import type { CodexNativeConversationTurn } from "./codex-native-conversation-prefix";

const transcriptRecordSchema = z.object({
	type: z.string(),
	timestamp: z.string().optional(),
	payload: z.looseObject({
		type: z.string().optional(),
		turn_id: z.string().optional(),
		turn_attribution: z.object({ turn_trigger: z.string().nullish() }).optional(),
		item: z.looseObject({ id: z.string(), type: z.string() }).optional(),
	}),
});

type VerifiedNativeUserMessageOnActiveBranch = {
	nativeUserMessageId: string;
	nativeTurnId: string;
	promptSha256: string;
	recordedAtMs: number;
};

export async function readPreReviewRestoreNativeMessageOwnership(input: {
	record: RvfAutomaticCloseoutRecord;
	summary: RuntimeTaskSessionSummary;
	turns: CodexNativeConversationTurn[];
	ledger: TaskMessageInjectionRecord[];
}) {
	const { record, summary, turns, ledger } = input;
	const bytes = await readFile(record.receipt.transcript_path);
	let records: z.infer<typeof transcriptRecordSchema>[];
	try {
		records = bytes
			.toString("utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => transcriptRecordSchema.parse(JSON.parse(line)));
	} catch {
		throw new Error("native_transcript_incomplete");
	}
	const metadata = records.filter((entry) => entry.type === "session_meta");
	const metadataPayload = metadata[0]?.payload;
	if (
		metadata.length !== 1 ||
		metadataPayload?.id !== record.receipt.session_id ||
		metadataPayload.originator !== "codex-tui" ||
		!["cli", "vscode"].includes(String(metadataPayload.source)) ||
		typeof metadataPayload.cwd !== "string" ||
		(await realpath(metadataPayload.cwd)) !== (await realpath(record.receipt.worktree))
	)
		throw new Error("native_transcript_identity_mismatch");
	const boundaryIndex = turns.findIndex((turn) => turn.id === record.receipt.native_turn_id);
	if (
		boundaryIndex !== record.preReviewTurnIds.length ||
		turns.slice(0, boundaryIndex).some((turn, index) => turn.id !== record.preReviewTurnIds[index])
	)
		throw new Error("native_review_prefix_changed");
	let accepted: VerifiedNativeUserMessageOnActiveBranch | null = null;
	const verifiedNativeUserMessagesOnActiveBranch: VerifiedNativeUserMessageOnActiveBranch[] = [];
	for (const turn of turns.slice(boundaryIndex)) {
		const messages = turn.items.filter((item) => item.type === "userMessage");
		if (messages.length !== 1) throw new Error("native_user_message_ownership_ambiguous");
		const message = messages[0];
		if (
			!message?.content?.length ||
			message.content.some((part) => !["text", "input_text"].includes(part.type) || part.text === undefined)
		)
			throw new Error("native_user_message_content_unproven");
		const text = message.content.map((part) => part.text).join("");
		const digest = computeRvfTextSha256(text);
		const isBoundary =
			turn.id === record.receipt.native_turn_id &&
			message.id === record.receipt.native_user_message_id &&
			digest === record.receipt.boundary_message_sha256;
		const matches = ledger.filter((entry) => {
			const evidence =
				entry.codex_native_prompt_delivery_evidence ??
				entry.codex_native_prompt_delivery_operation?.historicalAcceptanceEvidence;
			return (
				(entry.task_id === record.taskId || entry.task_id === record.conversationSessionId) &&
				(entry.attempt_id ?? record.conversationSessionId) === record.conversationSessionId &&
				(entry.source === "review-validate-fix" || entry.source.startsWith("rvf")) &&
				entry.prompt_sha256 === digest &&
				evidence?.nativeSessionId === record.receipt.session_id &&
				evidence.nativeTurnId === turn.id &&
				evidence.nativeUserMessageId === message.id &&
				(isBoundary
					? entry.idempotency_key === record.receipt.idempotency_key
					: Boolean(
							record.runId &&
								text.split("\n").includes(`run_id=${record.runId}`) &&
								text.split("\n").includes(`RVF_DECISION_TOKEN=${record.receipt.decision_token}`),
						))
			);
		});
		// 开审 receipt 自带精确消息归属；续跑必须有本 run 的正文绑定和原生投递凭据。
		if (
			((!isBoundary || record.receipt.source === "rvf_automatic_decision_message") && matches.length !== 1) ||
			matches.length > 1
		)
			throw new Error("native_user_message_not_owned_by_run");
		const events = records.filter(
			(entry) =>
				entry.type === "event_msg" &&
				entry.payload.type === "item_completed" &&
				entry.payload.item?.type === "UserMessage" &&
				entry.payload.item.id === message.id,
		);
		const event = events[0];
		const starts = records.filter(
			(entry) =>
				entry.type === "event_msg" &&
				entry.payload.type === "task_started" &&
				entry.payload.turn_id === turn.id &&
				entry.payload.turn_attribution?.turn_trigger === "user",
		);
		const startedAt = Date.parse(starts[0]?.timestamp ?? "");
		const recordedAt = Date.parse(event?.timestamp ?? "");
		const transcriptText = z
			.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) })
			.safeParse(event?.payload.item);
		if (
			events.length !== 1 ||
			starts.length !== 1 ||
			event?.payload.turn_id !== turn.id ||
			(event.payload.thread_id !== undefined && event.payload.thread_id !== record.receipt.session_id) ||
			!transcriptText.success ||
			transcriptText.data.content.some((part) => !["text", "input_text"].includes(part.type)) ||
			computeRvfTextSha256(transcriptText.data.content.map((part) => part.text).join("")) !== digest ||
			![startedAt, recordedAt].every(Number.isFinite) ||
			recordedAt < startedAt ||
			recordedAt > Date.now() + 60_000 ||
			(matches[0] &&
				(!Number.isFinite(Date.parse(matches[0].created_at)) || startedAt < Date.parse(matches[0].created_at)))
		)
			throw new Error("native_message_time_or_content_unproven");
		accepted = {
			nativeUserMessageId: message.id,
			nativeTurnId: turn.id,
			promptSha256: digest,
			recordedAtMs: recordedAt,
		};
		verifiedNativeUserMessagesOnActiveBranch.push(accepted);
	}
	const submission = summary.agentConversationPromptSubmissionAcceptance;
	if (
		!accepted ||
		(submission != null &&
			submission.runtimeSessionIncarnationId === summary.runtimeSessionIncarnationId &&
			(accepted.recordedAtMs < submission.attemptedAtMs ||
				(submission.nativeSessionId && submission.nativeSessionId !== record.receipt.session_id) ||
				(submission.eventId &&
					submission.eventId !==
						`codex:${record.receipt.session_id}:${accepted.nativeTurnId}:${accepted.nativeUserMessageId}`)))
	)
		throw new Error("current_submission_native_acceptance_unproven");
	return { ...accepted, transcriptSha256: computeRvfTextSha256(bytes), verifiedNativeUserMessagesOnActiveBranch };
}
