import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordDeploymentWithTaskDeploymentAttribution } from "../../../src/commands/deployment-record-with-task-deployment-attribution";
import { parsePostDeployVerificationState } from "../../../src/core/api-validation";
import { getDeployMarkerPath } from "../../../src/deployment/deploy-marker";
import {
	executeLocalDeploymentStages,
	initializeLocalDeploymentExecution,
} from "../../../src/deployment/local-deployment-execution";
import {
	LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER,
	type LocalDeploymentExecutionManifest,
} from "../../../src/deployment/local-deployment-execution-contract";
import {
	createDeploymentGroup,
	getPostDeployVerificationStatePath,
} from "../../../src/deployment/post-deploy-verification-state";
import { loadWorkspaceContext } from "../../../src/state/workspace-state";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

describe("绑定执行的真实部署登记", () => {
	it("在隔离仓库登记一次，后续同 SHA 部署不被旧执行重试回退，回执保留原统计", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("USERPROFILE", fixture.isolatedHomeDirectoryPath);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "bound-deployment-source" });
		await writeFile(join(repository.repositoryPath, "source.txt"), "隔离候选\n");
		const candidate = repository.commitAllRepositoryFilesAtDate({
			message: "隔离部署候选",
			authorAndCommitterIsoDate: "2026-10-31T12:00:00Z",
		});
		const workspace = await loadWorkspaceContext(repository.repositoryPath);
		const executionDirectory = join(fixture.fixtureRootDirectoryPath, "bound-local-deployment");
		const manifest: LocalDeploymentExecutionManifest = {
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: workspace.workspaceId,
			taskId: "isolated-deployment",
			originatingTaskWorktreePath: repository.repositoryPath,
			sourceCheckoutPath: repository.repositoryPath,
			deploymentNodeBinaryPath: process.execPath,
			candidateSourceCommit: candidate,
			previousDeployedSourceCommit: null,
			candidateDistributionSha256: "a".repeat(64),
			candidateDistributionDirectoryPath: join(executionDirectory, "candidate"),
			distributionDirectoryPath: join(executionDirectory, "published"),
			runtimeIdentity: {
				runtimeHomeDirectoryPath: join(fixture.isolatedHomeDirectoryPath, ".cline/kanban"),
				runtimeHost: "127.0.0.1",
				runtimePort: 39884,
			},
			runtimeBefore: { processId: 100, processStartTimeText: "isolated-runtime" },
			authorization: { sourceReference: "test:isolated-deployment", userRequestQuote: "只登记隔离仓库" },
			stages: LOCAL_DEPLOYMENT_STAGES_IN_EXECUTION_ORDER.map((stage) => ({
				stage,
				command: ["isolated-success"],
				...(["build_publication", "runtime_restart", "deployment_record"].includes(stage)
					? { effectVerificationCommand: ["isolated-effect-proof"] }
					: {}),
			})),
		};
		await initializeLocalDeploymentExecution(executionDirectory, manifest);
		await executeLocalDeploymentStages(executionDirectory, {
			runCommand: async (command) => ({
				exitCode: 0,
				stderr: "",
				stdout:
					command[0] === "isolated-effect-proof"
						? JSON.stringify({
								ok: true,
								executionId: manifest.executionId,
								candidateSourceCommit: candidate,
								candidateDistributionSha256: manifest.candidateDistributionSha256,
							})
						: "",
			}),
		});
		const readState = async () => {
			try {
				return parsePostDeployVerificationState(
					JSON.parse(await readFile(getPostDeployVerificationStatePath(), "utf8")),
				);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return { deploymentGroups: [] };
				throw error;
			}
		};
		const input = {
			cwd: repository.repositoryPath,
			projectPath: repository.repositoryPath,
			executionDirectory,
			readPostDeployVerificationStateReadOnly: readState,
		};
		const first = await recordDeploymentWithTaskDeploymentAttribution(input);
		expect(first.deploymentId).toBe(manifest.executionId);
		expect(first.totalVerificationTaskCount).toBe(0);
		await createDeploymentGroup(
			{
				deploymentId: "cf2574ad-9e8a-496c-b842-9cab57aa815a",
				workspaceId: workspace.workspaceId,
				deployedSourceCommit: candidate,
				previousDeployedSourceCommit: candidate,
				sourceCheckoutPath: repository.repositoryPath,
				packageVersion: "0.1.68",
				tasks: [],
			},
			"2099-01-01T12:00:00Z",
		);
		const laterMarker = await readFile(getDeployMarkerPath(), "utf8");
		expect(await recordDeploymentWithTaskDeploymentAttribution(input)).toEqual(first);
		expect(await readFile(getDeployMarkerPath(), "utf8")).toBe(laterMarker);
		expect((await readState()).deploymentGroups).toHaveLength(2);
		await expect(
			recordDeploymentWithTaskDeploymentAttribution({ ...input, newCommit: "b".repeat(40) }),
		).rejects.toThrow("绑定");
	});
});
