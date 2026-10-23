/**
 * 把暂存目录里已构建完的产物逐文件换入 dist，避免「先 rm -rf dist 再重建」留下的空窗。
 *
 * 为什么需要：agent 会话跨 runtime 重启存活之后，hook 会在构建期间照常执行 `node dist/cli.js`；
 * task worktree 的 dist 还软链到在线 runtime 正在服务的产物。任何时刻 dist 里都必须是一份可运行的产物。
 *
 * 做法：
 * - 每个文件用同一文件系统内的 rename 换入（单文件原子）。暂存目录放在 dist 内部，保证同一文件系统。
 * - 入口文件最后换入：先放好 content-hash 资源，再换 `web-ui/index.html`；最后换 `cli.js`。
 *   这样任一时刻读到的入口所引用的资源都已存在。
 * - 换入完成后，再清理整棵由构建独占的子目录（`web-ui`）里不再属于新产物的陈旧文件。
 *   顶层其他文件不在独占范围内，不删。
 *
 * 也可单独执行（测试用）：
 *   node scripts/promote-staged-kanban-build-output-into-distribution-directory.mjs \
 *     --staging-directory <dir> --distribution-directory <dir>
 * 执行结果以 JSON 打印到 stdout。
 */
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 暂存目录名前缀；后面接构建进程 pid，用来识别崩溃构建遗留的暂存目录。 */
export const KANBAN_BUILD_STAGING_DIRECTORY_NAME_PREFIX = ".kanban-build-staging-";

/**
 * 整棵由构建独占的子目录：换入后，这些子目录里不属于新产物的文件一律视为陈旧并删除。
 * `web-ui` 是从 `web-ui/dist` 原样复制的，content-hash 资源每次构建都换名，不清理会无限累积。
 */
export const DISTRIBUTION_SUBDIRECTORIES_WHOLLY_OWNED_BY_KANBAN_BUILD = ["web-ui"];

/**
 * 必须最后换入的入口文件，按换入先后排列。不在此表中的文件先于它们换入。
 * - `web-ui/index.html` 引用 content-hash 资源，必须在资源就位后才换。
 * - `cli.js` 是 hook / CLI 每次执行的入口，放在最后，使它换入时其他运行时文件都已是新版本。
 */
export const DISTRIBUTION_ENTRY_FILES_PROMOTED_LAST_IN_ORDER = [
	"web-ui/manifest.json",
	"web-ui/sw.js",
	"web-ui/index.html",
	"index.js",
	"kanban-agent-hook-cli.js",
	"cli.js",
];

function toPortableRelativePath(relativePath) {
	return relativePath.split(sep).join("/");
}

/**
 * 只列真实文件；遇到软链接直接报错，绝不跟进。
 * 教训：`web-ui/dist` 在 task worktree 里是指向主 checkout 的软链接，曾被原样复制进暂存目录，
 * 随后的陈旧文件清理顺着软链接删掉了主 checkout 的 `web-ui/dist`。
 */
async function listRelativeRegularFilePathsRecursivelyRejectingSymbolicLinks(rootDirectoryPath) {
	const relativeFilePaths = [];
	async function visitDirectory(directoryPath) {
		const entries = await readdir(directoryPath, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = join(directoryPath, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`refusing to traverse symbolic link in build output: ${entryPath}`);
			}
			if (entry.isDirectory()) {
				await visitDirectory(entryPath);
			} else {
				relativeFilePaths.push(toPortableRelativePath(relative(rootDirectoryPath, entryPath)));
			}
		}
	}
	await visitDirectory(rootDirectoryPath);
	return relativeFilePaths;
}

export function orderStagedRelativeFilePathsForPromotion(stagedRelativeFilePaths) {
	const entryFileOrder = new Map(DISTRIBUTION_ENTRY_FILES_PROMOTED_LAST_IN_ORDER.map((path, index) => [path, index]));
	const nonEntryFiles = stagedRelativeFilePaths.filter((path) => !entryFileOrder.has(path)).sort();
	const entryFiles = stagedRelativeFilePaths
		.filter((path) => entryFileOrder.has(path))
		.sort((left, right) => (entryFileOrder.get(left) ?? 0) - (entryFileOrder.get(right) ?? 0));
	return [...nonEntryFiles, ...entryFiles];
}

/** 用 lstat：软链接即使指向目录也不算目录，后续删除与遍历都不会跟进它。 */
async function pathIsRealDirectoryNotSymbolicLink(path) {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function removeEmptyDirectoriesBottomUp(directoryPath) {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			await removeEmptyDirectoriesBottomUp(join(directoryPath, entry.name));
		}
	}
	if ((await readdir(directoryPath)).length === 0) {
		await rmdir(directoryPath);
	}
}

