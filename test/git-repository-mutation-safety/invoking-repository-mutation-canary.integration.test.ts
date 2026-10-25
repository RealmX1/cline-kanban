import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import {
	type LoadSensitiveDeadlineAnnotatingTestContext,
	type LoadSensitiveWallClockTwoTierDeadline,
	waitForConditionWithinLoadSensitiveTwoTierDeadline,
} from "../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createIsolatedGitTestWorkspaceFixture } from "./isolated-git-test-workspace-fixture";
import {
	captureInvokingRepositoryEvidenceSnapshot,
	compareInvokingRepositoryEvidenceSnapshots,
	runCommandWithInvokingRepositoryMutationCanary,
} from "./run-test-projects-with-invoking-repository-mutation-canary";

const requireFromCanaryIntegrationTest = createRequire(import.meta.url);

function createCommittedCanaryRepository(repositoryDirectoryName: string) {
	const gitFixture = createIsolatedGitTestWorkspaceFixture();
	const repository = gitFixture.createNonBareRepository({ repositoryDirectoryName, initialBranchName: "main" });
	writeFileSync(join(repository.repositoryPath, "README.md"), "seed\n", "utf8");
	repository.runGit(["add", "README.md"]);
	repository.runGit(["commit", "--quiet", "-m", "seed"]);
	return { gitFixture, repository };
}

// canary runner 经 tsx 冷启动、再派生子测试进程：负载下 5s 不够，超过软档只告警。
const CANARY_RUNNER_CHILD_TEST_READY_OUTPUT_TWO_TIER_DEADLINE: LoadSensitiveWallClockTwoTierDeadline = {
	waitedForDescription: "canary runner 派生的子测试打印就绪标记（从 spawn 起算，含 tsx 冷启动）",
	softDeadlineMsExpectedOnUncontendedHost: 5_000,
	hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
};

async function waitForStandardOutputText(
	testContext: LoadSensitiveDeadlineAnnotatingTestContext,
	childProcess: ChildProcess,
	expectedText: string,
): Promise<void> {
	let standardOutput = "";
	let standardError = "";
	let childProcessFailureBeforeExpectedOutput: Error | null = null;
	childProcess.stdout?.setEncoding("utf8");
	childProcess.stdout?.on("data", (chunk: string) => {
		standardOutput += chunk;
	});
	childProcess.stderr?.setEncoding("utf8");
	childProcess.stderr?.on("data", (chunk: string) => {
		standardError += chunk;
	});
	childProcess.once("error", (error) => {
		childProcessFailureBeforeExpectedOutput ??= error;
	});
	childProcess.once("exit", (exitCode, signal) => {
		childProcessFailureBeforeExpectedOutput ??= new Error(
			`Child exited before output ${expectedText}: exit=${String(exitCode)} signal=${String(signal)} stdout=${standardOutput} stderr=${standardError}`,
		);
	});
	await waitForConditionWithinLoadSensitiveTwoTierDeadline(
		testContext,
		CANARY_RUNNER_CHILD_TEST_READY_OUTPUT_TWO_TIER_DEADLINE,
		() => {
			if (standardOutput.includes(expectedText)) {
				return true;
			}
			if (childProcessFailureBeforeExpectedOutput) {
				throw childProcessFailureBeforeExpectedOutput;
			}
			return false;
		},
		{ describeLastObservedStateForFailureMessage: () => `stdout=${standardOutput} stderr=${standardError}` },
	);
}

