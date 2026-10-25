import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type {
	RvfCloseoutSkillInstallationVersionReference,
	RvfCloseoutSkillSnapshot,
} from "../core/rvf-automatic-closeout-recovery-contract";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { parseCodexNativeSkillExpansion } from "./verify-codex-native-closeout-skill-attachment-evidence";

async function readPinnedGitSkillBlobAsExactUtf8(repositoryPath: string, commitSha: string, relativePath: string) {
	const objectExpression = `${commitSha}:${relativePath}`;
	const [text, blobOid] = await Promise.all([
		getGitStdout(["--no-replace-objects", "show", objectExpression], repositoryPath, { trimStdout: false }),
		getGitStdout(["--no-replace-objects", "rev-parse", "--verify", objectExpression], repositoryPath),
	]);
	if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(blobOid)) throw new Error("历史 Skill blob 身份不完整。");
	const bytes = Buffer.from(text, "utf8");
	const expectedOid = createHash(blobOid.length === 64 ? "sha256" : "sha1")
		.update(`blob ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
	if (expectedOid !== blobOid) throw new Error("历史 Skill blob 不能无损还原为 UTF-8。");
	return text;
}

export async function captureRvfCloseoutSkillInstallationVersionReference(input: {
	record: RvfAutomaticCloseoutRecord;
	idempotencyKey: string;
	promptSha256: string;
	skill: RvfCloseoutSkillSnapshot["skills"][number];
}): Promise<RvfCloseoutSkillInstallationVersionReference> {
	const { record, skill } = input;
	const instructionSha256 = computeRvfTextSha256(skill.instructionText);
	let gitVersion: RvfCloseoutSkillInstallationVersionReference["gitVersion"];
	try {
		const repositoryPath = await getGitStdout(["rev-parse", "--show-toplevel"], dirname(skill.realPath));
		const commitSha = await getGitStdout(["rev-parse", "HEAD"], repositoryPath);
		const relativePath = relative(repositoryPath, skill.realPath).split("\\").join("/");
		if (!relativePath.startsWith("../")) {
			const text = await readPinnedGitSkillBlobAsExactUtf8(repositoryPath, commitSha, relativePath);
			if (computeRvfTextSha256(text) === instructionSha256) gitVersion = { repositoryPath, commitSha, relativePath };
		}
	} catch {
		/* 未提交的安装仍可由完整快照及原生内容核验，不猜测 Git 版本。 */
	}
	return {
		runId: record.runId ?? "",
		handoffSha256: record.handoffSha256 ?? "",
		promptDeliveryIdempotencyKey: input.idempotencyKey,
		promptSha256: input.promptSha256,
		referenceName: skill.referenceName,
		referencePath: skill.referencePath,
		canonicalName: skill.canonicalName,
		canonicalPath: skill.canonicalPath,
		realPath: skill.realPath,
		instructionSha256,
		capturedAt: Date.now(),
		...(gitVersion ? { gitVersion } : {}),
	};
}
export async function readRvfCloseoutHistoricalInstallationSnapshots(
	record: RvfAutomaticCloseoutRecord,
	nativeExpansions: string[] = [],
) {
	const result: RvfCloseoutSkillSnapshot[] = [];
	for (const reference of record.skillInstallationVersionReferences ?? []) {
		if (reference.runId !== record.runId || reference.handoffSha256 !== record.handoffSha256) continue;
		let instructionText: string | undefined;
		if (reference.gitVersion) {
			const version = reference.gitVersion;
			try {
				instructionText = await readPinnedGitSkillBlobAsExactUtf8(
					version.repositoryPath,
					version.commitSha,
					version.relativePath,
				);
			} catch {
				/* 继续已绑定的缓存或原生内容。 */
			}
		}
		if (instructionText === undefined || computeRvfTextSha256(instructionText) !== reference.instructionSha256) {
			try {
				const bytes = await readFile(reference.realPath);
				if (computeRvfTextSha256(bytes) !== reference.instructionSha256) throw new Error("历史缓存字节摘要不符。");
				instructionText = bytes.toString("utf8");
			} catch {
				instructionText = undefined;
			}
		}
		if (instructionText === undefined || computeRvfTextSha256(instructionText) !== reference.instructionSha256) {
			instructionText = undefined;
			for (const text of nativeExpansions) {
				try {
					const expansion = parseCodexNativeSkillExpansion(text);
					if (computeRvfTextSha256(expansion.instructionText) === reference.instructionSha256)
						instructionText = expansion.instructionText;
				} catch {
					/* wrapper 本身不作为来源证明。 */
				}
			}
		}
		if (instructionText === undefined || computeRvfTextSha256(instructionText) !== reference.instructionSha256)
			continue;
		result.push({
			schema: "rvf-closeout-skill-attachment-snapshot/v1",
			workspaceId: record.workspaceId,
			taskId: record.taskId,
			decisionToken: record.receipt.decision_token,
			runId: reference.runId,
			handoffSha256: reference.handoffSha256,
			promptDeliveryIdempotencyKey: reference.promptDeliveryIdempotencyKey,
			promptSha256: reference.promptSha256,
			phase: "historical_installation",
			capturedAt: reference.capturedAt,
			skills: [
				{
					referenceName: reference.referenceName,
					referencePath: reference.referencePath,
					canonicalName: reference.canonicalName,
					canonicalPath: reference.canonicalPath,
					realPath: reference.realPath,
					instructionText,
				},
			],
		});
	}
	return result;
}

import { createHash } from "node:crypto";