/**
 * 把暂存目录里的全部文件换入 dist，然后清理独占子目录里的陈旧文件。暂存目录在换入后为空，由调用方删除。
 */
export async function promoteStagedKanbanBuildOutputIntoDistributionDirectory({
	stagingDirectoryPath,
	distributionDirectoryPath,
}) {
	const stagedRelativeFilePaths = await listRelativeRegularFilePathsRecursivelyRejectingSymbolicLinks(stagingDirectoryPath);
	const promotedRelativeFilePathsInPromotionOrder = orderStagedRelativeFilePathsForPromotion(stagedRelativeFilePaths);

	for (const relativeFilePath of promotedRelativeFilePathsInPromotionOrder) {
		const targetFilePath = join(distributionDirectoryPath, relativeFilePath);
		await mkdir(dirname(targetFilePath), { recursive: true });
		// 旧产物里同名路径若是目录（极少见的类型变化），rename 会失败，先移除。
		if (await pathIsRealDirectoryNotSymbolicLink(targetFilePath)) {
			await rm(targetFilePath, { recursive: true, force: true });
		}
		await rename(join(stagingDirectoryPath, relativeFilePath), targetFilePath);
	}

	const promotedRelativeFilePathSet = new Set(promotedRelativeFilePathsInPromotionOrder);
	const removedStaleRelativeFilePaths = [];
	for (const ownedSubdirectoryName of DISTRIBUTION_SUBDIRECTORIES_WHOLLY_OWNED_BY_KANBAN_BUILD) {
		const ownedSubdirectoryPath = join(distributionDirectoryPath, ownedSubdirectoryName);
		// 独占子目录若是软链接（或不存在），不做清理：它指向的内容不归本次构建所有。
		if (!(await pathIsRealDirectoryNotSymbolicLink(ownedSubdirectoryPath))) {
			continue;
		}
		const existingRelativeFilePaths = (
			await listRelativeRegularFilePathsRecursivelyRejectingSymbolicLinks(ownedSubdirectoryPath)
		).map(
			(path) => `${ownedSubdirectoryName}/${path}`,
		);
		for (const existingRelativeFilePath of existingRelativeFilePaths) {
			if (!promotedRelativeFilePathSet.has(existingRelativeFilePath)) {
				await rm(join(distributionDirectoryPath, existingRelativeFilePath), { force: true });
				removedStaleRelativeFilePaths.push(existingRelativeFilePath);
			}
		}
		await removeEmptyDirectoriesBottomUp(ownedSubdirectoryPath);
	}

	return { promotedRelativeFilePathsInPromotionOrder, removedStaleRelativeFilePaths };
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM：进程存在但属于别的用户，按存活处理。
		return error?.code === "EPERM";
	}
}

/**
 * 删除崩溃构建遗留的暂存目录：目录名里的构建进程 pid 已不存在才删，正在进行的并发构建不受影响。
 */
export async function removeAbandonedKanbanBuildStagingDirectories(distributionDirectoryPath) {
	let entries;
	try {
		entries = await readdir(distributionDirectoryPath, { withFileTypes: true });
	} catch {
		return [];
	}
	const removedStagingDirectoryNames = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(KANBAN_BUILD_STAGING_DIRECTORY_NAME_PREFIX)) {
			continue;
		}
		const builderProcessId = Number.parseInt(
			entry.name.slice(KANBAN_BUILD_STAGING_DIRECTORY_NAME_PREFIX.length).split("-")[0] ?? "",
			10,
		);
		if (Number.isInteger(builderProcessId) && builderProcessId > 0 && isProcessAlive(builderProcessId)) {
			continue;
		}
		await rm(join(distributionDirectoryPath, entry.name), { recursive: true, force: true });
		removedStagingDirectoryNames.push(entry.name);
	}
	return removedStagingDirectoryNames;
}

function readRequiredCommandLineOption(optionName) {
	const optionIndex = process.argv.indexOf(optionName);
	const optionValue = optionIndex >= 0 ? process.argv[optionIndex + 1] : undefined;
	if (!optionValue) {
		throw new Error(`missing required option ${optionName}`);
	}
	return resolve(optionValue);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = await promoteStagedKanbanBuildOutputIntoDistributionDirectory({
		stagingDirectoryPath: readRequiredCommandLineOption("--staging-directory"),
		distributionDirectoryPath: readRequiredCommandLineOption("--distribution-directory"),
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
