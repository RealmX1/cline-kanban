import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import { withRunningCodexAppServerControlSocketConnection } from "./codex-app-server-request-connection";
import { getRvfAutomaticCloseoutStorePath, updateRvfAutomaticCloseoutRecords } from "./rvf-automatic-closeout-store";
import {
	appendRvfCloseoutSkillEvidence,
	captureRvfCloseoutExpectedSkillSnapshot,
} from "./rvf-closeout-skill-attachment-snapshot-store";

export async function captureExpectedRvfCloseoutSkillEvidenceOnce(input: {
	record: RvfAutomaticCloseoutRecord;
	summary: RuntimeTaskSessionSummary;
	text: string;
	idempotencyKey: string;
	warn: (message: string) => void;
}) {
	const { record, summary } = input;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	if (
		!endpoint ||
		endpoint.workspaceId !== record.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return;
	const storePath = getRvfAutomaticCloseoutStorePath(record.workspaceId);
	const reserved = await updateRvfAutomaticCloseoutRecords(storePath, (records) => {
		const current = records.find(
			(entry) => entry.taskId === record.taskId && entry.receipt.decision_token === record.receipt.decision_token,
		);
		if (
			!current ||
			current.explicitStopRequestedAt !== undefined ||
			current.runId !== record.runId ||
			current.expectedSkillSnapshotCaptureAttemptKeys?.includes(input.idempotencyKey)
		)
			return { records, value: false };
		return {
			records: records.map((entry) =>
				entry === current
					? {
							...entry,
							expectedSkillSnapshotCaptureAttemptKeys: [
								...(entry.expectedSkillSnapshotCaptureAttemptKeys ?? []),
								input.idempotencyKey,
							],
						}
					: entry,
			),
			value: true,
		};
	});
	if (!reserved) return;
	try {
		const reference = await withRunningCodexAppServerControlSocketConnection(
			(port) =>
				captureRvfCloseoutExpectedSkillSnapshot({
					record,
					port,
					text: input.text,
					idempotencyKey: input.idempotencyKey,
					onVersionReferences: async (references) => {
						await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
							records: records.map((entry) =>
								entry.taskId === record.taskId &&
								entry.receipt.decision_token === record.receipt.decision_token &&
								entry.explicitStopRequestedAt === undefined
									? {
											...entry,
											skillInstallationVersionReferences: [
												...(entry.skillInstallationVersionReferences ?? []),
												...references,
											],
										}
									: entry,
							),
							value: undefined,
						}));
					},
				}),
			{ socketPath: endpoint.socketPath },
		);
		if (reference)
			await updateRvfAutomaticCloseoutRecords(storePath, (records) => ({
				records: records.map((entry) =>
					entry.taskId === record.taskId &&
					entry.receipt.decision_token === record.receipt.decision_token &&
					entry.explicitStopRequestedAt === undefined
						? { ...entry, skillAttachmentEvidenceHistory: appendRvfCloseoutSkillEvidence(entry, reference) }
						: entry,
				),
				value: undefined,
			}));
	} catch {
		input.warn("投递前 Skill 快照暂不可用，将使用事件绑定的安装清单或可信原生展开补证。");
	}
}
