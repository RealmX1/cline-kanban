import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { createGitProcessEnv } from "../core/git-process-env";
import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
import type { RvfCloseoutGoalCompletedStage } from "../core/rvf-closeout-goal-completion-contract";
import { getGitStdout } from "../workspace/git-utils";
import { computeRvfTextSha256 } from "./capture-rvf-review-start-boundary";
import { boundRvfCloseoutGoalCompletion, rvfCloseoutReceiptSha256 } from "./rvf-closeout-scheduling-decision";
import { readBoundRvfLocalBaseRef } from "./validate-rvf-automatic-closeout-execution-result";

const fullGitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const execFileAsync = promisify(execFile);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const historicalManualCloseoutRunBindingSchema = z.object({
	taskId: z.string(),
	decisionToken: z.string().optional(),
	runId: z.string().optional(),
	boundRun: z.string().optional(),
	handoffSha256: sha256DigestSchema,
});
const historicalManualLandExecutionReceiptSchema = historicalManualCloseoutRunBindingSchema.extend({
	schema: z.literal("user-authorized-manual-land-actual-execution/v1"),
	commitSha: fullGitObjectIdSchema,
	headBefore: fullGitObjectIdSchema.optional(),
	committedPaths: z.array(z.string()).optional(),
});
const historicalManualBaseSyncExecutionReceiptSchema = historicalManualCloseoutRunBindingSchema.extend({
	schema: z.literal("user-authorized-manual-base-sync-actual-execution/v1"),
	commitSha: fullGitObjectIdSchema,
	taskTip: fullGitObjectIdSchema,
	baseRef: z.string(),
	landCommitSha: fullGitObjectIdSchema,
	fixedBaseTip: fullGitObjectIdSchema,
});
const legacyManualBaseSyncExecutionReceiptSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	taskTip: fullGitObjectIdSchema,
	expectedBaseTip: fullGitObjectIdSchema,
	baseTipAfterLanding: fullGitObjectIdSchema,
});
const independentBackupRouteCompletionRecordSchema = z.object({
	status: z.literal("backup_closed"),
	operation_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u),
	original_run_directory: z.string(),
	worktree_git_directory: z.string(),
	artifacts_directory: z.string(),
	delivery_stage: z.enum(["review", "validate", "land", "base_sync"]),
	final_head: fullGitObjectIdSchema,
	content_fingerprint: sha256DigestSchema,
});
export interface CloseoutGoalCompletionSourceFile {
	path: string;
	bytes: Buffer;
}
export class CloseoutCompletionEvidenceConflict extends Error {}

export async function readCloseoutCompletionRegularFile(path: string) {
	const metadata = await lstat(path);
	if (
		!metadata.isFile() ||
		metadata.isSymbolicLink() ||
		metadata.size > 2 * 1024 * 1024 ||
		(await realpath(path)) !== resolve(path)
	)
		throw new CloseoutCompletionEvidenceConflict("完成材料不是受限的真实原件。");
	return { path, bytes: await readFile(path) };
}

