import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodexConfigurationSyncService,
	createCodexConfigurationSyncService,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import * as configurationSyncStore from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
	type StoredCodexConfigurationChange,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareIsolatedCodexConfigurationLegacyStorageFixture } from "../../utilities/prepare-isolated-codex-configuration-legacy-storage-fixture";
import { createTempDir } from "../../utilities/temp-dir";

const persistence = vi.hoisted(() => ({ reads: 0, replacements: 0, syncs: 0, failNextDirectorySync: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof filesystem>();
	return {
		...original,
		readFile: async (...arguments_: Parameters<typeof filesystem.readFile>) => {
			if (String(arguments_[0]).endsWith("/configuration-sync-state.json")) persistence.reads++;
			return original.readFile(...arguments_);
		},
		rename: vi.fn<typeof filesystem.rename>(async (...arguments_) => {
			if (String(arguments_[1]).endsWith("/configuration-sync-state.json")) persistence.replacements++;
			return original.rename(...arguments_);
		}),
		open: vi.fn<typeof filesystem.open>(async (...arguments_) => {
			const handle = await original.open(...arguments_);
			const path = String(arguments_[0]);
			if (
				path.endsWith("pending-configuration-sync-state.json") ||
				path.endsWith("codex-configuration-writer-bindings-and-sync")
			) {
				const sync = handle.sync.bind(handle);
				handle.sync = async () => {
					persistence.syncs++;
					if (persistence.failNextDirectorySync && path.endsWith("codex-configuration-writer-bindings-and-sync")) {
						persistence.failNextDirectorySync = false;
						throw new Error("隔离模拟原子替换成功后目录同步失败");
					}
					await sync();
				};
			}
			return handle;
		}),
	};
});

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let services: CodexConfigurationSyncService[];
const modelFieldKey = JSON.stringify(["config.toml", "model"]);
function resetPersistenceCounts() {
	persistence.reads = 0;
	persistence.replacements = 0;
	persistence.syncs = 0;
}
function service(dependencies: Partial<Parameters<typeof createCodexConfigurationSyncService>[0]> = {}) {
	const instance = createCodexConfigurationSyncService({
		getSessionSummary: () => null,
		listSessions: () => [],
		onUpdated: () => {},
		...dependencies,
	});
	services.push(instance);
	return instance;
}
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-sync-efficiency-");
	fixture.path = await filesystem.realpath(fixture.path);
	sourceHome = join(fixture.path, "isolated-codex-home");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, "isolated-codex-sqlite-home"));
	await filesystem.mkdir(sourceHome);
	await filesystem.writeFile(join(sourceHome, "config.toml"), 'model = "synthetic-model"\n');
	services = [];
	resetPersistenceCounts();
	persistence.failNextDirectorySync = false;
});
afterEach(async () => {
	await Promise.all(services.map((instance) => instance.close()));
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
async function prepareWriter() {
	return prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		workspaceId: "efficiency-fixture",
		conversationSessionId: "synthetic-session",
		runtimeSessionIncarnationId: "00000000-0000-0000-0000-000000000000",
	});
}

