import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import {
	resolveMigratedCodexConversationHome,
	resolveRecordedCodexConversationHome,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TaskMainSessionHandoverRecord } from "../core/task-main-session-handover-contract";

type AutomaticRecovery = NonNullable<TaskMainSessionHandoverRecord["automaticRecovery"]>;
export async function fingerprintTaskMainSessionHandoverRecoveryEvidence(input: {
	record: TaskMainSessionHandoverRecord;
	source?: RuntimeTaskSessionSummary;
	target?: RuntimeTaskSessionSummary;
}) {
	const descriptions: unknown[] = [input.record.reportAcceptanceProbe];
	for (const summary of [input.source, input.target]) {
		const identity = summary?.agentNativeConversationSessionIdentity;
		let migratedHome: string | null = null;
		if (summary && identity?.sourceAgentId === "codex") {
			try {
				migratedHome = await resolveMigratedCodexConversationHome(
					resolveRecordedCodexConversationHome({
						...summary,
						transcriptPath: identity.transcriptPath,
					}),
					identity.nativeSessionId,
				);
			} catch {
				/* 迁移证据暂不可读，仍保留原绑定与未知状态。 */
			}
		}
		descriptions.push([
			summary?.taskId,
			identity?.nativeSessionId,
			identity?.transcriptPath,
			migratedHome,
			summary?.runtimeSessionIncarnationId,
			summary?.codexNativeSessionControlEndpoint,
		]);
	}
	for (const path of [
		input.source?.agentNativeConversationSessionIdentity?.transcriptPath,
		input.target?.agentNativeConversationSessionIdentity?.transcriptPath,
		input.record.reportAcceptanceProbe?.transcriptPath,
		input.record.nativeForkPreparationReceiptPath,
	]) {
		if (!path) continue;
		const metadata = await stat(path).catch(() => null);
		descriptions.push([path, metadata?.dev, metadata?.ino, metadata?.size, metadata?.mtimeMs]);
	}
	return createHash("sha256").update(JSON.stringify(descriptions)).digest("hex");
}

export function canRetryTaskMainSessionHandoverMachineEvidence(input: {
	previous: AutomaticRecovery;
	evidenceFingerprint: string;
	now: number;
}) {
	return (
		input.previous.classification === "waiting_for_machine_evidence" &&
		input.now - input.previous.lastAttemptAt >= 15_000 &&
		(input.previous.evidenceFingerprint !== input.evidenceFingerprint || input.previous.attemptCount < 3)
	);
}

export function beginTaskMainSessionHandoverMachineEvidenceAttempt(input: {
	previous?: AutomaticRecovery;
	evidenceFingerprint: string;
	stage: AutomaticRecovery["stage"];
	now: number;
	reason: string;
}): AutomaticRecovery {
	const attemptCount =
		input.previous?.evidenceFingerprint === input.evidenceFingerprint ? input.previous.attemptCount + 1 : 1;
	return {
		classification: "waiting_for_machine_evidence",
		stage: input.stage,
		reason: input.reason,
		evidenceFingerprint: input.evidenceFingerprint,
		attemptCount,
		lastAttemptAt: input.now,
		nextAttemptAt: attemptCount < 3 ? input.now + 15_000 : null,
		recheckCondition: "原生历史、存储迁移记录、控制端点或固定准备凭据变化后自动重验；不重复发送汇报。",
	};
}
