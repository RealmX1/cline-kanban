import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureSourceGitWorkingState,
	readSourceGitWorkingStateCaptureInventory,
} from "../../../src/independent-task-creation/git-working-state-snapshot";
import { assertUnverifiedTaskClosurePayloadContainsOnlySourceDerivatives } from "../../../src/task-closure/task-closure-unverified-payload-preservation-guard";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => vi.unstubAllEnvs());

describe("未验证候选当前内容的真实 Git 和文件证明", () => {
	it("证明期间连续硬退出不遗留派生索引或 pack；来源和候选均保留", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "proof-crash-source",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "file.txt"), "硬退出也不能删除的成果\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "隔离证明崩溃来源",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		const candidateDirectory = join(fixture.fixtureRootDirectoryPath, "crash-preserved-candidate");
		await captureSourceGitWorkingState(repository.repositoryPath, candidateDirectory);
		const instrumentationPath = join(fixture.fixtureRootDirectoryPath, "observe-proof-start-before-hard-exit.mjs");
		writeFileSync(
			instrumentationPath,
			`import childProcess from 'node:child_process';
import fileSystemPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (...arguments_) {
	const child = originalSpawn.apply(this, arguments_);
	if (arguments_[1]?.includes('pack-objects')) child.once('spawn', () => {
		process.kill(child.pid, 'SIGSTOP');
		process.stdout.write(JSON.stringify({ proofStarted: true, gitPid: child.pid }) + '\\n');
	});
	return child;
};
const originalSymlink = fileSystemPromises.symlink;
fileSystemPromises.symlink = async function (...arguments_) {
	await originalSymlink.apply(this, arguments_);
	if (String(arguments_[1]).includes('unverified-payload-object-coverage-')) {
		process.stdout.write(JSON.stringify({ proofStarted: true, gitPid: null }) + '\\n');
		await new Promise(() => { setInterval(() => {}, 1000); });
	}
};
syncBuiltinESMExports();
`,
		);
		const guardModuleUrl = new URL(
			"../../../src/task-closure/task-closure-unverified-payload-preservation-guard.ts",
			import.meta.url,
		).href;
		const script = `import { readFileSync } from 'node:fs';
import { assertUnverifiedTaskClosurePayloadContainsOnlySourceDerivatives } from ${JSON.stringify(guardModuleUrl)};
await assertUnverifiedTaskClosurePayloadContainsOnlySourceDerivatives(
	${JSON.stringify(candidateDirectory)}, ${JSON.stringify(repository.repositoryPath)},
	JSON.parse(readFileSync(${JSON.stringify(join(candidateDirectory, "git-working-state-capture-inventory.json"))}, 'utf8'))
);
`;
		const originalDirectoryNames = readdirSync(fixture.fixtureRootDirectoryPath).sort();
		const originalPack = readFileSync(join(candidateDirectory, "source-git-objects.pack"));
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					"--import",
					pathToFileURL(instrumentationPath).href,
					"--input-type=module",
					"-e",
					script,
				],
				{
					env: fixture.createIsolatedChildProcessEnvironment(
						{
							CODEX_HOME: join(fixture.isolatedHomeDirectoryPath, ".codex"),
							CODEX_SQLITE_HOME: join(fixture.isolatedHomeDirectoryPath, "isolated-codex-sqlite-storage"),
						},
						{ independentPtyHostLaunchIsExcluded: true },
					),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk) => {
				stderr += String(chunk);
			});
			let ownedGitPid: number | null = null;
			try {
				await vi.waitFor(() => expect(stdout, stderr).toContain('"proofStarted":true'), { timeout: 10_000 });
				ownedGitPid = (JSON.parse(stdout.trim()) as { gitPid: number | null }).gitPid;
			} finally {
				child.kill("SIGKILL");
				if (ownedGitPid !== null) process.kill(ownedGitPid, "SIGKILL");
				await exited;
				if (ownedGitPid !== null) {
					await vi.waitFor(() => expect(() => process.kill(ownedGitPid ?? 0, 0)).toThrow(), { timeout: 10_000 });
				}
			}
			expect(child.signalCode).toBe("SIGKILL");
			expect(readdirSync(fixture.fixtureRootDirectoryPath).sort()).toEqual(originalDirectoryNames);
			expect(readFileSync(join(candidateDirectory, "source-git-objects.pack"))).toEqual(originalPack);
			expect(readFileSync(join(repository.repositoryPath, "file.txt"), "utf8")).toBe("硬退出也不能删除的成果\n");
		}
	}, 60_000);

	it.each([
		"source_derivatives",
		"partial_working_file",
		"extra_file",
		"modified_file",
		"unique_git_objects",
		"partial_git_pack",
	] as const)("候选内容 %s 的保留资格", async (scenario) => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, ".codex"));
		const repository = fixture.createNonBareRepository({
			repositoryDirectoryName: "source",
			initialBranchName: "main",
		});
		writeFileSync(join(repository.repositoryPath, "file.txt"), "已提交成果\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "隔离来源",
			authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
		});
		writeFileSync(join(repository.repositoryPath, "file.txt"), "仍被来源覆盖的完整成果\n");
		const candidateDirectory = join(fixture.fixtureRootDirectoryPath, "failed-candidate");
		await captureSourceGitWorkingState(repository.repositoryPath, candidateDirectory);
		const inventory = await readSourceGitWorkingStateCaptureInventory(repository.repositoryPath);
		if (scenario === "extra_file") writeFileSync(join(candidateDirectory, "unique.txt"), "独有成果");
		if (scenario === "modified_file")
			writeFileSync(join(candidateDirectory, "working-files", "file.txt"), "独有修改");
		if (scenario === "partial_working_file") truncateSync(join(candidateDirectory, "working-files", "file.txt"), 3);
		if (scenario === "partial_git_pack") truncateSync(join(candidateDirectory, "source-git-objects.pack"), 7);
		if (scenario === "unique_git_objects") {
			const other = fixture.createNonBareRepository({
				repositoryDirectoryName: "unique-source",
				initialBranchName: "main",
			});
			writeFileSync(join(other.repositoryPath, "unique.txt"), "仅候选对象包拥有的独有内容");
			other.commitAllRepositoryFilesAtDate({
				message: "独有提交",
				authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
			});
			const otherPayload = join(fixture.fixtureRootDirectoryPath, "other-captured-payload");
			mkdirSync(otherPayload);
			await captureSourceGitWorkingState(other.repositoryPath, otherPayload);
			copyFileSync(
				join(otherPayload, "source-git-objects.pack"),
				join(candidateDirectory, "source-git-objects.pack"),
			);
		}
		const proof = () =>
			assertUnverifiedTaskClosurePayloadContainsOnlySourceDerivatives(
				candidateDirectory,
				repository.repositoryPath,
				inventory,
			);
		if (["source_derivatives", "partial_working_file"].includes(scenario)) await proof();
		else await expect(proof()).rejects.toThrow();
		expect(readFileSync(join(repository.repositoryPath, "file.txt"), "utf8")).toBe("仍被来源覆盖的完整成果\n");
		expect(
			readdirSync(fixture.fixtureRootDirectoryPath).some((name) =>
				name.startsWith("unverified-payload-object-coverage-"),
			),
		).toBe(false);
	});
});
