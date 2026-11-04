import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	compareNativeProcessStartIdentities,
	readNativeProcessOwnershipSnapshot,
	readNativeSystemBootIdentity,
} from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { z } from "zod";
import { WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME } from "../state/workspace-state-snapshot-storage";

// 清单由部署编排在关闭旧写入启动入口后生成；只有进程缺席、启动身份改变或真实 boot 改变才证明旧写入者退出。
export const filesystemLockProtocolRetiringWriterInventorySchema = z.object({
	schemaVersion: z.literal(1),
	candidateSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
	runtimeHomeDirectoryPath: z.string().refine(isAbsolute),
	writerLaunchAdmissionClosed: z.literal(true),
	retiringWriterInventoryComplete: z.literal(true),
	systemBootIdentity: z.string().min(1),
	retiringWriterProcessIdentities: z.array(
		z.object({ processId: z.number().int().positive(), startIdentity: z.string().min(1) }),
	),
	retiringWriterCommandPathPrefixes: z.array(z.string().refine(isAbsolute)).min(1),
});
export type FilesystemLockProtocolRetiringWriterInventory = z.infer<
	typeof filesystemLockProtocolRetiringWriterInventorySchema
>;

type NativeProcessSnapshot = Awaited<ReturnType<typeof readNativeProcessOwnershipSnapshot>>;
export interface FilesystemLockProtocolTransitionPreflightAssessment {
	status:
		| "ready_for_protocol_switch"
		| "waiting_for_retiring_writers"
		| "waiting_for_snapshot_projection"
		| "evidence_unavailable";
	checkedAtEpochMs: number;
	candidateSourceCommit: string;
	blockingProcessIds: number[];
	pendingSnapshotWorkspaceIds: string[];
	recoveryCondition: string | null;
	nextCheckAtEpochMs: number | null;
}

function commandReferencesRetiringWriterPathPrefix(commandArgumentsText: string | undefined, prefix: string): boolean {
	// ps 不保留 argv 边界，不能把拼接文本片段当作完整路径豁免；URI、shell 展开和物理别名仍保守阻断。
	return Boolean(
		commandArgumentsText &&
			[prefix, pathToFileURL(prefix).href].some((pathReference) => commandArgumentsText.includes(pathReference)),
	);
}

export function assessFilesystemLockProtocolTransitionPreflight(input: {
	inventory: FilesystemLockProtocolRetiringWriterInventory;
	currentSystemBootIdentity: string | null;
	currentProcessSnapshot: NativeProcessSnapshot | null;
	pendingSnapshotWorkspaceIds: string[] | null;
	direction: "activate_kernel_write_locks" | "rollback_to_legacy_locks";
}): FilesystemLockProtocolTransitionPreflightAssessment {
	const inventory = filesystemLockProtocolRetiringWriterInventorySchema.parse(input.inventory);
	const observedAtEpochMs = Date.now();
	const base = {
		checkedAtEpochMs: observedAtEpochMs,
		candidateSourceCommit: inventory.candidateSourceCommit,
		blockingProcessIds: [] as number[],
		pendingSnapshotWorkspaceIds: input.pendingSnapshotWorkspaceIds ?? [],
		nextCheckAtEpochMs: observedAtEpochMs + 15_000,
	};
	if (!input.currentSystemBootIdentity || !input.currentProcessSnapshot || input.pendingSnapshotWorkspaceIds === null)
		return {
			...base,
			status: "evidence_unavailable",
			recoveryCondition: "原生进程表、boot identity 或快照清单恢复可读后自动重验。",
		};
	let unprovenProcessIdentity = false;
	const blockingProcessIds = new Set<number>();
	if (input.currentSystemBootIdentity === inventory.systemBootIdentity) {
		for (const writer of inventory.retiringWriterProcessIdentities) {
			const comparison = compareNativeProcessStartIdentities(
				input.currentProcessSnapshot.get(writer.processId)?.startIdentity,
				writer.startIdentity,
			);
			if (comparison === "same") blockingProcessIds.add(writer.processId);
			if (comparison === "unknown") unprovenProcessIdentity = true;
		}
	}
	// 即使清单进程已退，新派生的旧命令仍阻止切换；路径范围须覆盖 runtime、CLI、hook 与 Codex 直接写入入口。
	for (const observed of input.currentProcessSnapshot.values()) {
		// 专用检查器是只读观察者；显式旧 owner 清单仍按上面的原生身份独立阻断。
		if (observed.processPid === process.pid) continue;
		if (
			inventory.retiringWriterCommandPathPrefixes.some((prefix) =>
				commandReferencesRetiringWriterPathPrefix(observed.commandArgumentsText, prefix),
			)
		)
			blockingProcessIds.add(observed.processPid);
	}
	if (blockingProcessIds.size)
		return {
			...base,
			blockingProcessIds: [...blockingProcessIds].sort((a, b) => a - b),
			status: "waiting_for_retiring_writers",
			recoveryCondition: "保持启动入口关闭；旧写入进程及其所属会话自然结束后自动重验，不强杀会话。",
		};
	if (unprovenProcessIdentity)
		return {
			...base,
			status: "evidence_unavailable",
			recoveryCondition: "旧进程启动身份可核对、进程在完整表中缺席或真实 boot 改变后自动重验。",
		};
	if (input.direction === "rollback_to_legacy_locks" && input.pendingSnapshotWorkspaceIds.length)
		return {
			...base,
			status: "waiting_for_snapshot_projection",
			recoveryCondition: "在新协议锁内完成全部待投影日志，再重验回退资格。",
		};
	return { ...base, status: "ready_for_protocol_switch", recoveryCondition: null, nextCheckAtEpochMs: null };
}

export async function inspectFilesystemLockProtocolTransitionPreflight(input: {
	inventory: FilesystemLockProtocolRetiringWriterInventory;
	expectedCandidateSourceCommit: string;
	expectedRuntimeHomeDirectoryPath: string;
	direction: "activate_kernel_write_locks" | "rollback_to_legacy_locks";
}): Promise<FilesystemLockProtocolTransitionPreflightAssessment> {
	const inventory = filesystemLockProtocolRetiringWriterInventorySchema.parse(input.inventory);
	if (
		inventory.candidateSourceCommit !== input.expectedCandidateSourceCommit ||
		resolve(inventory.runtimeHomeDirectoryPath) !== resolve(input.expectedRuntimeHomeDirectoryPath)
	)
		throw new Error("协议切换清单不属于本次候选或 runtime home，未放行部署。");
	const [boot, processes, pending] = await Promise.allSettled([
		readNativeSystemBootIdentity(),
		readNativeProcessOwnershipSnapshot(),
		(async () => {
			const directory = join(inventory.runtimeHomeDirectoryPath, "workspaces");
			let entries: Dirent[];
			try {
				entries = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
			const workspaceIds: string[] = [];
			for (const entry of entries) {
				if (entry.isSymbolicLink()) throw new Error("workspace 清单包含软链，待投影日志范围尚未核实。");
				if (!entry.isDirectory()) continue;
				const names = await readdir(join(directory, entry.name));
				if (names.includes(WORKSPACE_STATE_SNAPSHOT_COMMIT_FILENAME)) workspaceIds.push(entry.name);
			}
			return workspaceIds;
		})(),
	]);
	return assessFilesystemLockProtocolTransitionPreflight({
		inventory,
		currentSystemBootIdentity: boot.status === "fulfilled" ? boot.value : null,
		currentProcessSnapshot: processes.status === "fulfilled" ? processes.value : null,
		pendingSnapshotWorkspaceIds: pending.status === "fulfilled" ? pending.value : null,
		direction: input.direction,
	});
}
