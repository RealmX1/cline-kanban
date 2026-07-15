import { access, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import { getRuntimeHomePath } from "../state/workspace-state";

// per-verification 资产根目录：~/.cline/kanban/verifications/。每个验证定义拥有 <root>/<verificationId>/ 一个子目录，
// 存放脚本入口、fixture 等。放在 runtime home（而非 repo）：repo 干净、且能扛住任务 worktree 完成后被 trash 删除。
const VERIFICATION_ASSETS_DIR_NAME = "verifications";

export function getVerificationAssetsRoot(): string {
	return join(getRuntimeHomePath(), VERIFICATION_ASSETS_DIR_NAME);
}

// 某个验证的资产目录。verificationId 是 uuid，join 后天然落在根目录下（此处只拼路径，越界护栏在 cleanup 侧断言 real path）。
export function getVerificationAssetsDir(verificationId: string): string {
	return join(getVerificationAssetsRoot(), verificationId);
}

// 确保某验证的资产目录存在（register 时调用），返回其绝对路径供 agent 填脚本 / fixture。
export async function ensureVerificationAssetsDir(verificationId: string): Promise<string> {
	const dir = getVerificationAssetsDir(verificationId);
	await mkdir(dir, { recursive: true });
	return resolve(dir);
}

// 某验证的资产目录是否仍在场。materialize 自动脚本项前的存在性护栏（issue CI4b）：
// 「任务核对完成的 automatic 清理」与 record/reconcile 建组并发时，定义可能先被读到、资产随后被删；
// 自动脚本以 assetsDir 为 cwd 运行，目录缺失必然 spawn 失败，该定义不应再被 seed 进新组。
export async function verificationAssetsDirExists(verificationId: string): Promise<boolean> {
	try {
		await access(getVerificationAssetsDir(verificationId));
		return true;
	} catch {
		return false;
	}
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export interface CleanupVerificationAssetsResult {
	removed: boolean;
	// 未删除时的原因（already-absent / assets-root-missing / out-of-bounds）。
	skippedReason?: string;
}

// per-verification 清理护栏（plan Stage 5）：只删「解析 real path 后确实落在 verifications 根目录之下」的资产目录。
// 越界（symlink 逃逸 / verificationId 含 ../ 等）一律拒删并 warn；目录已不存在视为幂等成功（no-op）。
export async function cleanupVerificationAssets(verificationId: string): Promise<CleanupVerificationAssetsResult> {
	const root = getVerificationAssetsRoot();
	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(root);
	} catch (error) {
		if (isEnoent(error)) {
			return { removed: false, skippedReason: "assets-root-missing" };
		}
		throw error;
	}
	let resolvedDir: string;
	try {
		resolvedDir = await realpath(getVerificationAssetsDir(verificationId));
	} catch (error) {
		if (isEnoent(error)) {
			return { removed: false, skippedReason: "already-absent" };
		}
		throw error;
	}
	// 护栏：resolvedDir 必须严格在 resolvedRoot 之下（不能等于 root 自身、不能越界）。
	const rel = relative(resolvedRoot, resolvedDir);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		logDeploymentDiagnosticWarning(
			`[verification-assets] 拒绝删除越界路径 ${resolvedDir}（不在资产根目录 ${resolvedRoot} 之下），verificationId=${verificationId}`,
		);
		return { removed: false, skippedReason: "out-of-bounds" };
	}
	await rm(resolvedDir, { recursive: true, force: true });
	return { removed: true };
}
