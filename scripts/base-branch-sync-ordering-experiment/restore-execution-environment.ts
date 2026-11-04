import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { fingerprint } from "./experiment-contract";
import {
	captureExternalPackageNodeDependencyResolutionBindings,
	externalPackageNodeDependencyResolutionBindingSchema,
	readDeclaredExternalPackageDependencies,
} from "./external-package-node-dependency-resolution-bindings";
import {
	assertOwnedExperimentRoot,
	createPrivateDirectory,
	fingerprintFile,
	isWithin,
	readJson,
	safeEntryPath,
	writeDurableJson,
} from "./persistent-experiment-storage";

const environmentManifestSchema = z.object({
	directories: z.array(z.object({ sourcePath: z.string(), destinationName: z.string().regex(/^[a-z0-9-]+$/u) })),
	executables: z.array(
		z.object({ sourcePath: z.string(), destinationName: z.string().regex(/^[a-z0-9.-]+$/u), sha256: z.string() }),
	),
	externalPackageNodeDependencyResolutionBindings: z
		.array(externalPackageNodeDependencyResolutionBindingSchema)
		.optional(),
});
const installationIndexSchema = z.object({
	files: z.array(
		z.object({
			path: z.string(),
			kind: z.enum(["file", "symlink"]),
			sha256: z.string().optional(),
			archivedRelativePath: z.string().optional(),
			linkTarget: z.string().optional(),
			mode: z.number(),
		}),
	),
});

type ArchivedDependencyInstallationSourceIndex = z.infer<typeof installationIndexSchema> & { sourcePath: string };

function indexArchivedPackageManifests(installations: ArchivedDependencyInstallationSourceIndex[]) {
	const manifests = new Map<string, ArchivedDependencyInstallationSourceIndex["files"][number]>();
	for (const installation of installations)
		for (const file of installation.files) {
			if (file.kind !== "file" || (file.path !== "package.json" && !file.path.endsWith("/package.json"))) continue;
			const path = join(installation.sourcePath, file.path);
			if (manifests.has(path) && manifests.get(path)?.sha256 !== file.sha256)
				throw new Error("同一物理包的归档清单不唯一");
			manifests.set(path, file);
		}
	return manifests;
}

async function verifyCurrentPackageContentMatchesArchive(
	packageRoot: string,
	installations: ArchivedDependencyInstallationSourceIndex[],
) {
	const expectedFiles = new Map<string, ArchivedDependencyInstallationSourceIndex["files"][number]>();
	for (const installation of installations)
		for (const file of installation.files) {
			const path = join(installation.sourcePath, file.path);
			if (isWithin(packageRoot, path)) expectedFiles.set(relative(packageRoot, path), file);
		}
	let observedFileCount = 0;
	const verifyDirectory = async (directory: string) => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await verifyDirectory(path);
				continue;
			}
			const expected = expectedFiles.get(relative(packageRoot, path));
			if (
				!expected ||
				((await lstat(path)).mode & 0o777) !== (expected.mode & 0o777) ||
				(expected.kind === "file"
					? !entry.isFile() || (await fingerprintFile(path)) !== expected.sha256
					: !entry.isSymbolicLink() || (await readlink(path)) !== expected.linkTarget)
			)
				throw new Error("当前来源依赖与归档内容不一致，不能补证旧解析关系");
			observedFileCount++;
		}
	};
	await verifyDirectory(packageRoot);
	if (observedFileCount !== expectedFiles.size) throw new Error("当前来源依赖缺少归档文件，解析关系仍未知");
}

