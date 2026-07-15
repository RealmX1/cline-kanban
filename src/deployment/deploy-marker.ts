import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeDeploymentMarker } from "../core/api-contract";
import { parseDeploymentMarker } from "../core/api-validation";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import type { AtomicTextWriteOptions } from "../fs/locked-file-system";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";

// 运行中 build 当前部署到的源 commit 标记（plan 1a）。
// 唯一由 `kanban deployment record` 写入，与 post-deploy-verification-state 组键（deploymentId）同源冗余互存。
const DEPLOY_MARKER_FILENAME = "last-deployed-source-commit.json";

export function getDeployMarkerPath(): string {
	return join(getRuntimeHomePath(), DEPLOY_MARKER_FILENAME);
}

/**
 * 读取部署标记；文件不存在返回 null（尚未部署）。
 * 内容用 marker schema 校验；损坏时降级为 null（record 会重写），并打 warn。
 */
export async function readDeployMarker(): Promise<RuntimeDeploymentMarker | null> {
	const path = getDeployMarkerPath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
	try {
		return parseDeploymentMarker(JSON.parse(raw));
	} catch (error) {
		logDeploymentDiagnosticWarning(`[deploy-marker] 部署标记损坏，按未部署处理（${path}）：${errorMessage(error)}`);
		return null;
	}
}

/**
 * 写入部署标记（原子写）。
 * 默认用 marker 文件自身的锁；`createDeploymentGroup` 需在 state 全局锁内连带写 marker 时传 `{ lock: null }`
 * 跳过内层加锁，实现 marker + state 单锁内写入、避免半写。
 */
export async function writeDeployMarker(
	marker: RuntimeDeploymentMarker,
	options: Pick<AtomicTextWriteOptions, "lock"> = {},
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(getDeployMarkerPath(), marker, options);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
