import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { analyzeLocalDeploymentExecutions } from "../../../src/deployment/local-deployment-execution";
import { localDeploymentExecutionManifestSchema } from "../../../src/deployment/local-deployment-execution-contract";
import {
	LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME,
	prepareLocalRedeployment,
	readFrozenLocalRedeploymentRequest,
} from "../../../src/deployment/local-redeployment-preparation";
import type * as LockedFileSystemModule from "../../../src/fs/locked-file-system";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

vi.mock("../../../src/fs/locked-file-system", async (importOriginal) => {
	const actual = await importOriginal<typeof LockedFileSystemModule>();
	const guardedTestDirectory = process.env.TMPDIR;
	if (!guardedTestDirectory) throw new Error("必须通过 guarded runner 提供独占测试目录。");
	return { ...actual, lockedFileSystem: await actual.LockedFileSystem.forIsolatedTestDirectory(guardedTestDirectory) };
});

describe("构建前准备标准重部署", () => {
	it("只冻结本地提交、工具与授权，既不构建也不碰共享输出；同身份不能更换材料", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(fixture.cleanup);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "source" });
		await writeFile(join(repository.repositoryPath, "source.txt"), "提交内容");
		const commit = repository.commitAllRepositoryFilesAtDate({
			message: "隔离候选",
			authorAndCommitterIsoDate: "2026-11-13T00:00:00Z",
		});
		await writeFile(join(repository.repositoryPath, "source.txt"), "未提交内容不能带入候选");
		const directory = join(fixture.fixtureRootDirectoryPath, "persistent-request");
		const executor = join(fixture.fixtureRootDirectoryPath, "bound-executor.mjs");
		await writeFile(executor, "// 冻结工具原件\n");
		await copyFile(
			resolve(".codex/skills/cline-kanban-local-deploy/scripts/prepare-source-validation-with-evidence-reuse.mjs"),
			join(fixture.fixtureRootDirectoryPath, LOCAL_REDEPLOYMENT_SOURCE_VALIDATION_PREPARER_FILENAME),
		);
		const request = {
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "workspace",
			taskId: "task",
			originatingTaskWorktreePath: repository.repositoryPath,
			sourceCheckoutPath: repository.repositoryPath,
			candidateSourceCommit: commit,
			previousDeploymentExecution: {
				executionId: "132609d8-7508-4bdc-b202-1d7bd7da8a14",
				executionDirectory: join(fixture.fixtureRootDirectoryPath, "unavailable-predecessor"),
			},
			sourceValidationEvidenceFilePaths: [join(fixture.fixtureRootDirectoryPath, "upstream", "validation.json")],
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath: join(repository.repositoryPath, "dist"),
			runtimeIdentity: {
				runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline/kanban"),
				runtimeHost: "127.0.0.1",
				runtimePort: 39884,
			},
			serviceLaunch: { command: [process.execPath, executor] },
			authorization: { sourceReference: "test:explicit-deployment", userRequestQuote: "只部署隔离实例" },
		};
		const result = await prepareLocalRedeployment(directory, request, executor);
		expect(result.specification.command).toContain("run-redeployment");
		expect(result.specification.resumeCommand).toEqual(result.specification.command);
		await expect(readFile(join(repository.repositoryPath, "dist/cli.js"))).rejects.toThrow();
		expect((await readFrozenLocalRedeploymentRequest(directory)).request).toMatchObject({
			candidateSourceCommit: commit,
			previousDeploymentExecution: request.previousDeploymentExecution,
			sourceValidationEvidenceFilePaths: request.sourceValidationEvidenceFilePaths,
		});
		expect((await analyzeLocalDeploymentExecutions([directory])).executions[0]).toMatchObject({
			executionId: request.executionId,
			executionIdentityEvidenceKind: "bound_redeployment_request",
			candidateSourceCommit: commit,
			deploymentOutcome: "prepared",
			operationalProgress: { sourceValidation: { evidenceReferenceCount: 2, status: "pending" } },
		});
		await expect(
			prepareLocalRedeployment(
				directory,
				{ ...request, authorization: { ...request.authorization, userRequestQuote: "另一授权" } },
				executor,
			),
		).rejects.toThrow();
		expect(await readFile(join(repository.repositoryPath, "source.txt"), "utf8")).toContain("未提交内容");
		await mkdir(join(directory, "retained-artifacts"));
	});
	it("v2 离线基线不用虚拟 PID；在线与进程字段必须一致", () => {
		const fields = {
			schemaVersion: 2,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "w",
			taskId: "t",
			originatingTaskWorktreePath: "/source",
			sourceCheckoutPath: "/source",
			deploymentNodeBinaryPath: "/node",
			candidateSourceCommit: "a".repeat(40),
			previousDeployedSourceCommit: null,
			candidateDistributionSha256: "b".repeat(64),
			candidateDistributionDirectoryPath: "/candidate",
			distributionDirectoryPath: "/distribution",
			runtimeIdentity: { runtimeHomeDirectoryPath: "/runtime", runtimeHost: "127.0.0.1", runtimePort: 39884 },
			runtimeBefore: null,
			runtimeStartingState: "verified_offline",
			runtimeStartingStateEvidenceFilePath: "/offline-proof.json",
			redeploymentRequestSha256: "c".repeat(64),
			authorization: { sourceReference: "test", userRequestQuote: "部署" },
			stages: [
				"candidate_preparation",
				"state_preservation",
				"build_publication",
				"runtime_restart",
				"runtime_validation",
				"deployment_record",
				"staging_cleanup",
				"task_comment",
			].map((stage) => ({ stage, command: ["stage"], effectVerificationCommand: ["verify"] })),
		};
		expect(localDeploymentExecutionManifestSchema.safeParse(fields).success).toBe(true);
		expect(
			localDeploymentExecutionManifestSchema.safeParse({ ...fields, runtimeStartingState: "verified_online" })
				.success,
		).toBe(false);
		expect(
			localDeploymentExecutionManifestSchema.safeParse({
				...fields,
				runtimeBefore: { processId: 123, processStartTimeText: "虚拟进程" },
			}).success,
		).toBe(false);
	});
});
