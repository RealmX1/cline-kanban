import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
	RvfAutomaticCloseoutExecutionResultReportRequest,
	RvfAutomaticCloseoutRecord,
} from "../core/rvf-automatic-closeout-contract";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";

export class RvfAutomaticCloseoutExecutionResultDeliveryPendingError extends Error {}

const landedCandidateEvidenceSchema = z.object({
	subject: z.object({ head_oid: z.string(), worktree_realpath: z.string(), git_common_dir_realpath: z.string() }),
	review: z.object({ run_id: z.string(), protocol_valid: z.literal(true) }),
});

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
		if ((await readFile(`${path}.sha256`, "utf8")).trim() !== computeRvfTextSha256(bytes))
			throw new Error("land evidence 摘要不一致。");
		const evidence = landedCandidateEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
		if (
			evidence.subject.head_oid !== commit ||
			evidence.review.run_id !== record.runId ||
			(await realpath(evidence.subject.worktree_realpath)) !== (await realpath(record.receipt.worktree)) ||
			(await realpath(evidence.subject.git_common_dir_realpath)) !==
				(await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])))
		)
			throw new Error("land evidence 与提交、run 或工作区绑定不一致。");
	} else {
		if (record.landExecutionResult?.outcome !== "completed" || !record.landExecutionResult.commitSha)
			throw new Error("尚未确认 land 成功，不能登记 base 同步完成。");
		const baseRef = input.baseRef;
		if (!record.runDirectory) throw new Error("缺少绑定的 RVF run 目录。");
		const scopeContract = z
			.object({ base_ref: z.string().nullable().optional() })
			.parse(
				JSON.parse(await readFile(join(record.runDirectory, "artifacts", "inputs", "scope.contract.json"), "utf8")),
			);
		const boundBaseRef = scopeContract.base_ref ?? record.receipt.comparison_base_ref;
		const normalizeLocalBaseRef = (value: string) => value.replace(/^refs\/heads\//u, "");
		if (!baseRef || !boundBaseRef || normalizeLocalBaseRef(baseRef) !== normalizeLocalBaseRef(boundBaseRef))
			throw new Error("base 同步结果与已绑定的本地 base ref 不一致。");
		const fullRef = baseRef.startsWith("refs/heads/") ? baseRef : `refs/heads/${baseRef}`;
		await git(["check-ref-format", fullRef]);
		await git(["merge-base", "--is-ancestor", record.landExecutionResult.commitSha, commit]);
		await git(["merge-base", "--is-ancestor", commit, fullRef]);
	}
}
