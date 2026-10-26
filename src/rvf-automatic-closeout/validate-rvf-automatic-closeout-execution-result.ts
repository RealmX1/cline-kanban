import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
	RvfAutomaticCloseoutExecutionResultReportRequest,
	RvfAutomaticCloseoutRecord,
} from "../core/rvf-automatic-closeout-contract";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { boundRvfCloseoutGoalCompletion, completedRvfCloseoutStage } from "./rvf-closeout-scheduling-decision";
import { verifyBoundRvfSupplementalLandCompletionEvidence } from "./verify-rvf-supplemental-land-completion-evidence";

export class RvfAutomaticCloseoutExecutionResultDeliveryPendingError extends Error {}

const landedCandidateEvidenceSchema = z.object({
	subject: z.object({ head_oid: z.string(), worktree_realpath: z.string(), git_common_dir_realpath: z.string() }),
	review: z.object({ run_id: z.string(), protocol_valid: z.literal(true) }),
});

export async function readBoundRvfLandCandidateEvidence(record: RvfAutomaticCloseoutRecord, commit: string) {
	const git = (arguments_: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...arguments_], record.receipt.worktree);
	await git(["merge-base", "--is-ancestor", commit, "HEAD"]);
	const path = await git([
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"rvf/evidence/reviewed-task-candidate-evidence.json",
	]);
	if ((await lstat(path)).isSymbolicLink() || (await lstat(`${path}.sha256`)).isSymbolicLink())
		throw new Error("land evidence 及摘要不能是符号链接。");
	const bytes = await readFile(path);
	const candidateEvidenceSha256 = computeRvfTextSha256(bytes);
	if ((await readFile(`${path}.sha256`, "utf8")).trim() !== candidateEvidenceSha256)
		throw new Error("land evidence 摘要不一致。");
	const evidence = landedCandidateEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
	const gitCommonDirectoryRealpath = await realpath(
		await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
	);
	if (
		evidence.subject.head_oid !== commit ||
		evidence.review.run_id !== record.runId ||
		(await realpath(evidence.subject.worktree_realpath)) !== (await realpath(record.receipt.worktree)) ||
		(await realpath(evidence.subject.git_common_dir_realpath)) !== gitCommonDirectoryRealpath
	)
		throw new Error("land evidence 与提交、run 或工作区绑定不一致。");
	return { candidateEvidenceSha256, gitCommonDirectoryRealpath };
}

export async function readBoundRvfLocalBaseRef(record: RvfAutomaticCloseoutRecord) {
	if (!record.runDirectory) throw new Error("缺少绑定的 RVF run 目录。");
	const scopeBytes = await readFile(join(record.runDirectory, "artifacts", "inputs", "scope.contract.json"));
	if (
		record.landExecutionResult?.verificationBasis === "verified_supplemental_land_completion" &&
		computeRvfTextSha256(scopeBytes) !==
			record.landExecutionResult.supplementalLandCompletionVerification?.scopeContractSha256
	)
		throw new Error("当前 base scope 与已接受补充证明中的冻结原件不符。");
	const scopeContract = z
		.object({ base_ref: z.string().nullable().optional() })
		.parse(JSON.parse(scopeBytes.toString("utf8")));
	const boundBaseRef = scopeContract.base_ref ?? record.receipt.comparison_base_ref;
	if (!boundBaseRef || (boundBaseRef.startsWith("refs/") && !boundBaseRef.startsWith("refs/heads/")))
		throw new Error("缺少已绑定的本地 base ref。");
	const baseRef = boundBaseRef.startsWith("refs/heads/") ? boundBaseRef : `refs/heads/${boundBaseRef}`;
	await getGitStdout(["-c", "core.hooksPath=/dev/null", "check-ref-format", baseRef], record.receipt.worktree);
	return { baseRef, scopeContractSha256: computeRvfTextSha256(scopeBytes) };
}

