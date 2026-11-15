import * as filesystem from "node:fs/promises";
import { mkdir, readdir, readFile, readlink, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	clearLocalRedeploymentFilesystemEvidenceRequests,
	observeLocalRedeploymentFilesystemEvidence,
	readLocalRedeploymentMachineEvidenceRequests,
	recordLocalRedeploymentFilesystemEvidenceRequest,
	reuseLocalRedeploymentCheck,
} from "../../../src/deployment/local-redeployment-persistent-checks";
import {
	type LocalRedeploymentRequest,
	localRedeploymentSha256,
} from "../../../src/deployment/local-redeployment-preparation";
import {
	backupLocalRedeploymentRuntimeState,
	preserveLocalRedeploymentWorktree,
} from "../../../src/deployment/local-redeployment-state-preservation";
import { isFilesystemKernelAtomicWriteTemporaryFilePath, lockedFileSystem } from "../../../src/fs/locked-file-system";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof filesystem>();
	return { ...actual, cp: vi.fn(actual.cp), rename: vi.fn(actual.rename) };
});

describe("重部署局部补证与真实 WIP 保全", () => {
	async function createRuntimeStateBackupFixture(executionDirectoryNesting: "direct_child" | "nested_child") {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(fixture.cleanup);
		const runtimeHomeDirectoryPath = join(fixture.fixtureRootDirectoryPath, "isolated-runtime-home");
		const directory = join(
			runtimeHomeDirectoryPath,
			...(executionDirectoryNesting === "nested_child" ? ["persistent-executions"] : []),
			"redeployment-execution",
		);
		const distributionDirectoryPath = join(fixture.fixtureRootDirectoryPath, "previous-runtime-distribution");
		await mkdir(directory, { recursive: true });
		await mkdir(distributionDirectoryPath);
		await writeFile(join(distributionDirectoryPath, "cli.js"), "原运行版本");
		const request: LocalRedeploymentRequest = {
			schemaVersion: 1,
			executionId: "032609d8-7508-4bdc-b202-1d7bd7da8a14",
			workspaceId: "isolated-workspace",
			taskId: "isolated-task",
			originatingTaskWorktreePath: fixture.fixtureRootDirectoryPath,
			sourceCheckoutPath: fixture.fixtureRootDirectoryPath,
			candidateSourceCommit: "a".repeat(40),
			deploymentNodeBinaryPath: process.execPath,
			distributionDirectoryPath,
			runtimeIdentity: { runtimeHomeDirectoryPath, runtimeHost: "127.0.0.1", runtimePort: 39884 },
			serviceLaunch: { command: [process.execPath, join(distributionDirectoryPath, "cli.js")] },
			authorization: { sourceReference: "test:runtime-state-backup", userRequestQuote: "保全隔离实例" },
		};
		return { request, directory, runtimeHomeDirectoryPath };
	}
	it.each(["direct_child", "nested_child"] as const)(
		"执行目录为 runtime home 的 %s 时排除自身及其祖先，不递归复制备份输出",
		async (nesting) => {
			const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture(nesting);
			await writeFile(join(runtimeHomeDirectoryPath, "config.json"), "原配置");
			await backupLocalRedeploymentRuntimeState(request, directory);
			expect(await readdir(join(directory, "preserved-runtime-state"))).toEqual(["config.json"]);
			expect(await readFile(join(directory, "preserved-runtime-state", "config.json"), "utf8")).toBe("原配置");
			const receipt = JSON.parse(await readFile(join(directory, "runtime-state-backup-receipt.json"), "utf8"));
			expect(receipt.preservedInPlaceOrTransientEndpoints).toContain(
				join(
					runtimeHomeDirectoryPath,
					nesting === "direct_child" ? "redeployment-execution" : "persistent-executions",
				),
			);
		},
	);
	it("保全工作区状态时原地保留活跃所属命令产物，进度变化不使备份自阻塞", async () => {
		const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
		const workspaceDirectory = join(runtimeHomeDirectoryPath, "workspaces", request.workspaceId);
		const supervisorArtifactDirectory = join(workspaceDirectory, "task-command-executions", request.executionId);
		await mkdir(supervisorArtifactDirectory, { recursive: true });
		const supervisorProgressFilePath = join(supervisorArtifactDirectory, "supervisor-progress.json");
		await writeFile(supervisorProgressFilePath, '{"observation":1}');
		const workspaceBoardFilePath = join(workspaceDirectory, "board.json");
		await writeFile(workspaceBoardFilePath, '{"retained":true}');
		await writeFile(join(workspaceDirectory, "task-command-executions.json"), '[{"retained":true}]');
		const ordinaryConfigurationDirectory = join(runtimeHomeDirectoryPath, "settings", "task-command-executions");
		await mkdir(ordinaryConfigurationDirectory, { recursive: true });
		await writeFile(join(ordinaryConfigurationDirectory, "config.json"), "普通同名目录仍须备份");
		const originalFilesystemEntryCopy = vi.mocked(filesystem.cp).getMockImplementation();
		if (!originalFilesystemEntryCopy) throw new Error("缺少真实文件复制函数");
		onTestFinished(() => {
			vi.mocked(filesystem.cp).mockImplementation(originalFilesystemEntryCopy);
		});
		vi.mocked(filesystem.cp).mockImplementation(async (...filesystemEntryCopyArguments) => {
			await originalFilesystemEntryCopy(...filesystemEntryCopyArguments);
			// 在真实复制期间模拟并发监督进度，避免依赖墙钟与调度速度。
			if (String(filesystemEntryCopyArguments[0]) === workspaceBoardFilePath)
				await writeFile(supervisorProgressFilePath, '{"observation":2}');
		});
		await backupLocalRedeploymentRuntimeState(request, directory);
		const preservedWorkspaceDirectory = join(directory, "preserved-runtime-state", "workspaces", request.workspaceId);
		expect(await readdir(preservedWorkspaceDirectory)).toEqual(["board.json", "task-command-executions.json"]);
		expect(await readFile(join(preservedWorkspaceDirectory, "board.json"), "utf8")).toBe('{"retained":true}');
		expect(await readFile(join(preservedWorkspaceDirectory, "task-command-executions.json"), "utf8")).toBe(
			'[{"retained":true}]',
		);
		expect(
			await readFile(
				join(directory, "preserved-runtime-state", "settings", "task-command-executions", "config.json"),
				"utf8",
			),
		).toBe("普通同名目录仍须备份");
		expect(await readFile(supervisorProgressFilePath, "utf8")).toBe('{"observation":2}');
		const receipt = JSON.parse(await readFile(join(directory, "runtime-state-backup-receipt.json"), "utf8"));
		expect(receipt.preservedInPlaceOrTransientEndpoints).toContain(
			join(workspaceDirectory, "task-command-executions"),
		);
	});
	it("临时文件识别与真实内核原子写的命名一致", async () => {
		const { runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
		const destination = join(runtimeHomeDirectoryPath, "native-state.json");
		const originalRename = vi.mocked(filesystem.rename).getMockImplementation();
		if (!originalRename) throw new Error("缺少真实原子发布函数");
		onTestFinished(() => {
			vi.mocked(filesystem.rename).mockImplementation(originalRename);
		});
		const observedTemporaryPaths: string[] = [];
		vi.mocked(filesystem.rename).mockImplementation(async (source, target) => {
			if (String(target) === destination) observedTemporaryPaths.push(String(source));
			await originalRename(source, target);
		});
		await lockedFileSystem.writeJsonFileAtomic(destination, { committed: true }, { lock: null });
		expect(observedTemporaryPaths).toHaveLength(1);
		expect(isFilesystemKernelAtomicWriteTemporaryFilePath(observedTemporaryPaths[0])).toBe(true);
		expect(isFilesystemKernelAtomicWriteTemporaryFilePath(destination)).toBe(false);
	});
	it.each(["workspace", "pty_host", "runtime_root"] as const)(
		"%s 的内核原子写临时文件在复制前消失时仍保全正式文件",
		async (scope) => {
			const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
			const nativeStateDirectory =
				scope === "workspace"
					? join(runtimeHomeDirectoryPath, "workspaces", request.workspaceId)
					: scope === "pty_host"
						? join(runtimeHomeDirectoryPath, "agent-session-pty-host")
						: runtimeHomeDirectoryPath;
			await mkdir(nativeStateDirectory, { recursive: true });
			const committedFile = join(nativeStateDirectory, "a-state.json");
			const unpublishedTemporaryFile = join(
				nativeStateDirectory,
				"z-state.json.tmp.15993.1794745938802.b477d266-e8cc-4bf9-9f83-78d88042ee94",
			);
			await writeFile(committedFile, '{"committed":true}');
			await writeFile(unpublishedTemporaryFile, '{"pending":true}');
			const originalCopy = vi.mocked(filesystem.cp).getMockImplementation();
			if (!originalCopy) throw new Error("缺少真实复制函数");
			onTestFinished(() => {
				vi.mocked(filesystem.cp).mockImplementation(originalCopy);
			});
			vi.mocked(filesystem.cp).mockImplementation(async (...arguments_) => {
				await originalCopy(...arguments_);
				if (String(arguments_[0]) === committedFile) await unlink(unpublishedTemporaryFile);
			});
			await backupLocalRedeploymentRuntimeState(request, directory);
			const relativeCommittedFile = committedFile.slice(runtimeHomeDirectoryPath.length + 1);
			expect(await readFile(join(directory, "preserved-runtime-state", relativeCommittedFile), "utf8")).toBe(
				'{"committed":true}',
			);
			const receipt = JSON.parse(await readFile(join(directory, "runtime-state-backup-receipt.json"), "utf8"));
			expect(receipt.preservedInPlaceOrTransientEndpoints).toContain(unpublishedTemporaryFile);
		},
	);
	it("临时文件识别保留普通 tmp 文件及用户资料中的同形文件", async () => {
		const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
		const sourcePaths = [
			"workspaces/isolated-workspace/user-notes.tmp.txt",
			"workspaces/isolated-workspace/state.json.tmp.15993.1794745938802.not-a-uuid",
			"retained-user-artifacts/state.json.tmp.15993.1794745938802.b477d266-e8cc-4bf9-9f83-78d88042ee94",
		];
		for (const path of sourcePaths) {
			await mkdir(join(runtimeHomeDirectoryPath, path, ".."), { recursive: true });
			await writeFile(join(runtimeHomeDirectoryPath, path), "必须保全的用户资料");
		}
		await backupLocalRedeploymentRuntimeState(request, directory);
		for (const path of sourcePaths)
			expect(await readFile(join(directory, "preserved-runtime-state", path), "utf8")).toBe("必须保全的用户资料");
	});
	it("等待期间配置与 WAL 数据库变化时另存当前版本，保留首版并复用未变项目", async () => {
		const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
		await mkdir(join(runtimeHomeDirectoryPath, "settings"));
		await writeFile(join(runtimeHomeDirectoryPath, "settings", "config.json"), '{"version":1}');
		await writeFile(join(runtimeHomeDirectoryPath, "unchanged.json"), "不变配置");
		const database = new Database(join(runtimeHomeDirectoryPath, "state.sqlite"));
		onTestFinished(() => {
			database.close();
		});
		database.pragma("journal_mode = WAL");
		database.pragma("wal_autocheckpoint = 0");
		database.exec("CREATE TABLE runtime_state(version INTEGER); INSERT INTO runtime_state VALUES(1)");
		const readCheckpoint = async (
			name: string,
		): Promise<{ destination: string; sourceFingerprint: string; preservedFingerprint: string }> =>
			JSON.parse(
				await readFile(
					join(directory, "runtime-backup-checkpoints", `${localRedeploymentSha256(name)}.json`),
					"utf8",
				),
			);
		const readPreservedDatabaseVersion = (path: string): unknown => {
			const preserved = new Database(path, { readonly: true, fileMustExist: true });
			try {
				expect(preserved.pragma("quick_check", { simple: true })).toBe("ok");
				return preserved.prepare("SELECT version FROM runtime_state").pluck().get();
			} finally {
				preserved.close();
			}
		};
		await backupLocalRedeploymentRuntimeState(request, directory);
		const firstSettings = await readCheckpoint("settings");
		const firstDatabase = await readCheckpoint("state.sqlite");
		expect(firstDatabase.preservedFingerprint).toMatch(/^[a-f0-9]{64}$/u);
		expect(firstDatabase.sourceFingerprint).not.toBe(firstDatabase.preservedFingerprint);
		const unchangedCheckpoint = await readCheckpoint("unchanged.json");
		await writeFile(join(runtimeHomeDirectoryPath, "settings", "config.json"), '{"version":2}');
		database.exec("UPDATE runtime_state SET version = 2");
		await backupLocalRedeploymentRuntimeState(request, directory);
		const currentSettings = await readCheckpoint("settings");
		const currentDatabase = await readCheckpoint("state.sqlite");
		expect(currentSettings.destination).not.toBe(firstSettings.destination);
		expect(currentDatabase.destination).not.toBe(firstDatabase.destination);
		expect(await readFile(join(firstSettings.destination, "config.json"), "utf8")).toBe('{"version":1}');
		expect(await readFile(join(currentSettings.destination, "config.json"), "utf8")).toBe('{"version":2}');
		expect(readPreservedDatabaseVersion(firstDatabase.destination)).toBe(1);
		expect(readPreservedDatabaseVersion(currentDatabase.destination)).toBe(2);
		expect(await readCheckpoint("unchanged.json")).toEqual(unchangedCheckpoint);
		await backupLocalRedeploymentRuntimeState(request, directory);
		expect(await readCheckpoint("settings")).toEqual(currentSettings);
		expect(await readCheckpoint("state.sqlite")).toEqual(currentDatabase);
	});
	it("已核验文件与在线数据库在随后继续更新时保留一致副本，不要求整个活动目录静止", async () => {
		const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
		const activeDirectory = join(runtimeHomeDirectoryPath, "active-native-session-state");
		await mkdir(activeDirectory);
		const cachePath = join(activeDirectory, "models_cache.json");
		const copiedLastPath = join(activeDirectory, "remaining-file.json");
		await writeFile(cachePath, '{"fetched_at":1,"models":[]}');
		await writeFile(copiedLastPath, "另一个需要保全的文件");
		const database = new Database(join(activeDirectory, "conversation.sqlite"));
		onTestFinished(() => {
			database.close();
		});
		database.pragma("journal_mode = WAL");
		database.exec("CREATE TABLE messages(value TEXT); INSERT INTO messages VALUES('已保全消息')");
		const originalFilesystemEntryCopy = vi.mocked(filesystem.cp).getMockImplementation();
		if (!originalFilesystemEntryCopy) throw new Error("缺少真实文件复制函数");
		onTestFinished(() => {
			vi.mocked(filesystem.cp).mockImplementation(originalFilesystemEntryCopy);
		});
		vi.mocked(filesystem.cp).mockImplementation(async (...arguments_) => {
			await originalFilesystemEntryCopy(...arguments_);
			if (String(arguments_[0]) === copiedLastPath) {
				await writeFile(cachePath, '{"fetched_at":2,"models":[]}');
				database.exec("INSERT INTO messages VALUES('备份后新消息')");
			}
		});
		await backupLocalRedeploymentRuntimeState(request, directory);
		const checkpoint = JSON.parse(
			await readFile(
				join(
					directory,
					"runtime-backup-checkpoints",
					`${localRedeploymentSha256("active-native-session-state")}.json`,
				),
				"utf8",
			),
		);
		expect(checkpoint.sourceFingerprint).toBeNull();
		expect(checkpoint.concurrentSourceChangesObserved).toBe(true);
		expect(checkpoint.sourceFingerprintBeforeCapture).not.toBe(checkpoint.sourceFingerprintAfterCapture);
		expect(await readFile(join(checkpoint.destination, "models_cache.json"), "utf8")).toBe(
			'{"fetched_at":1,"models":[]}',
		);
		const preservedDatabase = new Database(join(checkpoint.destination, "conversation.sqlite"), { readonly: true });
		try {
			expect(preservedDatabase.pragma("quick_check", { simple: true })).toBe("ok");
			expect(preservedDatabase.prepare("SELECT value FROM messages").pluck().all()).toEqual(["已保全消息"]);
		} finally {
			preservedDatabase.close();
		}
		expect(database.prepare("SELECT count(*) FROM messages").pluck().get()).toBe(2);
	});
	it("普通文件在复制期间被改写仍拒绝不一致副本，不生成通过回执", async () => {
		const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
		const source = join(runtimeHomeDirectoryPath, "config.json");
		await writeFile(source, '{"version":1}');
		const originalFilesystemEntryCopy = vi.mocked(filesystem.cp).getMockImplementation();
		if (!originalFilesystemEntryCopy) throw new Error("缺少真实文件复制函数");
		onTestFinished(() => {
			vi.mocked(filesystem.cp).mockImplementation(originalFilesystemEntryCopy);
		});
		vi.mocked(filesystem.cp).mockImplementation(async (...arguments_) => {
			await originalFilesystemEntryCopy(...arguments_);
			if (String(arguments_[0]) === source) await writeFile(source, '{"version":2}');
		});
		await expect(backupLocalRedeploymentRuntimeState(request, directory)).rejects.toMatchObject({
			code: "SOURCE_CONTENT_CHANGED_DURING_CAPTURE",
			path: source,
		});
		await expect(readFile(join(directory, "runtime-state-backup-receipt.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
	it("恢复旧版名称检查点时保留旧原件，副本内容损坏后重新保全当前状态", async () => {
		const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
		await writeFile(join(runtimeHomeDirectoryPath, "config.json"), "当前配置");
		const historicalDestination = join(directory, "preserved-runtime-state", "config.json");
		await mkdir(join(directory, "preserved-runtime-state"));
		await writeFile(historicalDestination, "历史配置");
		const checkpointPath = join(
			directory,
			"runtime-backup-checkpoints",
			`${localRedeploymentSha256("config.json")}.json`,
		);
		await mkdir(join(directory, "runtime-backup-checkpoints"));
		await writeFile(checkpointPath, JSON.stringify({ destination: historicalDestination }));
		await backupLocalRedeploymentRuntimeState(request, directory);
		const firstCurrent = JSON.parse(await readFile(checkpointPath, "utf8"));
		expect(await readFile(historicalDestination, "utf8")).toBe("历史配置");
		expect(await readFile(firstCurrent.destination, "utf8")).toBe("当前配置");
		await writeFile(firstCurrent.destination, "副本损坏");
		await backupLocalRedeploymentRuntimeState(request, directory);
		const recoveredCurrent = JSON.parse(await readFile(checkpointPath, "utf8"));
		expect(recoveredCurrent.destination).not.toBe(firstCurrent.destination);
		expect(await readFile(recoveredCurrent.destination, "utf8")).toBe("当前配置");
		expect(await readFile(firstCurrent.destination, "utf8")).toBe("副本损坏");
	});
	it.each(["runtime_home_state_backup", "previous_runtime_distribution_backup"] as const)(
		"%s 保留相对及悬空链接的原始目标文本，源文件移除后副本仍可独立读取",
		async (backupKind) => {
			const { request, directory, runtimeHomeDirectoryPath } = await createRuntimeStateBackupFixture("direct_child");
			const sourceDirectoryContainingRelativeSymbolicLinks =
				backupKind === "runtime_home_state_backup" ? runtimeHomeDirectoryPath : request.distributionDirectoryPath;
			const preservedDirectoryContainingRelativeSymbolicLinks = join(
				directory,
				backupKind === "runtime_home_state_backup" ? "preserved-runtime-state" : "preserved-previous-distribution",
			);
			const targetFilename = backupKind === "runtime_home_state_backup" ? "config.json" : "cli.js";
			const sourceTargetFile = join(sourceDirectoryContainingRelativeSymbolicLinks, targetFilename);
			if (backupKind === "runtime_home_state_backup") await writeFile(sourceTargetFile, "原始运行配置");
			const expectedContents = await readFile(sourceTargetFile, "utf8");
			await symlink(targetFilename, join(sourceDirectoryContainingRelativeSymbolicLinks, "relative-existing-link"));
			await symlink(
				"missing-content",
				join(sourceDirectoryContainingRelativeSymbolicLinks, "relative-missing-link"),
			);
			await backupLocalRedeploymentRuntimeState(request, directory);
			expect(await readlink(join(preservedDirectoryContainingRelativeSymbolicLinks, "relative-existing-link"))).toBe(
				targetFilename,
			);
			expect(await readlink(join(preservedDirectoryContainingRelativeSymbolicLinks, "relative-missing-link"))).toBe(
				"missing-content",
			);
			await unlink(sourceTargetFile);
			expect(
				await readFile(join(preservedDirectoryContainingRelativeSymbolicLinks, "relative-existing-link"), "utf8"),
			).toBe(expectedContents);
		},
	);
	it("只补失败项目，跨执行器重启复用成功原件；只使已变化项目失效", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(fixture.cleanup);
		const directory = join(fixture.fixtureRootDirectoryPath, "persistent-checks");
		const invocations: string[] = [];
		let failing = true;
		const check = (project: string, revision: string) =>
			reuseLocalRedeploymentCheck({
				directory,
				checkKey: project,
				inputFingerprint: revision,
				read: async () => {
					invocations.push(project);
					if (project === "second" && failing) throw new Error("API 暂时超时");
					return { value: { project }, evidenceSource: "consistent_workspace_snapshot" };
				},
				validate: (value): value is { project: string } =>
					!!value && typeof value === "object" && "project" in value && value.project === project,
			});
		await check("first", "revision-1");
		await expect(check("second", "revision-1")).rejects.toThrow("API 暂时超时");
		expect(
			(await readLocalRedeploymentMachineEvidenceRequests(directory)).map((request) => request.checkKey),
		).toEqual(["second"]);
		failing = false;
		await check("first", "revision-1");
		await check("second", "revision-1");
		await check("first", "revision-2");
		await check("second", "revision-1");
		expect(invocations).toEqual(["first", "second", "second", "first"]);
		expect(await readLocalRedeploymentMachineEvidenceRequests(directory)).toEqual([]);
	});
	it("保全 binary、staged、unstaged、untracked 与符号链接，不修改原工作树", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(fixture.cleanup);
		const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "dirty-source" });
		await writeFile(join(repository.repositoryPath, "binary-file.bin"), Buffer.from([0, 1, 2]));
		await writeFile(join(repository.repositoryPath, "staged-file.txt"), "初始\n");
		repository.commitAllRepositoryFilesAtDate({
			message: "保全基线",
			authorAndCommitterIsoDate: "2026-11-13T00:00:00Z",
		});
		await writeFile(join(repository.repositoryPath, "staged-file.txt"), "已暂存\n");
		repository.runGit(["add", "staged-file.txt"]);
		await writeFile(join(repository.repositoryPath, "staged-file.txt"), "工作区另有内容\n");
		await writeFile(join(repository.repositoryPath, "binary-file.bin"), Buffer.from([0, 9, 255]));
		await writeFile(join(repository.repositoryPath, "untracked file.txt"), "尚未提交\n");
		await symlink("untracked file.txt", join(repository.repositoryPath, "untracked-link"));
		const before = repository.runGit(["status", "--porcelain=v1"]).stdout;
		const snapshot = await preserveLocalRedeploymentWorktree(
			repository.repositoryPath,
			join(fixture.fixtureRootDirectoryPath, "preserved-worktrees"),
			true,
		);
		expect(snapshot.files["untracked-link"]).toEqual({ symlinkTarget: "untracked file.txt" });
		expect(
			await readFile(join(snapshot.preservedDirectory ?? "", "preserved-working-files", "binary-file.bin")),
		).toEqual(Buffer.from([0, 9, 255]));
		const patch = JSON.parse(
			await readFile(join(snapshot.preservedDirectory ?? "", "index-vs-head.patch.base64.json"), "utf8"),
		);
		expect(Buffer.from(patch.content, "base64").toString()).toContain("已暂存");
		expect(repository.runGit(["status", "--porcelain=v1"]).stdout).toBe(before);
		await mkdir(join(fixture.fixtureRootDirectoryPath, "kept-evidence"));
	});
	it("文件缺证记录可跨重启观察；仅修改 mtime 不重置语义预算", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		onTestFinished(fixture.cleanup);
		const directory = join(fixture.fixtureRootDirectoryPath, "machine-recovery");
		const path = join(fixture.fixtureRootDirectoryPath, "expected-state.json");
		await recordLocalRedeploymentFilesystemEvidenceRequest(
			directory,
			Object.assign(new Error("缺件"), { path, code: "ENOENT" }),
			"state_preservation",
		);
		expect(await observeLocalRedeploymentFilesystemEvidence(path)).toEqual({ kind: "unavailable", code: "ENOENT" });
		await writeFile(path, "真实状态");
		const recovered = await observeLocalRedeploymentFilesystemEvidence(path);
		await utimes(path, new Date(), new Date(Date.now() + 60_000));
		expect(await observeLocalRedeploymentFilesystemEvidence(path)).toEqual(recovered);
		expect((await readLocalRedeploymentMachineEvidenceRequests(directory))[0].stage).toBe("state_preservation");
		await clearLocalRedeploymentFilesystemEvidenceRequests(directory, "state_preservation");
		expect(await readLocalRedeploymentMachineEvidenceRequests(directory)).toEqual([]);
	});
});
