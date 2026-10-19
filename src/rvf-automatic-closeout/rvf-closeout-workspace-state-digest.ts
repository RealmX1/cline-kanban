import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { getGitStdout } from "../workspace/git-utils";

// 不改真实 index；同时覆盖 HEAD、已暂存补丁、未暂存补丁与未跟踪文件内容。
export async function readRvfCloseoutWorkspaceStateDigest(cwd: string) {
	const git = (args: string[]) =>
		getGitStdout(["-c", "core.hooksPath=/dev/null", ...args], cwd, { trimStdout: false });
	const hash = createHash("sha256");
	for (const args of [
		["rev-parse", "HEAD"],
		["diff", "--cached", "--binary", "--full-index"],
		["diff", "--binary", "--full-index"],
		["status", "--porcelain=v1", "-z", "-uall"],
	])
		hash.update(await git(args));
	const paths = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
	for (const path of paths) {
		const full = join(cwd, path);
		const stat = await lstat(full);
		hash.update(JSON.stringify([path, stat.mode]));
		hash.update(stat.isSymbolicLink() ? await readlink(full) : await readFile(full));
	}
	return hash.digest("hex");
}
