import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	recordLocalDeploymentTargetStageFailure,
	reserveLocalDeploymentTargetStageAttempt,
} from "../../../src/deployment/local-deployment-target-stage-recovery-budget";
import * as preparation from "../../../src/deployment/local-redeployment-preparation";
import {
	LocalRedeploymentIdentityMismatch,
	prepareLocalRedeployment,
	readFrozenLocalRedeploymentRequest,
} from "../../../src/deployment/local-redeployment-preparation";
import {
	observeLocalRedeploymentRepairValidationEligibility,
	prepareLocalRedeploymentRepairContinuation,
} from "../../../src/deployment/local-redeployment-repair-continuation";
import {
	LocalRedeploymentQualityFailure,
	localRedeploymentStageCommandStatus,
	observeStandardLocalRedeploymentRecoveryEvidence,
	observeStandardLocalRedeploymentStageRecoveryEvidence,
} from "../../../src/deployment/local-redeployment-standard-execution";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

async function createFailedDeploymentFixture(options?: { symlinkDistribution?: boolean }) {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	onTestFinished(fixture.cleanup);
	const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "deployment-source" });
	await writeFile(join(repository.repositoryPath, "source.txt"), "原始候选\n");
	const originalCommit = repository.commitAllRepositoryFilesAtDate({
		message: "原始候选",
		authorAndCommitterIsoDate: "2026-11-16T00:00:00Z",
	});
	const executor = join(fixture.fixtureRootDirectoryPath, "executor.mjs");
	await writeFile(executor, "// 隔离执行器\n");
	let distributionDirectoryPath = join(repository.repositoryPath, "dist");
	if (options?.symlinkDistribution) {
		const realParent = join(fixture.fixtureRootDirectoryPath, "real-distribution-parent");
		const linkParent = join(fixture.fixtureRootDirectoryPath, "linked-distribution-parent");
		await mkdir(realParent);
		await symlink(realParent, linkParent);
		distributionDirectoryPath = join(linkParent, "nested", "dist");
	}
	const parent = join(fixture.fixtureRootDirectoryPath, "failed-deployment");
	await prepareLocalRedeployment(
		parent,
		{
			schemaVersion: 1,
			executionId: randomUUID(),
			workspaceId: "isolated-repair-workspace",
			taskId: "isolated-repair",
			originatingTaskWorktreePath: repository.repositoryPath,
			sourceCheckoutPath: repository.repositoryPath,
			candidateSourceCommit: originalCommit,
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath,
			runtimeIdentity: {
				runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline/kanban"),
				runtimeHost: "127.0.0.1",
				runtimePort: 39884,
			},
			serviceLaunch: { command: [process.execPath] },
			authorization: { sourceReference: "test:isolated-repair", userRequestQuote: "仅隔离部署修复回归" },
		},
		executor,
	);
	const frozen = await readFrozenLocalRedeploymentRequest(parent);
	const recordFailure = async (directory: string, executionId: string, candidateSourceCommit: string) => {
		await mkdir(join(directory, "source-validation"), { recursive: true });
		await writeFile(
			join(directory, "owned-command-business-result.json"),
			JSON.stringify({ disposition: "agent_review_ready", deploymentExecutionId: executionId }),
		);
		await writeFile(
			join(directory, "source-validation/source-validation-evidence-reuse-report.json"),
			JSON.stringify({ status: "quality_validation_failed", candidateSourceCommit }),
		);
	};
	await recordFailure(parent, frozen.request.executionId, originalCommit);
	const branch = "deployment-repair/isolated-repair-test";
	repository.runGit(["branch", branch]);
	repository.runGit(["switch", branch]);
	const commitRepair = async () => {
		await writeFile(join(repository.repositoryPath, "repair.txt"), randomUUID());
		return repository.commitAllRepositoryFilesAtDate({
			message: "修复隔离候选",
			authorAndCommitterIsoDate: "2026-11-16T00:01:00Z",
		});
	};
	return { fixture, repository, executor, parent, frozen, branch, commitRepair, recordFailure };
}

