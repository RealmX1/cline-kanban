import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type {
	CodexRvfCloseoutCompactionAwareConfirmation,
	CodexRvfCloseoutConfirmationBinding,
} from "../core/codex-rvf-closeout-compaction-aware-confirmation";
import {
	getTaskMessageInjectionLedgerPath,
	persistTaskMessageNativeCompactionAwareConfirmation,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { readWorkspaceQueuedTaskPromptDeliverySnapshot } from "../state/queued-task-prompt-delivery-store";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";
import { buildRvfAutomaticCloseoutPrompt } from "./rvf-automatic-closeout-prompt";
import { getRvfAutomaticCloseoutStorePath, readRvfAutomaticCloseoutRecords } from "./rvf-automatic-closeout-store";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface RvfCloseoutCompactionConfirmationPersistence {
	binding: Omit<CodexRvfCloseoutConfirmationBinding, "terminalSessionSpawnedAtEpochMs">;
	promptText: string;
	validateStillAuthorized: () => Promise<boolean>;
	persistSnapshot: (
		snapshot: CodexRvfCloseoutCompactionAwareConfirmation,
		expectedRevision: number | null,
	) => Promise<boolean>;
}

// 只由明确的自动收尾来源调用；不根据提示词内容或 idempotency key 前缀推导资格。
export async function resolveRvfCloseoutCompactionConfirmationPersistence(input: {
	workspaceId: string;
	summary: RuntimeTaskSessionSummary;
	idempotencyKey: string;
	promptText?: string;
	// 仅供同宿主接管：从账本核验旧提交，不因当前交接文件变化否定历史事实；不允许重新发送。
	resumeExistingSubmissionOnly?: boolean;
}): Promise<RvfCloseoutCompactionConfirmationPersistence | null> {
	const { summary } = input;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	const identity = summary.agentNativeConversationSessionIdentity;
	if (
		summary.agentId !== "codex" ||
		identity?.sourceAgentId !== "codex" ||
		!endpoint ||
		endpoint.workspaceId !== input.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return null;
	const records = await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(input.workspaceId));
	const matching = records.filter(
		(record) =>
			record.conversationSessionId === summary.taskId &&
			record.promptDeliveryIdempotencyKey === input.idempotencyKey,
	);
	const record = matching.length === 1 ? matching[0] : undefined;
	if (
		!record ||
		record.status !== "submitting_closeout_prompt" ||
		record.explicitStopRequestedAt !== undefined ||
		!record.runId ||
		!record.handoffPath ||
		!record.handoffSha256 ||
		record.restoredNativeSessionId !== identity.nativeSessionId ||
		record.restoredTranscriptPath !== identity.transcriptPath
	)
		return null;
	const ledgerPath = getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(input.workspaceId));
	const ledgerMatches = (await readTaskMessageInjectionLedger(ledgerPath)).filter(
		(entry) =>
			entry.idempotency_key === input.idempotencyKey &&
			entry.source === "rvf_automatic_closeout" &&
			(entry.task_id === record.taskId || entry.task_id === record.conversationSessionId) &&
			(entry.attempt_id === undefined || entry.attempt_id === record.conversationSessionId),
	);
	const delivery = ledgerMatches.length === 1 ? ledgerMatches[0] : undefined;
	if (!delivery || delivery.terminal_delivery_status !== "accepted_pending_submit_confirmation") return null;
	let promptText = buildRvfAutomaticCloseoutPrompt(record);
	if (input.resumeExistingSubmissionOnly) {
		const previousSubmission = delivery.nativeCompactionAwareConfirmation;
		if (!previousSubmission || previousSubmission.binding.promptSha256 !== delivery.prompt_sha256) return null;
		if (sha256(promptText) !== delivery.prompt_sha256) {
			// 入队时已经冻结正文；模板后来升级时复用同一条历史文本，不重建另一份提示词。
			const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(input.workspaceId);
			const matches = (snapshot.entriesByTaskId[summary.taskId] ?? []).filter(
				(entry) =>
					entry.dispatchIdempotencyKey === input.idempotencyKey &&
					entry.programmaticInjectionLedgerReceiptLink?.injectionSource === "rvf_automatic_closeout" &&
					entry.programmaticInjectionLedgerReceiptLink.injectionLedgerIdempotencyKey === input.idempotencyKey &&
					(entry.programmaticInjectionLedgerReceiptLink.injectionLedgerTaskId ?? entry.taskId) ===
						delivery.task_id &&
					sha256(entry.text) === delivery.prompt_sha256,
			);
			if (matches.length !== 1 || !matches[0]) return null;
			promptText = matches[0].text;
		}
	} else if (sha256(await readFile(record.handoffPath, "utf8")) !== record.handoffSha256) return null;
	if (
		sha256(promptText) !== delivery.prompt_sha256 ||
		(input.promptText !== undefined && input.promptText !== promptText)
	)
		return null;
	const binding = {
		workspaceId: input.workspaceId,
		taskId: record.taskId,
		conversationSessionId: summary.taskId,
		decisionToken: record.receipt.decision_token,
		runId: record.runId,
		handoffSha256: record.handoffSha256,
		idempotencyKey: input.idempotencyKey,
		promptSha256: sha256(promptText),
		nativeSessionId: identity.nativeSessionId,
		runtimeSessionIncarnationId: endpoint.runtimeSessionIncarnationId,
		controlHostSocketPath: endpoint.socketPath,
	};
	if (
		input.resumeExistingSubmissionOnly &&
		Object.entries(binding).some(
			([key, value]) =>
				delivery.nativeCompactionAwareConfirmation?.binding[key as keyof CodexRvfCloseoutConfirmationBinding] !==
				value,
		)
	)
		return null;
	return {
		binding,
		promptText,
		validateStillAuthorized: async () => {
			const latest = (
				await readRvfAutomaticCloseoutRecords(getRvfAutomaticCloseoutStorePath(input.workspaceId))
			).find((entry) => entry.receipt.decision_token === binding.decisionToken && entry.taskId === binding.taskId);
			return (
				latest?.status === "submitting_closeout_prompt" &&
				latest.explicitStopRequestedAt === undefined &&
				latest.conversationSessionId === binding.conversationSessionId &&
				latest.runId === binding.runId &&
				latest.handoffSha256 === binding.handoffSha256 &&
				latest.promptDeliveryIdempotencyKey === binding.idempotencyKey
			);
		},
		persistSnapshot: (snapshot, expectedRevision) =>
			persistTaskMessageNativeCompactionAwareConfirmation({
				ledgerPath,
				ledgerTaskId: delivery.task_id,
				snapshot,
				expectedRevision,
			}),
	};
}
