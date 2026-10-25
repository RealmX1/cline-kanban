import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveVerifiedAdditionalNativeConversationTranscriptPath } from "../agent-session-history/verified-additional-native-conversation-transcript-location";
import {
	resolveMigratedCodexConversationHome,
	resolveRecordedCodexConversationHome,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type {
	TaskMainSessionHandoverRecord,
	TaskMainSessionHandoverReportAcceptanceProbe,
} from "../core/task-main-session-handover-contract";

type AutomaticRecovery = NonNullable<TaskMainSessionHandoverRecord["automaticRecovery"]>;
export async function fingerprintTaskMainSessionHandoverRecoveryEvidence(input: {
	record: TaskMainSessionHandoverRecord;
	source?: RuntimeTaskSessionSummary;
	target?: RuntimeTaskSessionSummary;
}) {
	const probe = input.record.reportAcceptanceProbe;
	// 游标和访问记录是查询自身的进度，不能成为重置恢复预算的外部证据。
	const descriptions: unknown[] = [
		probe && {
			targetAgentId: probe.targetAgentId,
			nativeSessionId: probe.nativeSessionId,
			workingDirectoryPath: probe.workingDirectoryPath,
			codexConversationStorageHomeDirectoryPath: probe.codexConversationStorageHomeDirectoryPath,
		},
	];
	const additionalNativeEvidencePaths: string[] = [];
	for (const summary of [input.source, input.target]) {
		const identity = summary?.agentNativeConversationSessionIdentity;
		if (summary && (summary.agentId === "cursor" || summary.agentId === "kimi")) {
			const path = await resolveVerifiedAdditionalNativeConversationTranscriptPath(summary).catch(() => null);
			descriptions.push([summary.taskId, path]);
			if (path) additionalNativeEvidencePaths.push(path);
		}
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
	const preparedNativeForkEvidencePaths: string[] = [];
	if (input.record.nativeForkPreparationReceiptPath) {
		try {
			const receipt = z
				.object({
					attempts: z.array(z.object({ childIdentity: z.object({ transcriptPath: z.string() }).nullable() })),
					frozenOmpArtifactFilesSha256: z.record(z.string(), z.string()).optional(),
				})
				.parse(JSON.parse(await readFile(input.record.nativeForkPreparationReceiptPath, "utf8")));
			for (const [index, attempt] of receipt.attempts.entries()) {
				preparedNativeForkEvidencePaths.push(
					`${input.record.nativeForkPreparationReceiptPath}.attempt-${index + 1}.child-identity.json`,
				);
				if (attempt.childIdentity) {
					preparedNativeForkEvidencePaths.push(attempt.childIdentity.transcriptPath);
					for (const relativePath of Object.keys(receipt.frozenOmpArtifactFilesSha256 ?? {}))
						preparedNativeForkEvidencePaths.push(
							join(attempt.childIdentity.transcriptPath.replace(/\.jsonl$/u, ""), relativePath),
						);
				}
			}
		} catch {
			/* 凭据暂不可读时保留未知；不据此重新创建模型回合。 */
		}
	}
	for (const path of [
		...additionalNativeEvidencePaths,
		...preparedNativeForkEvidencePaths,
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
		(input.previous.evidenceFingerprint !== input.evidenceFingerprint ||
			input.previous.attemptCount < 3 ||
			input.previous.reportAcceptanceScanPendingContinuation === true)
	);
}

export function beginTaskMainSessionHandoverMachineEvidenceAttempt(input: {
	previous?: AutomaticRecovery;
	evidenceFingerprint: string;
	stage: AutomaticRecovery["stage"];
	now: number;
	reason: string;
}): AutomaticRecovery {
	const sameEvidence = input.previous?.evidenceFingerprint === input.evidenceFingerprint;
	const continuingScan = sameEvidence && input.previous?.reportAcceptanceScanPendingContinuation === true;
	const attemptCount = sameEvidence && input.previous ? input.previous.attemptCount + (continuingScan ? 0 : 1) : 1;
	return {
		classification: "waiting_for_machine_evidence",
		stage: input.stage,
		reason: input.reason,
		evidenceFingerprint: input.evidenceFingerprint,
		attemptCount,
		lastAttemptAt: input.now,
		// 续页资格先消耗并持久化；查询抛错或没有新进度时不能无限续期。
		reportAcceptanceScanPendingContinuation: false,
		reportAcceptanceScanVisitedCursorPairs: continuingScan
			? (input.previous?.reportAcceptanceScanVisitedCursorPairs ?? [])
			: [],
		nextAttemptAt: attemptCount < 3 ? input.now + 15_000 : null,
		recheckCondition: "原生历史、存储迁移记录、控制端点或固定准备凭据变化后自动重验；不重复发送汇报。",
	};
}

export function recordTaskMainSessionHandoverReportAcceptanceScanProgress(input: {
	previous: AutomaticRecovery;
	before: TaskMainSessionHandoverReportAcceptanceProbe;
	after: TaskMainSessionHandoverReportAcceptanceProbe;
}): AutomaticRecovery {
	const beforeCursorPair = JSON.stringify([input.before.nativeHistoryCursor, input.before.transcriptHistoryCursor]);
	const afterCursorPair = JSON.stringify([input.after.nativeHistoryCursor, input.after.transcriptHistoryCursor]);
	const visitedCursorPairs = input.previous.reportAcceptanceScanVisitedCursorPairs ?? [];
	const pendingContinuation =
		!input.after.historicalAcceptanceEvidence &&
		(input.after.nativeHistoryCursor !== null || input.after.transcriptHistoryCursor !== null) &&
		beforeCursorPair !== afterCursorPair &&
		!visitedCursorPairs.includes(afterCursorPair);
	return {
		...input.previous,
		reportAcceptanceScanPendingContinuation: pendingContinuation,
		reportAcceptanceScanVisitedCursorPairs: pendingContinuation
			? [...new Set([...visitedCursorPairs, beforeCursorPair, afterCursorPair])]
			: visitedCursorPairs,
		nextAttemptAt:
			pendingContinuation || input.previous.attemptCount < 3 ? input.previous.lastAttemptAt + 15_000 : null,
	};
}
