import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

// 同步 CLI 使用私有 cwd 和发现上界，保留原生 Automatic 的仓库环境隔离。
const repositoryScopedGitEnvironmentNames = new Set([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_CONFIG",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
	"GIT_DIR",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_GRAFT_FILE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_NAMESPACE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_REPLACE_REF_BASE",
	"GIT_SHALLOW_FILE",
	"GIT_WORK_TREE",
]);

export function buildCodexAutomaticPluginInstallationGitEnvironment(
	environment: NodeJS.ProcessEnv,
	isolatedGitWorkingDirectoryPath: string,
): NodeJS.ProcessEnv {
	return {
		...Object.fromEntries(
			Object.entries(environment).filter(([name]) => !repositoryScopedGitEnvironmentNames.has(name)),
		),
		GIT_CEILING_DIRECTORIES: isolatedGitWorkingDirectoryPath,
		GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
	};
}

export async function assertCodexAutomaticPluginGitWorkingDirectory(isolatedGitWorkingDirectoryPath: string) {
	if (
		!(await lstat(isolatedGitWorkingDirectoryPath)).isDirectory() ||
		(await realpath(isolatedGitWorkingDirectoryPath)) !== resolve(isolatedGitWorkingDirectoryPath)
	)
		throw new Error("Codex 自动插件安装的私有 Git 工作目录归属不符。");
	try {
		await lstat(join(isolatedGitWorkingDirectoryPath, ".git"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error("Codex 自动插件安装目录出现 Git 仓库发现标记，未执行命令。");
}