const manualReceiptNames = new Set([
	"manual-land-actual-execution-receipt.json",
	"manual-base-sync-actual-execution-receipt.json",
	"base-sync-actual-execution-receipt.json",
]);
async function readCloseoutCompletionDirectoryEntries(path: string) {
	return readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
}
export async function discoverCloseoutGoalCompletionEvidencePaths(
	record: RvfAutomaticCloseoutRecord,
	gitDirectory: string,
) {
	const artifacts = join(record.runDirectory ?? "", "artifacts");
	const paths: string[] = [];
	for (const entry of await readCloseoutCompletionDirectoryEntries(artifacts)) {
		if (manualReceiptNames.has(entry.name)) paths.push(join(artifacts, entry.name));
		if (entry.isDirectory() && /^manual-closeout-retry-[a-zA-Z0-9-]+$/u.test(entry.name))
			for (const child of await readCloseoutCompletionDirectoryEntries(join(artifacts, entry.name)))
				if (manualReceiptNames.has(child.name)) paths.push(join(artifacts, entry.name, child.name));
	}
	for (const entry of await readCloseoutCompletionDirectoryEntries(
		join(artifacts, "rvf-land-commit-execution-results"),
	))
		if (/^[a-f0-9]{64}\.json$/u.test(entry.name))
			paths.push(join(artifacts, "rvf-land-commit-execution-results", entry.name));
	if (!isAbsolute(gitDirectory)) return [...new Set(paths)].sort();
	const control = join(gitDirectory, "rvf-independent-backup-route");
	for (const entry of await readCloseoutCompletionDirectoryEntries(join(control, "completed-operations")))
		if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.json$/u.test(entry.name))
			paths.push(join(control, "completed-operations", entry.name));
	for (const entry of await readCloseoutCompletionDirectoryEntries(join(control, "closed-ownership-markers")))
		if (entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(entry.name))
			paths.push(join(control, "closed-ownership-markers", entry.name, "identity.json"));
	paths.push(join(control, "active-owner", "identity.json"));
	paths.push(join(control, "consumed-original-runs", `${computeRvfTextSha256(record.runDirectory ?? "")}.json`));
	return [...new Set(paths)].sort();
}

export async function verifyCloseoutGoalOriginalRunBinding(record: RvfAutomaticCloseoutRecord) {
	if (
		!record.runDirectory ||
		!record.runId ||
		!record.handoffPath ||
		!record.handoffSha256 ||
		record.taskId !== record.receipt.kanban_task_id
	)
		throw new CloseoutCompletionEvidenceConflict("缺少原 task/run/handoff 归属。");
	const archivedReceipt = await readCloseoutCompletionRegularFile(
		join(record.runDirectory, "inputs", "automatic-closeout-review-start-receipt.json"),
	);
	const parsedReceipt = JSON.parse(archivedReceipt.bytes.toString("utf8")) as RvfAutomaticCloseoutRecord["receipt"];
	if (rvfCloseoutReceiptSha256({ ...record, receipt: parsedReceipt }) !== rvfCloseoutReceiptSha256(record))
		throw new CloseoutCompletionEvidenceConflict("原 run 开审凭据与任务绑定不符。");
	const scope = await readCloseoutCompletionRegularFile(
		join(record.runDirectory, "artifacts", "inputs", "scope.contract.json"),
	);
	const scopeValue = z
		.object({ run_id: z.string(), repo: z.string().optional() })
		.parse(JSON.parse(scope.bytes.toString("utf8")));
	const worktreeRealpath = await realpath(record.receipt.worktree);
	if (
		scopeValue.run_id !== record.runId ||
		(scopeValue.repo && (await realpath(scopeValue.repo)) !== worktreeRealpath)
	)
		throw new CloseoutCompletionEvidenceConflict("原 run 的 scope 与仓库归属不符。");
	const handoff = await readCloseoutCompletionRegularFile(record.handoffPath);
	if (computeRvfTextSha256(handoff.bytes) !== record.handoffSha256)
		throw new CloseoutCompletionEvidenceConflict("原 handoff 摘要不符。");
	const previouslyBoundWorktreeRealpath = boundRvfCloseoutGoalCompletion(record)?.binding.worktreeRealpath;
	if (previouslyBoundWorktreeRealpath && worktreeRealpath !== previouslyBoundWorktreeRealpath)
		throw new CloseoutCompletionEvidenceConflict("原 worktree 的真实路径归属改变。");
	const checkpointTree = await getGitStdout(
		["rev-parse", "--verify", `${fullGitObjectIdSchema.parse(record.receipt.checkpoint_commit)}^{tree}`],
		record.receipt.worktree,
	);
	if (checkpointTree !== record.receipt.checkpoint_tree)
		throw new CloseoutCompletionEvidenceConflict("原开审 checkpoint 与仓库对象归属不符。");
	return [archivedReceipt, scope, handoff];
}

