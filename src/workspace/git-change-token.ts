import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 廉价的「git 工作区是否可能已变更」签名。
 *
 * 动机：workspace 元数据轮询原先每个 poll 都要跑 `git status --porcelain=v2 --untracked-files=all`
 * 这类重命令来判断「变没变」——探针本身就是最贵的 git 命令之一，且每次都要同步 spawn 子进程。
 * 在挂了大量任务的实例上，这些同步 spawn 占满事件循环，导致 Agent TUI 键盘回显数秒级卡顿。
 *
 * 本模块用几次 `fs.stat` + 一次 gitdir 解析，得到一个「HEAD 移动 / 暂存 / 工作树根增删」都会变的廉价 token，
 * **完全不 spawn 任何 git 进程**。调用方以此做第一层门控：token 未变且未超兜底窗口就复用缓存、跳过真探针。
 *
 * 有意的取舍：就地未暂存编辑（改动已跟踪文件、不 `git add`）不改这些 stat 目标的 mtime，本 token 捕获不到；
 * 由调用方既有的热 / 冷兜底全量刷新窗口补上，不以此 token 代替工作树内容探测。
 */

const NO_GIT_DIR_SENTINEL = "no-gitdir";

// 同路径重建或替换 .git 后必须重新解析；缺失结果不缓存，避免首次创建后永久沿用 no-gitdir。
const resolvedGitDirCache = new Map<string, { dotGitIdentity: string; gitDir: string }>();
const MAX_CACHED_WORKTREE_GIT_DIRECTORY_RESOLUTIONS = 2_048;

async function resolveWorktreeGitDirUncached(worktreeRoot: string): Promise<string | null> {
	const dotGitPath = join(worktreeRoot, ".git");
	const dotGitInfo = await lstat(dotGitPath).catch(() => null);
	if (!dotGitInfo) {
		return null;
	}
	// 普通仓库：`.git` 是目录。
	if (dotGitInfo.isDirectory()) {
		return dotGitPath;
	}
	// linked worktree（task worktree）：`.git` 是文件，内容形如 `gitdir: /path/to/.git/worktrees/<name>`。
	if (dotGitInfo.isFile()) {
		const content = await readFile(dotGitPath, "utf8").catch(() => "");
		const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
		if (!match) {
			return null;
		}
		const target = match[1];
		return isAbsolute(target) ? target : resolve(worktreeRoot, target);
	}
	return null;
}

async function resolveWorktreeGitDir(worktreeRoot: string): Promise<string | null> {
	const dotGitInfo = await lstat(join(worktreeRoot, ".git")).catch(() => null);
	if (!dotGitInfo) {
		resolvedGitDirCache.delete(worktreeRoot);
		return null;
	}
	const dotGitIdentity = `${dotGitInfo.dev}:${dotGitInfo.ino}:${dotGitInfo.isFile() ? `${dotGitInfo.size}:${dotGitInfo.mtimeMs}:${dotGitInfo.ctimeMs}` : "directory"}`;
	const cached = resolvedGitDirCache.get(worktreeRoot);
	if (cached?.dotGitIdentity === dotGitIdentity) {
		return cached.gitDir;
	}
	const resolved = await resolveWorktreeGitDirUncached(worktreeRoot);
	if (resolved !== null) {
		resolvedGitDirCache.delete(worktreeRoot);
		resolvedGitDirCache.set(worktreeRoot, { dotGitIdentity, gitDir: resolved });
		while (resolvedGitDirCache.size > MAX_CACHED_WORKTREE_GIT_DIRECTORY_RESOLUTIONS) {
			const oldest = resolvedGitDirCache.keys().next().value;
			if (oldest !== undefined) resolvedGitDirCache.delete(oldest);
		}
	} else {
		resolvedGitDirCache.delete(worktreeRoot);
	}
	return resolved;
}

async function statSignature(targetPath: string): Promise<string> {
	const info = await stat(targetPath).catch(() => null);
	return info ? `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}` : "∅";
}

/**
 * 计算 worktree 的廉价 git 变更 token（不 spawn git）。
 *
 * - HEAD 移动（提交 / checkout / reset / merge）→ `HEAD` 与 `logs/HEAD` 的 mtime 变化。
 * - 暂存（`git add`）→ `index` 的 mtime 变化。
 * - 工作树根目录增删文件 → 根目录 mtime 变化。
 *
 * gitdir 解析不出（路径缺失、非 git 目录）→ 返回恒定 sentinel。调用方仍会因兜底窗口定期跑真探针，
 * 由真探针自行优雅处理非 git 的情况，故恒定 sentinel 安全。
 */
export async function computeWorktreeGitChangeToken(
	worktreeRoot: string,
	onHeadReflogChangeToken?: (token: string) => void,
): Promise<string> {
	const gitDir = await resolveWorktreeGitDir(worktreeRoot);
	if (!gitDir) {
		return NO_GIT_DIR_SENTINEL;
	}
	const [head, commonDirectory] = await Promise.all([
		readFile(join(gitDir, "HEAD"), "utf8").catch(() => ""),
		readFile(join(gitDir, "commondir"), "utf8").catch(() => ""),
	]);
	const commonGitDir = commonDirectory.trim() ? resolve(gitDir, commonDirectory.trim()) : gitDir;
	const symbolicHeadRef = head.match(/^ref:\s*(refs\/\S+)/)?.[1];
	const [
		headSignature,
		indexSignature,
		reflogSignature,
		worktreeRootSignature,
		headRefSignature,
		packedRefsSignature,
	] = await Promise.all([
		statSignature(join(gitDir, "HEAD")),
		statSignature(join(gitDir, "index")),
		statSignature(join(gitDir, "logs", "HEAD")),
		statSignature(worktreeRoot),
		symbolicHeadRef ? statSignature(join(commonGitDir, symbolicHeadRef)) : Promise.resolve("detached"),
		statSignature(join(commonGitDir, "packed-refs")),
	]);
	onHeadReflogChangeToken?.(`${gitDir}|${reflogSignature}`);
	return `${gitDir}|${commonGitDir}|${head}|${headSignature}|${indexSignature}|${reflogSignature}|${worktreeRootSignature}|${headRefSignature}|${packedRefsSignature}`;
}

/** 仅供测试：清空 gitdir 解析缓存。 */
export function resetResolvedGitDirCacheForTest(): void {
	resolvedGitDirCache.clear();
}
