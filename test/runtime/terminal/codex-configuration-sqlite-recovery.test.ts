import { createHash, randomUUID } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeCodexConfigurationSyncDatabase,
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncLookupStore,
	readCodexConfigurationSyncStore,
	restoreLatestCodexConfigurationSyncLegacyStorage,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	linkCodexSourceSharedPluginInstallationDirectories,
	prepareCodexSourceSharedPluginInstallationDirectoriesBinding,
} from "../../../src/codex-configuration-sync/codex-source-shared-plugin-installation-directories";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { prepareIsolatedCodexConfigurationLegacyStorageFixture } from "../../utilities/prepare-isolated-codex-configuration-legacy-storage-fixture";
import { createTempDir } from "../../utilities/temp-dir";

const injectedFailure = vi.hoisted(() => ({ destinationSuffix: "", phase: "", afterRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof filesystem>();
	return {
		...original,
		rename: async (...arguments_: Parameters<typeof filesystem.rename>) => {
			const matches =
				injectedFailure.destinationSuffix &&
				String(arguments_[1]).endsWith(injectedFailure.destinationSuffix) &&
				(!injectedFailure.phase ||
					JSON.parse(await original.readFile(arguments_[0], "utf8")).phase === injectedFailure.phase);
			if (matches && !injectedFailure.afterRename) {
				injectedFailure.destinationSuffix = "";
				throw new Error("隔离注入迁移文件替换前中断");
			}
			await original.rename(...arguments_);
			if (matches) {
				injectedFailure.destinationSuffix = "";
				throw new Error("隔离注入迁移文件替换后中断");
			}
		},
	};
});

let fixture: ReturnType<typeof createTempDir>;
beforeEach(() => {
	fixture = createTempDir("codex-configuration-sqlite-recovery-");
	vi.stubEnv("HOME", fixture.path);
	Object.assign(injectedFailure, { destinationSuffix: "", phase: "", afterRename: false });
});
afterEach(async () => {
	vi.restoreAllMocks();
	await closeCodexConfigurationSyncDatabase();
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("配置同步持久边界恢复", () => {
	it("回退拒绝被替换的插件父目录，重启后直接回退仍补齐完整准备意图", async () => {
		const home = join(await filesystem.realpath(fixture.path), "isolated-source");
		await filesystem.mkdir(home);
		await filesystem.writeFile(join(home, "config.toml"), 'model = "synthetic-model"\n');
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "auxiliary_process",
			storageHome: home,
			runtimeSessionIncarnationId: randomUUID(),
		});
		const shared = await prepareCodexSourceSharedPluginInstallationDirectoriesBinding({
			sourceHome: home,
			existingBindings: [],
			nativeCapabilityEvidence: {
				nativeBinaryVersion: "codex-cli 0.166.0",
				nativeExecutableRealPath: "/synthetic/codex",
				nativeExecutableIdentityDigest: "synthetic",
				observedAtMs: 1,
			},
		});
		for (const path of [
			join(binding.configurationHomeDirectoryPath, "plugins"),
			join(binding.configurationHomeDirectoryPath, ".tmp"),
		])
			await filesystem.rm(path, { recursive: true, force: true });
		await linkCodexSourceSharedPluginInstallationDirectories(home, binding.configurationHomeDirectoryPath, shared);
		const parent = join(shared.pluginsDirectoryCanonicalPath, ".kanban-source-installation-coordination");
		const intentId = randomUUID();
		const intentPath = join(parent, "native-launch-preparation-intents", `${intentId}.json`);
		const intent = {
			schemaVersion: 1,
			intentId,
			writerId: binding.writerId,
			sourceIdentity: binding.sourceIdentity,
			baseWriterMarketplaceConfigurationDigest: "synthetic",
			effectiveConfigurationToml: 'model = "synthetic-model"\n',
			sourceInstallationStatePath: join(parent, `source-installation-${"0".repeat(64)}.json`),
			status: "pending",
			createdAtMs: 1,
			nextEvidenceObservationAtMs: 1,
		};
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[binding.writerId].binding.sourceSharedPluginInstallationDirectoriesBinding = shared;
			store.writers[binding.writerId].pendingSourceSharedPluginInstallationPreparations = { [intentPath]: intent };
		});
		const outside = join(fixture.path, "outside-bound-plugin-directory");
		await filesystem.mkdir(outside);
		await filesystem.symlink(outside, parent, "dir");
		await expect(restoreLatestCodexConfigurationSyncLegacyStorage()).rejects.toThrow("物理归属");
		expect(await filesystem.readdir(outside)).toEqual([]);
		await closeCodexConfigurationSyncDatabase();
		await filesystem.unlink(parent);
		await expect(restoreLatestCodexConfigurationSyncLegacyStorage()).rejects.toThrow(/回退|旧格式状态/);
		expect(JSON.parse(await filesystem.readFile(intentPath, "utf8"))).toEqual(intent);
		const restored = JSON.parse(
			await filesystem.readFile(
				join(getCodexConfigurationSyncDirectory(), "configuration-sync-storage-authority.json"),
				"utf8",
			),
		);
		expect(restored.phase).toBe("legacy_restored");
	});
	it.each([
		["configuration-sync-state.original.json", "", false],
		["configuration-sync-state.json", "", false],
		["configuration-sync-state.json", "", true],
		["configuration-sync-storage-authority.json", "sqlite_authoritative", false],
		["configuration-sync-storage-authority.json", "sqlite_authoritative", true],
	])("%s 在指定持久边界中断后按同一记录恢复", async (destinationSuffix, phase, afterRename) => {
		const store = await readCodexConfigurationSyncStore();
		store.mutationReceipts.original = { requestDigest: "原始请求摘要", changeId: "原始结果" };
		await prepareIsolatedCodexConfigurationLegacyStorageFixture(fixture.path, store);
		const directory = getCodexConfigurationSyncDirectory();
		const legacyPath = join(directory, "configuration-sync-state.json");
		const originalBytes = await filesystem.readFile(legacyPath);
		await filesystem.chmod(legacyPath, 0o640);
		Object.assign(injectedFailure, { destinationSuffix, phase, afterRename });
		await expect(readCodexConfigurationSyncStore()).rejects.toThrow("隔离注入");
		await closeCodexConfigurationSyncDatabase();
		const restored = await readCodexConfigurationSyncStore();
		expect(restored.mutationReceipts.original).toEqual(store.mutationReceipts.original);
		const authority = JSON.parse(
			await filesystem.readFile(join(directory, "configuration-sync-storage-authority.json"), "utf8"),
		);
		expect(authority.phase).toBe("sqlite_authoritative");
		expect(
			await filesystem.readFile(join(authority.backupDirectory, "configuration-sync-state.original.json")),
		).toEqual(originalBytes);
		const provenance = JSON.parse(
			await filesystem.readFile(
				join(authority.backupDirectory, "configuration-sync-original-file-provenance.json"),
				"utf8",
			),
		);
		expect(provenance.originalFileDigest).toBe(createHash("sha256").update(originalBytes).digest("hex"));
		expect(provenance.mode).toBe(0o640);
	});

	it("提交成功但 worker 回执丢失，重启先读原回执且不重复业务动作", async () => {
		await readCodexConfigurationSyncStore();
		const originalPost = Worker.prototype.postMessage;
		const originalEmit = Worker.prototype.emit;
		let lostRequestId: string | undefined;
		vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message, ...arguments_) {
			if (message.command === "commit" && !lostRequestId) lostRequestId = message.requestId;
			return originalPost.call(this, message, ...arguments_);
		});
		vi.spyOn(Worker.prototype, "emit").mockImplementation(function (this: Worker, event, ...arguments_) {
			const response = arguments_[0] as { requestId?: string; error?: string };
			if (event === "message" && response.requestId === lostRequestId && !response.error) {
				void this.terminate();
				return false;
			}
			return originalEmit.call(this, event, ...arguments_);
		});
		let businessActionCount = 0;
		const action = (store: Awaited<ReturnType<typeof readCodexConfigurationSyncStore>>) => {
			if (store.mutationReceipts.original) return;
			businessActionCount++;
			store.mutationReceipts.original = { requestDigest: "same-request", changeId: "committed-result" };
		};
		await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("worker");
		vi.restoreAllMocks();
		await closeCodexConfigurationSyncDatabase();
		expect(
			(await readCodexConfigurationSyncLookupStore({ receiptKeys: ["original"] })).mutationReceipts.original
				.changeId,
		).toBe("committed-result");
		await mutateCodexConfigurationSyncStore(action);
		expect(businessActionCount).toBe(1);
	});

	it("同一故障三次后跨重启保留预算，数据库恢复可读后自动接续", async () => {
		await readCodexConfigurationSyncStore();
		await closeCodexConfigurationSyncDatabase();
		const directory = getCodexConfigurationSyncDirectory();
		const databasePath = join(directory, "codex-configuration-sync.sqlite");
		const validBytes = await filesystem.readFile(databasePath);
		await filesystem.writeFile(databasePath, "隔离损坏数据库");
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(readCodexConfigurationSyncStore()).rejects.toThrow();
			await closeCodexConfigurationSyncDatabase();
		}
		const recoveryPath = join(directory, "configuration-sync-database-recovery-observation.json");
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(3);
		await expect(readCodexConfigurationSyncStore()).rejects.toThrow("恢复条件");
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(3);
		await filesystem.writeFile(databasePath, validBytes);
		expect((await readCodexConfigurationSyncStore()).storageIdentity).toBeTruthy();
	});

	it("读成功和重新打开不清空写失败预算，健康探测通过后才恢复领域动作", async () => {
		await readCodexConfigurationSyncStore();
		let rejectHealthProbe = false;
		const originalPost = Worker.prototype.postMessage;
		const injectCommitFailure = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			message,
			...arguments_
		) {
			if (message.command === "commit" || (message.command === "storage_health_probe" && rejectHealthProbe)) {
				queueMicrotask(() =>
					this.emit("message", {
						requestId: message.requestId,
						error: "隔离注入数据库写锁争用",
						code: "SQLITE_BUSY",
						metrics: { decodedRows: 0, decodedBytes: 0 },
					}),
				);
				return;
			}
			return originalPost.call(this, message, ...arguments_);
		});
		let businessActionCount = 0;
		const action = () => {
			businessActionCount++;
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("写锁争用");
			await readCodexConfigurationSyncStore();
			await closeCodexConfigurationSyncDatabase();
			await readCodexConfigurationSyncStore();
		}
		const recoveryPath = join(
			getCodexConfigurationSyncDirectory(),
			"configuration-sync-database-recovery-observation.json",
		);
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(3);
		await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("恢复条件");
		expect(businessActionCount).toBe(3);
		const beforeProbe = await readCodexConfigurationSyncStore();
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
		rejectHealthProbe = true;
		await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("写锁争用");
		expect(businessActionCount).toBe(3);
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(3);
		await readCodexConfigurationSyncStore();
		injectCommitFailure.mockRestore();
		clock.mockReturnValue(now + 60_002);
		await mutateCodexConfigurationSyncStore(action);
		expect(businessActionCount).toBe(4);
		expect((await readCodexConfigurationSyncStore()).storageGeneration).toBe(
			(beforeProbe.storageGeneration ?? 0) + 1,
		);
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(0);
	});

	it("无变化提交不能清空真实持久写失败的预算", async () => {
		await readCodexConfigurationSyncStore();
		const originalPost = Worker.prototype.postMessage;
		vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message, ...arguments_) {
			if (message.command === "commit" && message.input.after.mutationReceipts.written) {
				queueMicrotask(() =>
					this.emit("message", {
						requestId: message.requestId,
						error: "隔离注入持久写空间不足",
						code: "SQLITE_FULL",
						metrics: { decodedRows: 0, decodedBytes: 0 },
					}),
				);
				return;
			}
			return originalPost.call(this, message, ...arguments_);
		});
		const action = vi.fn((store: Awaited<ReturnType<typeof readCodexConfigurationSyncStore>>) => {
			store.mutationReceipts.written = { requestDigest: "same-request", changeId: "synthetic-result" };
		});
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt) await mutateCodexConfigurationSyncStore(() => {});
			await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("空间不足");
		}
		const recoveryPath = join(
			getCodexConfigurationSyncDirectory(),
			"configuration-sync-database-recovery-observation.json",
		);
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(3);
		await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("恢复条件");
		expect(action).toHaveBeenCalledTimes(3);
	});

	it("跨进程取锁失败有持久预算，读成功不重置且探测取锁成功后自动接续", async () => {
		await readCodexConfigurationSyncStore();
		const acquire = vi
			.spyOn(lockedFileSystem, "acquireLock")
			.mockRejectedValue(Object.assign(new Error("隔离注入内核写锁争用"), { code: "ELOCKED" }));
		const action = vi.fn();
		for (let attempt = 0; attempt < 3; attempt++) {
			await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("内核写锁争用");
			await readCodexConfigurationSyncStore();
		}
		const recoveryPath = join(
			getCodexConfigurationSyncDirectory(),
			"configuration-sync-database-recovery-observation.json",
		);
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(3);
		await expect(mutateCodexConfigurationSyncStore(action)).rejects.toThrow("恢复条件");
		expect(acquire).toHaveBeenCalledTimes(3);
		expect(action).not.toHaveBeenCalled();
		acquire.mockRestore();
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
		await mutateCodexConfigurationSyncStore(action);
		expect(action).toHaveBeenCalledOnce();
		expect(JSON.parse(await filesystem.readFile(recoveryPath, "utf8")).attemptCount).toBe(0);
	});

	it("活连接发现数据库物理替换后，重新核验同一存储身份并自动重开", async () => {
		const original = await readCodexConfigurationSyncStore();
		await closeCodexConfigurationSyncDatabase();
		const path = join(getCodexConfigurationSyncDirectory(), "codex-configuration-sync.sqlite");
		const backup = await filesystem.readFile(path);
		await readCodexConfigurationSyncStore();
		await filesystem.writeFile(`${path}.restored`, backup);
		await filesystem.rename(`${path}.restored`, path);
		await expect(readCodexConfigurationSyncStore()).rejects.toThrow("物理身份");
		expect((await readCodexConfigurationSyncStore()).storageIdentity).toBe(original.storageIdentity);
	});

	it.each([false, true])("回退清单替换中断（已替换=%s）后恢复最新导出，保持新写入关闭", async (afterRename) => {
		await mutateCodexConfigurationSyncStore((store) => {
			store.mutationReceipts.latest = { requestDigest: "latest", changeId: "latest" };
		});
		Object.assign(injectedFailure, {
			destinationSuffix: "configuration-sync-storage-authority.json",
			phase: "legacy_rollback_prepared",
			afterRename,
		});
		await expect(restoreLatestCodexConfigurationSyncLegacyStorage()).rejects.toThrow("隔离注入");
		await closeCodexConfigurationSyncDatabase();
		await expect(readCodexConfigurationSyncStore()).rejects.toThrow(/回退|旧格式状态/);
		const legacy = JSON.parse(
			await filesystem.readFile(join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"), "utf8"),
		);
		expect(legacy.mutationReceipts.latest.changeId).toBe("latest");
	});
});