async function readBoundRvfLandCompletionEvidence(
	record: RvfAutomaticCloseoutRecord,
	commitSha: string,
	options: { reuseIndependentLandCompletionForBaseIntegration?: boolean } = {},
) {
	const accepted = record.landExecutionResult;
	if (
		(accepted?.outcome === "completed" && accepted.commitSha === commitSha) ||
		(options.reuseIndependentLandCompletionForBaseIntegration &&
			completedRvfCloseoutStage(record, "land")?.commitSha === commitSha)
	) {
		// 这是服务端已接受的历史阶段；当前候选是可替换指针，不能撤销旧 run 的接受事实。
		const independentObservation =
			accepted?.outcome === "completed" ? undefined : boundRvfCloseoutGoalCompletion(record);
		const gitCommonDirectoryRealpath = await realpath(
			await getGitStdout(["rev-parse", "--path-format=absolute", "--git-common-dir"], record.receipt.worktree),
		);
		await getGitStdout(["cat-file", "-e", `${commitSha}^{commit}`], record.receipt.worktree);
		const expectedCommonDirectory = independentObservation
			? independentObservation.binding.gitCommonDirectoryRealpath
			: accepted?.supplementalLandCompletionVerification?.gitCommonDirectoryRealpath;
		if (
			independentObservation &&
			(!expectedCommonDirectory ||
				independentObservation.binding.worktreeRealpath !== (await realpath(record.receipt.worktree)))
		)
			throw new Error("独立 Land 完成观察缺少可信的 Git 或工作区归属。");
		if (expectedCommonDirectory && expectedCommonDirectory !== gitCommonDirectoryRealpath)
			throw new Error("历史 Land 的 Git common-dir 归属改变。");
		return {
			gitCommonDirectoryRealpath,
			...(accepted?.supplementalLandCompletionEvidence
				? {
						supplementalLandCompletionEvidenceSha256: accepted.supplementalLandCompletionEvidence.evidenceSha256,
					}
				: {}),
		};
	}
	if (accepted?.verificationBasis === "verified_supplemental_land_completion") {
		if (!accepted.supplementalLandCompletionEvidence || accepted.commitSha !== commitSha)
			throw new Error("已接受的历史 Land 缺少原补充证明引用。");
		const verification = await verifyBoundRvfSupplementalLandCompletionEvidence(
			record,
			commitSha,
			accepted.supplementalLandCompletionEvidence,
		);
		return {
			gitCommonDirectoryRealpath: verification.gitCommonDirectoryRealpath,
			supplementalLandCompletionEvidenceSha256: accepted.supplementalLandCompletionEvidence.evidenceSha256,
		};
	}
	return readBoundRvfLandCandidateEvidence(record, commitSha);
}

// 证明本次观测到的等价整合状态，不证明历史上由谁、在哪次 handback 中执行。
export async function readBoundRvfBaseIntegrationState(record: RvfAutomaticCloseoutRecord) {
	const landCommitSha = completedRvfCloseoutStage(record, "land")?.commitSha;
	if (!landCommitSha || !record.runId || !record.handoffSha256)
		throw new Error("尚未确认 land 成功，不能核验 base 整合。");
	if (record.receipt.kanban_task_id !== record.taskId) throw new Error("开审凭据的 task 归属不符。");
	const [candidate, base] = await Promise.all([
		readBoundRvfLandCompletionEvidence(record, landCommitSha, {
			reuseIndependentLandCompletionForBaseIntegration: true,
		}),
		readBoundRvfLocalBaseRef(record),
	]);
	const git = (arguments_: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...arguments_], record.receipt.worktree);
	const baseCommitSha = await git(["rev-parse", "--verify", `${base.baseRef}^{commit}`]);
	await git(["merge-base", "--is-ancestor", landCommitSha, baseCommitSha]);
	return {
		source: "observed_local_base_ancestry" as const,
		workspaceId: record.workspaceId,
		taskId: record.taskId,
		decisionToken: record.receipt.decision_token,
		runId: record.runId,
		handoffSha256: record.handoffSha256,
		...candidate,
		...base,
		landCommitSha,
		baseCommitSha,
	};
}

export async function validateRvfAutomaticCloseoutExecutionResult(
	record: RvfAutomaticCloseoutRecord,
	input: RvfAutomaticCloseoutExecutionResultReportRequest,
) {
	if (record.runId !== input.runId || record.handoffSha256 !== input.handoffSha256 || !record.handoffPath)
		throw new Error("执行结果与已登记的 run/handoff 绑定不一致。");
	if (computeRvfTextSha256(await readFile(record.handoffPath)) !== record.handoffSha256)
		throw new Error("已绑定的 handoff 内容改变，不能登记执行成功。");
	if (input.outcome !== "completed") return;
	const commit = input.commitSha;
	if (!commit) throw new Error("完成结果缺少真实提交。");
	const git = (arguments_: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...arguments_], record.receipt.worktree);
	await git(["cat-file", "-e", `${commit}^{commit}`]);
	if (input.stage === "land") {
		// 已提交候选可以复用开审前 HEAD，是否完成由当前 run 的 candidate evidence 证明。
		if (input.supplementalLandCompletionEvidence)
			await verifyBoundRvfSupplementalLandCompletionEvidence(
				record,
				commit,
				input.supplementalLandCompletionEvidence,
			);
		else await readBoundRvfLandCompletionEvidence(record, commit);
	} else {
		const landCommitSha = completedRvfCloseoutStage(record, "land")?.commitSha;
		if (!landCommitSha) throw new Error("尚未确认 land 成功，不能登记 base 同步完成。");
		await readBoundRvfLandCompletionEvidence(record, landCommitSha, {
			reuseIndependentLandCompletionForBaseIntegration: true,
		});
		const baseRef = input.baseRef;
		const { baseRef: boundBaseRef } = await readBoundRvfLocalBaseRef(record);
		const normalizeLocalBaseRef = (value: string) => value.replace(/^refs\/heads\//u, "");
		if (!baseRef || !boundBaseRef || normalizeLocalBaseRef(baseRef) !== normalizeLocalBaseRef(boundBaseRef))
			throw new Error("base 同步结果与已绑定的本地 base ref 不一致。");
		const fullRef = baseRef.startsWith("refs/heads/") ? baseRef : `refs/heads/${baseRef}`;
		await git(["check-ref-format", fullRef]);
		await git(["merge-base", "--is-ancestor", landCommitSha, commit]);
		await git(["merge-base", "--is-ancestor", commit, fullRef]);
	}
}