export async function readCloseoutGoalCommitFacts(record: RvfAutomaticCloseoutRecord, commitSha: string) {
	fullGitObjectIdSchema.parse(commitSha);
	const git = (args: string[]) => getGitStdout(["-c", "core.hooksPath=/dev/null", ...args], record.receipt.worktree);
	if ((await git(["rev-parse", "--verify", `${commitSha}^{commit}`])) !== commitSha)
		throw new CloseoutCompletionEvidenceConflict("完成目标必须是完整提交 OID。");
	const treeSha = await git(["rev-parse", "--verify", `${commitSha}^{tree}`]);
	const parents = await git(["show", "-s", "--format=%P", commitSha]);
	return { commitSha, treeSha, parentCommitShas: parents ? parents.split(" ") : [] };
}
function assertHistoricalManualCloseoutRunBinding(
	record: RvfAutomaticCloseoutRecord,
	value: z.infer<typeof historicalManualCloseoutRunBindingSchema>,
) {
	if (
		value.taskId !== record.taskId ||
		(value.runId ?? value.boundRun) !== record.runId ||
		value.handoffSha256 !== record.handoffSha256 ||
		(value.decisionToken !== undefined && value.decisionToken !== record.receipt.decision_token)
	)
		throw new CloseoutCompletionEvidenceConflict("手动材料的 task/token/run/handoff 不符。");
}
function safeRepositoryRelativePath(path: string) {
	if (
		!path ||
		isAbsolute(path) ||
		path.split(/[\\/]/u).some((part) => part === ".." || part === ".") ||
		path.includes("\0")
	)
		throw new CloseoutCompletionEvidenceConflict("冻结源码路径非法。");
	return path;
}

// 兼容材料只定位目标；提交内容必须与原 run 的持久源码指纹逐项匹配。
async function verifyManualLandSourceSnapshot(record: RvfAutomaticCloseoutRecord, commitSha: string) {
	const artifacts = join(record.runDirectory ?? "", "artifacts");
	let snapshot: CloseoutGoalCompletionSourceFile;
	let fingerprints: Array<{ path: string; sha256: string }>;
	try {
		snapshot = await readCloseoutCompletionRegularFile(join(artifacts, "final-source-manifest.json"));
		const manifest = z
			.object({
				run_id: z.string(),
				task_id: z.string(),
				files: z.array(z.object({ path: z.string(), sha256: sha256DigestSchema })),
			})
			.parse(JSON.parse(snapshot.bytes.toString("utf8")));
		if (manifest.run_id !== record.runId || manifest.task_id !== record.taskId)
			throw new CloseoutCompletionEvidenceConflict("最终源码清单的 run/task 绑定不符。");
		fingerprints = manifest.files;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		snapshot = await readCloseoutCompletionRegularFile(join(artifacts, "after-workspace-snapshot.json"));
		const manifest = z
			.object({
				repo: z.string(),
				head: fullGitObjectIdSchema,
				path_fingerprints: z.record(
					z.string(),
					z.object({ exists: z.boolean(), type: z.string().optional(), sha256: sha256DigestSchema.optional() }),
				),
			})
			.parse(JSON.parse(snapshot.bytes.toString("utf8")));
		if (
			(await realpath(manifest.repo)) !== (await realpath(record.receipt.worktree)) ||
			manifest.head !== record.receipt.worktree_head_commit_sha
		)
			throw new CloseoutCompletionEvidenceConflict("原源码快照与仓库或开审 HEAD 不符。");
		fingerprints = Object.entries(manifest.path_fingerprints).map(([path, value]) => {
			if (!value.exists || value.type !== "file" || !value.sha256)
				throw new Error("历史源码指纹格式尚不能完整核验，等待等价源码清单。");
			return { path, sha256: value.sha256 };
		});
	}
	if (!fingerprints.length) throw new CloseoutCompletionEvidenceConflict("源码指纹清单为空。");
	for (const entry of fingerprints) {
		const { stdout } = await execFileAsync(
			"git",
			["cat-file", "blob", `${commitSha}:${safeRepositoryRelativePath(entry.path)}`],
			{
				cwd: record.receipt.worktree,
				encoding: "buffer",
				env: createGitProcessEnv(),
				timeout: 5_000,
				maxBuffer: 10 * 1024 * 1024,
			},
		);
		if (computeRvfTextSha256(stdout) !== entry.sha256)
			throw new CloseoutCompletionEvidenceConflict("目标提交与原 run 源码指纹不符。");
	}
	return snapshot;
}

