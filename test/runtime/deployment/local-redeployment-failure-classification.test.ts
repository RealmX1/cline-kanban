import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	readLocalDeploymentTargetStageRecoveryBudget,
	recordLocalDeploymentTargetStageFailure,
	reserveLocalDeploymentTargetStageAttempt,
} from "../../../src/deployment/local-deployment-target-stage-recovery-budget";
import {
	classifyLocalRedeploymentStageFailure,
	observeLocalRedeploymentBlockingFailureRecovery,
} from "../../../src/deployment/local-redeployment-failure-recovery-evidence";
import {
	localRedeploymentRequestSchema,
	localRedeploymentSha256,
} from "../../../src/deployment/local-redeployment-preparation";
import { observeStandardLocalRedeploymentStageRecoveryEvidence } from "../../../src/deployment/local-redeployment-standard-execution";
import {
	createWorkspaceStateSnapshotCommit,
	projectWorkspaceStateSnapshotCommitWithinLock,
	WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME,
} from "../../../src/state/workspace-state-snapshot-storage";
import { createTempDir } from "../../utilities/temp-dir";

describe("部署失败分类及原件", () => {
	it("旧竞争错误码不证明源竞争，静态链接复制身份不同独立分类并保留链接文本", async () => {
		const temporary = createTempDir("local-redeployment-copy-failure-classification-");
		onTestFinished(temporary.cleanup);
		const source = join(temporary.path, "LICENSE");
		const destination = join(temporary.path, "copied-LICENSE");
		await symlink("COPYING", source);
		await symlink(join(temporary.path, "COPYING"), destination);
		const failure = await classifyLocalRedeploymentStageFailure(
			temporary.path,
			Object.assign(new Error("副本不一致"), {
				code: "SOURCE_CONTENT_CHANGED_DURING_CAPTURE",
				path: source,
				dest: destination,
			}),
			"state_preservation",
		);
		expect(failure.classification).toBe("copy_identity_mismatch");
		expect(await readFile(failure.originalErrorReference, "utf8")).toContain('"target": "COPYING"');
		await writeFile(join(temporary.path, "ordinary-file"), "稳定内容");
		const unproven = await classifyLocalRedeploymentStageFailure(
			temporary.path,
			Object.assign(new Error("旧错误码"), {
				code: "SOURCE_CONTENT_CHANGED_DURING_CAPTURE",
				path: join(temporary.path, "ordinary-file"),
			}),
			"state_preservation",
		);
		expect(unproven.classification).toBe("unclassified_failure");
	});

	it("原子临时路径消失绑定正式逻辑资源，不等待随机旧路径重现", async () => {
		const temporary = createTempDir("local-redeployment-atomic-file-classification-");
		onTestFinished(temporary.cleanup);
		const logicalResource = join(temporary.path, "workspaces/project/config.json");
		await mkdir(join(temporary.path, "workspaces/project"), { recursive: true });
		await writeFile(logicalResource, "{}");
		const failure = await classifyLocalRedeploymentStageFailure(
			temporary.path,
			Object.assign(new Error("已发布"), {
				code: "ENOENT",
				path: `${logicalResource}.tmp.123.456.032609d8-7508-4bdc-b202-1d7bd7da8a14`,
			}),
			"state_preservation",
		);
		expect(failure.classification).toBe("atomic_temporary_path_disappeared");
		expect(failure.logicalResource).toBe(logicalResource);
		const executor = "// 隔离原子路径恢复观察\n";
		await writeFile(join(temporary.path, "frozen-local-redeployment-executor.mjs"), executor);
		const request = localRedeploymentRequestSchema.parse({
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "isolated-atomic-path",
			taskId: "isolated-atomic-path",
			originatingTaskWorktreePath: temporary.path,
			sourceCheckoutPath: temporary.path,
			candidateSourceCommit: "a".repeat(40),
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath: join(temporary.path, "distribution"),
			runtimeIdentity: { runtimeHomeDirectoryPath: temporary.path, runtimeHost: "127.0.0.1", runtimePort: 39884 },
			serviceLaunch: { command: [process.execPath] },
			authorization: { sourceReference: "test:atomic-path-recovery", userRequestQuote: "仅隔离观察" },
		});
		await writeFile(
			join(temporary.path, "frozen-redeployment-request.json"),
			JSON.stringify({
				request,
				requestSha256: localRedeploymentSha256(JSON.stringify(request)),
				executorSha256: localRedeploymentSha256(executor),
				npmCliEntrypointPath: process.execPath,
				serviceExecutableSha256: "b".repeat(64),
				owner: null,
			}),
		);
		const recovered = await observeLocalRedeploymentBlockingFailureRecovery(temporary.path, failure);
		expect(recovered.recoveryEvidenceReady).toBe(true);
		await writeFile(logicalResource, JSON.stringify({ unrelatedTimestamp: Date.now() }));
		expect(await observeLocalRedeploymentBlockingFailureRecovery(temporary.path, failure)).toEqual(recovered);
	});

	it("rename 丢失的临时文件在正式资源出现前不解锁，出现后忽略内容变化", async () => {
		const temporary = createTempDir("local-redeployment-atomic-rename-recovery-");
		onTestFinished(temporary.cleanup);
		const logicalResource = join(temporary.path, "workspaces/project/config.json");
		await mkdir(join(temporary.path, "workspaces/project"), { recursive: true });
		const failure = await classifyLocalRedeploymentStageFailure(
			temporary.path,
			Object.assign(new Error("rename 时临时路径已消失"), {
				code: "ENOENT",
				syscall: "rename",
				path: `${logicalResource}.tmp.15993.1794745938802.032609d8-7508-4bdc-b202-1d7bd7da8a14`,
			}),
			"state_preservation",
		);
		expect(failure.classification).toBe("atomic_temporary_path_disappeared");
		expect(failure.logicalResource).toBe(logicalResource);
		const executor = "// 隔离 rename 恢复观察\n";
		await writeFile(join(temporary.path, "frozen-local-redeployment-executor.mjs"), executor);
		const request = localRedeploymentRequestSchema.parse({
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "isolated-atomic-rename",
			taskId: "isolated-atomic-rename",
			originatingTaskWorktreePath: temporary.path,
			sourceCheckoutPath: temporary.path,
			candidateSourceCommit: "a".repeat(40),
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath: join(temporary.path, "distribution"),
			runtimeIdentity: { runtimeHomeDirectoryPath: temporary.path, runtimeHost: "127.0.0.1", runtimePort: 39884 },
			serviceLaunch: { command: [process.execPath] },
			authorization: { sourceReference: "test:atomic-rename-recovery", userRequestQuote: "仅隔离观察" },
		});
		await writeFile(
			join(temporary.path, "frozen-redeployment-request.json"),
			JSON.stringify({
				request,
				requestSha256: localRedeploymentSha256(JSON.stringify(request)),
				executorSha256: localRedeploymentSha256(executor),
				npmCliEntrypointPath: process.execPath,
				serviceExecutableSha256: "b".repeat(64),
				owner: null,
			}),
		);
		const missing = await observeLocalRedeploymentBlockingFailureRecovery(temporary.path, failure);
		expect(missing.recoveryEvidenceReady).toBe(false);
		await writeFile(logicalResource, "{}");
		const present = await observeLocalRedeploymentBlockingFailureRecovery(temporary.path, failure);
		expect(present.recoveryEvidenceReady).toBe(true);
		expect(present.evidenceSha256).not.toBe(missing.evidenceSha256);
		await writeFile(logicalResource, JSON.stringify({ changed: true }));
		expect(await observeLocalRedeploymentBlockingFailureRecovery(temporary.path, failure)).toEqual(present);
	});

	it("未记录日志身份的旧 ENOENT 由当前投影补证，普通写入不增加派发资格", async () => {
		const temporary = createTempDir("local-redeployment-projected-journal-recovery-");
		onTestFinished(temporary.cleanup);
		const directory = temporary.path;
		const runtimeHome = join(directory, "runtime-home");
		const workspaces = join(runtimeHome, "workspaces");
		const workspaceId = "project";
		const workspace = join(workspaces, workspaceId);
		await mkdir(workspace, { recursive: true });
		await writeFile(
			join(workspaces, "index.json"),
			JSON.stringify({
				version: 1,
				entries: { [workspaceId]: { workspaceId, repoPath: directory } },
				repoPathToId: { [directory]: workspaceId },
			}),
		);
		const request = localRedeploymentRequestSchema.parse({
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId,
			taskId: "isolated-journal-recovery",
			originatingTaskWorktreePath: directory,
			sourceCheckoutPath: directory,
			candidateSourceCommit: "a".repeat(40),
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath: join(directory, "distribution"),
			runtimeIdentity: { runtimeHomeDirectoryPath: runtimeHome, runtimeHost: "127.0.0.1", runtimePort: 39884 },
			serviceLaunch: { command: [process.execPath] },
			authorization: { sourceReference: "test:historical-journal-disappearance", userRequestQuote: "仅隔离观察" },
		});
		const executor = "// 隔离旧日志补证\n";
		await writeFile(join(directory, "frozen-local-redeployment-executor.mjs"), executor);
		await writeFile(
			join(directory, "frozen-redeployment-request.json"),
			JSON.stringify({
				request,
				requestSha256: localRedeploymentSha256(JSON.stringify(request)),
				executorSha256: localRedeploymentSha256(executor),
				npmCliEntrypointPath: process.execPath,
				serviceExecutableSha256: "b".repeat(64),
				owner: null,
			}),
		);
		const journal = join(workspace, WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME);
		const failure = await classifyLocalRedeploymentStageFailure(
			directory,
			Object.assign(new Error("原枚举资源已消失"), { code: "ENOENT", path: journal, syscall: "lstat" }),
			"state_preservation",
		);
		const originalBytes = await readFile(failure.originalErrorReference);
		const observe = () => observeLocalRedeploymentBlockingFailureRecovery(directory, failure);
		expect((await observe()).recoveryEvidenceReady).toBe(false);
		const independentResource = join(workspace, "independent-file.json");
		await writeFile(
			join(directory, "runtime-state-backup-progress.json"),
			JSON.stringify({
				pendingEntries: [{ resource: independentResource, code: "ENOENT" }],
			}),
		);
		await writeFile(independentResource, "{}");
		expect((await observe()).recoveryEvidenceReady).toBe(true);
		const project = (revision: number) =>
			projectWorkspaceStateSnapshotCommitWithinLock(
				workspace,
				createWorkspaceStateSnapshotCommit({
					workspaceId,
					boardJsonText: '{"columns":[]}',
					sessionsJsonText: "{}",
					meta: { revision, updatedAt: revision },
				}),
			);
		await project(1);
		const recovered = await observe();
		expect(recovered.recoveryEvidenceReady).toBe(true);
		await project(2);
		expect(await observe()).toEqual(recovered);
		expect(await readFile(failure.originalErrorReference)).toEqual(originalBytes);
		await expect(readFile(journal)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("实例起点未知登记可重新观察的监听身份条件", async () => {
		const temporary = createTempDir("local-redeployment-listener-identity-");
		onTestFinished(temporary.cleanup);
		const failure = await classifyLocalRedeploymentStageFailure(
			temporary.path,
			Object.assign(new Error("实例起点身份仍未知，候选已保留，等待原生监听证据恢复"), {
				verificationCheckKey: "native_listener_and_boot_identity",
			}),
			"candidate_bootstrap",
		);
		expect(failure.classification).toBe("verification_evidence_pending");
		expect(failure.logicalResource).toBe("native_listener_and_boot_identity");
		expect(failure.sourcePath).toBeUndefined();
	});

	it("锁协议恢复重新观察当前清单，不复用缺失时的旧预检", async () => {
		const temporary = createTempDir("local-redeployment-lock-protocol-recovery-");
		onTestFinished(temporary.cleanup);
		const runtimeHome = join(temporary.path, "runtime-home");
		const distribution = join(temporary.path, "distribution");
		await mkdir(runtimeHome);
		await mkdir(distribution);
		const executor = "// 隔离锁协议恢复\n";
		const request = localRedeploymentRequestSchema.parse({
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "isolated-lock-protocol",
			taskId: "isolated-lock-protocol",
			originatingTaskWorktreePath: temporary.path,
			sourceCheckoutPath: temporary.path,
			candidateSourceCommit: "a".repeat(40),
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath: distribution,
			runtimeIdentity: { runtimeHomeDirectoryPath: runtimeHome, runtimeHost: "127.0.0.1", runtimePort: 39884 },
			serviceLaunch: { command: [process.execPath] },
			authorization: { sourceReference: "test:lock-protocol-recovery", userRequestQuote: "仅隔离观察" },
		});
		await writeFile(join(temporary.path, "frozen-local-redeployment-executor.mjs"), executor);
		await writeFile(
			join(temporary.path, "frozen-redeployment-request.json"),
			JSON.stringify({
				request,
				requestSha256: localRedeploymentSha256(JSON.stringify(request)),
				executorSha256: localRedeploymentSha256(executor),
				npmCliEntrypointPath: process.execPath,
				serviceExecutableSha256: "b".repeat(64),
				owner: null,
			}),
		);
		const attempt = {
			binding: request,
			stage: "build_publication" as const,
			executionDirectory: temporary.path,
			attemptNumber: 1,
		};
		expect(
			await reserveLocalDeploymentTargetStageAttempt({
				...attempt,
				recoveryEvidenceSha256: "1".repeat(64),
				recoveryEvidenceReady: false,
			}),
		).toBe(true);
		await recordLocalDeploymentTargetStageFailure({
			...attempt,
			failure: {
				classification: "verification_evidence_pending",
				logicalResource: "filesystem-lock-protocol-transition",
				recoveryCondition: "等待退休写入者清单",
				originalErrorReference: join(temporary.path, "stage-failure-originals/build_publication/original.json"),
			},
		});
		const before = await observeStandardLocalRedeploymentStageRecoveryEvidence(temporary.path, "build_publication");
		expect(before.recoveryEvidenceReady).toBe(false);
		expect(await observeStandardLocalRedeploymentStageRecoveryEvidence(temporary.path, "build_publication")).toEqual(
			before,
		);
		await writeFile(
			join(temporary.path, "filesystem-lock-protocol-retiring-writer-inventory.json"),
			JSON.stringify({ candidateSourceCommit: request.candidateSourceCommit, status: "restored" }),
		);
		const inventoryPresent = await observeStandardLocalRedeploymentStageRecoveryEvidence(
			temporary.path,
			"build_publication",
		);
		expect(inventoryPresent.evidenceSha256).not.toBe(before.evidenceSha256);
		expect(inventoryPresent.recoveryEvidenceReady).toBe(false);
		await mkdir(join(temporary.path, "preserved-previous-distribution"), { recursive: true });
		await mkdir(join(temporary.path, "candidate-source-checkout/dist"), { recursive: true });
		await writeFile(join(temporary.path, "preserved-previous-distribution/cli.js"), "legacy-lock");
		await writeFile(join(temporary.path, "candidate-source-checkout/dist/cli.js"), "legacy-lock");
		const protocolUnchanged = await observeStandardLocalRedeploymentStageRecoveryEvidence(
			temporary.path,
			"build_publication",
		);
		expect(protocolUnchanged.recoveryEvidenceReady).toBe(true);
		expect(await observeStandardLocalRedeploymentStageRecoveryEvidence(temporary.path, "build_publication")).toEqual(
			protocolUnchanged,
		);
		const budget = await readLocalDeploymentTargetStageRecoveryBudget(request, "build_publication");
		expect(budget?.blockingFailure?.logicalResource).toBe("filesystem-lock-protocol-transition");
	});
});