describe("Codex 配置扫描和查询的持久化开销", () => {
	it("相同业务请求跨 active/full 响应范围重放，沿用原幂等回执", async () => {
		await prepareWriter();
		const instance = service();
		const store = await readCodexConfigurationSyncStore();
		if (!store.defaultCodexConfigurationProfileId) throw new Error("缺少隔离初始 profile");
		const input = {
			action: "create" as const,
			name: "跨响应范围",
			copyFromProfileId: store.defaultCodexConfigurationProfileId,
			idempotencyKey: "same-business-request",
		};
		const active = await instance.mutateProfile({ ...input, stateResponseScope: "active" });
		const full = await instance.mutateProfile({ ...input, stateResponseScope: "full" });
		expect(active.stateResponseScope).toBe("active");
		expect(full.stateResponseScope).toBe("full");
		expect(full.profiles?.filter((profile) => profile.name === input.name)).toHaveLength(1);
		expect(full.revision).toBe(active.revision);
	});
	it("无浏览器时启动扫描、目录监听与五秒补扫仍自动收敛", async () => {
		const binding = await prepareWriter();
		const updated = vi.fn();
		const interval = vi.spyOn(globalThis, "setInterval");
		const instance = service({ onUpdated: updated });
		instance.start();
		await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1), { timeout: 10_000 });
		const periodicScan = interval.mock.calls.find(([, delay]) => delay === 5000)?.[0];
		if (!periodicScan) throw new Error("缺少五秒补扫");
		const configurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
		await filesystem.writeFile(configurationPath, 'model = "synthetic-watcher-change"\n');
		await vi.waitFor(() => expect(updated.mock.calls.length).toBeGreaterThan(1), { timeout: 10_000 });
		expect(
			(await readCodexConfigurationSyncStore()).changes.some(
				(change) => change.value?.value === "synthetic-watcher-change",
			),
		).toBe(true);
		await mutateCodexConfigurationSyncStore((store) => {
			const change = store.changes.find((change) => change.approvalStatus === "pending");
			if (!change) throw new Error("缺少待过期合成建议");
			change.feedbackExpiresAtMs = Date.now() - 1;
		});
		periodicScan();
		await vi.waitFor(
			async () =>
				expect((await instance.getState()).changes.some((change) => change.approvalStatus === "expired")).toBe(
					true,
				),
			{ timeout: 10_000 },
		);
	});
	it("稳定后连续十次空闲扫描不写正文或 fsync", async () => {
		await prepareWriter();
		const instance = service();
		await instance.scan();
		resetPersistenceCounts();
		for (let index = 0; index < 10; index++) await instance.scan();
		expect(persistence.replacements).toBe(0);
		expect(persistence.syncs).toBe(0);
	});
	it("没有 revision 变化的 writer 文件清单仍会持久保存", async () => {
		const binding = await prepareWriter();
		const instance = service();
		await instance.scan();
		const revision = (await readCodexConfigurationSyncStore()).revision;
		await filesystem.writeFile(join(binding.configurationHomeDirectoryPath, "synthetic-extra.config.toml"), "");
		await instance.scan();
		const stored = await readCodexConfigurationSyncStore();
		expect(stored.revision).toBe(revision);
		expect(stored.writers[binding.writerId].fileNames).toContain("synthetic-extra.config.toml");
	});
	it("首次观察创建正文，旧 schema 迁移也保存且后续稳定", async () => {
		const instance = service();
		await instance.scan();
		expect(persistence.replacements).toBe(1);
		const previous = await readCodexConfigurationSyncStore();
		previous.schemaVersion = 2;
		await prepareIsolatedCodexConfigurationLegacyStorageFixture(fixture.path, previous);
		resetPersistenceCounts();
		await instance.scan();
		expect((await readCodexConfigurationSyncStore()).schemaVersion).toBe(3);
		expect(persistence.replacements).toBe(1);
		await instance.scan();
		expect(persistence.replacements).toBe(1);
	});
	it("迁移权威清单同步失败后，从持久意图恢复，再幂等保存明确操作", async () => {
		const operation = vi.fn((store: Awaited<ReturnType<typeof readCodexConfigurationSyncStore>>) => {
			store.mutationReceipts["synthetic-request"] ??= { requestDigest: "same-digest", changeId: "synthetic-change" };
		});
		persistence.failNextDirectorySync = process.platform !== "win32";
		if (process.platform !== "win32")
			await expect(mutateCodexConfigurationSyncStore(operation)).rejects.toThrow("目录同步失败");
		else await mutateCodexConfigurationSyncStore(operation);
		resetPersistenceCounts();
		await mutateCodexConfigurationSyncStore(operation);
		expect(persistence.replacements).toBe(1);
		expect((await readCodexConfigurationSyncStore()).mutationReceipts["synthetic-request"]).toEqual({
			requestDigest: "same-digest",
			changeId: "synthetic-change",
		});
		const generation = (await readCodexConfigurationSyncStore()).storageGeneration;
		await mutateCodexConfigurationSyncStore(operation);
		expect((await readCodexConfigurationSyncStore()).storageGeneration).toBe(generation);
		expect(operation).toHaveBeenCalledTimes(process.platform === "win32" ? 3 : 2);
	});
	it("重复和并发查询只读持久状态，不调用观察、原生请求或续接", async () => {
		await prepareWriter();
		const observe = vi.fn(async () => ({ bindings: [], unavailableWorkspaceCount: 0 }));
		const native = vi.fn();
		const resume = vi.fn();
		const instance = service({
			listTaskProfileBindings: observe,
			withOwnerConnection: native,
			resumeSessionToAdoptProfile: resume,
		});
		resetPersistenceCounts();
		await Promise.all(Array.from({ length: 10 }, () => instance.getState()));
		expect(observe).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();
		expect(resume).not.toHaveBeenCalled();
		expect(persistence.reads).toBe(0);
		expect(persistence.replacements).toBe(0);
	});
	it("恢复阻塞时查询仍返回，并保留与观察并发的明确操作", async () => {
		await prepareWriter();
		let confirmEntered: () => void = () => {};
		let releaseRecovery: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			confirmEntered = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseRecovery = resolve;
		});
		const instance = service({
			reconcileRetainedTerminalInput: async () => {
				confirmEntered();
				await release;
			},
		});
		const scanning = instance.scan();
		await entered;
		try {
			await mutateCodexConfigurationSyncStore((store) => {
				store.mutationReceipts["concurrent-request"] = {
					requestDigest: "concurrent-digest",
					changeId: "concurrent-change",
				};
			});
			const query = instance.getState();
			let recoveryReleasedAtDeadline = false;
			const deadline = setTimeout(() => {
				recoveryReleasedAtDeadline = true;
				releaseRecovery();
			}, 1000);
			try {
				await query;
				expect(recoveryReleasedAtDeadline).toBe(false);
			} finally {
				clearTimeout(deadline);
			}
		} finally {
			releaseRecovery();
			await scanning;
		}
		expect((await readCodexConfigurationSyncStore()).mutationReceipts["concurrent-request"].requestDigest).toBe(
			"concurrent-digest",
		);
	});
	it("固定待恢复数量时增加终态历史不增加逐目标状态读取，新增 accepted 仍推进", async () => {
		const binding = await prepareWriter();
		const instance = service({ resumeSessionToAdoptProfile: vi.fn() });
		const seed = (
			status: StoredCodexConfigurationChange["targets"][number]["status"],
			index: number,
		): StoredCodexConfigurationChange => ({
			changeId: `synthetic-change-${index}`,
			version: index,
			sourceWriterId: binding.writerId,
			sourceIdentity: binding.sourceIdentity,
			fieldKey: modelFieldKey,
			value: { value: "synthetic-model" },
			observedAt: 1,
			recordKind: "settings_proposal",
			approvalStatus: "approved",
			mergeStatus: "shared_default_updated",
			acknowledgedAt: null,
			targets: [
				{
					writerId: binding.writerId,
					workspaceId: "efficiency-fixture",
					conversationSessionId: "synthetic-session",
					status,
					reason: "合成历史",
					recoveryCondition: null,
					acceptedAt: 1,
					diskSavedAt: null,
					ownerReloadedAt: null,
					attemptCount: 0,
				},
			],
		});
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes = [seed("pending_next_start", 0)];
		});
		await instance.scan();
		resetPersistenceCounts();
		await instance.scan();
		const initialReads = persistence.reads;
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(
				...Array.from({ length: 60 }, (_, index) =>
					seed((["applied", "conflict", "not_applicable"] as const)[index % 3], index + 1),
				),
			);
		});
		resetPersistenceCounts();
		await instance.scan();
		expect(persistence.reads).toBe(initialReads);
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(seed("accepted", 100));
		});
		await instance.scan();
		expect((await readCodexConfigurationSyncStore()).changes.at(-1)?.targets[0].status).toBe("pending_next_start");
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(...Array.from({ length: 40 }, (_, index) => seed("pending_next_start", index + 200)));
		});
		const activeReads = vi.spyOn(configurationSyncStore, "readCodexConfigurationSyncActiveStore");
		const targetedReads = vi.spyOn(configurationSyncStore, "readCodexConfigurationSyncLookupStore");
		await instance.scan();
		expect(activeReads.mock.calls.length).toBeLessThan(10);
		expect(targetedReads).not.toHaveBeenCalled();
	});
});
