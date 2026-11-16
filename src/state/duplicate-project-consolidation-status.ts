import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type DuplicateProjectConsolidationControl,
	duplicateProjectConsolidationControlSchema,
} from "../core/duplicate-project-consolidation-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "./runtime-home-path";

export const duplicateProjectConsolidationDirectory = () =>
	join(getRuntimeHomePath(), "duplicate-project-consolidations");
const consolidationControlDirectory = () => join(getRuntimeHomePath(), "duplicate-project-consolidation-controls");

function assertWorkspaceId(workspaceId: string) {
	if (!/^[a-zA-Z0-9_-]+$/u.test(workspaceId)) throw new Error("项目身份不能包含路径分隔符。");
}
export function duplicateProjectConsolidationReceiptPath(sourceWorkspaceId: string) {
	assertWorkspaceId(sourceWorkspaceId);
	return join(duplicateProjectConsolidationDirectory(), `${sourceWorkspaceId}.json`);
}
const workspaceControlPath = (workspaceId: string) => {
	assertWorkspaceId(workspaceId);
	return join(consolidationControlDirectory(), "by-workspace-id", `${workspaceId}.json`);
};
const repositoryAliasPath = (repositoryPath: string) =>
	join(
		consolidationControlDirectory(),
		"by-repository-path",
		`${createHash("sha256").update(repositoryPath).digest("hex")}.json`,
	);
const workspaceControlFileSchema = z.object({
	schemaVersion: z.literal(1),
	consolidationsBySourceWorkspaceId: z.record(z.string(), duplicateProjectConsolidationControlSchema),
});

async function readOptionalJson(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}
async function readWorkspaceControls(workspaceId: string) {
	const value = await readOptionalJson(workspaceControlPath(workspaceId));
	const controls = workspaceControlFileSchema.parse(
		value ?? { schemaVersion: 1, consolidationsBySourceWorkspaceId: {} },
	);
	for (const [sourceId, control] of Object.entries(controls.consolidationsBySourceWorkspaceId)) {
		if (sourceId !== control.sourceWorkspaceId || ![sourceId, control.targetWorkspaceId].includes(workspaceId))
			throw new Error("项目合并控制状态的归属不匹配。");
	}
	return controls;
}

// 在线门禁只读小型控制记录；完整会话、任务快照和失败原件不进入日常查询。
export async function writeDuplicateProjectConsolidationControl(input: DuplicateProjectConsolidationControl) {
	const control = duplicateProjectConsolidationControlSchema.parse(input);
	await lockedFileSystem.withLock({ path: consolidationControlDirectory(), type: "directory" }, async () => {
		for (const workspaceId of [control.sourceWorkspaceId, control.targetWorkspaceId]) {
			const file = await readWorkspaceControls(workspaceId);
			const previous = file.consolidationsBySourceWorkspaceId[control.sourceWorkspaceId];
			if (previous && previous.operationId !== control.operationId) throw new Error("项目已绑定另一项保全合并。");
			file.consolidationsBySourceWorkspaceId[control.sourceWorkspaceId] = control;
			await lockedFileSystem.writeJsonFileAtomic(workspaceControlPath(workspaceId), file, {
				lock: null,
				durable: true,
				fileMode: 0o600,
			});
		}
		await lockedFileSystem.writeJsonFileAtomic(repositoryAliasPath(control.sourceRepositoryPath), control, {
			lock: null,
			durable: true,
			fileMode: 0o600,
		});
	});
}

