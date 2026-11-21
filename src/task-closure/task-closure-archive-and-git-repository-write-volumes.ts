import { lstat, realpath } from "node:fs/promises";
import { getGitStdout } from "../workspace/git-utils";
import { ensurePrivateTaskClosureArtifactDirectory, type TaskClosureOperation } from "./task-closure-operation-store";

/** 载荷、Git 对象库和 common 元数据可以分处三卷；空间与互斥按真实设备去重并覆盖全部写入位置。 */
export async function readTaskClosureArchiveAndGitRepositoryWriteVolumes(operation: TaskClosureOperation) {
	const archiveDirectory = await ensurePrivateTaskClosureArtifactDirectory(
		operation.taskIdentity,
		operation.progress.closureRequestId,
	);
	const objectDirectory = await getGitStdout(
		["rev-parse", "--path-format=absolute", "--git-path", "objects"],
		operation.workspacePath,
	);
	const commonMetadataDirectory = await getGitStdout(
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		operation.workspacePath,
	);
	const volumes = new Map<number, { path: string; deviceId: number }>();
	for (const directory of [archiveDirectory, objectDirectory, commonMetadataDirectory]) {
		const path = await realpath(directory);
		const metadata = await lstat(path);
		if (!metadata.isDirectory()) throw new Error("结案写入目标不是目录，尚不能核验卷空间。");
		if (!volumes.has(metadata.dev)) volumes.set(metadata.dev, { path, deviceId: metadata.dev });
	}
	return [...volumes.values()];
}
