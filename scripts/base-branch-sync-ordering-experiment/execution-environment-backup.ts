import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
	captureExternalPackageNodeDependencyResolutionBindings,
	externalPackageNodeDependencyResolutionBindingSchema,
} from "./external-package-node-dependency-resolution-bindings";
import {
	assertOwnedExperimentRoot,
	fingerprintFile,
	isWithin,
	readJson,
	writeDurableJson,
} from "./persistent-experiment-storage";

export const environmentBackupInputSchema = z.object({
	schemaVersion: z.literal(1),
	directories: z.array(z.object({ sourcePath: z.string(), destinationName: z.string().regex(/^[a-z0-9-]+$/u) })),
	executables: z.array(z.object({ sourcePath: z.string(), destinationName: z.string().regex(/^[a-z0-9.-]+$/u) })),
});

interface EnvironmentFile {
	path: string;
	kind: "file" | "symlink";
	sha256?: string;
	linkTarget?: string;
	mode: number;
	byteLength: number;
	archivedRelativePath?: string;
}

/** 任务各自的安装目录按内容去重保存；恢复时复制到私有目录，不能把对象库作为可写安装目录。 */
export async function appendTaskDependencyEnvironmentBackups(root: string, sourceBindingsPath: string) {
	await assertOwnedExperimentRoot(root, join(root, "execution-environment"));
	const bindings = z.record(z.string(), z.array(z.string())).parse(await readJson(sourceBindingsPath));
	const directory = join(root, "execution-environment");
	const manifest = z
		.object({
			directories: z.array(z.object({ sourcePath: z.string(), destinationName: z.string(), fileCount: z.number() })),
			outsideSymlinks: z.array(z.object({ sourcePath: z.string(), target: z.string() })),
			externalPackageNodeDependencyResolutionBindings: z
				.array(externalPackageNodeDependencyResolutionBindingSchema)
				.optional(),
		})
		.passthrough()
		.parse(await readJson(join(directory, "execution-environment-backup-manifest.json")));
	const storedContent = new Map<string, string>();
	for (const source of manifest.directories) {
		const index = z
			.object({
				files: z.array(
					z.object({
						path: z.string(),
						sha256: z.string().optional(),
						archivedRelativePath: z.string().optional(),
					}),
				),
			})
			.parse(await readJson(join(directory, `${source.destinationName}-manifest.json`)));
		for (const file of index.files)
			if (file.sha256)
				storedContent.set(file.sha256, file.archivedRelativePath ?? join(source.destinationName, file.path));
	}
	let newObjectCount = 0;
	const newlyArchivedPackageSources: { sourcePath: string; packageManifestSha256?: string }[] = [];
	for (const [sourceRoot, taskBindings] of Object.entries(bindings)) {
		if (manifest.directories.some((item) => item.sourcePath === sourceRoot)) continue;
		const destinationName = `task-${taskBindings[0].replace(/[^a-z0-9-]/gu, "-")}`;
		const files: EnvironmentFile[] = [];
		const collect = async (path: string) => {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				const source = join(path, entry.name);
				const before = await lstat(source);
				if (entry.isDirectory()) {
					await collect(source);
					continue;
				}
				if (entry.isSymbolicLink()) {
					const linkTarget = await readlink(source);
					if (!isWithin(sourceRoot, resolve(dirname(source), linkTarget)))
						manifest.outsideSymlinks.push({ sourcePath: source, target: linkTarget });
					files.push({
						path: relative(sourceRoot, source),
						kind: "symlink",
						linkTarget,
						mode: before.mode,
						byteLength: before.size,
					});
				} else if (entry.isFile()) {
					const sha256 = await fingerprintFile(source);
					let archivedRelativePath = storedContent.get(sha256);
					if (!archivedRelativePath) {
						archivedRelativePath = join("task-dependency-content-objects", sha256);
						await mkdir(dirname(join(directory, archivedRelativePath)), { recursive: true, mode: 0o700 });
						try {
							await copyFile(
								source,
								join(directory, archivedRelativePath),
								constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
							);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						}
						await chmod(join(directory, archivedRelativePath), 0o600);
						if ((await fingerprintFile(join(directory, archivedRelativePath))) !== sha256)
							throw new Error("任务依赖对象归档不一致");
						storedContent.set(sha256, archivedRelativePath);
						newObjectCount++;
					}
					const after = await lstat(source);
					if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
						throw new Error("任务依赖采集期间发生变化");
					files.push({
						path: relative(sourceRoot, source),
						kind: "file",
						sha256,
						archivedRelativePath,
						mode: before.mode,
						byteLength: before.size,
					});
				} else throw new Error("任务依赖包含特殊文件");
			}
		};
		await collect(sourceRoot);
		await writeDurableJson(join(directory, `${destinationName}-manifest.json`), {
			sourcePath: sourceRoot,
			files,
			taskBindings,
			storageFormat: "content-addressed-files-v1",
		});
		manifest.directories.push({ sourcePath: sourceRoot, destinationName, fileCount: files.length });
		manifest.status = manifest.outsideSymlinks.length ? "external-symlink-mapping-required" : "backed-up";
		manifest.taskDependencyBindings = bindings;
		newlyArchivedPackageSources.push({
			sourcePath: sourceRoot,
			packageManifestSha256: files.find((file) => file.path === "package.json")?.sha256,
		});
		await writeDurableJson(join(directory, "execution-environment-backup-manifest.json"), manifest);
	}
	if (newlyArchivedPackageSources.length) {
		manifest.externalPackageNodeDependencyResolutionBindings = [
			...(manifest.externalPackageNodeDependencyResolutionBindings ?? []),
			...(await captureExternalPackageNodeDependencyResolutionBindings(newlyArchivedPackageSources)),
		];
		await writeDurableJson(join(directory, "execution-environment-backup-manifest.json"), manifest);
	}
	return {
		directoryCount: manifest.directories.length,
		newObjectCount,
		outsideSymlinkCount: manifest.outsideSymlinks.length,
	};
}