export async function clearRejectedDuplicateProjectConsolidationControl(control: DuplicateProjectConsolidationControl) {
	await lockedFileSystem.withLock({ path: consolidationControlDirectory(), type: "directory" }, async () => {
		const alias = await readOptionalJson(repositoryAliasPath(control.sourceRepositoryPath));
		if (alias && duplicateProjectConsolidationControlSchema.parse(alias).operationId === control.operationId)
			await rm(repositoryAliasPath(control.sourceRepositoryPath), { force: true });
		for (const workspaceId of [control.sourceWorkspaceId, control.targetWorkspaceId]) {
			const file = await readWorkspaceControls(workspaceId);
			const previous = file.consolidationsBySourceWorkspaceId[control.sourceWorkspaceId];
			if (!previous || previous.operationId !== control.operationId) continue;
			if (previous.status !== "quiescing") throw new Error("已经捕获来源的合并不能按未受理操作解冻。");
			delete file.consolidationsBySourceWorkspaceId[control.sourceWorkspaceId];
			await lockedFileSystem.writeJsonFileAtomic(workspaceControlPath(workspaceId), file, {
				lock: null,
				durable: true,
				fileMode: 0o600,
			});
		}
	});
}

export async function readDuplicateProjectConsolidationControlRecord(
	workspaceId: string,
	sourceWorkspaceId = workspaceId,
): Promise<DuplicateProjectConsolidationControl | null> {
	return (await readWorkspaceControls(workspaceId)).consolidationsBySourceWorkspaceId[sourceWorkspaceId] ?? null;
}
export async function readDuplicateProjectConsolidationStatus(workspaceId: string) {
	return await readDuplicateProjectConsolidationControlRecord(workspaceId);
}
export async function assertWorkspaceHasNotBeenConsolidated(workspaceId: string) {
	if (await readDuplicateProjectConsolidationStatus(workspaceId))
		throw new Error(`项目 ${workspaceId} 正在合并或已合并；来源写入已冻结，请从目标项目继续。`);
}
export async function assertWorkspaceBackgroundStateWritesAreAllowed(workspaceId: string) {
	const status = await readDuplicateProjectConsolidationStatus(workspaceId);
	if (status && status.status !== "quiescing")
		throw new Error(`项目 ${workspaceId} 已完成停止写入核验，禁止后台改写来源状态。`);
}
export async function resolveConsolidatedWorkspaceId(workspaceId: string): Promise<string> {
	const visited = new Set<string>();
	let current = workspaceId;
	for (;;) {
		if (visited.has(current)) throw new Error("项目迁移别名存在循环。");
		visited.add(current);
		const status = await readDuplicateProjectConsolidationStatus(current);
		if (!status || status.status !== "completed") return current;
		current = status.targetWorkspaceId;
	}
}
export async function findConsolidatedRepositoryPath(repositoryPath: string) {
	const value = await readOptionalJson(repositoryAliasPath(repositoryPath));
	if (!value) return null;
	const control = duplicateProjectConsolidationControlSchema.parse(value);
	if (control.sourceRepositoryPath !== repositoryPath) throw new Error("合并仓库别名的路径不匹配。");
	return control;
}
export async function hasRemovedTaskFromDuplicateProjectConsolidation(
	workspaceId: string,
	removedTasks: Array<{ id: string; createdAt: number }>,
) {
	return Object.values((await readWorkspaceControls(workspaceId)).consolidationsBySourceWorkspaceId).some(
		(control) =>
			control.targetWorkspaceId === workspaceId &&
			control.tasks.some((task) =>
				removedTasks.some((card) => card.id === task.taskId && card.createdAt === task.createdAt),
			),
	);
}
export async function assertProjectIsNotInPendingConsolidation(workspaceId: string) {
	if (
		Object.values((await readWorkspaceControls(workspaceId)).consolidationsBySourceWorkspaceId).some(
			(control) => control.status !== "completed",
		)
	)
		throw new Error("项目有尚未完成的保全合并，不能同时永久删除。");
}
export async function assertTaskSessionIsNotPendingProjectConsolidation(workspaceId: string, taskId: string) {
	if (
		Object.values((await readWorkspaceControls(workspaceId)).consolidationsBySourceWorkspaceId).some(
			(control) =>
				control.status !== "completed" &&
				control.targetWorkspaceId === workspaceId &&
				control.tasks.some((task) => task.taskId === taskId),
		)
	)
		throw new Error("该任务正在保全迁移，会话尚未装入目标项目，请等待迁移完成后继续。");
}