async function restoreIndependentFile(source: string, destination: string, expectedSha256: string, mode: number) {
	try {
		await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const destinationStat = await lstat(destination);
	if (!destinationStat.isFile() || destinationStat.nlink !== 1)
		throw new Error("独立依赖副本必须是无硬链接的普通文件");
	const descriptor = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const verifiedStat = await descriptor.stat();
		const sourceStat = await lstat(source);
		if (
			!verifiedStat.isFile() ||
			verifiedStat.nlink !== 1 ||
			verifiedStat.dev !== destinationStat.dev ||
			verifiedStat.ino !== destinationStat.ino ||
			(verifiedStat.dev === sourceStat.dev && verifiedStat.ino === sourceStat.ino)
		)
			throw new Error("独立依赖副本的 inode 验证失败");
		const digest = createHash("sha256");
		for await (const chunk of descriptor.createReadStream({ autoClose: false })) digest.update(chunk);
		if (digest.digest("hex") !== expectedSha256) throw new Error("独立依赖副本的字节验证失败");
		await descriptor.chmod(mode);
	} finally {
		await descriptor.close();
	}
}

export async function restoreExecutionEnvironmentIntoPrivateDirectories(
	root: string,
	target: string,
	sourceArchiveExperimentRootDirectory = root,
	supplementalExternalPackageNodeResolutionEvidence?: { path: string; expectedSha256: string },
) {
	const targetOwnership = await assertOwnedExperimentRoot(root, target);
	const archive = join(sourceArchiveExperimentRootDirectory, "execution-environment");
	const sourceOwnership = await assertOwnedExperimentRoot(sourceArchiveExperimentRootDirectory, archive);
	if (sourceOwnership.sourceCommonDirectory !== targetOwnership.sourceCommonDirectory)
		throw new Error("依赖归档与目标实验不属于同一来源仓库");
	if (isWithin(archive, target) || isWithin(target, archive)) throw new Error("私有安装不能覆盖依赖归档");
	const sourceManifestPath = join(archive, "execution-environment-backup-manifest.json");
	const sourceManifestSha256 = await fingerprintFile(sourceManifestPath);
	const manifest = environmentManifestSchema.parse(await readJson(sourceManifestPath));
	const installations = await Promise.all(
		manifest.directories.map(async (directory) => ({
			...directory,
			privateDirectory: join(
				target,
				directory.destinationName,
				...(basename(directory.sourcePath) === "node_modules" ? ["node_modules"] : []),
			),
			...installationIndexSchema.parse(await readJson(join(archive, `${directory.destinationName}-manifest.json`))),
			sourceInstallationManifestSha256: await fingerprintFile(
				join(archive, `${directory.destinationName}-manifest.json`),
			),
		})),
	);
	let resolutionBindings = manifest.externalPackageNodeDependencyResolutionBindings ?? [];
	if (supplementalExternalPackageNodeResolutionEvidence) {
		await assertOwnedExperimentRoot(root, supplementalExternalPackageNodeResolutionEvidence.path);
		const evidenceText = await readFile(supplementalExternalPackageNodeResolutionEvidence.path, "utf8");
		if (fingerprint(evidenceText) !== supplementalExternalPackageNodeResolutionEvidence.expectedSha256)
			throw new Error("外部包依赖解析补充原件摘要变化");
		const evidence = z
			.object({
				sourceManifestSha256: z.literal(sourceManifestSha256),
				sourceInstallationManifestSha256s: z.record(z.string(), z.string()),
				bindings: z.array(externalPackageNodeDependencyResolutionBindingSchema),
			})
			.parse(JSON.parse(evidenceText));
		if (
			installations.some(
				(installation) =>
					evidence.sourceInstallationManifestSha256s[installation.destinationName] !==
					installation.sourceInstallationManifestSha256,
			)
		)
			throw new Error("补充解析绑定不属于该旧归档的完整安装索引");
		resolutionBindings = [...resolutionBindings, ...evidence.bindings];
	}
	const mapping = (source: string) => {
		const directory = [...installations]
			.sort((left, right) => right.sourcePath.length - left.sourcePath.length)
			.find((item) => isWithin(item.sourcePath, source));
		if (directory) return join(directory.privateDirectory, relative(directory.sourcePath, source));
		const executable = manifest.executables.find((item) => item.sourcePath === source);
		if (executable) return join(target, "executables", executable.destinationName);
		throw new Error(`依赖链接尚无独立归档：${source}`);
	};
	const links = installations.flatMap((installation) =>
		installation.files
			.filter((file) => file.kind === "symlink")
			.map((file) => {
				if (!file.linkTarget) throw new Error("归档链接缺少目标文本");
				const originalTarget = resolve(dirname(join(installation.sourcePath, file.path)), file.linkTarget);
				return {
					sourcePath: join(installation.sourcePath, file.path),
					privateInstallationDirectory: installation.privateDirectory,
					path: file.path,
					originalTarget,
					privateTarget: mapping(originalTarget),
				};
			}),
	);
	const archivedPackageManifests = indexArchivedPackageManifests(installations);
	const archivedLinks = [...links].sort((left, right) => left.sourcePath.length - right.sourcePath.length);
	const resolveArchivedLinkedPath = (sourcePath: string) => {
		let path = sourcePath;
		for (let remainingLinks = 40; remainingLinks > 0; remainingLinks--) {
			const ancestor = archivedLinks.find((link) => isWithin(link.sourcePath, path));
			if (!ancestor) return path;
			path = join(ancestor.originalTarget, relative(ancestor.sourcePath, path));
		}
		throw new Error("归档依赖链接循环或超过有界解析次数");
	};
	const verifiedResolutionBindings: (z.infer<typeof externalPackageNodeDependencyResolutionBindingSchema> & {
		privatePackageRootDirectory?: string;
		privateDependencyPackageRootDirectory?: string;
	})[] = [];
	for (const installation of installations) {
		if (basename(installation.sourcePath) === "node_modules") continue;
		const packageManifest = installation.files.find((file) => file.path === "package.json" && file.kind === "file");
		if (!packageManifest) continue;
		const manifestText = await readFile(
			await safeEntryPath(
				archive,
				packageManifest.archivedRelativePath ?? join(installation.destinationName, "package.json"),
			),
			"utf8",
		);
		if (fingerprint(manifestText) !== packageManifest.sha256) throw new Error("外部包归档清单字节变化");
		for (const dependency of readDeclaredExternalPackageDependencies(manifestText)) {
			const matchingBindings = resolutionBindings.filter(
				(binding) =>
					binding.sourcePackageRootDirectory === installation.sourcePath &&
					binding.dependencyPackageName === dependency.dependencyPackageName,
			);
			const binding = matchingBindings[0];
			if (
				matchingBindings.length !== 1 ||
				binding.sourcePackageManifestSha256 !== packageManifest.sha256 ||
				binding.optional !== dependency.optional
			)
				throw new Error(
					`外部包依赖解析关系未知或不唯一；需要同源补证：${installation.sourcePath} -> ${dependency.dependencyPackageName}`,
				);
			if (!binding.resolvedDependencyPackageRootDirectory || !binding.resolvedDependencyPackageManifestSha256) {
				if (
					binding.optional &&
					binding.resolutionStatus === "not-installed" &&
					binding.resolvedDependencyPackageRootDirectory === null &&
					binding.resolvedDependencyPackageManifestSha256 === null
				) {
					verifiedResolutionBindings.push(binding);
					continue;
				}
				throw new Error(`外部包依赖解析仍未知：${dependency.dependencyPackageName}`);
			}
			if (binding.resolutionStatus !== "resolved") throw new Error("外部包解析状态与目标证据不一致");
			const dependencyManifestPath = join(binding.resolvedDependencyPackageRootDirectory, "package.json");
			const archivedDependency = archivedPackageManifests.get(dependencyManifestPath);
			if (!archivedDependency || archivedDependency.sha256 !== binding.resolvedDependencyPackageManifestSha256)
				throw new Error("外部包解析目标未被同源归档精确保存");
			const privateTarget = mapping(binding.resolvedDependencyPackageRootDirectory);
			const sourceLookupPath = resolveArchivedLinkedPath(
				join(installation.sourcePath, "node_modules", dependency.dependencyPackageName),
			);
			if (!archivedPackageManifests.has(join(sourceLookupPath, "package.json"))) {
				const privateLookupPath = mapping(sourceLookupPath);
				const lookupInstallation = [...installations]
					.sort((left, right) => right.privateDirectory.length - left.privateDirectory.length)
					.find((candidate) => isWithin(candidate.privateDirectory, privateLookupPath));
				if (!lookupInstallation) throw new Error("外部包解析补充链接缺少精确私有安装归属");
				links.push({
					sourcePath: sourceLookupPath,
					privateInstallationDirectory: lookupInstallation.privateDirectory,
					path: relative(lookupInstallation.privateDirectory, privateLookupPath),
					originalTarget: binding.resolvedDependencyPackageRootDirectory,
					privateTarget,
				});
			}
			verifiedResolutionBindings.push({
				...binding,
				privatePackageRootDirectory: installation.privateDirectory,
				privateDependencyPackageRootDirectory: privateTarget,
			});
		}
	}
	if (verifiedResolutionBindings.length !== resolutionBindings.length)
		throw new Error("外部包解析绑定含未登记或重复条目");
	const targetsByPrivateLinkPath = new Map<string, string>();
	for (const link of links) {
		const destination = join(link.privateInstallationDirectory, link.path);
		if (targetsByPrivateLinkPath.has(destination) && targetsByPrivateLinkPath.get(destination) !== link.privateTarget)
			throw new Error("同一私有依赖链接具有冲突解析目标，不能合并恢复");
		targetsByPrivateLinkPath.set(destination, link.privateTarget);
	}
	await mkdir(target, { recursive: true, mode: 0o700 });
	for (const installation of installations) {
		const directory = installation.privateDirectory;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		for (const file of installation.files.filter((file) => file.kind === "file")) {
			const destination = await safeEntryPath(directory, file.path);
			const source = await safeEntryPath(
				archive,
				file.archivedRelativePath ?? join(installation.destinationName, file.path),
			);
			await mkdir(dirname(destination), { recursive: true });
			await restoreIndependentFile(source, destination, z.string().parse(file.sha256), file.mode & 0o777);
		}
	}
	await createPrivateDirectory(join(target, "executables"));
	for (const executable of manifest.executables) {
		const destination = await safeEntryPath(target, join("executables", executable.destinationName));
		await restoreIndependentFile(join(archive, executable.destinationName), destination, executable.sha256, 0o700);
	}
	for (const link of links) {
		const destination = await safeEntryPath(link.privateInstallationDirectory, link.path);
		await mkdir(dirname(destination), { recursive: true });
		const targetText = relative(dirname(destination), link.privateTarget);
		try {
			await symlink(targetText, destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if ((await readlink(destination)) !== targetText) throw new Error("依赖链接未正确映射到私有副本");
	}
	for (const binding of verifiedResolutionBindings) {
		if (!binding.privatePackageRootDirectory || !binding.privateDependencyPackageRootDirectory) continue;
		const resolvedManifestPath = await realpath(
			join(binding.privatePackageRootDirectory, "node_modules", binding.dependencyPackageName, "package.json"),
		);
		if (resolvedManifestPath !== join(binding.privateDependencyPackageRootDirectory, "package.json"))
			throw new Error("恢复后的外部包依赖解析不匹配冻结物理目标");
	}
	const result = {
		status: "restored",
		sourceArchiveExperimentRootDirectory: resolve(sourceArchiveExperimentRootDirectory),
		sourceManifestSha256,
		sourceInstallationManifestSha256s: Object.fromEntries(
			installations.map((installation) => [
				installation.destinationName,
				installation.sourceInstallationManifestSha256,
			]),
		),
		supplementalExternalPackageNodeResolutionEvidence: supplementalExternalPackageNodeResolutionEvidence ?? null,
		externalPackageNodeDependencyResolutionBindings: verifiedResolutionBindings,
		externalPackageNodeDependencyResolutionBindingsSha256: fingerprint(JSON.stringify(verifiedResolutionBindings)),
		targetExperimentRootDirectory: resolve(root),
		directoryCount: installations.length,
		mappedSymlinkCount: links.length,
		allSymlinksTargetPrivateDirectories: links.every((link) => isWithin(target, link.privateTarget)),
		writableHardLinksToBackupOrProduction: false,
		installations: installations.map(({ sourcePath, privateDirectory }) => ({ sourcePath, privateDirectory })),
		links,
	};
	if ((await fingerprintFile(sourceManifestPath)) !== sourceManifestSha256)
		throw new Error("依赖恢复期间归档清单发生变化");
	for (const installation of installations)
		if (
			(await fingerprintFile(join(archive, `${installation.destinationName}-manifest.json`))) !==
			installation.sourceInstallationManifestSha256
		)
			throw new Error("依赖恢复期间归档安装索引发生变化");
	await writeDurableJson(join(target, "private-environment-restoration-verification.json"), result);
	return { directoryCount: result.directoryCount, mappedSymlinkCount: result.mappedSymlinkCount };
}

/** 旧归档只补写独立证据；来源与归档的包清单逐字相符后才采集当前默认 Node 搜索关系。 */
export async function captureSupplementalExternalPackageNodeResolutionEvidence(
	root: string,
	sourceArchiveExperimentRootDirectory: string,
	evidencePath: string,
) {
	const targetOwnership = await assertOwnedExperimentRoot(root, evidencePath);
	const archive = join(sourceArchiveExperimentRootDirectory, "execution-environment");
	const sourceOwnership = await assertOwnedExperimentRoot(sourceArchiveExperimentRootDirectory, archive);
	if (
		targetOwnership.sourceCommonDirectory !== sourceOwnership.sourceCommonDirectory ||
		isWithin(archive, evidencePath)
	)
		throw new Error("补充解析证据必须写入同源 owned root，不能改写归档");
	const manifestPath = join(archive, "execution-environment-backup-manifest.json");
	const sourceManifestSha256 = await fingerprintFile(manifestPath);
	const manifest = environmentManifestSchema.parse(await readJson(manifestPath));
	const installations = await Promise.all(
		manifest.directories.map(async (directory) => {
			const indexPath = join(archive, `${directory.destinationName}-manifest.json`);
			const index = installationIndexSchema.parse(await readJson(indexPath));
			return {
				...directory,
				packageManifestSha256: index.files.find((file) => file.path === "package.json" && file.kind === "file")
					?.sha256,
				...index,
				indexSha256: await fingerprintFile(indexPath),
			};
		}),
	);
	const alreadyBoundPackageRoots = new Set(
		(manifest.externalPackageNodeDependencyResolutionBindings ?? []).map(
			(binding) => binding.sourcePackageRootDirectory,
		),
	);
	const bindings = await captureExternalPackageNodeDependencyResolutionBindings(
		installations.filter((installation) => !alreadyBoundPackageRoots.has(installation.sourcePath)),
	);
	const archivedPackageManifests = indexArchivedPackageManifests(installations);
	const sourcePackageRoots = new Set(bindings.map((binding) => binding.sourcePackageRootDirectory));
	for (const binding of bindings) {
		if (!binding.resolvedDependencyPackageRootDirectory) continue;
		const archivedManifest = archivedPackageManifests.get(
			join(binding.resolvedDependencyPackageRootDirectory, "package.json"),
		);
		if (!archivedManifest || archivedManifest.sha256 !== binding.resolvedDependencyPackageManifestSha256)
			throw new Error("当前来源依赖与归档内容不一致，不能补证旧解析关系");
		sourcePackageRoots.add(binding.resolvedDependencyPackageRootDirectory);
	}
	for (const sourcePackageRoot of sourcePackageRoots)
		await verifyCurrentPackageContentMatchesArchive(sourcePackageRoot, installations);
	if ((await fingerprintFile(manifestPath)) !== sourceManifestSha256) throw new Error("补证期间来源归档变化");
	for (const installation of installations)
		if (
			(await fingerprintFile(join(archive, `${installation.destinationName}-manifest.json`))) !==
			installation.indexSha256
		)
			throw new Error("补证期间归档安装索引变化");
	await writeDurableJson(evidencePath, {
		schemaVersion: 1,
		sourceManifestSha256,
		sourceInstallationManifestSha256s: Object.fromEntries(
			installations.map((installation) => [installation.destinationName, installation.indexSha256]),
		),
		bindings,
	});
	return { path: evidencePath, expectedSha256: await fingerprintFile(evidencePath) };
}
