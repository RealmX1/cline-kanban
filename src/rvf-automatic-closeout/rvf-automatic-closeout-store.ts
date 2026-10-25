import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	type RvfAutomaticCloseoutRecord,
	rvfAutomaticCloseoutRecordSchema,
} from "../core/rvf-automatic-closeout-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath } from "../state/workspace-state";

export class RvfAutomaticCloseoutRecordOperationClaimLostError extends Error {}

export async function withRvfAutomaticCloseoutRecordOperationLock(
	storePath: string,
	decisionToken: string,
	operation: (assertOperationLockStillOwned: () => void) => Promise<void>,
): Promise<void> {
	// 副作用锁独立于 JSON 短写锁，恢复中仍能 save，用户也能随时持久暂停。
	const tokenDigest = createHash("sha256").update(decisionToken).digest("hex");
	let enteredOperation = false;
	let lockCompromised = false;
	try {
		await lockedFileSystem.withLocks(
			[
				{
					path: `${storePath}.record-operation-${tokenDigest}`,
					retries: 0,
					onCompromised: () => {
						lockCompromised = true;
					},
				},
			],
			async () => {
				enteredOperation = true;
				await operation(() => {
					if (lockCompromised)
						throw new RvfAutomaticCloseoutRecordOperationClaimLostError("自动收尾记录操作锁已失效。");
				});
			},
		);
	} catch (error) {
		if (!enteredOperation && (error as NodeJS.ErrnoException).code === "ELOCKED") return;
		throw error;
	}
}

export function getRvfAutomaticCloseoutStorePath(workspaceId: string): string {
	const directory = resolve(getWorkspaceDirectoryPath(workspaceId));
	if (dirname(directory) !== resolve(getWorkspacesRootPath())) throw new Error("非法 workspaceId。");
	return join(directory, "rvf-automatic-rewind-and-closeout-records.json");
}
export async function readRvfAutomaticCloseoutRecords(path: string): Promise<RvfAutomaticCloseoutRecord[]> {
	try {
		return z.array(rvfAutomaticCloseoutRecordSchema).parse(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
export async function updateRvfAutomaticCloseoutRecords<T>(
	path: string,
	operation: (
		records: RvfAutomaticCloseoutRecord[],
	) =>
		| { records: RvfAutomaticCloseoutRecord[]; value: T }
		| Promise<{ records: RvfAutomaticCloseoutRecord[]; value: T }>,
): Promise<T> {
	return lockedFileSystem.withLocks([{ path }], async () => {
		const outcome = await operation(await readRvfAutomaticCloseoutRecords(path));
		const parsed = z.array(rvfAutomaticCloseoutRecordSchema).parse(outcome.records);
		await lockedFileSystem.writeJsonFileAtomic(path, parsed, { lock: null });
		return outcome.value;
	});
}
