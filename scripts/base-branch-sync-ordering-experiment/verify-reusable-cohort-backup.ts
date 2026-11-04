import { copyFile, lstat, mkdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readSourceGitWorkingStateSnapshot } from "../../src/independent-task-creation/git-working-state-snapshot";
import { taskIdSchema } from "./experiment-contract";
import {
	materializeIndependentWorkingState,
	verifyMaterializedIndependentWorkingState,
} from "./frozen-source-snapshot";
import {
	assertIndependentGitRepository,
	assertOwnedExperimentRoot,
	executeGit,
	fingerprintFile,
	isolatedProcessEnvironment,
	readJson,
	safeEntryPath,
	writeDurableJson,
} from "./persistent-experiment-storage";

const backupManifestSchema = z.object({
	experimentId: z.string(),
	baseCommit: z.string(),
	files: z.array(z.object({ archivedRelativePath: z.string(), sha256: z.string() })),
	taskResults: z.array(z.object({ taskId: taskIdSchema, headCommit: z.string(), restoredTree: z.string() })),
	gitObjects: z.object({ objectPackSha256: z.string() }),
});

export async function verifyReusableTaskCohortBackup(root: string) {
	const marker = await assertOwnedExperimentRoot(root, join(root, "offline-restoration-validation"));
	const manifest = backupManifestSchema.parse(await readJson(join(root, "reusable-cohort-backup-manifest.json")));
	if (marker.experimentId !== manifest.experimentId) throw new Error("备份身份与归档不一致");
	let verifiedFileCount = 0;
	for (const file of manifest.files) {
		if ((await fingerprintFile(await safeEntryPath(root, file.archivedRelativePath))) !== file.sha256)
			throw new Error(`备份附件损坏：${file.archivedRelativePath}`);
		verifiedFileCount++;
	}
	try {
		const supplement = z
			.object({ files: z.array(z.object({ archivedRelativePath: z.string(), sha256: z.string() })) })
			.parse(await readJson(join(root, "cohort-supplemental-evidence-manifest.json")));
		for (const file of supplement.files) {
			if ((await fingerprintFile(await safeEntryPath(root, file.archivedRelativePath))) !== file.sha256)
				throw new Error("补充原件归档损坏");
			verifiedFileCount++;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (
		(await fingerprintFile(join(root, "base-and-reviewed-candidate-objects.pack"))) !==
		manifest.gitObjects.objectPackSha256
	)
		throw new Error("base 与评审对象包损坏");
	const baseTarget = join(root, "offline-restoration-validation", "preserved-base-worktree");
	try {
		await lstat(join(baseTarget, ".git"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await materializeIndependentWorkingState(root, join(root, "base-working-state"), baseTarget);
	}
	await verifyMaterializedIndependentWorkingState(root, join(root, "base-working-state"), baseTarget);
	const restoredTasks = [];
	for (const task of manifest.taskResults) {
		const archive = join(root, "tasks", task.taskId, "git-working-state");
		const snapshot = await readSourceGitWorkingStateSnapshot(archive);
		if (
			snapshot.headCommit !== task.headCommit ||
			(await fingerprintFile(join(archive, "source-git-objects.pack"))) !== snapshot.objectPackHash
		)
			throw new Error("任务对象包或 HEAD 损坏");
		const target = join(root, "offline-restoration-validation", task.taskId);
		try {
			await lstat(join(target, ".git"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await materializeIndependentWorkingState(root, archive, target);
		}
		await verifyMaterializedIndependentWorkingState(root, archive, target);
		const common = await assertIndependentGitRepository(root, target);
		const temporaryIndex = join(common, "verification-index");
		await copyFile(join(common, "index"), temporaryIndex);
		const environment = {
			...isolatedProcessEnvironment(
				join(root, "offline-verification-home"),
				join(root, "offline-verification-temporary-files"),
			),
			GIT_INDEX_FILE: temporaryIndex,
		};
		await executeGit(target, ["add", "--all", "--", "."], { environment });
		const tree = (await executeGit(target, ["write-tree"], { environment })).toString().trim();
		if (tree !== task.restoredTree) throw new Error(`完整源码树恢复不一致：${task.taskId}`);
		await verifyMaterializedIndependentWorkingState(root, archive, target);
		restoredTasks.push({
			taskId: task.taskId,
			headCommit: task.headCommit,
			tree,
			pathCount: snapshot.entries.length,
			originalIndexBytesVerified: true,
		});
	}
	const dependencyManifest = z
		.object({
			directories: z.array(z.object({ destinationName: z.string() })),
			executables: z.array(z.object({ destinationName: z.string(), sha256: z.string() })),
		})
		.parse(await readJson(join(root, "execution-environment", "execution-environment-backup-manifest.json")));
	for (const directory of dependencyManifest.directories) {
		const index = z
			.object({
				storageFormat: z.string().optional(),
				files: z.array(
					z.object({
						path: z.string(),
						kind: z.string(),
						sha256: z.string().optional(),
						linkTarget: z.string().optional(),
						archivedRelativePath: z.string().optional(),
					}),
				),
			})
			.parse(await readJson(join(root, "execution-environment", `${directory.destinationName}-manifest.json`)));
		for (const file of index.files) {
			const path = file.archivedRelativePath
				? await safeEntryPath(join(root, "execution-environment"), file.archivedRelativePath)
				: await safeEntryPath(join(root, "execution-environment", directory.destinationName), file.path);
			if (file.kind === "file" && (await fingerprintFile(path)) !== file.sha256)
				throw new Error("依赖归档哈希不一致");
			if (
				file.kind === "symlink" &&
				index.storageFormat !== "content-addressed-files-v1" &&
				(await readlink(path)) !== file.linkTarget
			)
				throw new Error("依赖符号链接归档不一致");
			verifiedFileCount++;
		}
	}
	for (const executable of dependencyManifest.executables)
		if (
			(await fingerprintFile(join(root, "execution-environment", executable.destinationName))) !== executable.sha256
		)
			throw new Error("执行二进制归档不一致");
	const result = {
		status: "verified",
		verifiedAt: Date.now(),
		experimentId: manifest.experimentId,
		verifiedFileCount,
		baseWorkingStateRestored: true,
		restoredTasks,
	};
	await mkdir(join(root, "offline-verification-home"), { recursive: true, mode: 0o700 });
	await writeDurableJson(join(root, "cohort-backup-integrity-and-offline-restoration-verification.json"), result);
	return result;
}
