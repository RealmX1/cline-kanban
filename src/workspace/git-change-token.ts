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
 * 由调用方的「兜底全量刷新窗口」在数秒内补上。看板级 git 元数据可以接受这点延迟。
 */

const NO_GIT_DIR_SENTINEL = "no-gitdir";

// worktree root → 真实 gitdir 的解析结果缓存。gitdir 位置对一个 worktree 稳定不变（不随提交移动），
// 因此解析一次即可长期复用，避免每 poll 都读 `.git` 文件。
const resolvedGitDirCache = new Map<string, string | null>();

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
	const cached = resolvedGitDirCache.get(worktreeRoot);
	if (cached !== undefined) {
		return cached;
	}
	const resolved = await resolveWorktreeGitDirUncached(worktreeRoot);
	resolvedGitDirCache.set(worktreeRoot, resolved);
	return resolved;
}

async function statSignature(targetPath: string): Promise<string> {
	const info = await stat(targetPath).catch(() => null);
	return info ? `${info.mtimeMs}:${info.size}` : "∅";
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
export async function computeWorktreeGitChangeToken(worktreeRoot: string): Promise<string> {
	const gitDir = await resolveWorktreeGitDir(worktreeRoot);
	if (!gitDir) {
		return NO_GIT_DIR_SENTINEL;
	}
	const [headSignature, indexSignature, reflogSignature, worktreeRootSignature] = await Promise.all([
		statSignature(join(gitDir, "HEAD")),
		statSignature(join(gitDir, "index")),
		statSignature(join(gitDir, "logs", "HEAD")),
		statSignature(worktreeRoot),
	]);
	return `${headSignature}|${indexSignature}|${reflogSignature}|${worktreeRootSignature}`;
}

/** 仅供测试：清空 gitdir 解析缓存。 */
export function resetResolvedGitDirCacheForTest(): void {
	resolvedGitDirCache.clear();
}
