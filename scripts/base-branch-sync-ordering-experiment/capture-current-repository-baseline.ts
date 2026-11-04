import { constants } from "node:fs";
import { cp, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	assertSourceGitWorkingStateMatchesSnapshot,
	captureSourceGitWorkingState,
} from "../../src/independent-task-creation/git-working-state-snapshot";
import { fingerprint } from "./experiment-contract";
import {
	materializeIndependentWorkingState,
	verifyMaterializedIndependentWorkingState,
} from "./frozen-source-snapshot";
import {
	createOwnedExperimentRoot,
	executeGit,
	fingerprintFile,
	readJson,
	writeDurableJson,
} from "./persistent-experiment-storage";

export async function captureCurrentRepositoryBaseline(input: {
	projectPath: string;
	taskWorktreePath: string;
	baseRef: string;
	outputDirectory: string;
	sourceCohortDirectory: string;
}) {
	const common = (await executeGit(input.projectPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
		.toString()
		.trim();
	const owner = await createOwnedExperimentRoot(input.outputDirectory, common);
	const root = input.outputDirectory;
	const startedAt = Date.now();
	const refsBefore = (
		await executeGit(input.projectPath, ["for-each-ref", "--format=%(refname)%09%(objectname)"])
	).toString();
	const worktreesBefore = (await executeGit(input.projectPath, ["worktree", "list", "--porcelain"])).toString();
	const baseCommit = (await executeGit(input.projectPath, ["rev-parse", `${input.baseRef}^{commit}`]))
		.toString()
		.trim();
	await writeFile(join(root, "source-refs-at-start.txt"), refsBefore, { mode: 0o600 });
	await writeFile(join(root, "source-worktree-identities-at-start.txt"), worktreesBefore, { mode: 0o600 });
	await writeDurableJson(join(root, "repository-backup-progress.json"), {
		status: "capturing",
		startedAt,
		baseCommit,
	});
	const protectedWorktrees = [];
	for (const [name, source] of [
		["base", input.projectPath],
		["experiment-task-f8bd4", input.taskWorktreePath],
	]) {
		const archive = join(root, `${name}-working-state`);
		const snapshot = await captureSourceGitWorkingState(source, archive);
		protectedWorktrees.push({
			name,
			sourcePath: source,
			headCommit: snapshot.headCommit,
			archiveRelativePath: `${name}-working-state`,
			snapshotManifestSha256: await fingerprintFile(join(archive, "git-working-state.json")),
			originalIndexSha256: snapshot.indexHash,
		});
	}
	const metadata = [];
	for (const path of [
		"config",
		"config.worktree",
		"HEAD",
		"packed-refs",
		"shallow",
		"description",
		"info",
		"hooks",
		"rr-cache",
		"logs",
	]) {
		const source = join(common, path);
		try {
			await lstat(source);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const target = join(root, "git-administrative-state", path);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await cp(source, target, { recursive: true, mode: constants.COPYFILE_FICLONE, dereference: false });
		metadata.push({ sourcePath: source, archivedRelativePath: `git-administrative-state/${path}` });
	}
	const globalConfig = process.env.HOME ? join(process.env.HOME, ".gitconfig") : null;
	if (globalConfig) {
		try {
			await cp(globalConfig, join(root, "global-git-configuration-at-start"), {
				mode: constants.COPYFILE_FICLONE,
				dereference: true,
			});
			metadata.push({ sourcePath: globalConfig, archivedRelativePath: "global-git-configuration-at-start" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	// Git 对象按固定 refs 与全部已登记 HEAD 归档；不进入其他任务的工作树或会话目录。
	const revisions = new Set([
		...refsBefore
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("\t")[1]),
		...worktreesBefore
			.split("\n")
			.filter((line) => line.startsWith("HEAD "))
			.map((line) => line.slice(5)),
	]);
	await executeGit(input.projectPath, ["pack-objects", "--stdout", "--revs", "--threads=1"], {
		input: `${[...revisions].join("\n")}\n`,
		outputPath: join(root, "all-recorded-refs-and-worktree-heads.pack"),
		timeoutMs: 300_000,
	});
	const cohort = z
		.object({
			baseCommit: z.string(),
			input: z.object({ tasks: z.array(z.object({ taskId: z.string(), worktreePath: z.string() })) }),
		})
		.parse(await readJson(join(input.sourceCohortDirectory, "reusable-cohort-backup-manifest.json")));
	const candidateDrift = [];
	for (const task of cohort.input.tasks) {
		try {
			await assertSourceGitWorkingStateMatchesSnapshot(
				task.worktreePath,
				join(input.sourceCohortDirectory, "tasks", task.taskId, "git-working-state"),
			);
			candidateDrift.push({ taskId: task.taskId, unchangedSinceCohortBackup: true });
		} catch (error) {
			// 当前快照单独保存，旧冻结输入继续保留；漂移不伪装成已验证候选。
			const archive = join(root, "changed-candidate-working-states", task.taskId);
			await captureSourceGitWorkingState(task.worktreePath, archive);
			candidateDrift.push({
				taskId: task.taskId,
				unchangedSinceCohortBackup: false,
				driftReason: String(error),
				currentSnapshotRelativePath: `changed-candidate-working-states/${task.taskId}`,
			});
		}
	}
	const refsAfter = (
		await executeGit(input.projectPath, ["for-each-ref", "--format=%(refname)%09%(objectname)"])
	).toString();
	const worktreesAfter = (await executeGit(input.projectPath, ["worktree", "list", "--porcelain"])).toString();
	if (refsAfter !== refsBefore || worktreesAfter !== worktreesBefore)
		throw new Error("采集期间 refs 或工作树身份发生变化，保留本次归档并建立新版本重试");
	for (const tree of protectedWorktrees) {
		await assertSourceGitWorkingStateMatchesSnapshot(tree.sourcePath, join(root, tree.archiveRelativePath));
		const restored = join(root, "independent-restoration-verification", tree.name);
		await materializeIndependentWorkingState(root, join(root, tree.archiveRelativePath), restored);
		await verifyMaterializedIndependentWorkingState(root, join(root, tree.archiveRelativePath), restored);
	}
	const verificationRepository = join(root, "independent-restoration-verification", "all-refs-mirror.git");
	await mkdir(verificationRepository);
	await executeGit(verificationRepository, ["init", "--bare", "--quiet"]);
	await executeGit(verificationRepository, ["index-pack", "--stdin"], {
		inputPath: join(root, "all-recorded-refs-and-worktree-heads.pack"),
		timeoutMs: 300_000,
	});
	await executeGit(verificationRepository, ["update-ref", "--stdin"], {
		input: `${refsBefore
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [ref, oid] = line.split("\t");
				return `update ${ref} ${oid}`;
			})
			.join("\n")}\n`,
	});
	const restoredRefs = (
		await executeGit(verificationRepository, ["for-each-ref", "--format=%(refname)%09%(objectname)"])
	).toString();
	if (restoredRefs !== refsBefore) throw new Error("独立镜像恢复后的完整 refs 不一致");
	const objectCheck = (
		await executeGit(verificationRepository, ["cat-file", "--batch-check"], {
			input: `${[...revisions].join("\n")}\n`,
		})
	).toString();
	if (objectCheck.includes(" missing")) throw new Error("独立镜像缺少已登记 HEAD 的对象");
	const manifest = {
		schemaVersion: 1,
		status: "current-repository-state-backed-up-and-restored",
		experimentId: owner.experimentId,
		startedAt,
		completedAt: Date.now(),
		baseRef: input.baseRef,
		baseCommit,
		previousCohortBaseCommit: cohort.baseCommit,
		baseCommitUnchangedSinceCohortBackup: baseCommit === cohort.baseCommit,
		protectedWorktrees,
		candidateDrift,
		metadata,
		recordedRefCount: refsBefore.split("\n").filter(Boolean).length,
		recordedObjectRootCount: revisions.size,
		refsSha256: fingerprint(refsBefore),
		worktreeIdentitiesSha256: fingerprint(worktreesBefore),
		objectPackSha256: await fingerprintFile(join(root, "all-recorded-refs-and-worktree-heads.pack")),
		productionRefsAndWorkingStatesUnchangedDuringCapture: true,
		scope: "全仓 refs 和登记 HEAD 的对象闭包、Git 管理状态、主工作区与本任务 WIP；原批次候选检查漂移并保存变化。其他任务工作树不作为实验输入，d55ee 工作树及会话不采集。",
	};
	await writeDurableJson(join(root, "current-repository-state-backup-manifest.json"), manifest);
	await writeDurableJson(join(root, "repository-backup-progress.json"), {
		status: manifest.status,
		completedAt: manifest.completedAt,
	});
	return manifest;
}
