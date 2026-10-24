import { stat } from "node:fs/promises";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type {
	RvfAutomaticCloseoutRecord,
	RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse,
} from "../core/rvf-automatic-closeout-contract";
import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";

export type AutomaticLateNativePromptAcceptanceRecoveryTrigger =
	| "background_sweep"
	| "status_query"
	| "execution_report";

export function isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(record: RvfAutomaticCloseoutRecord) {
	return (
		record.status === "paused" &&
		record.pauseReason === "收尾投递失败：submit_confirmation_budget_exhausted" &&
		record.explicitStopRequestedAt === undefined &&
		record.runId !== null &&
		record.handoffSha256 !== null &&
		record.restoredTranscriptPath !== null
	);
}

// 普通扫描只读文件元数据。同一收尾绑定、会话代际与转录证据最多核验三次；新证据或服务重建重新核验，绝不重投正文。
export function createAutomaticLateNativeCloseoutPromptAcceptanceRecovery() {
	const attempts = new Map<string, { fingerprint: string; count: number; nextAttemptAtMs: number }>();
	return async (input: {
		record: RvfAutomaticCloseoutRecord;
		summary: RuntimeTaskSessionSummary;
		trigger: AutomaticLateNativePromptAcceptanceRecoveryTrigger;
		recover: () => Promise<RvfLateNativeCloseoutPromptAcceptanceRecoveryResponse>;
	}) => {
		const { record, summary } = input;
		if (!isRvfCloseoutEligibleForAutomaticLateNativeAcceptanceRecovery(record)) return;
		const identity = summary.agentNativeConversationSessionIdentity;
		if (
			summary.taskId !== record.conversationSessionId ||
			identity?.nativeSessionId !== record.restoredNativeSessionId
		)
			return;
		const metadata = await stat(record.restoredTranscriptPath ?? "").catch(() => null);
		if (!metadata) return;
		const fingerprint = JSON.stringify([
			record.conversationSessionId,
			record.runId,
			record.handoffSha256,
			record.promptDeliveryIdempotencyKey,
			record.restoredTranscriptPath,
			summary.startedAt,
			summary.runtimeSessionIncarnationId,
			identity?.nativeSessionId,
			identity?.transcriptPath,
			metadata.dev,
			metadata.ino,
			metadata.size,
			metadata.mtimeMs,
		]);
		const key = `${record.workspaceId}:${record.taskId}:${record.receipt.decision_token}`;
		const previous = attempts.get(key);
		const sameEvidence = previous?.fingerprint === fingerprint;
		if (sameEvidence && (previous.count >= 3 || previous.nextAttemptAtMs > Date.now())) return;
		const attempt = {
			fingerprint,
			count: sameEvidence ? previous.count + 1 : 1,
			nextAttemptAtMs: Date.now() + 15_000,
		};
		attempts.set(key, attempt);
		const result = await input.recover();
		if (result.status === "recovered" || result.status === "already_recovered") attempts.delete(key);
		else if (result.status === "blocked") attempt.count = 3;
		appendDiagnosticEventToRotatingJsonlJournal("rvf-late-native-closeout-prompt-acceptance-automatic-recovery", {
			workspaceId: record.workspaceId,
			taskId: record.taskId,
			decisionToken: record.receipt.decision_token,
			runId: record.runId,
			trigger: input.trigger,
			outcome: result.status,
			reasonCode: result.reasonCode,
		});
	};
}
