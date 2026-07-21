/**
 * 从仓库路径派生项目展示名：取归一化路径的最后一个非空路径段（末级目录名）。
 *
 * 与 `workspace-registry.ts` 的 `toProjectSummary` 共用同一来源，避免两处 name 派生逻辑漂移。
 */
export function deriveProjectDisplayNameFromRepoPath(repoPath: string): string {
	const normalized = repoPath.replaceAll("\\", "/").replace(/\/+$/g, "");
	const segments = normalized.split("/").filter((segment) => segment.length > 0);
	return segments[segments.length - 1] ?? normalized;
}