export async function verifyHistoricalManualCloseoutEvidence(
	record: RvfAutomaticCloseoutRecord,
	files: CloseoutGoalCompletionSourceFile[],
	completedLand?: string,
) {
	const stages: RvfCloseoutGoalCompletedStage[] = [];
	const additionalFiles: CloseoutGoalCompletionSourceFile[] = [];
	const landFiles = files.filter((file) => basename(file.path) === "manual-land-actual-execution-receipt.json");
	const lands = landFiles.map((file) => ({
		file,
		value: historicalManualLandExecutionReceiptSchema.parse(JSON.parse(file.bytes.toString("utf8"))),
	}));
	for (const { value } of lands) assertHistoricalManualCloseoutRunBinding(record, value);
	if (new Set([...lands.map(({ value }) => value.commitSha), ...(completedLand ? [completedLand] : [])]).size > 1)
		throw new CloseoutCompletionEvidenceConflict("同一 run 的手动 Land 存在多个完成目标。");
	const git = (args: string[]) => getGitStdout(["-c", "core.hooksPath=/dev/null", ...args], record.receipt.worktree);
	for (const { file, value } of lands) {
		const facts = await readCloseoutGoalCommitFacts(record, value.commitSha);
		const expectedParent = value.headBefore ?? record.receipt.worktree_head_commit_sha;
		if (
			facts.parentCommitShas.length !== 1 ||
			facts.parentCommitShas[0] !== expectedParent ||
			expectedParent !== record.receipt.worktree_head_commit_sha
		)
			throw new CloseoutCompletionEvidenceConflict("手动 Land 的真实父提交与开审 HEAD 不符。");
		await git(["merge-base", "--is-ancestor", value.commitSha, "HEAD"]);
		if (value.committedPaths) {
			const paths = (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", value.commitSha]))
				.split("\0")
				.filter(Boolean)
				.sort();
			if (!paths.length || JSON.stringify(paths) !== JSON.stringify([...value.committedPaths].sort()))
				throw new CloseoutCompletionEvidenceConflict("手动 Land 的真实提交路径与原材料不符。");
		}
		const snapshot = await verifyManualLandSourceSnapshot(record, value.commitSha);
		additionalFiles.push(snapshot);
		stages.push({
			stage: "land",
			...facts,
			source: "historical_manual_execution",
			evidenceSha256s: [computeRvfTextSha256(file.bytes), computeRvfTextSha256(snapshot.bytes)],
			observedAt: Date.now(),
		});
	}
	const landCommitSha = completedLand ?? stages.find((stage) => stage.stage === "land")?.commitSha;
	const bases: Array<{
		file: CloseoutGoalCompletionSourceFile;
		commitSha: string;
		taskTip: string;
		baseRef: string;
		fixedBaseTip: string;
	}> = [];
	for (const file of files.filter((entry) =>
		["manual-base-sync-actual-execution-receipt.json", "base-sync-actual-execution-receipt.json"].includes(
			basename(entry.path),
		),
	)) {
		const raw: unknown = JSON.parse(file.bytes.toString("utf8"));
		const modern = historicalManualBaseSyncExecutionReceiptSchema.safeParse(raw);
		if (modern.success) {
			assertHistoricalManualCloseoutRunBinding(record, modern.data);
			if (modern.data.landCommitSha !== landCommitSha)
				throw new CloseoutCompletionEvidenceConflict("手动 base 的 Land 目标不符。");
			bases.push({ file, ...modern.data });
		} else {
			const value = legacyManualBaseSyncExecutionReceiptSchema.parse(raw);
			// 无 run/token 的旧 base 必须在同一持久目录与唯一 Land 原件配对。
			if (
				value.taskId !== record.taskId ||
				lands.filter((entry) => dirname(entry.file.path) === dirname(file.path)).length !== 1
			)
				throw new CloseoutCompletionEvidenceConflict("旧 base 回执无法与原 run 的唯一 Land 配对。");
			bases.push({ file, ...value, commitSha: value.baseTipAfterLanding, fixedBaseTip: value.expectedBaseTip });
		}
	}
	if (new Set(bases.map((entry) => entry.commitSha)).size > 1)
		throw new CloseoutCompletionEvidenceConflict("同一 run 存在多个手动 base 整合目标。");
	for (const value of bases) {
		if (!landCommitSha) throw new Error("base 材料已发现，等待独立 Land 完成事实。");
		const expectedBase = (await readBoundRvfLocalBaseRef(record)).baseRef.replace(/^refs\/heads\//u, "");
		if (!expectedBase || value.baseRef.replace(/^refs\/heads\//u, "") !== expectedBase)
			throw new CloseoutCompletionEvidenceConflict("手动 base 与原本地 base ref 不符。");
		const baseRef = `refs/heads/${expectedBase}`;
		await git(["check-ref-format", baseRef]);
		const facts = await readCloseoutGoalCommitFacts(record, value.commitSha);
		await git(["merge-base", "--is-ancestor", landCommitSha, value.taskTip]);
		await git(["merge-base", "--is-ancestor", value.taskTip, value.commitSha]);
		await git(["merge-base", "--is-ancestor", value.commitSha, baseRef]);
		if (
			facts.parentCommitShas[0] !== value.fixedBaseTip ||
			!facts.parentCommitShas.includes(value.taskTip) ||
			facts.treeSha !== (await git(["rev-parse", `${value.taskTip}^{tree}`]))
		)
			throw new CloseoutCompletionEvidenceConflict("手动 base 的父提交、任务 tip 或真实 tree 不符。");
		stages.push({
			stage: "base_branch_sync",
			...facts,
			baseRef,
			landCommitSha,
			source: "historical_manual_execution",
			evidenceSha256s: [computeRvfTextSha256(value.file.bytes)],
			observedAt: Date.now(),
		});
	}
	return { stages, additionalFiles };
}

export async function readIndependentBackupCompletionFromSource(
	record: RvfAutomaticCloseoutRecord,
	file: CloseoutGoalCompletionSourceFile,
	gitDirectory: string,
) {
	const raw = z
		.object({
			original_run_directory: z.string().nullish(),
			operation_id: z.string().optional(),
			artifacts_directory: z.string().optional(),
		})
		.passthrough()
		.parse(JSON.parse(file.bytes.toString("utf8")));
	if (raw.original_run_directory !== record.runDirectory) return null;
	independentBackupRouteCompletionRecordSchema.shape.operation_id.parse(raw.operation_id);
	const additionalFiles: CloseoutGoalCompletionSourceFile[] = [];
	let completionFile = file;
	if (dirname(file.path).endsWith("consumed-original-runs")) {
		if (!raw.operation_id) throw new CloseoutCompletionEvidenceConflict("备用消费索引缺少 operation 身份。");
		try {
			completionFile = await readCloseoutCompletionRegularFile(
				join(gitDirectory, "rvf-independent-backup-route", "completed-operations", `${raw.operation_id}.json`),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			if (!raw.artifacts_directory || !isAbsolute(raw.artifacts_directory))
				throw new Error("备用消费索引的交付原件尚未恢复。");
			completionFile = await readCloseoutCompletionRegularFile(
				join(raw.artifacts_directory, "backup-route-delivery-result.json"),
			);
		}
		additionalFiles.push(completionFile);
	}
	if (basename(file.path) === "identity.json") {
		if (!raw.artifacts_directory || !isAbsolute(raw.artifacts_directory))
			throw new Error("备用路线交付原件位置尚未恢复。");
		completionFile = await readCloseoutCompletionRegularFile(
			join(raw.artifacts_directory, "backup-route-delivery-result.json"),
		);
		additionalFiles.push(completionFile);
	}
	const value = independentBackupRouteCompletionRecordSchema.parse(JSON.parse(completionFile.bytes.toString("utf8")));
	if (
		value.original_run_directory !== record.runDirectory ||
		value.worktree_git_directory !== gitDirectory ||
		(dirname(completionFile.path).endsWith("completed-operations") &&
			basename(completionFile.path, ".json") !== value.operation_id) ||
		(raw.operation_id && raw.operation_id !== value.operation_id) ||
		(raw.artifacts_directory && raw.artifacts_directory !== value.artifacts_directory)
	)
		throw new CloseoutCompletionEvidenceConflict("备用路线完成材料的 operation/run/仓库身份不符。");
	const facts = await readCloseoutGoalCommitFacts(record, value.final_head);
	const stages: RvfCloseoutGoalCompletedStage[] = [];
	const stageVerificationErrors: unknown[] = [];
	// consumed 仅抑制旧路线；具体完成阶段必须另有该阶段的原始事实与 Git 关系。
	for (const [producerStage, stage] of [
		["land", "land"],
		["base_sync", "base_branch_sync"],
	] as const) {
		if (
			!["land", "base_sync"].includes(value.delivery_stage) ||
			(producerStage === "base_sync" && value.delivery_stage !== "base_sync")
		)
			continue;
		try {
			const factFile = await readCloseoutCompletionRegularFile(
				join(value.artifacts_directory, "stage-facts", `${producerStage}.json`),
			);
			const fact = z
				.object({
					stage: z.string(),
					commit: fullGitObjectIdSchema.optional(),
					head: fullGitObjectIdSchema.optional(),
					task_head: fullGitObjectIdSchema.optional(),
					base_ref: z.string().optional(),
					base_tip: fullGitObjectIdSchema.optional(),
					evidence: z.object({ path: z.string(), sha256: sha256DigestSchema }),
				})
				.parse(JSON.parse(factFile.bytes.toString("utf8")));
			if (
				dirname(resolve(fact.evidence.path)) !== resolve(value.artifacts_directory, "raw-evidence") ||
				!basename(fact.evidence.path).startsWith(fact.evidence.sha256)
			)
				throw new CloseoutCompletionEvidenceConflict(
					"备用阶段原件不属于同 operation 的内容寻址 raw-evidence 目录。",
				);
			const proof = await readCloseoutCompletionRegularFile(fact.evidence.path);
			if (fact.stage !== producerStage || computeRvfTextSha256(proof.bytes) !== fact.evidence.sha256)
				throw new CloseoutCompletionEvidenceConflict("备用阶段事实与原件摘要不符。");
			additionalFiles.push(factFile, proof);
			const target = stage === "land" ? fact.commit : fact.base_tip;
			if (!target) continue;
			const actual = await readCloseoutGoalCommitFacts(record, target);
			if (stage === "land")
				await getGitStdout(["merge-base", "--is-ancestor", target, value.final_head], record.receipt.worktree);
			if (stage === "base_branch_sync") {
				const baseRef = (await readBoundRvfLocalBaseRef(record)).baseRef.replace(/^refs\/heads\//u, "");
				if (!fact.task_head || !baseRef || fact.base_ref?.replace(/^refs\/heads\//u, "") !== baseRef) continue;
				await getGitStdout(["merge-base", "--is-ancestor", fact.task_head, target], record.receipt.worktree);
				await getGitStdout(
					["merge-base", "--is-ancestor", target, `refs/heads/${baseRef}`],
					record.receipt.worktree,
				);
				if (actual.treeSha !== (await readCloseoutGoalCommitFacts(record, fact.task_head)).treeSha)
					throw new CloseoutCompletionEvidenceConflict("备用 base 的真实 tree 与任务 tip 不符。");
			}
			stages.push({
				stage,
				...actual,
				...(fact.base_ref ? { baseRef: fact.base_ref } : {}),
				source: "independent_backup_route",
				evidenceSha256s: [computeRvfTextSha256(factFile.bytes), fact.evidence.sha256],
				observedAt: Date.now(),
			});
		} catch (error) {
			stageVerificationErrors.push(error);
		}
	}
	return {
		stages,
		additionalFiles,
		externalConsumption: {
			operationId: value.operation_id,
			evidenceSha256: computeRvfTextSha256(completionFile.bytes),
			observedAt: Date.now(),
		},
		finalCommitFacts: facts,
		stageVerificationErrors,
	};
}

export async function verifyImmutableCloseoutLandGoalEvidence(
	record: RvfAutomaticCloseoutRecord,
	files: CloseoutGoalCompletionSourceFile[],
) {
	const stages: RvfCloseoutGoalCompletedStage[] = [];
	const additionalFiles: CloseoutGoalCompletionSourceFile[] = [];
	for (const file of files.filter((entry) => dirname(entry.path).endsWith("rvf-land-commit-execution-results"))) {
		if (computeRvfTextSha256(file.bytes) !== basename(file.path, ".json"))
			throw new CloseoutCompletionEvidenceConflict("不可变 Land 执行结果的内容寻址摘要不符。");
		const value = z
			.object({
				run_id: z.string(),
				run_dir: z.string(),
				repo_root: z.string(),
				head_oid_after_commit: fullGitObjectIdSchema.optional(),
				result: z.object({
					exit_code: z.number(),
					commit_oid: fullGitObjectIdSchema.nullish(),
					candidate_evidence: z
						.object({ status: z.string(), candidate_evidence_sha256: sha256DigestSchema.optional() })
						.optional(),
					round_baseline_seal: z.object({ sealed: z.boolean() }).optional(),
				}),
			})
			.parse(JSON.parse(file.bytes.toString("utf8")));
		if (value.result.exit_code !== 0) continue;
		if (
			value.run_id !== record.runId ||
			value.run_dir !== record.runDirectory ||
			(await realpath(value.repo_root)) !== (await realpath(record.receipt.worktree))
		)
			throw new CloseoutCompletionEvidenceConflict("不可变 Land 执行结果的 run/仓库归属不符。");
		if (
			!value.result.round_baseline_seal?.sealed ||
			!["written", "reused"].includes(value.result.candidate_evidence?.status ?? "") ||
			!value.result.candidate_evidence?.candidate_evidence_sha256
		)
			continue;
		const target = value.result.commit_oid ?? value.head_oid_after_commit;
		if (!target) throw new Error("不可变 Land 执行结果尚缺提交目标。");
		const actual = await readCloseoutGoalCommitFacts(record, target);
		await getGitStdout(
			["merge-base", "--is-ancestor", record.receipt.worktree_head_commit_sha, target],
			record.receipt.worktree,
		);
		const snapshot = await verifyManualLandSourceSnapshot(record, target);
		additionalFiles.push(snapshot);
		stages.push({
			stage: "land",
			...actual,
			source: "immutable_execution_result",
			evidenceSha256s: [computeRvfTextSha256(file.bytes), computeRvfTextSha256(snapshot.bytes)],
			observedAt: Date.now(),
		});
	}
	if (new Set(stages.map((entry) => entry.commitSha)).size > 1)
		throw new CloseoutCompletionEvidenceConflict("不可变 Land 执行结果存在多个无法唯一关联的目标。");
	return { stages, additionalFiles };
}