describe.sequential("invoking repository mutation canary", () => {
	it("清除 poisoned Git hook 环境且不触碰牺牲仓库", async () => {
		const invoking = createCommittedCanaryRepository("poisoned-environment-invoking-repository");
		const sacrificial = createCommittedCanaryRepository("poisoned-environment-sacrificial-repository");
		const poisonedGitEnvironmentVariables = {
			GIT_DIR: join(sacrificial.repository.repositoryPath, ".git"),
			GIT_WORK_TREE: sacrificial.repository.repositoryPath,
			GIT_COMMON_DIR: join(sacrificial.repository.repositoryPath, ".git"),
			GIT_INDEX_FILE: join(sacrificial.repository.repositoryPath, ".git", "index"),
			GIT_OBJECT_DIRECTORY: join(sacrificial.repository.repositoryPath, ".git", "objects"),
			GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sacrificial.repository.repositoryPath, ".git", "objects"),
		} as const;
		const previousEnvironmentVariableValues = new Map<string, string | undefined>();
		for (const [environmentVariableName, environmentVariableValue] of Object.entries(
			poisonedGitEnvironmentVariables,
		)) {
			previousEnvironmentVariableValues.set(environmentVariableName, process.env[environmentVariableName]);
			process.env[environmentVariableName] = environmentVariableValue;
		}

		try {
			const invokingBefore = captureInvokingRepositoryEvidenceSnapshot(invoking.repository.repositoryPath);
			const sacrificialBefore = captureInvokingRepositoryEvidenceSnapshot(sacrificial.repository.repositoryPath);
			const childScript = [
				'const { realpathSync } = require("node:fs");',
				`if (realpathSync(process.cwd()) !== ${JSON.stringify(invoking.repository.repositoryPath)}) process.exit(12);`,
				'for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) if (process.env[name] !== undefined) process.exit(13);',
			].join("\n");
			const result = await runCommandWithInvokingRepositoryMutationCanary({
				invokingDirectoryPath: invoking.repository.repositoryPath,
				command: process.execPath,
				arguments: ["-e", childScript],
			});
			expect(result.exitCode).toBe(0);
			expect(result.mutationCategories).toEqual([]);
			const invokingAfter = captureInvokingRepositoryEvidenceSnapshot(invoking.repository.repositoryPath);
			const sacrificialAfter = captureInvokingRepositoryEvidenceSnapshot(sacrificial.repository.repositoryPath);
			expect(compareInvokingRepositoryEvidenceSnapshots(invokingBefore, invokingAfter)).toEqual([]);
			expect(compareInvokingRepositoryEvidenceSnapshots(sacrificialBefore, sacrificialAfter)).toEqual([]);
		} finally {
			for (const [environmentVariableName, previousEnvironmentVariableValue] of previousEnvironmentVariableValues) {
				if (previousEnvironmentVariableValue === undefined) {
					delete process.env[environmentVariableName];
				} else {
					process.env[environmentVariableName] = previousEnvironmentVariableValue;
				}
			}
			invoking.gitFixture.cleanup();
			sacrificial.gitFixture.cleanup();
		}
	});

	it("保留无修改子进程的退出码并删除临时诊断", async () => {
		const { gitFixture, repository } = createCommittedCanaryRepository("no-mutation-repository");
		try {
			const result = await runCommandWithInvokingRepositoryMutationCanary({
				invokingDirectoryPath: repository.repositoryPath,
				command: process.execPath,
				arguments: ["-e", "process.exit(7)"],
			});
			expect(result.exitCode).toBe(7);
			expect(result.mutationCategories).toEqual([]);
			expect(result.diagnosticReportPath).toBeNull();
		} finally {
			gitFixture.cleanup();
		}
	});

	it("分别识别 config、HEAD、index 和 working tree 漂移", () => {
		const mutationCases = [
			{
				repositoryDirectoryName: "config-mutation-repository",
				expectedCategory: "local-config",
				mutate: (_repositoryPath: string, runGit: (arguments_: readonly string[]) => void) => {
					runGit(["config", "canary.changed", "true"]);
				},
			},
			{
				repositoryDirectoryName: "head-mutation-repository",
				expectedCategory: "head-oid",
				mutate: (repositoryPath: string, runGit: (arguments_: readonly string[]) => void) => {
					writeFileSync(join(repositoryPath, "head-change.txt"), "change\n", "utf8");
					runGit(["add", "head-change.txt"]);
					runGit(["commit", "--quiet", "-m", "head change"]);
				},
			},
			{
				repositoryDirectoryName: "index-mutation-repository",
				expectedCategory: "index",
				mutate: (repositoryPath: string, runGit: (arguments_: readonly string[]) => void) => {
					writeFileSync(join(repositoryPath, "index-change.txt"), "change\n", "utf8");
					runGit(["add", "index-change.txt"]);
				},
			},
			{
				repositoryDirectoryName: "working-tree-mutation-repository",
				expectedCategory: "working-tree-status",
				mutate: (repositoryPath: string) => {
					writeFileSync(join(repositoryPath, "working-tree-change.txt"), "change\n", "utf8");
				},
			},
		] as const;

		for (const mutationCase of mutationCases) {
			const { gitFixture, repository } = createCommittedCanaryRepository(mutationCase.repositoryDirectoryName);
			try {
				const before = captureInvokingRepositoryEvidenceSnapshot(repository.repositoryPath);
				mutationCase.mutate(repository.repositoryPath, (arguments_) => {
					repository.runGit(arguments_);
				});
				const after = captureInvokingRepositoryEvidenceSnapshot(repository.repositoryPath);
				expect(compareInvokingRepositoryEvidenceSnapshots(before, after)).toContain(mutationCase.expectedCategory);
			} finally {
				gitFixture.cleanup();
			}
		}
	});

	it("仅新增未引用对象使 OID 缩写增长时不误报 working tree 漂移", () => {
		const gitFixture = createIsolatedGitTestWorkspaceFixture();
		const repository = gitFixture.createNonBareRepository({
			repositoryDirectoryName: "object-id-abbreviation-growth-canary-repository",
		});
		try {
			repository.runGit(["config", "core.abbrev", "4"]);
			writeFileSync(join(repository.repositoryPath, "README.md"), "seed\n", "utf8");
			repository.commitAllRepositoryFilesAtDate({
				message: "固定 OID 缩写回归基线",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			writeFileSync(join(repository.repositoryPath, "README.md"), "dirty version one\n", "utf8");
			const abbreviatedPatchBefore = repository.runGit(["diff", "--binary", "HEAD", "--"]).stdout;
			const fullIndexPatchBefore = repository.runGit(["diff", "--binary", "--full-index", "HEAD", "--"]).stdout;
			const before = captureInvokingRepositoryEvidenceSnapshot(repository.repositoryPath);

			// 两个固定 blob 的 OID 共享 e31d 前缀；内容文件放在 worktree 外，写入对象不改变受保护状态。
			const collidingBlobContentFilePath = join(
				gitFixture.fixtureRootDirectoryPath,
				"oid-prefix-collision-blob.txt",
			);
			writeFileSync(collidingBlobContentFilePath, "canary-abbreviation-collision-21212\n", "utf8");
			expect(
				repository.runGit(["hash-object", "-w", "--no-filters", collidingBlobContentFilePath]).stdout.trim(),
			).toBe("e31dce9a68aad23bead686ab9a065e19d30e3541");

			const abbreviatedPatchAfter = repository.runGit(["diff", "--binary", "HEAD", "--"]).stdout;
			const after = captureInvokingRepositoryEvidenceSnapshot(repository.repositoryPath);
			expect(abbreviatedPatchBefore).toMatch(/^index e31d\.\./mu);
			expect(abbreviatedPatchAfter).toMatch(/^index e31de\.\./mu);
			expect(abbreviatedPatchAfter).not.toBe(abbreviatedPatchBefore);
			expect(repository.runGit(["diff", "--binary", "--full-index", "HEAD", "--"]).stdout).toBe(
				fullIndexPatchBefore,
			);
			expect(after).toEqual(before);
			expect(compareInvokingRepositoryEvidenceSnapshots(before, after)).toEqual([]);
		} finally {
			gitFixture.cleanup();
		}
	});

	it.each([
		{
			fileTrackingDescription: "已修改的 tracked",
			repositoryDirectoryName: "dirty-tracked-content-mutation-repository",
			repositoryRelativeFilePath: "README.md",
		},
		{
			fileTrackingDescription: "已存在的 untracked",
			repositoryDirectoryName: "existing-untracked-content-mutation-repository",
			repositoryRelativeFilePath: "existing-untracked-file.txt",
		},
	])(
		"$fileTrackingDescription 文件在 status 文本不变时仍按内容 hash 识别漂移",
		({ repositoryDirectoryName, repositoryRelativeFilePath }) => {
			const { gitFixture, repository } = createCommittedCanaryRepository(repositoryDirectoryName);
			try {
				const mutatedFilePath = join(repository.repositoryPath, repositoryRelativeFilePath);
				writeFileSync(mutatedFilePath, "dirty version one\n", "utf8");
				const before = captureInvokingRepositoryEvidenceSnapshot(repository.repositoryPath);
				writeFileSync(mutatedFilePath, "dirty version two\n", "utf8");
				const after = captureInvokingRepositoryEvidenceSnapshot(repository.repositoryPath);
				expect(after.porcelainVersionTwoStatus).toBe(before.porcelainVersionTwoStatus);
				expect(compareInvokingRepositoryEvidenceSnapshots(before, after)).toEqual(["working-tree-status"]);
			} finally {
				gitFixture.cleanup();
			}
		},
	);

	it("漂移时以 mutation 为主错误、保留原退出码且不自动恢复", async () => {
		const { gitFixture, repository } = createCommittedCanaryRepository("runner-mutation-repository");
		try {
			const mutationScript = [
				'const { appendFileSync } = require("node:fs");',
				'appendFileSync(".git/config", "\\n[canary]\\n\\trunnerChanged = true\\n");',
				"process.exit(9);",
			].join("\n");
			const result = await runCommandWithInvokingRepositoryMutationCanary({
				invokingDirectoryPath: repository.repositoryPath,
				command: process.execPath,
				arguments: ["-e", mutationScript],
			});
			expect(result.exitCode).toBe(1);
			expect(result.originalChildExitCode).toBe(9);
			expect(result.mutationCategories).toContain("local-config");
			expect(result.diagnosticReportPath).not.toBeNull();
			expect(existsSync(result.diagnosticReportPath ?? "")).toBe(true);
			const report = readFileSync(result.diagnosticReportPath ?? "", "utf8");
			expect(report).not.toContain("runnerChanged");
			expect(repository.runGit(["config", "--get", "canary.runnerChanged"]).stdout.trim()).toBe("true");
		} finally {
			gitFixture.cleanup();
		}
	});

	it("后采样因 Git 身份被破坏而失败时仍保留 mutation 主错误与报告", async () => {
		const { gitFixture, repository } = createCommittedCanaryRepository("unverifiable-after-snapshot-repository");
		try {
			const result = await runCommandWithInvokingRepositoryMutationCanary({
				invokingDirectoryPath: repository.repositoryPath,
				command: process.execPath,
				arguments: ["-e", 'require("node:fs").unlinkSync(".git/config")'],
			});
			expect(result.exitCode).toBe(1);
			expect(result.mutationCategories).toContain("git-directory-identity");
			expect(result.diagnosticReportPath).not.toBeNull();
			expect(existsSync(result.diagnosticReportPath ?? "")).toBe(true);
		} finally {
			gitFixture.cleanup();
		}
	});

	it("SIGTERM 转发给子测试后仍执行 canary 复查", async (testContext) => {
		const { gitFixture, repository } = createCommittedCanaryRepository("signal-forwarding-repository");
		let canaryRunnerProcess: ChildProcess | null = null;
		try {
			const childTestScript = [
				'process.stdout.write("CHILD_READY\\n");',
				'process.on("SIGTERM", () => process.exit(23));',
				"setInterval(() => {}, 1000);",
			].join("\n");
			const spawnedCanaryRunnerProcess = spawn(
				process.execPath,
				[
					"--import",
					pathToFileURL(requireFromCanaryIntegrationTest.resolve("tsx")).href,
					join(
						process.cwd(),
						"test",
						"git-repository-mutation-safety",
						"run-test-projects-with-invoking-repository-mutation-canary.ts",
					),
					"--",
					process.execPath,
					"-e",
					childTestScript,
				],
				{
					cwd: repository.repositoryPath,
					env: gitFixture.createIsolatedChildProcessEnvironment(),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			canaryRunnerProcess = spawnedCanaryRunnerProcess;
			await waitForStandardOutputText(testContext, spawnedCanaryRunnerProcess, "CHILD_READY");
			spawnedCanaryRunnerProcess.kill("SIGTERM");
			await new Promise<void>((resolveExit, rejectExit) => {
				spawnedCanaryRunnerProcess.once("error", rejectExit);
				spawnedCanaryRunnerProcess.once("exit", () => resolveExit());
			});

			expect(spawnedCanaryRunnerProcess.exitCode).toBe(23);
		} finally {
			if (canaryRunnerProcess && canaryRunnerProcess.exitCode === null && canaryRunnerProcess.signalCode === null) {
				canaryRunnerProcess.kill("SIGKILL");
				await new Promise<void>((resolveExit) => canaryRunnerProcess?.once("exit", () => resolveExit()));
			}
			gitFixture.cleanup();
		}
		// 用例超时覆盖：就绪标记硬档 30s + SIGTERM 转发后的 canary 复查。
	}, 60_000);
});
