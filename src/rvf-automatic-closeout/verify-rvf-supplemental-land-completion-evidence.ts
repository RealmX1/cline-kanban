import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
	RvfAutomaticCloseoutRecord,
	RvfSupplementalLandCompletionEvidenceReference,
} from "../core/rvf-automatic-closeout-contract";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";

export function resolveRvfSupplementalCompletionVerificationExecutable() {
	// 与 rvf-history 共用只读生产方入口；RVF_HOME 只决定数据根。
	return process.env.KANBAN_RVF_INSPECTION_EXECUTABLE_PATH?.trim() || join(homedir(), ".rvf", "bin", "rvf");
}

export function getRvfSupplementalCompletionEvidenceDirectory(record: RvfAutomaticCloseoutRecord) {
	if (!record.runDirectory) throw new Error("缺少补充证明绑定的原 run 目录。");
	return join(record.runDirectory, "artifacts", "supplemental-land-completion-evidence");
}

export async function readRvfSupplementalCompletionCapabilityFingerprint(record: RvfAutomaticCloseoutRecord) {
	const directory = getRvfSupplementalCompletionEvidenceDirectory(record);
	const names = (await readdir(directory).catch(() => [] as string[])).sort();
	const executable = resolveRvfSupplementalCompletionVerificationExecutable();
	const paths = [
		directory,
		...names
			.filter((name) => /^[a-f0-9]{64}\.(?:json|bundle)(?:\.sha256)?$/u.test(name))
			.map((name) => join(directory, name)),
		record.handoffPath ?? "",
		executable,
		await realpath(executable).catch(() => executable),
	];
	const metadata = await Promise.all(
		paths.map(async (path) => {
			try {
				const entry = await lstat(path);
				return [path, entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs, entry.isSymbolicLink()];
			} catch (error) {
				return [path, (error as NodeJS.ErrnoException).code ?? "unknown"];
			}
		}),
	);
	const git = (arguments_: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...arguments_], record.receipt.worktree).catch(
			(error: NodeJS.ErrnoException) => `unavailable:${error.code ?? "unknown"}`,
		);
	const targets = await findBoundRvfSupplementalCompletionReferences(record).catch(() => []);
	// 只探测目标 commit/tree 是否可读；对象补回但 HEAD/ref 未改变时也能自动重开预算。
	const targetObjectAvailability = await Promise.all(
		[...new Set(targets.map((entry) => entry.targetCommitSha))].map(async (target) => [
			target,
			await git(["cat-file", "-e", `${target}^{commit}`]),
			await git(["cat-file", "-e", `${target}^{tree}`]),
		]),
	);
	return JSON.stringify([
		record.workspaceId,
		record.taskId,
		record.receipt,
		record.runId,
		record.runDirectory,
		record.handoffSha256,
		metadata,
		targetObjectAvailability,
		await git(["rev-parse", "HEAD"]),
		await git(["rev-parse", "--git-common-dir"]),
	]);
}

export async function findBoundRvfSupplementalCompletionReferences(record: RvfAutomaticCloseoutRecord) {
	const directory = getRvfSupplementalCompletionEvidenceDirectory(record);
	const references: Array<RvfSupplementalLandCompletionEvidenceReference & { targetCommitSha: string }> = [];
	for (const name of (await readdir(directory)).sort()) {
		if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
		try {
			const evidencePath = join(directory, name);
			const metadata = await lstat(evidencePath);
			if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
			const evidence = supplementalLandCompletionBindingSchema.parse(
				JSON.parse(await readFile(evidencePath, "utf8")),
			);
			const binding = evidence.binding;
			if (
				binding.task_id === record.taskId &&
				binding.decision_token === record.receipt.decision_token &&
				binding.run_id === record.runId &&
				binding.handoff_sha256 === record.handoffSha256
			)
				references.push({
					evidencePath,
					evidenceSha256: name.slice(0, 64),
					targetCommitSha: binding.target_commit,
				});
		} catch {
			/* 未发布完或损坏的条目不能授证；完整核验只处理能精确定位的引用。 */
		}
	}
	if (new Set(references.map((entry) => entry.targetCommitSha)).size > 1)
		throw new Error("同一 run 存在多个补充目标，须由精确执行报告指定证明；不推断 latest。");
	return references;
}

// 这里只解析查找证明所需的绑定；双审、处置和验证的权威判据全部由 RVF verify 重放。
export const supplementalLandCompletionBindingSchema = z.object({
	schema: z.literal("rvf-supplemental-land-completion-evidence"),
	schema_version: z.literal(1),
	binding: z.object({
		task_id: z.string(),
		decision_token: z.string(),
		run_id: z.string(),
		run_directory: z.string(),
		handoff_sha256: z.string(),
		target_commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
	}),
	repository_git_common_directory: z.string(),
	source_snapshots: z.object({ "artifacts/inputs/scope.contract.json": z.string() }),
	does_not_attest_precommit_review: z.literal(true),
	does_not_authorize_followup_execution: z.literal(true),
});

const supplementalVerificationResponseSchema = z.object({
	status: z.literal("acceptable"),
	historical_completion: z.object({
		status: z.literal("verified"),
		target_commit: z.string(),
		target_tree: z.string(),
	}),
	current_execution_eligibility: z.object({
		status: z.enum(["requires_current_authorization_check", "execution_prohibited"]),
		stop_restrictions_unchanged: z.literal(true),
		task_id: z.string(),
	}),
	evidence_path: z.string(),
	evidence_sha256: z.string(),
});