describe("部署修复分支接续", () => {
	it("绑定的实际修复只解锁一次源码重验，未相关机器失败、篡改报告和Stop不能取得资格", async () => {
		const f = await createFailedDeploymentFixture();
		const failurePath = join(f.parent, "stage-failure-originals/candidate_bootstrap/original.json");
		await mkdir(join(f.parent, "stage-failure-originals/candidate_bootstrap"), { recursive: true });
		await writeFile(failurePath, JSON.stringify({ stage: "candidate_bootstrap", error: "源码验证真实失败" }));
		const failure = {
			classification: "unclassified_failure" as const,
			logicalResource: "candidate_bootstrap",
			originalErrorReference: failurePath,
			recoveryCondition: "实际修复后重验",
		};
		const attempt = {
			binding: f.frozen.request,
			stage: "candidate_bootstrap" as const,
			executionDirectory: f.parent,
			attemptNumber: 1,
		};
		expect(
			await reserveLocalDeploymentTargetStageAttempt({
				...attempt,
				recoveryEvidenceSha256: null,
				recoveryEvidenceReady: true,
			}),
		).toBe(true);
		await recordLocalDeploymentTargetStageFailure({ ...attempt, failure });
		const request = { ...f.frozen.request, executionId: randomUUID(), candidateSourceCommit: await f.commitRepair() };
		const directory = join(f.fixture.fixtureRootDirectoryPath, "repaired-validation");
		await prepareLocalRedeploymentRepairContinuation(directory, request, f.executor, f.parent, f.branch);
		const proof = await observeStandardLocalRedeploymentRecoveryEvidence(directory);
		expect(proof.recoveryEvidenceReady).toBe(true);
		const retry = {
			binding: request,
			stage: "candidate_bootstrap" as const,
			executionDirectory: directory,
			attemptNumber: 2,
			recoveryEvidenceSha256: proof.evidenceSha256,
			recoveryEvidenceReady: proof.recoveryEvidenceReady === true,
		};
		expect(await reserveLocalDeploymentTargetStageAttempt(retry)).toBe(true);
		expect(await reserveLocalDeploymentTargetStageAttempt({ ...retry, attemptNumber: 3 })).toBe(false);
		expect(
			await observeLocalRedeploymentRepairValidationEligibility(directory, {
				...failure,
				logicalResource: "state_preservation",
			}),
		).toBeNull();
		await writeFile(
			join(f.parent, "source-validation/source-validation-evidence-reuse-report.json"),
			JSON.stringify({
				status: "quality_validation_failed",
				candidateSourceCommit: f.frozen.request.candidateSourceCommit,
				changed: true,
			}),
		);
		expect(await observeLocalRedeploymentRepairValidationEligibility(directory, failure)).toBeNull();
		await f.recordFailure(f.parent, f.frozen.request.executionId, f.frozen.request.candidateSourceCommit);
		await writeFile(join(f.parent, "redeployment-revocation.json"), "{}");
		expect(await observeLocalRedeploymentRepairValidationEligibility(directory, failure)).toBeNull();
	});
	it("固定修复分支并关联新旧执行，重试不增加预算，原失败和背景WIP保留", async () => {
		const f = await createFailedDeploymentFixture();
		const commit = await f.commitRepair();
		await writeFile(join(f.repository.repositoryPath, "background-wip.txt"), "不能带入候选或删除\n");
		const request = { ...f.frozen.request, executionId: randomUUID(), candidateSourceCommit: commit };
		const directory = join(f.fixture.fixtureRootDirectoryPath, "repaired-deployment");
		const originalFailure = await readFile(join(f.parent, "owned-command-business-result.json"), "utf8");
		const first = await prepareLocalRedeploymentRepairContinuation(
			directory,
			request,
			f.executor,
			f.parent,
			f.branch,
		);
		const repeated = await prepareLocalRedeploymentRepairContinuation(
			directory,
			request,
			f.executor,
			f.parent,
			f.branch,
		);
		expect(repeated).toEqual(first);
		expect(first.repairContinuation.repairAttemptNumber).toBe(1);
		expect(
			(await readdir(join(f.parent, "deployment-repair-continuations"))).filter((name) => name.endsWith(".json")),
		).toHaveLength(1);
		expect((await readFrozenLocalRedeploymentRequest(directory)).request).toEqual(request);
		expect(await readFile(join(f.parent, "owned-command-business-result.json"), "utf8")).toBe(originalFailure);
		expect(await readFile(join(f.repository.repositoryPath, "background-wip.txt"), "utf8")).toContain("不能带入候选");
		await expect(readFile(join(f.repository.repositoryPath, "dist/cli.js"))).rejects.toThrow();
	});
	it("拒绝改变目标、未变化候选、错误分支、错误失败原件及Stop", async () => {
		const f = await createFailedDeploymentFixture();
		f.repository.runGit(["commit", "--allow-empty", "--quiet", "-m", "只有新SHA的空提交"]);
		const emptyCommit = f.repository.runGit(["rev-parse", "HEAD"]).stdout.trim();
		await expect(
			prepareLocalRedeploymentRepairContinuation(
				join(f.fixture.fixtureRootDirectoryPath, "empty-repair"),
				{ ...f.frozen.request, executionId: randomUUID(), candidateSourceCommit: emptyCommit },
				f.executor,
				f.parent,
				f.branch,
			),
		).rejects.toThrow("空提交");
		const request = { ...f.frozen.request, executionId: randomUUID(), candidateSourceCommit: await f.commitRepair() };
		const directory = join(f.fixture.fixtureRootDirectoryPath, "repaired-deployment");
		const prepare = (raw = request, branch = f.branch) =>
			prepareLocalRedeploymentRepairContinuation(directory, raw, f.executor, f.parent, branch);
		await expect(
			prepare({ ...request, runtimeIdentity: { ...request.runtimeIdentity, runtimePort: 39885 } }),
		).rejects.toThrow("只能改变");
		await expect(
			prepare({ ...request, candidateSourceCommit: f.frozen.request.candidateSourceCommit }),
		).rejects.toThrow("只能改变");
		await expect(prepare(request, "main")).rejects.toThrow("deployment-repair");
		f.repository.runGit([
			"branch",
			"deployment-repair/isolated-repair-wrong",
			f.frozen.request.candidateSourceCommit,
		]);
		await expect(prepare(request, "deployment-repair/isolated-repair-wrong")).rejects.toThrow("分支与候选");
		await f.recordFailure(f.parent, randomUUID(), f.frozen.request.candidateSourceCommit);
		await expect(prepare()).rejects.toThrow("原件与来源");
		await f.recordFailure(f.parent, f.frozen.request.executionId, f.frozen.request.candidateSourceCommit);
		await writeFile(join(f.parent, "redeployment-revocation.json"), "{}");
		await expect(prepare()).rejects.toThrow("撤销");
	});
	it("修复不能丢失原任务归属，正常会话换代后重新核验当前owner", async () => {
		const f = await createFailedDeploymentFixture();
		const owner = {
			taskIncarnationCreatedAtEpochMs: 1,
			conversationSessionId: "original-conversation",
			nativeSessionId: "old-native",
			runtimeSessionIncarnationId: "old-generation",
			worktreeIdentity: {
				realPath: f.frozen.request.originatingTaskWorktreePath,
				device: 1,
				inode: 1,
				createdAtEpochMs: 1,
			},
		};
		await writeFile(join(f.parent, "frozen-redeployment-request.json"), JSON.stringify({ ...f.frozen, owner }));
		const currentOwner = vi.spyOn(preparation, "readCurrentBoundLocalRedeploymentOwner");
		const assertEligible = vi.spyOn(preparation, "assertLocalRedeploymentOwnerStillEligible");
		onTestFinished(() => {
			currentOwner.mockRestore();
			assertEligible.mockRestore();
		});
		const request = { ...f.frozen.request, executionId: randomUUID(), candidateSourceCommit: await f.commitRepair() };
		const prepare = () =>
			prepareLocalRedeploymentRepairContinuation(
				join(f.fixture.fixtureRootDirectoryPath, "repaired-owner"),
				request,
				f.executor,
				f.parent,
				f.branch,
			);
		currentOwner.mockResolvedValue(null);
		await expect(prepare()).rejects.toThrow("原任务与工作树归属");
		currentOwner.mockResolvedValue({ ...owner, taskIncarnationCreatedAtEpochMs: 2 });
		await expect(prepare()).rejects.toThrow("原任务与工作树归属");
		const resumedOwner = {
			...owner,
			runtimeSessionIncarnationId: "current-generation",
			nativeSessionId: "current-native",
		};
		currentOwner.mockResolvedValue(resumedOwner);
		assertEligible.mockResolvedValue(undefined);
		await expect(prepare()).resolves.toMatchObject({ ok: true });
		expect(assertEligible).toHaveBeenLastCalledWith(f.parent, expect.objectContaining({ owner: resumedOwner }));
	});
	it("三次预算跨新执行目录和修复链保存，第四次不准备候选", async () => {
		const f = await createFailedDeploymentFixture();
		let parent = f.parent;
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			const previous = await readFrozenLocalRedeploymentRequest(parent);
			const request = {
				...previous.request,
				executionId: randomUUID(),
				candidateSourceCommit: await f.commitRepair(),
			};
			const directory = join(f.fixture.fixtureRootDirectoryPath, `repair-attempt-${attempt}`);
			const preparation = prepareLocalRedeploymentRepairContinuation(
				directory,
				request,
				f.executor,
				parent,
				f.branch,
			);
			if (attempt === 4) {
				await expect(preparation).rejects.toThrow("三次修复候选预算");
				await expect(readFile(join(directory, "frozen-redeployment-request.json"))).rejects.toThrow();
			} else {
				expect((await preparation).repairContinuation.repairAttemptNumber).toBe(attempt);
				await f.recordFailure(directory, request.executionId, request.candidateSourceCommit);
				parent = directory;
			}
		}
	});
	it("发布目录经符号链接祖先后被创建时，修复名额摘要与冻结请求一致", async () => {
		const f = await createFailedDeploymentFixture({ symlinkDistribution: true });
		await mkdir(f.frozen.request.distributionDirectoryPath, { recursive: true });
		expect(f.frozen.request.distributionDirectoryPath).not.toBe(
			await realpath(f.frozen.request.distributionDirectoryPath),
		);
		const failurePath = join(f.parent, "stage-failure-originals/candidate_bootstrap/original.json");
		await mkdir(join(f.parent, "stage-failure-originals/candidate_bootstrap"), { recursive: true });
		await writeFile(failurePath, JSON.stringify({ stage: "candidate_bootstrap", error: "源码验证真实失败" }));
		const failure = {
			classification: "unclassified_failure" as const,
			logicalResource: "candidate_bootstrap",
			originalErrorReference: failurePath,
			recoveryCondition: "实际修复后重验",
		};
		const attempt = {
			binding: f.frozen.request,
			stage: "candidate_bootstrap" as const,
			executionDirectory: f.parent,
			attemptNumber: 1,
		};
		expect(
			await reserveLocalDeploymentTargetStageAttempt({
				...attempt,
				recoveryEvidenceSha256: null,
				recoveryEvidenceReady: true,
			}),
		).toBe(true);
		await recordLocalDeploymentTargetStageFailure({ ...attempt, failure });
		const request = { ...f.frozen.request, executionId: randomUUID(), candidateSourceCommit: await f.commitRepair() };
		const directory = join(f.fixture.fixtureRootDirectoryPath, "symlink-repaired-validation");
		const prepared = await prepareLocalRedeploymentRepairContinuation(
			directory,
			request,
			f.executor,
			f.parent,
			f.branch,
		);
		const frozen = await readFrozenLocalRedeploymentRequest(directory);
		expect(prepared.repairContinuation.requestSha256).toBe(frozen.requestSha256);
		expect(frozen.request.distributionDirectoryPath).toBe(await realpath(f.frozen.request.distributionDirectoryPath));
		const repeated = await prepareLocalRedeploymentRepairContinuation(
			directory,
			request,
			f.executor,
			f.parent,
			f.branch,
		);
		expect(repeated.repairContinuation).toEqual(prepared.repairContinuation);
		expect(
			(await readdir(join(f.parent, "deployment-repair-continuations"))).filter((name) => name.endsWith(".json")),
		).toHaveLength(1);
		expect((await observeStandardLocalRedeploymentRecoveryEvidence(directory)).recoveryEvidenceReady).toBe(true);
	});
	it("源码验证已通过后的阶段质量失败可以接续并只解锁该阶段，身份不匹配不能占用修复名额", async () => {
		expect(String(new LocalRedeploymentQualityFailure("服务 PATH 丢失原有工具：rg"))).toMatch(
			/^LocalRedeploymentQualityFailure:/u,
		);
		expect(localRedeploymentStageCommandStatus(new LocalRedeploymentQualityFailure("两次服务启动均未成功"))).toBe(
			"quality_validation_failed",
		);
		expect(
			localRedeploymentStageCommandStatus(
				new LocalRedeploymentIdentityMismatch("当前源码 package 的 CLI 名称或链接目标与授权发布目录不一致"),
			),
		).toBe("human_decision_required");
		expect(localRedeploymentStageCommandStatus(new Error("绑定服务尚未就绪"))).toBe("machine_evidence_pending");
		const f = await createFailedDeploymentFixture();
		const failurePath = join(f.parent, "stage-failure-originals/runtime_validation/original.json");
		await mkdir(join(f.parent, "stage-failure-originals/runtime_validation"), { recursive: true });
		await writeFile(
			failurePath,
			JSON.stringify({
				stage: "runtime_validation",
				error: String(new LocalRedeploymentQualityFailure("部署后工作树路径缺失，保留原始快照供核对：/worktree")),
			}),
		);
		await writeFile(
			join(f.parent, "source-validation/source-validation-evidence-reuse-report.json"),
			JSON.stringify({ status: "passed", candidateSourceCommit: f.frozen.request.candidateSourceCommit }),
		);
		await writeFile(
			join(f.parent, "owned-command-business-result.json"),
			JSON.stringify({
				disposition: "agent_review_ready",
				deploymentExecutionId: f.frozen.request.executionId,
				analysis: { deploymentOutcome: "quality_validation_failed" },
			}),
		);
		const failure = {
			classification: "unclassified_failure" as const,
			logicalResource: "runtime_validation",
			originalErrorReference: failurePath,
			recoveryCondition: "实际修复后重跑该阶段",
		};
		const attempt = {
			binding: f.frozen.request,
			stage: "runtime_validation" as const,
			executionDirectory: f.parent,
			attemptNumber: 1,
		};
		expect(
			await reserveLocalDeploymentTargetStageAttempt({
				...attempt,
				recoveryEvidenceSha256: null,
				recoveryEvidenceReady: true,
			}),
		).toBe(true);
		await recordLocalDeploymentTargetStageFailure({ ...attempt, failure });
		const request = { ...f.frozen.request, executionId: randomUUID(), candidateSourceCommit: await f.commitRepair() };
		const directory = join(f.fixture.fixtureRootDirectoryPath, "post-source-repair");
		await prepareLocalRedeploymentRepairContinuation(directory, request, f.executor, f.parent, f.branch);
		expect(
			(await observeStandardLocalRedeploymentStageRecoveryEvidence(directory, "runtime_validation"))
				.recoveryEvidenceReady,
		).toBe(true);
		expect(
			await observeLocalRedeploymentRepairValidationEligibility(directory, {
				...failure,
				logicalResource: "candidate_bootstrap",
				originalErrorReference: join(f.parent, "stage-failure-originals/candidate_bootstrap/original.json"),
			}),
		).toBeNull();
		const identityDirectory = join(f.fixture.fixtureRootDirectoryPath, "identity-mismatch-repair");
		await writeFile(
			failurePath,
			JSON.stringify({
				stage: "runtime_validation",
				error: String(new LocalRedeploymentIdentityMismatch("部署阶段原件与本次冻结执行不匹配")),
			}),
		);
		await expect(
			prepareLocalRedeploymentRepairContinuation(
				identityDirectory,
				{ ...request, executionId: randomUUID() },
				f.executor,
				f.parent,
				f.branch,
			),
		).rejects.toThrow("质量失败原件");
		await expect(readFile(join(identityDirectory, "frozen-redeployment-request.json"))).rejects.toThrow();
		expect(
			(await readdir(join(f.parent, "deployment-repair-continuations"))).filter((name) => name.endsWith(".json")),
		).toHaveLength(1);
	});
});
