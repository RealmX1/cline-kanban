import type * as NodeFsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTaskClosureArchiveVolumeAdmission } from "../../../src/task-closure/task-closure-archive-resource-admission";
import {
	beginTaskClosureAutomaticSideEffect,
	getTaskClosureAutomaticRecoveryState,
	isTaskClosureAutomaticRecoveryEligible,
	recordTaskClosureAutomaticFailure,
} from "../../../src/task-closure/task-closure-automatic-recovery-policy";
import { readTaskClosureRecoveryEvidence } from "../../../src/task-closure/task-closure-failure-recovery-evidence";
import type { TaskClosureOperation } from "../../../src/task-closure/task-closure-operation-store";

const volumeHarness = vi.hoisted(() => ({
	objectVolumeAvailableBytes: 100_000,
	commonMetadataVolumeAvailableBytes: 100_000,
	commonMetadataDeviceId: 3,
	locks: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof NodeFsPromises>()),
	lstat: vi.fn(async (path: string) => ({
		dev:
			path === "/isolated-git-objects"
				? 2
				: path === "/isolated-git-common-metadata"
					? volumeHarness.commonMetadataDeviceId
					: 1,
		isDirectory: () => true,
	})),
	realpath: vi.fn(async (path: string) => path),
	readdir: vi.fn(async () => []),
	statfs: vi.fn(async (path: string) => ({
		bavail:
			path === "/isolated-git-objects"
				? volumeHarness.objectVolumeAvailableBytes
				: path === "/isolated-git-common-metadata"
					? volumeHarness.commonMetadataVolumeAvailableBytes
					: 100_000,
		bsize: 1,
	})),
}));
vi.mock("../../../src/workspace/git-utils", () => ({
	getGitStdout: vi.fn(async (arguments_: string[]) =>
		arguments_.includes("--git-common-dir") ? "/isolated-git-common-metadata" : "/isolated-git-objects",
	),
}));
vi.mock("../../../src/fs/locked-file-system", () => ({
	lockedFileSystem: {
		withLocks: async (locks: { path: string }[], action: () => Promise<unknown>) => {
			volumeHarness.locks = locks.map((lock) => lock.path);
			return action();
		},
	},
}));
vi.mock("../../../src/task-closure/task-closure-operation-store", () => ({
	ensurePrivateTaskClosureArtifactDirectory: vi.fn(async () => "/isolated-archive-volume"),
	assertTaskClosureLifecycleNotCancelled: vi.fn(async () => undefined),
	writeTaskClosureOperation: vi.fn(async () => undefined),
	writeTaskClosureAutomaticAttemptReceipt: vi.fn(async () => undefined),
}));
beforeEach(() => {
	volumeHarness.objectVolumeAvailableBytes = 100_000;
	volumeHarness.commonMetadataVolumeAvailableBytes = 100_000;
	volumeHarness.commonMetadataDeviceId = 3;
	volumeHarness.locks = [];
});
afterEach(() => vi.restoreAllMocks());

describe("结案归档、Git 对象库与 common 元数据跨卷空间门禁", () => {
	it.each([
		[false, "objects"],
		[true, "objects"],
		[false, "common_metadata"],
		[true, "common_metadata"],
	] as const)(
		"restoringOnly=%s 时 %s 卷不足不能开始副作用，原预算观察同一卷恢复",
		async (restoringOnly, lowVolume) => {
			const operation = {
				schemaVersion: 2,
				taskIdentity: { workspaceId: "isolated-workspace", taskId: "abc12", taskIncarnationCreatedAtEpochMs: 1 },
				workspacePath: "/isolated-source",
				sourceWorktreePath: null,
				progress: { closureRequestId: "22222222-2222-4222-8222-222222222222", attemptCount: 0 },
				archiveStorageLimits: {
					maximumArchivePayloadBytes: 100,
					maximumRestorationWorkspaceBytes: 100,
					minimumRemainingVolumeStorageBytes: 10,
				},
			} as TaskClosureOperation;
			const action = vi.fn(async () => undefined);
			if (lowVolume === "objects") volumeHarness.objectVolumeAvailableBytes = 0;
			else volumeHarness.commonMetadataVolumeAvailableBytes = 0;
			await beginTaskClosureAutomaticSideEffect(operation, restoringOnly ? "restore_archive" : "preserve_archive");
			await expect(withTaskClosureArchiveVolumeAdmission(operation, restoringOnly, action)).rejects.toThrow(
				"未开始复制",
			);
			expect(action).not.toHaveBeenCalled();
			expect(volumeHarness.locks).toEqual([
				expect.stringContaining("/1"),
				expect.stringContaining("/2"),
				expect.stringContaining("/3"),
			]);
			await recordTaskClosureAutomaticFailure(operation, new Error("ENOSPC: No space left on device"));
			expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(false);
			expect(
				(await readTaskClosureRecoveryEvidence(operation, "insufficient_storage_space")).prerequisiteSatisfied,
			).toBe(false);
			volumeHarness.objectVolumeAvailableBytes = 100_000;
			volumeHarness.commonMetadataVolumeAvailableBytes = 100_000;
			expect(
				(await readTaskClosureRecoveryEvidence(operation, "insufficient_storage_space")).prerequisiteSatisfied,
			).toBe(true);
			expect(await isTaskClosureAutomaticRecoveryEligible(operation)).toBe(true);
			await beginTaskClosureAutomaticSideEffect(operation, restoringOnly ? "restore_archive" : "preserve_archive");
			expect(getTaskClosureAutomaticRecoveryState(operation).automaticAttemptCount).toBe(2);
			await withTaskClosureArchiveVolumeAdmission(operation, restoringOnly, action);
			expect(action).toHaveBeenCalledOnce();
			volumeHarness.commonMetadataDeviceId = 2;
			await withTaskClosureArchiveVolumeAdmission(operation, restoringOnly, action);
			expect(volumeHarness.locks).toEqual([expect.stringContaining("/1"), expect.stringContaining("/2")]);
		},
	);
});
