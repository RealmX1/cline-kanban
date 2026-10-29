import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readPosixProcessResourceTable } from "../../diagnostics/posix-process-table-with-resource-columns-reader";
import { lockedFileSystem } from "../../fs/locked-file-system";
import type { AgentSessionPtyHostRuntimeIdentity } from "./agent-session-pty-host-socket-path-for-runtime-identity";

const runtimeControllerOwnerSchema = z.object({
	processId: z.number().int().positive(),
	processStartTimeText: z.string(),
	ownershipToken: z.string(),
});

export class AgentSessionPtyHostRuntimeControllerOwnershipError extends Error {}

// 持久所有权与短文件锁分开：活 runtime 的身份不能因锁心跳迟到而被另一 runtime 抢走。
export async function claimAgentSessionPtyHostRuntimeControllerOwnership(
	identity: AgentSessionPtyHostRuntimeIdentity,
): Promise<{
	processStartTimeText: string;
	release: () => Promise<void>;
}> {
	const ownerFilePath = join(
		identity.runtimeHomeDirectoryPath,
		"agent-session-pty-host",
		`p${identity.runtimePort}-runtime-controller-owner.json`,
	);
	const ownershipToken = randomUUID();
	const readOwner = async () => {
		try {
			return runtimeControllerOwnerSchema.parse(JSON.parse(await readFile(ownerFilePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	};
	const processStartTimeText = await lockedFileSystem.withLocks([{ path: ownerFilePath }], async () => {
		const processes = await readPosixProcessResourceTable();
		const currentProcess = processes.find((entry) => entry.processId === process.pid);
		if (!currentProcess)
			throw new AgentSessionPtyHostRuntimeControllerOwnershipError("无法核对当前 runtime 的进程启动身份");
		const owner = await readOwner();
		if (
			owner &&
			processes.some(
				(entry) => entry.processId === owner.processId && entry.processStartTimeText === owner.processStartTimeText,
			)
		) {
			throw new AgentSessionPtyHostRuntimeControllerOwnershipError(
				`runtime 身份已由 pid=${owner.processId}@${owner.processStartTimeText} 持有，拒绝握手与接管`,
			);
		}
		if (owner) {
			try {
				process.kill(owner.processId, 0);
				if (!processes.some((entry) => entry.processId === owner.processId))
					throw new AgentSessionPtyHostRuntimeControllerOwnershipError(
						"原 runtime 仍可能存活，进程表缺证，保留所有权",
					);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		await lockedFileSystem.writeJsonFileAtomic(
			ownerFilePath,
			{
				processId: process.pid,
				processStartTimeText: currentProcess.processStartTimeText,
				ownershipToken,
			},
			{ lock: null, durable: true, fileMode: 0o600 },
		);
		return currentProcess.processStartTimeText;
	});
	return {
		processStartTimeText,
		release: async () => {
			await lockedFileSystem.withLocks([{ path: ownerFilePath }], async () => {
				if ((await readOwner())?.ownershipToken === ownershipToken) await rm(ownerFilePath);
			});
		},
	};
}
