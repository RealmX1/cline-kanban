import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
	RuntimeAuthoredVerificationDefinition,
	RuntimeAuthoredVerificationDefinitionsFile,
	RuntimePostDeployVerificationChecklistItem,
} from "../core/api-contract";
import { parseAuthoredVerificationDefinitionsFile } from "../core/api-validation";
import { logDeploymentDiagnosticWarning } from "../diagnostics/deployment-diagnostics-logger";
import type { LockRequest } from "../fs/locked-file-system";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { verificationAssetsDirExists } from "./verification-assets";

// ~/.cline/kanban/authored-verification-definitions.json —— agent 注册的部署后验证定义的 pending 存储（plan Stage 2）。
// 与 post-deploy-verification-state.json 分离：定义在「部署前」注册（此时无部署组），record/reconcile 时才 materialize 进组。
const AUTHORED_VERIFICATION_DEFINITIONS_FILENAME = "authored-verification-definitions.json";

// materialize 出的 checklist item id 前缀：`authored:<verificationId>`，与 commit:/custom 项区分、按 verificationId 去重。
export const AUTHORED_VERIFICATION_ITEM_ID_PREFIX = "authored:";

export function getAuthoredVerificationDefinitionsPath(): string {
	return join(getRuntimeHomePath(), AUTHORED_VERIFICATION_DEFINITIONS_FILENAME);
}

// 单一全局锁：register CLI / record 建组 / reconcile 三方读改写，写频率低，不做分组锁（与 state 模块一致）。
function getAuthoredVerificationDefinitionsLockRequest(): LockRequest {
	return { path: getAuthoredVerificationDefinitionsPath(), type: "file" };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// 损坏 JSON 不 throw：把损坏文件改名隔离（.corrupt-<时间戳>），降级为空定义集重建并 warn（与 state 模块同策略）。
async function readAuthoredVerificationDefinitionsCorruptionTolerant(
	corruptIsolationTimestamp: string,
): Promise<RuntimeAuthoredVerificationDefinitionsFile> {
	const path = getAuthoredVerificationDefinitionsPath();
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { definitions: [] };
		}
		throw error;
	}
	try {
		return parseAuthoredVerificationDefinitionsFile(JSON.parse(raw));
	} catch (error) {
		const isolatedPath = `${path}.corrupt-${corruptIsolationTimestamp}`;
		try {
			await rename(path, isolatedPath);
		} catch {
			// 隔离改名失败不阻塞降级：仍返回空集，下一次写入会覆盖损坏内容。
		}
		logDeploymentDiagnosticWarning(
			`[authored-verification-definitions] 定义文件 JSON 损坏，已隔离为 ${isolatedPath}，降级为空集重建：${errorMessage(error)}`,
		);
		return { definitions: [] };
	}
}

// 通用 read-modify-write 骨架：全程持锁；mutator 就地改 file 并返回结果。
async function mutateAuthoredVerificationDefinitions<ResultType>(
	nowIso: string,
	mutator: (file: RuntimeAuthoredVerificationDefinitionsFile) => ResultType,
): Promise<ResultType> {
	// 确保 runtime home 目录存在再加锁：首次注册时该目录可能尚未建（proper-lockfile 需父目录在场才能落锁文件）。
	await mkdir(getRuntimeHomePath(), { recursive: true });
	return await lockedFileSystem.withLock(getAuthoredVerificationDefinitionsLockRequest(), async () => {
		const file = await readAuthoredVerificationDefinitionsCorruptionTolerant(nowIso);
		const result = mutator(file);
		await lockedFileSystem.writeJsonFileAtomic(getAuthoredVerificationDefinitionsPath(), file, { lock: null });
		return result;
	});
}

// 按 verificationId upsert 一条定义（已存在则整体替换，用于 rvf-reopen / 多轮重注册幂等）。
export async function upsertAuthoredVerificationDefinition(
	definition: RuntimeAuthoredVerificationDefinition,
	nowIso: string,
): Promise<void> {
	await mutateAuthoredVerificationDefinitions(nowIso, (file) => {
		const existingIndex = file.definitions.findIndex((entry) => entry.verificationId === definition.verificationId);
		if (existingIndex >= 0) {
			file.definitions[existingIndex] = definition;
		} else {
			file.definitions.push(definition);
		}
	});
}

// 列出已注册定义，可按 workspaceId / taskId 过滤（自查 + reconcile materialize 热路径）。
// 纯只读：不走 mutate 骨架（那会每次加锁 + 原子重写整份文件——30s 轮询 reconcile 下变成随
// validation 任务数线性增长的 N+1 磁盘写与锁竞争）。写盘均为原子 rename，无锁读不会读到半写内容；
// 损坏文件的隔离改名由读函数自身兜底（best-effort，失败静默）。
export async function listAuthoredVerificationDefinitions(
	filter: { workspaceId?: string; taskId?: string },
	nowIso: string,
): Promise<RuntimeAuthoredVerificationDefinition[]> {
	const file = await readAuthoredVerificationDefinitionsCorruptionTolerant(nowIso);
	return file.definitions.filter(
		(entry) =>
			(filter.workspaceId === undefined || entry.workspaceId === filter.workspaceId) &&
			(filter.taskId === undefined || entry.taskId === filter.taskId),
	);
}

// 删除一条 pending 定义（不影响已 seed 进历史组的 item）。返回是否命中。
export async function removeAuthoredVerificationDefinition(verificationId: string, nowIso: string): Promise<boolean> {
	return await mutateAuthoredVerificationDefinitions(nowIso, (file) => {
		const before = file.definitions.length;
		file.definitions = file.definitions.filter((entry) => entry.verificationId !== verificationId);
		return file.definitions.length < before;
	});
}

// 把某 (workspaceId, taskId) 的已注册定义 materialize 成 checklist item（record/reconcile 追加进部署组时调用）。
// item id = `authored:<verificationId>`；source="authored"；run 初始 null（自动脚本首次运行时才创建 run 快照）。
// 自动脚本项带 assetsDir 存在性护栏（issue CI4b）：脚本以 assetsDir 为 cwd 运行，目录缺失必然 spawn 失败，
// 且 authored 项不可手动勾选/删除，seed 进组会把该任务的完成门控永久卡死。典型来源是与「任务核对完成的
// automatic 清理」并发——定义先被读到、资产随后被删。此护栏把竞态窗口收窄到 check 与建组之间（缓解非闭合）。
export async function materializeAuthoredVerificationItemsForTask(
	workspaceId: string,
	taskId: string,
	nowIso: string,
): Promise<RuntimePostDeployVerificationChecklistItem[]> {
	const definitions = await listAuthoredVerificationDefinitions({ workspaceId, taskId }, nowIso);
	const items: RuntimePostDeployVerificationChecklistItem[] = [];
	for (const definition of definitions) {
		if (definition.kind === "automated_script" && !(await verificationAssetsDirExists(definition.verificationId))) {
			logDeploymentDiagnosticWarning(
				`[authored-verification-definitions] 跳过 materialize 自动脚本验证项 verificationId=${definition.verificationId}（资产目录已不存在，可能已被任务核对完成的 automatic 清理删除）`,
			);
			continue;
		}
		items.push({
			id: `${AUTHORED_VERIFICATION_ITEM_ID_PREFIX}${definition.verificationId}`,
			label: definition.label,
			checked: false,
			source: "authored",
			kind: definition.kind,
			guidance: definition.guidance,
			script: definition.script,
			run: null,
			cleanup: definition.cleanup,
		});
	}
	return items;
}