export async function backupExecutionEnvironment(inputPath: string, root: string) {
	await assertOwnedExperimentRoot(root, join(root, "execution-environment"));
	const input = environmentBackupInputSchema.parse(await readJson(inputPath));
	const destination = join(root, "execution-environment");
	await mkdir(destination, { mode: 0o700 });
	const startedAt = Date.now();
	const directories: { sourcePath: string; destinationName: string; files: EnvironmentFile[] }[] = [];
	const outsideSymlinks: { sourcePath: string; target: string }[] = [];
	const copyDirectory = async (
		sourceRoot: string,
		sourceDirectory: string,
		targetDirectory: string,
		files: EnvironmentFile[],
	) => {
		await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
		for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
			const source = join(sourceDirectory, entry.name);
			const target = join(targetDirectory, entry.name);
			const before = await lstat(source);
			if (entry.isDirectory()) await copyDirectory(sourceRoot, source, target, files);
			else if (entry.isSymbolicLink()) {
				const linkTarget = await readlink(source);
				if (!isWithin(sourceRoot, resolve(dirname(source), linkTarget)))
					outsideSymlinks.push({ sourcePath: source, target: linkTarget });
				await symlink(linkTarget, target);
				files.push({
					path: relative(sourceRoot, source),
					kind: "symlink",
					linkTarget,
					mode: before.mode,
					byteLength: before.size,
				});
			} else if (entry.isFile()) {
				await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
				const sha256 = await fingerprintFile(target);
				const after = await lstat(source);
				if (
					before.size !== after.size ||
					before.mtimeMs !== after.mtimeMs ||
					(await fingerprintFile(source)) !== sha256
				)
					throw new Error(`依赖归档期间来源变化：${source}`);
				if (before.ino === (await lstat(target)).ino) throw new Error("依赖副本不能与生产文件共享可写 inode");
				files.push({
					path: relative(sourceRoot, source),
					kind: "file",
					sha256,
					mode: before.mode,
					byteLength: before.size,
				});
			} else throw new Error(`依赖目录包含特殊文件：${source}`);
		}
	};
	for (const directory of input.directories) {
		const sourcePath = await realpath(directory.sourcePath);
		const files: EnvironmentFile[] = [];
		await copyDirectory(sourcePath, sourcePath, join(destination, directory.destinationName), files);
		directories.push({ sourcePath, destinationName: directory.destinationName, files });
		await writeDurableJson(join(destination, `${directory.destinationName}-manifest.json`), { sourcePath, files });
	}
	const executables = [];
	for (const executable of input.executables) {
		const sourcePath = await realpath(executable.sourcePath);
		const target = join(destination, executable.destinationName);
		await copyFile(sourcePath, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
		await chmod(target, 0o700);
		executables.push({ ...executable, sourcePath, sha256: await fingerprintFile(target) });
	}
	await writeDurableJson(join(destination, "execution-environment-backup-manifest.json"), {
		schemaVersion: 1,
		startedAt,
		completedAt: Date.now(),
		status: outsideSymlinks.length ? "external-symlink-mapping-required" : "backed-up",
		directories: directories.map(({ sourcePath, destinationName, files }) => ({
			sourcePath,
			destinationName,
			fileCount: files.length,
		})),
		executables,
		outsideSymlinks,
		fileCopyMethod: "COPYFILE_FICLONE 优先；无可写硬链接；逐文件 SHA-256 比对",
		externalPackageNodeDependencyResolutionBindings: await captureExternalPackageNodeDependencyResolutionBindings(
			directories.map((installation) => ({
				...installation,
				packageManifestSha256: installation.files.find((file) => file.path === "package.json")?.sha256,
			})),
		),
	});
	return { fileCount: directories.reduce((count, directory) => count + directory.files.length, 0), outsideSymlinks };
}
