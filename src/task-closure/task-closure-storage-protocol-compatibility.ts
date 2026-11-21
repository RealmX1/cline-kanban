import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";

export const TASK_CLOSURE_STORAGE_PROTOCOL_CAPABILITIES_FILENAME = "task-closure-storage-protocol-capabilities.json";
export const taskClosureStorageProtocolAdoptionPath = () =>
	join(getRuntimeHomePath(), "task-closure-storage-protocol-adoption.json");

export async function adoptTaskClosureOperationStorageProtocolVersion() {
	const path = taskClosureStorageProtocolAdoptionPath();
	await lockedFileSystem.withLock({ path }, async () => {
		try {
			const current = z
				.object({ minimumReadableOperationSchemaVersion: z.number().int().positive() })
				.parse(JSON.parse(await readFile(path, "utf8")));
			if (current.minimumReadableOperationSchemaVersion > 2)
				throw new Error("结案存储已采用更新协议，当前运行时不能降级写入。");
			if (current.minimumReadableOperationSchemaVersion === 2) return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify({ minimumReadableOperationSchemaVersion: 2 }), {
			lock: null,
			durable: true,
			fileMode: 0o600,
		});
	});
}

/** 发布前检查持久协议下界；未知旧产物仅支持 v1，不修改或降级原操作记录。 */
export async function assertTaskClosureStorageProtocolCompatibleWithDistribution(
	distributionDirectory: string,
	runtimeHomeDirectoryPath = getRuntimeHomePath(),
) {
	let required = 1;
	try {
		required = z
			.object({ minimumReadableOperationSchemaVersion: z.number().int().positive() })
			.parse(
				JSON.parse(
					await readFile(join(runtimeHomeDirectoryPath, "task-closure-storage-protocol-adoption.json"), "utf8"),
				),
			).minimumReadableOperationSchemaVersion;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let readable = [1];
	try {
		readable = z
			.object({ readableOperationSchemaVersions: z.array(z.number().int().positive()).min(1) })
			.parse(
				JSON.parse(
					await readFile(join(distributionDirectory, TASK_CLOSURE_STORAGE_PROTOCOL_CAPABILITIES_FILENAME), "utf8"),
				),
			).readableOperationSchemaVersions;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!readable.includes(required))
		throw new Error(`候选安装不支持已采用的结案存储协议 v${required}，保留现有安装与归档；不能由旧写入者接管。`);
}
