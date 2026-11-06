import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serialize } from "node:v8";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeCodexConfigurationSyncDatabase,
	getCodexConfigurationSyncDirectory,
	listCodexConfigurationSyncStoredHistory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncActiveQueryPlans,
	readCodexConfigurationSyncActiveStore,
	readCodexConfigurationSyncLookupStore,
	readCodexConfigurationSyncStorageMetrics,
	readCodexConfigurationSyncStore,
	restoreLatestCodexConfigurationSyncLegacyStorage,
	type StoredCodexConfigurationChange,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(() => {
	fixture = createTempDir("codex-configuration-sqlite-storage-");
	vi.stubEnv("HOME", fixture.path);
});
afterEach(async () => {
	await closeCodexConfigurationSyncDatabase();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
function historicalChange(index: number): StoredCodexConfigurationChange {
	return {
		changeId: `historical-change-${index}`,
		version: index + 1,
		sourceWriterId: "historical-writer",
		sourceIdentity: "historical-source",
		fieldKey: '["config.toml","model"]',
		observedAt: index,
		recordKind: "historical_record",
		approvalStatus: "historical",
		mergeStatus: "kept_shared_value",
		acknowledgedAt: index,
		targets: [],
	};
}
describe("配置同步 SQLite 权威存储", () => {
	it("服务端搜索覆盖历史绑定会话、字段显示名称及提醒的全部原始关联", async () => {
		const home = join(fixture.path, "isolated-source");
		await mkdir(home);
		await writeFile(join(home, "config.toml"), 'model = "synthetic-model"\n');
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: home,
			workspaceId: "search-workspace",
			conversationSessionId: "search-session",
			runtimeSessionIncarnationId: "00000000-0000-0000-0000-000000000000",
		});
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push({
				...historicalChange(0),
				sourceWriterId: binding.writerId,
				sourceIdentity: binding.sourceIdentity,
			});
			store.changes.push({
				...historicalChange(1),
				recordKind: "source_observation",
				sourceWriterId: binding.writerId,
				modificationInitiator: { status: "unknown", description: "只存在于旧关联的搜索证据" },
			});
			store.changes.push({ ...historicalChange(2), recordKind: "source_observation" });
			store.sourceObservations.push({
				observationId: "processed-source",
				version: 1,
				sourceIdentity: binding.sourceIdentity,
				sourceKey: "source-key",
				sourceLabel: "已处理来源",
				firstObservedAt: 1,
				observedAt: 2,
				observationCount: 2,
				detectedLocationCount: 1,
				acknowledgedAt: 3,
				reminderDisposition: "deferred",
				rawChangeIds: ["historical-change-1", "historical-change-2"],
				detectedWriterIds: [binding.writerId],
			});
		});
		for (const search of ["search-workspace", "search-session", "config.toml · model"])
			expect((await listCodexConfigurationSyncStoredHistory({ category: "settings", search })).entries).toHaveLength(
				1,
			);
		expect(
			(await listCodexConfigurationSyncStoredHistory({ category: "sources", search: "只存在于旧关联" })).entries.map(
				(entry) => entry.entry_id,
			),
		).toEqual(["processed-source"]);
	});
	it("保留完整历史和回执，但活跃快照不随终态历史增长", async () => {
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes = Array.from({ length: 100 }, (_, index) => historicalChange(index));
			store.mutationReceipts.original = { requestDigest: "original-digest", changeId: "historical-change-0" };
		});
		const active = await readCodexConfigurationSyncActiveStore();
		expect(active.changes).toHaveLength(0);
		expect(active.storageGeneration).toBeGreaterThan(0);
		const full = await readCodexConfigurationSyncStore();
		expect(full.changes).toHaveLength(100);
		expect(full.mutationReceipts.original.requestDigest).toBe("original-digest");
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(...Array.from({ length: 900 }, (_, index) => historicalChange(index + 100)));
		});
		expect((await readCodexConfigurationSyncActiveStore()).changes).toHaveLength(0);
		expect((await readCodexConfigurationSyncStore()).changes).toHaveLength(1000);
	});
	it("无变化观察不推进提交代数，相同业务 revision 的修改仍推进代数", async () => {
		const initial = await readCodexConfigurationSyncStore();
		await mutateCodexConfigurationSyncStore(() => {}, { skipUnchangedObservationPersistence: true });
		expect((await readCodexConfigurationSyncStore()).storageGeneration).toBe(initial.storageGeneration);
		await mutateCodexConfigurationSyncStore((store) => {
			store.mutationReceipts.metadata = { requestDigest: "metadata", changeId: "metadata" };
		});
		const changed = await readCodexConfigurationSyncStore();
		expect(changed.revision).toBe(initial.revision);
		expect(changed.storageGeneration).toBeGreaterThan(initial.storageGeneration ?? 0);
	});
	it("迁移后的旧路径是明确屏障，数据库缺失时不重新导入或返回空状态", async () => {
		await readCodexConfigurationSyncStore();
		const directory = getCodexConfigurationSyncDirectory();
		const sentinel = JSON.parse(await readFile(join(directory, "configuration-sync-state.json"), "utf8"));
		expect(sentinel.storageBackend).toBe("sqlite");
		await closeCodexConfigurationSyncDatabase();
		await writeFile(join(directory, "codex-configuration-sync.sqlite"), "损坏的数据库");
		await expect(readCodexConfigurationSyncStore()).rejects.toThrow();
		expect(JSON.parse(await readFile(join(directory, "configuration-sync-state.json"), "utf8"))).toEqual(sentinel);
	});
	it("回退导出迁移后最新工作，并阻断 SQLite 再次写入或自动重迁", async () => {
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(historicalChange(1));
		});
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(historicalChange(2));
		});
		const restored = await restoreLatestCodexConfigurationSyncLegacyStorage();
		expect(JSON.parse(await readFile(restored.exportPath, "utf8")).changes).toHaveLength(2);
		expect(
			JSON.parse(await readFile(join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"), "utf8"))
				.changes,
		).toHaveLength(2);
		await expect(
			mutateCodexConfigurationSyncStore((store) => {
				store.revision++;
			}),
		).rejects.toThrow();
		await closeCodexConfigurationSyncDatabase();
		await expect(readCodexConfigurationSyncStore()).rejects.toThrow("回退");
	});

	it("固定活跃工作时，终态变更及同一记录内的终态目标十倍增长不放大活跃读取", async () => {
		const makeTarget = (index: number) => ({
			writerId: `target-${index}`,
			conversationSessionId: "session",
			workspaceId: "isolated",
			status: index === 0 ? ("accepted" as const) : ("applied" as const),
			reason: "隔离测试",
			attemptCount: 0,
			acceptedAt: 1,
			diskSavedAt: null,
			ownerReloadedAt: null,
			recoveryCondition: null,
			conflictHistory: Array.from({ length: 10 }, (_, ordinal) => ({
				observedAt: ordinal,
				value: { value: "historical-conflict" },
			})),
		});
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes = [
				...Array.from({ length: 100 }, (_, index) => historicalChange(index)),
				{
					...historicalChange(10000),
					approvalStatus: "approved",
					targets: Array.from({ length: 100 }, (_, index) => makeTarget(index)),
				},
			];
		});
		const first = await readCodexConfigurationSyncActiveStore();
		const small = await readCodexConfigurationSyncStorageMetrics();
		expect(first.changes).toHaveLength(1);
		expect(first.changes[0].targets).toHaveLength(1);
		expect(first.changes[0].targets[0].conflictHistory).toHaveLength(1);
		expect(first.changes[0].propagationTargetTotalCount).toBe(100);
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(...Array.from({ length: 900 }, (_, index) => historicalChange(index + 100)));
			const active = store.changes.find((change) => change.changeId === "historical-change-10000");
			if (!active) throw new Error("隔离活跃样本丢失");
			active.targets.push(...Array.from({ length: 900 }, (_, index) => makeTarget(index + 100)));
		});
		const expanded = await readCodexConfigurationSyncActiveStore();
		const large = await readCodexConfigurationSyncStorageMetrics();
		expect(expanded.changes[0].targets).toHaveLength(1);
		expect(expanded.changes[0].propagationTargetTotalCount).toBe(1000);
		expect(large.decodedRows).toBe(small.decodedRows);
		expect(large.decodedBytes).toBeLessThan(small.decodedBytes + 1000);
		expect(serialize(expanded).byteLength).toBeLessThan(serialize(first).byteLength + 1000);
		const full = await readCodexConfigurationSyncStore();
		expect(full.changes.find((change) => change.changeId === "historical-change-10000")?.targets).toHaveLength(1000);
	});
	it("固定观测 writer 时，退休 writer 和来源原始关联十倍增长不放大活跃载荷", async () => {
		const home = join(fixture.path, "isolated-observation-source");
		await mkdir(home);
		await writeFile(join(home, "config.toml"), 'model = "synthetic-model"\n');
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: home,
			workspaceId: "isolated",
			conversationSessionId: "observed-without-pending-work",
			runtimeSessionIncarnationId: randomUUID(),
		});
		const chronologicalWriterIds = ["ffffffff-ffff-4fff-afff-ffffffffffff", "00000000-0000-4000-a000-000000000000"];
		await mutateCodexConfigurationSyncStore((store) => {
			const original = store.writers[binding.writerId];
			for (const writerId of chronologicalWriterIds)
				store.writers[writerId] = {
					...structuredClone(original),
					binding: { ...original.binding, writerId },
					pendingSessionProfileBinding: undefined,
				};
		});
		expect(Object.keys((await readCodexConfigurationSyncActiveStore()).writers)).toEqual([
			binding.writerId,
			...chronologicalWriterIds,
		]);
		await mutateCodexConfigurationSyncStore((store) => {
			for (const writerId of chronologicalWriterIds) delete store.writers[writerId];
		});
		const retiredLegacyInstallationWriterId = randomUUID();
		await mutateCodexConfigurationSyncStore((store) => {
			const original = store.writers[binding.writerId];
			store.writers[retiredLegacyInstallationWriterId] = {
				...structuredClone(original),
				binding: { ...original.binding, writerId: retiredLegacyInstallationWriterId, purpose: "auxiliary_process" },
				retiredAt: 1,
				pendingSessionProfileBinding: undefined,
			};
		});
		expect(
			(
				await readCodexConfigurationSyncLookupStore({
					legacyMarketplaceInstallationSourceIdentities: [binding.sourceIdentity],
				})
			).writers[retiredLegacyInstallationWriterId],
		).toBeDefined();
		expect(
			(
				await readCodexConfigurationSyncLookupStore({
					sourceIdentityBindingEvidenceSourceIdentities: [binding.sourceIdentity],
				})
			).writers[retiredLegacyInstallationWriterId],
		).toBeDefined();
		for (const count of [100, 1000]) {
			await mutateCodexConfigurationSyncStore((store) => {
				const original = store.writers[binding.writerId];
				for (let index = Object.keys(store.writers).length - 1; index < count; index++) {
					const id = randomUUID();
					store.writers[id] = {
						...structuredClone(original),
						pendingNativePermissionVerificationAtMs: undefined,
						pendingSessionProfileBinding: undefined,
						pendingSourceSharedPluginInstallationPreparations: undefined,
						binding: { ...original.binding, writerId: id },
						retiredAt: 1,
					};
				}
				store.changes = Array.from({ length: count }, (_, index) => ({
					...historicalChange(index),
					recordKind: "source_observation",
					approvalStatus: "not_required",
					sourceWriterId: binding.writerId,
				}));
				store.sourceObservations = [
					{
						observationId: "unread-source",
						version: count,
						sourceIdentity: binding.sourceIdentity,
						sourceKey: "same-source",
						sourceLabel: "持续观测来源",
						firstObservedAt: 1,
						observedAt: 1,
						observationCount: count,
						detectedLocationCount: 1,
						acknowledgedAt: null,
						reminderDisposition: "unread",
						rawChangeIds: store.changes.map((change) => change.changeId),
						detectedWriterIds: [binding.writerId],
					},
				];
			});
			const active = await readCodexConfigurationSyncActiveStore();
			expect(Object.keys(active.writers)).toEqual([binding.writerId]);
			expect(active.changes).toHaveLength(1);
			expect(active.sourceObservations[0].rawChangeIds).toHaveLength(1);
			expect(serialize(active).byteLength).toBeLessThan(10000);
			expect((await readCodexConfigurationSyncStorageMetrics()).decodedRows).toBeLessThan(15);
		}
		const full = await readCodexConfigurationSyncStore();
		expect(Object.keys(full.writers)).toHaveLength(1001);
		expect(full.sourceObservations[0].rawChangeIds).toHaveLength(1000);
	});
	it("新增历史不挤乱旧游标，既有历史内容修改使旧游标失效", async () => {
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes = Array.from({ length: 60 }, (_, index) => historicalChange(index));
		});
		const first = await listCodexConfigurationSyncStoredHistory({ limit: 50 });
		expect(first.entries).toHaveLength(50);
		expect(first.nextCursor).toBeTruthy();
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(historicalChange(999));
		});
		const second = await listCodexConfigurationSyncStoredHistory({
			limit: 50,
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.entries).toHaveLength(10);
		expect(second.entries.some((entry) => entry.entry_id === "historical-change-999")).toBe(false);
		expect(second.historyMaximumSequence).toBe(first.historyMaximumSequence);
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes[0].acknowledgedAt = 999;
		});
		await expect(listCodexConfigurationSyncStoredHistory({ cursor: first.nextCursor ?? undefined })).rejects.toThrow(
			"CURSOR_INVALIDATED",
		);
	});
	it("旧版本仍标为待传播的目标十倍增长，也不进入当前 profile 的后台候选", async () => {
		const fieldKey = '["config.toml","model"]';
		const makeChange = (index: number): StoredCodexConfigurationChange => ({
			...historicalChange(index),
			codexConfigurationProfileId: "profile",
			approvalStatus: "approved",
			mergeStatus: "shared_default_updated",
			acceptedProfileFieldVersion: index === 0 ? 10001 : index,
			value: { value: index === 0 ? "current" : "superseded" },
			targets: [
				{
					writerId: `target-${index}`,
					conversationSessionId: "session",
					workspaceId: "isolated",
					status: "pending_next_start",
					reason: "隔离测试",
					attemptCount: 0,
					acceptedAt: 1,
					diskSavedAt: null,
					ownerReloadedAt: null,
					recoveryCondition: null,
				},
			],
		});
		await mutateCodexConfigurationSyncStore((store) => {
			store.profiles.profile = {
				profileId: "profile",
				name: "隔离测试",
				sourceIdentity: "historical-source",
				version: 10001,
				fields: { [fieldKey]: { value: "current" } },
				fieldVersions: { [fieldKey]: 10001 },
			};
			store.changes = Array.from({ length: 100 }, (_, index) => makeChange(index));
		});
		expect((await readCodexConfigurationSyncActiveStore()).changes.flatMap((change) => change.targets)).toHaveLength(
			1,
		);
		const small = await readCodexConfigurationSyncStorageMetrics();
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push(...Array.from({ length: 900 }, (_, index) => makeChange(index + 100)));
			store.changes.push(
				...Array.from({ length: 1000 }, (_, index) => ({
					...makeChange(index + 2000),
					acceptedProfileFieldVersion: undefined,
					value: { value: "current" },
					targets: [{ ...makeChange(index + 2000).targets[0], status: "applied" as const }],
				})),
			);
		});
		expect((await readCodexConfigurationSyncActiveStore()).changes.flatMap((change) => change.targets)).toHaveLength(
			1,
		);
		const large = await readCodexConfigurationSyncStorageMetrics();
		expect(large.decodedRows).toBe(small.decodedRows);
		expect(large.decodedBytes).toBeLessThan(small.decodedBytes + 64);
		const plans = await readCodexConfigurationSyncActiveQueryPlans();
		expect(plans.filter((plan) => /SCAN (c|t)\b/.test(plan.detail))).toEqual([]);
		expect(plans.some((plan) => plan.detail.includes("configuration_targets_legacy_processing"))).toBe(true);
		expect(plans.some((plan) => plan.detail.includes("configuration_changes_current_profile_value"))).toBe(true);
	});
});