async function querySupplementalCompletionVerifier(arguments_: string[]): Promise<unknown> {
	return new Promise((accept, reject) => {
		execFile(
			resolveRvfSupplementalCompletionVerificationExecutable(),
			arguments_,
			{
				timeout: 15_000,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
				windowsHide: true,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", PYTHONDONTWRITEBYTECODE: "1" },
			},
			(error, stdout) => {
				try {
					const result: unknown = JSON.parse(stdout);
					if (error) {
						const diagnostic = z.object({ status: z.string(), reason: z.string().optional() }).parse(result);
						return reject(
							new Error(
								`RVF 补充证明核验未接受：${diagnostic.status}；${diagnostic.reason ?? "保留原始证明并等待证据变化。"}`,
							),
						);
					}
					accept(result);
				} catch {
					reject(new Error(`RVF 补充证明核验接口暂不可用：${error?.code ?? "invalid_json"}`));
				}
			},
		);
	});
}

export async function verifyBoundRvfSupplementalLandCompletionEvidence(
	record: RvfAutomaticCloseoutRecord,
	commitSha: string,
	reference: RvfSupplementalLandCompletionEvidenceReference,
) {
	if (!record.runDirectory || !record.runId || !record.handoffPath || !record.handoffSha256)
		throw new Error("补充完成证明缺少原 run/handoff 绑定。");
	if (record.receipt.kanban_task_id !== record.taskId) throw new Error("补充完成证明的开审 task 归属不符。");
	const runDirectory = await realpath(record.runDirectory);
	const expectedPath = join(
		runDirectory,
		"artifacts",
		"supplemental-land-completion-evidence",
		`${reference.evidenceSha256}.json`,
	);
	const [proofMetadata, sidecarMetadata] = await Promise.all([
		lstat(reference.evidencePath),
		lstat(`${reference.evidencePath}.sha256`),
	]);
	if (
		(await realpath(reference.evidencePath)) !== expectedPath ||
		!proofMetadata.isFile() ||
		proofMetadata.isSymbolicLink() ||
		!sidecarMetadata.isFile() ||
		sidecarMetadata.isSymbolicLink()
	)
		throw new Error("补充完成证明必须是绑定 run 内的内容寻址原件。");
	const bytes = await readFile(reference.evidencePath);
	if (
		computeRvfTextSha256(bytes) !== reference.evidenceSha256 ||
		(await readFile(`${reference.evidencePath}.sha256`, "utf8")).trim() !== reference.evidenceSha256 ||
		computeRvfTextSha256(await readFile(record.handoffPath)) !== record.handoffSha256
	)
		throw new Error("补充完成证明、sidecar 或原 handoff 摘要不符。");
	const evidence = supplementalLandCompletionBindingSchema.parse(JSON.parse(bytes.toString("utf8")));
	const binding = evidence.binding;
	const git = (arguments_: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...arguments_], record.receipt.worktree);
	const gitCommonDirectoryRealpath = await realpath(
		await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
	);
	if (
		binding.task_id !== record.taskId ||
		binding.decision_token !== record.receipt.decision_token ||
		binding.run_id !== record.runId ||
		(await realpath(binding.run_directory)) !== runDirectory ||
		binding.handoff_sha256 !== record.handoffSha256 ||
		binding.target_commit !== commitSha ||
		(await realpath(evidence.repository_git_common_directory)) !== gitCommonDirectoryRealpath
	)
		throw new Error("补充完成证明的 task/token/run/handoff/目标提交或 Git common-dir 不符。");
	await git(["merge-base", "--is-ancestor", commitSha, "HEAD"]);
	const targetTreeSha = await git(["rev-parse", "--verify", `${commitSha}^{tree}`]);
	const response = supplementalVerificationResponseSchema.parse(
		await querySupplementalCompletionVerifier([
			"land",
			"supplemental-completion",
			"verify",
			"--repo",
			record.receipt.worktree,
			"--task-id",
			record.taskId,
			"--decision-token",
			record.receipt.decision_token,
			"--run-id",
			record.runId,
			"--run-dir",
			record.runDirectory,
			"--handoff-sha256",
			record.handoffSha256,
			"--target-commit",
			commitSha,
			"--evidence",
			reference.evidencePath,
			"--evidence-sha256",
			reference.evidenceSha256,
		]),
	);
	if (
		response.historical_completion.target_commit !== commitSha ||
		response.historical_completion.target_tree !== targetTreeSha ||
		response.current_execution_eligibility.task_id !== record.taskId ||
		response.evidence_sha256 !== reference.evidenceSha256 ||
		(await realpath(response.evidence_path)) !== expectedPath ||
		computeRvfTextSha256(await readFile(reference.evidencePath)) !== reference.evidenceSha256
	)
		throw new Error("补充完成证明的核验回执与当前精确绑定不符。");
	return {
		source: "historical_supplemental_completion" as const,
		workspaceId: record.workspaceId,
		taskId: record.taskId,
		decisionToken: record.receipt.decision_token,
		runId: record.runId,
		handoffSha256: record.handoffSha256,
		gitCommonDirectoryRealpath,
		targetCommitSha: commitSha,
		targetTreeSha,
		scopeContractSha256: computeRvfTextSha256(
			Buffer.from(evidence.source_snapshots["artifacts/inputs/scope.contract.json"], "base64"),
		),
		doesNotAttestPrecommitReview: true as const,
		doesNotAuthorizeFollowupExecution: true as const,
		currentExecutionEligibility: response.current_execution_eligibility.status,
	};
}
