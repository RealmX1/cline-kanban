import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface RvfBoundaryCandidateFile {
	path: string;
	included_in_candidate_set: boolean;
	content_sha256: string;
}

// 与 RVF candidate_filesystem_state_sha256 同口径；整数直接编码十进制，不经过 Number。
export async function computeRvfCandidateFilesystemIdentitySha256(
	repositoryPath: string,
	candidates: readonly RvfBoundaryCandidateFile[],
) {
	const observations: string[] = [];
	for (const candidate of [...candidates].sort((left, right) =>
		Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
	)) {
		if (!candidate.included_in_candidate_set) continue;
		if (isAbsolute(candidate.path) || candidate.path.split(/[\\/]/u).includes(".."))
			throw new Error("候选文件不能位于仓库之外。");
		const path = join(repositoryPath, candidate.path);
		let metadata: bigint[] | null;
		try {
			const file = await lstat(path, { bigint: true });
			metadata = [file.dev, file.ino, file.mode, file.size, file.mtimeNs, file.ctimeNs];
			if (file.isSymbolicLink()) {
				try {
					const target = await stat(path, { bigint: true });
					metadata.push(target.dev, target.ino, target.size, target.mtimeNs, target.ctimeNs);
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			metadata = null;
		}
		observations.push(`[${JSON.stringify(candidate.path)},${metadata ? `[${metadata.join(",")}]` : "null"}]`);
	}
	return createHash("sha256")
		.update(`[${observations.join(",")}]`)
		.digest("hex");
}

export async function assertRvfCandidateContentsMatchToken(
	repositoryPath: string,
	candidates: readonly RvfBoundaryCandidateFile[],
) {
	for (const candidate of candidates) {
		if (!candidate.included_in_candidate_set) continue;
		// 路径先经 identity 检查；删除文件与 RVF 的 absent 表示一致。
		let digest: string;
		try {
			digest = createHash("sha256")
				.update(await readFile(join(repositoryPath, candidate.path)))
				.digest("hex");
		} catch (error) {
			// RVF 将 gitlink 目录内容编码为 absent；子模块 HEAD 与 clean 状态由 checkpoint consumer 核验。
			if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR")))
				throw error;
			digest = "absent";
		}
		if (digest !== candidate.content_sha256) throw new Error(`候选内容在铸造 token 后改变：${candidate.path}`);
	}
}
