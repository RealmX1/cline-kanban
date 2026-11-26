import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function localDeploymentGlobalCliLinkMatchesPublishedEntrypoint(
	deploymentNodeBinaryPath: string,
	distributionDirectoryPath: string,
): Promise<boolean> {
	const expectedEntrypoint = await realpath(join(distributionDirectoryPath, "cli.js"));
	const globalCli = join(dirname(deploymentNodeBinaryPath), "kanban");
	try {
		if ((await realpath(globalCli)) !== expectedEntrypoint) return false;
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP"))
			return false;
		throw error;
	}
	return localDeploymentPublishedCliEntrypointIsExecutable(distributionDirectoryPath);
}

export async function localDeploymentPublishedCliEntrypointIsExecutable(
	distributionDirectoryPath: string,
): Promise<boolean> {
	try {
		await access(join(distributionDirectoryPath, "cli.js"), constants.X_OK);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "ENOENT"))
			return false;
		throw error;
	}
}

export async function fingerprintLocalDeploymentDistribution(directory: string) {
	const root = await realpath(directory);
	const files: Array<{ relativeFilePath: string; sha256: string }> = [];
	async function visit(path: string, prefix: string): Promise<void> {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const relativeFilePath = `${prefix}${entry.name}`;
			if (entry.isDirectory()) await visit(join(path, entry.name), `${relativeFilePath}/`);
			else if (entry.isFile())
				files.push({
					relativeFilePath,
					sha256: createHash("sha256")
						.update(await readFile(join(path, entry.name)))
						.digest("hex"),
				});
			else throw new Error(`候选产物包含软链接或非普通文件：${relativeFilePath}`);
		}
	}
	await visit(root, "");
	if (files.length === 0) throw new Error("候选产物为空，不能绑定部署摘要");
	files.sort((left, right) =>
		left.relativeFilePath < right.relativeFilePath ? -1 : left.relativeFilePath > right.relativeFilePath ? 1 : 0,
	);
	return {
		distributionDirectoryPath: root,
		candidateDistributionSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
		files,
	};
}

export async function verifyLocalDeploymentPublishedFiles(input: {
	candidateDistributionDirectoryPath: string;
	distributionDirectoryPath: string;
	candidateDistributionSha256: string;
}): Promise<boolean> {
	const candidate = await fingerprintLocalDeploymentDistribution(input.candidateDistributionDirectoryPath);
	if (candidate.candidateDistributionSha256 !== input.candidateDistributionSha256)
		throw new Error("已绑定的候选产物发生变化");
	const root = await realpath(input.distributionDirectoryPath);
	for (const file of candidate.files) {
		let path = root;
		try {
			for (const segment of file.relativeFilePath.split("/")) {
				path = join(path, segment);
				if ((await lstat(path)).isSymbolicLink()) return false;
			}
			if (
				createHash("sha256")
					.update(await readFile(path))
					.digest("hex") !== file.sha256
			)
				return false;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	}
	const candidateRelativePaths = new Set(candidate.files.map((file) => file.relativeFilePath));
	// 与发布脚本的独占子目录一致：换入中断后留下的陈旧构建文件不能算发布完成。目标里原有的非构建文件仍可保留。
	for (const ownedSubdirectoryName of ["web-ui"]) {
		const staleBuildFile = await findStaleOwnedBuildFile(root, ownedSubdirectoryName, candidateRelativePaths);
		if (staleBuildFile !== null) return false;
	}
	return true;
}

async function findStaleOwnedBuildFile(
	distributionRoot: string,
	ownedSubdirectoryName: string,
	candidateRelativePaths: ReadonlySet<string>,
): Promise<string | null> {
	const ownedRoot = join(distributionRoot, ownedSubdirectoryName);
	let ownedStatus: Awaited<ReturnType<typeof lstat>>;
	try {
		ownedStatus = await lstat(ownedRoot);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	// 独占根是软链接时不跟进；发布脚本也会跳过它，避免把链接目标当成陈旧构建文件。
	if (!ownedStatus.isDirectory() || ownedStatus.isSymbolicLink()) return null;
	async function visit(directoryPath: string, prefix: string): Promise<string | null> {
		for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
			const relativeFilePath = `${prefix}${entry.name}`;
			if (entry.isSymbolicLink()) return relativeFilePath;
			if (entry.isDirectory()) {
				const stale = await visit(join(directoryPath, entry.name), `${relativeFilePath}/`);
				if (stale !== null) return stale;
			} else if (!entry.isFile() || !candidateRelativePaths.has(relativeFilePath)) return relativeFilePath;
		}
		return null;
	}
	return await visit(ownedRoot, `${ownedSubdirectoryName}/`);
}
