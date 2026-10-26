import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { captureCodexConfigurationExecutionClosure } from "../codex-configuration-sync/codex-configuration-execution-closure";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type { RvfCloseoutSkillInstallationVersionReference } from "../core/rvf-automatic-closeout-recovery-contract";
import {
	type RvfCloseoutSkillEvidenceReference,
	type RvfCloseoutSkillSnapshot,
	rvfCloseoutSkillSnapshotSchema,
} from "../core/rvf-automatic-closeout-recovery-contract";
import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import type { CodexAppServerRequestPort } from "./codex-native-conversation-prefix";
import { readCodexNativeCloseoutPromptAcceptanceEvidence } from "./read-codex-native-closeout-prompt-acceptance-evidence";
import { getRvfAutomaticCloseoutStorePath } from "./rvf-automatic-closeout-store";
import {
	captureRvfCloseoutSkillInstallationVersionReference,
	readRvfCloseoutHistoricalInstallationSnapshots,
} from "./rvf-closeout-historical-skill-installation-evidence";
import { parseCodexNativeSkillExpansion } from "./verify-codex-native-closeout-skill-attachment-evidence";

function snapshotDirectory(workspaceId: string) {
	return join(dirname(getRvfAutomaticCloseoutStorePath(workspaceId)), "rvf-closeout-skill-attachment-snapshots");
}
export async function readRvfCloseoutSkillEvidenceSourceAvailabilityFingerprint(record: RvfAutomaticCloseoutRecord) {
	const observeFile = async (path: string) => {
		const metadata = await lstat(path).catch(() => null);
		return metadata
			? [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs, metadata.isSymbolicLink()]
			: null;
	};
	const [snapshots, versions] = await Promise.all([
		Promise.all(
			(record.skillAttachmentEvidenceHistory ?? []).map(async (reference) => [
				reference.snapshotSha256,
				await observeFile(join(snapshotDirectory(record.workspaceId), `${reference.snapshotSha256}.json`)),
			]),
		),
		Promise.all(
			(record.skillInstallationVersionReferences ?? []).map(async (reference) => {
				let gitObjectAvailable = false;
				if (reference.gitVersion) {
					try {
						await getGitStdout(
							[
								"--no-replace-objects",
								"cat-file",
								"-e",
								`${reference.gitVersion.commitSha}:${reference.gitVersion.relativePath}`,
							],
							reference.gitVersion.repositoryPath,
						);
						gitObjectAvailable = true;
					} catch {
						/* 缺失的历史对象仍可由其它来源补齐。 */
					}
				}
				return [reference.instructionSha256, await observeFile(reference.realPath), gitObjectAvailable];
			}),
		),
	]);
	return JSON.stringify([snapshots, versions]);
}
export async function writeRvfCloseoutSkillSnapshot(
	input: RvfCloseoutSkillSnapshot,
): Promise<RvfCloseoutSkillEvidenceReference> {
	const snapshot = rvfCloseoutSkillSnapshotSchema.parse(input);
	const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
	const snapshotSha256 = computeRvfTextSha256(bytes);
	const directory = snapshotDirectory(snapshot.workspaceId);
	await mkdir(directory, { recursive: true });
	if ((await lstat(directory)).isSymbolicLink()) throw new Error("Skill 快照目录不能是符号链接。");
	const path = join(directory, `${snapshotSha256}.json`);
	try {
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await lstat(path)).isSymbolicLink() || !(await readFile(path)).equals(bytes))
			throw new Error("不可变 Skill 快照存在冲突。");
	}
	return {
		schema: "rvf-closeout-skill-attachment-evidence/v1",
		snapshotSha256,
		phase: snapshot.phase,
		promptDeliveryIdempotencyKey: snapshot.promptDeliveryIdempotencyKey,
		capturedAt: snapshot.capturedAt,
	};
}
export async function readRvfCloseoutSkillSnapshots(
	record: RvfAutomaticCloseoutRecord,
	nativeExpansions: string[] = [],
	options: { persistDiagnostics?: boolean } = {},
) {
	const snapshots: RvfCloseoutSkillSnapshot[] = [];
	for (const reference of record.skillAttachmentEvidenceHistory ?? []) {
		try {
			const path = join(snapshotDirectory(record.workspaceId), `${reference.snapshotSha256}.json`);
			if ((await lstat(path)).isSymbolicLink()) throw new Error("Skill 快照不能是符号链接。");
			const bytes = await readFile(path);
			if (computeRvfTextSha256(bytes) !== reference.snapshotSha256) throw new Error("Skill 快照摘要不符。");
			const snapshot = rvfCloseoutSkillSnapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
			if (
				snapshot.workspaceId !== record.workspaceId ||
				snapshot.taskId !== record.taskId ||
				snapshot.decisionToken !== record.receipt.decision_token ||
				snapshot.runId !== record.runId ||
				snapshot.handoffSha256 !== record.handoffSha256 ||
				snapshot.phase !== reference.phase ||
				snapshot.promptDeliveryIdempotencyKey !== reference.promptDeliveryIdempotencyKey
			)
				throw new Error("Skill 快照绑定不符。");
			snapshots.push(snapshot);
		} catch {
			// 一种来源不可用不禁止独立的可信原生补证；不会使用损坏内容作为历史别名证据。
			if (options.persistDiagnostics !== false)
				appendDiagnosticEventToRotatingJsonlJournal(
					"rvf-late-native-closeout-prompt-acceptance-automatic-recovery",
					{
						outcome: "skill_evidence_source_unavailable",
						workspaceId: record.workspaceId,
						taskId: record.taskId,
						snapshotSha256: reference.snapshotSha256,
					},
				);
		}
	}
	return [...snapshots, ...(await readRvfCloseoutHistoricalInstallationSnapshots(record, nativeExpansions))];
}
export function appendRvfCloseoutSkillEvidence(
	record: RvfAutomaticCloseoutRecord,
	reference: RvfCloseoutSkillEvidenceReference,
) {
	const previous = record.skillAttachmentEvidenceHistory ?? [];
	return previous.some((entry) => entry.snapshotSha256 === reference.snapshotSha256)
		? previous
		: [...previous, reference];
}
export async function captureRvfCloseoutExpectedSkillSnapshot(input: {
	record: RvfAutomaticCloseoutRecord;
	port: CodexAppServerRequestPort;
	text: string;
	idempotencyKey: string;
	onVersionReferences?: (references: RvfCloseoutSkillInstallationVersionReference[]) => Promise<void>;
}) {
	const { record } = input;
	const response = z
		.object({
			data: z.array(
				z.object({
					cwd: z.string(),
					skills: z.array(
						z.object({
							name: z.string(),
							path: z.string(),
							enabled: z.boolean(),
						}),
					),
					errors: z.array(z.unknown()),
				}),
			),
		})
		.parse(
			await input.port.request("skills/list", {
				cwds: [record.receipt.worktree],
				forceReload: true,
			}),
		);
	const catalog = response.data[0];
	if (
		response.data.length !== 1 ||
		!catalog ||
		catalog.errors.length ||
		(await realpath(catalog.cwd)) !== (await realpath(record.receipt.worktree))
	)
		throw new Error("Skill catalog 无法完整确认。");
	const names = [...input.text.matchAll(/\$([\p{L}\p{N}_.-]+(?::[\p{L}\p{N}_.-]+)*)/gu)].map(
		(match) => match[1] ?? "",
	);
	const skills: RvfCloseoutSkillSnapshot["skills"] = [];
	for (const name of new Set(names)) {
		const candidates = catalog.skills.filter(
			(skill) => skill.enabled && (skill.name === name || (!name.includes(":") && skill.name.endsWith(`:${name}`))),
		);
		const selected = candidates[0];
		if (candidates.length !== 1 || !selected || !isAbsolute(selected.path))
			throw new Error("投递前 Skill 归属不唯一。");
		const path = await realpath(selected.path);
		const bytes = await readFile(path);
		const instructionText = bytes.toString("utf8");
		if (!Buffer.from(instructionText).equals(bytes)) throw new Error("Skill 不是完整 UTF-8 文本。");
		skills.push({
			referenceName: name,
			referencePath: selected.path,
			canonicalName: selected.name,
			canonicalPath: selected.path,
			realPath: path,
			instructionText,
			executionClosure: await captureCodexConfigurationExecutionClosure(path),
		});
	}
	if (!skills.length) return null;
	if (input.onVersionReferences) {
		const references = await Promise.all(
			skills.map((skill) =>
				captureRvfCloseoutSkillInstallationVersionReference({
					record,
					idempotencyKey: input.idempotencyKey,
					promptSha256: computeRvfTextSha256(input.text),
					skill,
				}),
			),
		);
		await input.onVersionReferences(references);
	}
	return writeRvfCloseoutSkillSnapshot({
		schema: "rvf-closeout-skill-attachment-snapshot/v1",
		workspaceId: record.workspaceId,
		taskId: record.taskId,
		decisionToken: record.receipt.decision_token,
		runId: record.runId ?? "",
		handoffSha256: record.handoffSha256 ?? "",
		promptSha256: computeRvfTextSha256(input.text),
		promptDeliveryIdempotencyKey: input.idempotencyKey,
		phase: "expected_installation",
		capturedAt: Date.now(),
		skills,
	});
}
export async function captureRvfCloseoutAcceptedSkillSnapshot(
	record: RvfAutomaticCloseoutRecord,
	delivery: {
		idempotencyKey: string;
		promptSha256: string;
		createdAt: string;
		nativeMessageId?: string;
	},
) {
	const evidence = await readCodexNativeCloseoutPromptAcceptanceEvidence({
		transcriptPath: record.restoredTranscriptPath ?? "",
		nativeSessionId: record.restoredNativeSessionId ?? "",
		worktree: record.receipt.worktree,
		promptSha256: delivery.promptSha256,
		deliveryCreatedAt: delivery.createdAt,
		decisionToken: record.receipt.decision_token,
		runId: record.runId ?? "",
		handoffSha256: record.handoffSha256 ?? "",
		handoffPath: record.handoffPath ?? "",
		previousTranscriptSnapshot:
			delivery.idempotencyKey === record.promptDeliveryIdempotencyKey
				? record.lateNativePromptAcceptanceRecoveryReceipt
				: undefined,
	});
	if (delivery.nativeMessageId && evidence.nativeUserMessageId !== delivery.nativeMessageId)
		throw new Error("实际 Skill 快照的消息身份不符。");
	return writeRvfCloseoutSkillSnapshot({
		schema: "rvf-closeout-skill-attachment-snapshot/v1",
		workspaceId: record.workspaceId,
		taskId: record.taskId,
		decisionToken: record.receipt.decision_token,
		runId: record.runId ?? "",
		handoffSha256: record.handoffSha256 ?? "",
		promptSha256: delivery.promptSha256,
		promptDeliveryIdempotencyKey: delivery.idempotencyKey,
		phase: "accepted_native_expansion",
		capturedAt: Date.now(),
		nativeMessageRecordedAt: evidence.nativeUserMessageRecordedAt,
		nativeSessionId: record.restoredNativeSessionId ?? "",
		nativeTurnId: evidence.nativeTurnId,
		nativeMessageId: evidence.nativeUserMessageId,
		transcriptSha256: evidence.transcriptSha256,
		transcriptByteLength: evidence.transcriptByteLength,
		skills: evidence.skillReferences.map((reference, index) => {
			const expansionText = evidence.nativeSkillExpansionTexts[index] ?? "";
			const expansion = parseCodexNativeSkillExpansion(expansionText);
			return {
				referenceName: reference.name,
				referencePath: reference.path,
				canonicalName: expansion.name,
				canonicalPath: expansion.path,
				realPath: expansion.path,
				instructionText: expansion.instructionText,
				expansionText,
			};
		}),
	});
}
