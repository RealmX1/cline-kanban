import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeObservedCodexConfigurationWriter } from "../../../src/codex-configuration-sync/codex-configuration-incremental-merge";
import { describeCodexConfigurationSettingDifferences } from "../../../src/codex-configuration-sync/codex-configuration-observation-records";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let storageHome: string;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-approval-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, "isolated-sqlite"));
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), 'model="initial-model"\n');
	storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});
const createWriter = (name: string) =>
	prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		workspaceId: "approval-fixture",
		conversationSessionId: name,
		runtimeSessionIncarnationId: randomUUID(),
	});

describe("配置审批与来源提示", () => {
	it.each(["confirm_source", "defer"] as const)("后台恢复阻塞时，来源 %s 仍独立持久化、发布和返回", async (action) => {
		const binding = await createWriter("source-reminder-quick-receipt");
		const hookTrustPath = join(binding.configurationHomeDirectoryPath, "hooks.json");
		const pluginCacheProbePath = join(sourceHome, "plugins", "isolated-cache-probe");
		await mkdir(join(sourceHome, "plugins"), { recursive: true });
		await writeFile(hookTrustPath, '{"trusted_hash":"preserved-trust","enabled":false}');
		await writeFile(pluginCacheProbePath, "保留插件缓存原文");
		await mutateCodexConfigurationSyncStore((store) => {
			store.sourceObservations.push({
				observationId: "isolated-source-observation",
				sourceIdentity: "isolated-source",
				sourceKey: "isolated-hook",
				sourceLabel: "隔离来源",
				version: ++store.revision,
				firstObservedAt: 1,
				observedAt: 1,
				observationCount: 1,
				detectedLocationCount: 1,
				acknowledgedAt: null,
				reminderDisposition: "unread",
				rawChangeIds: [],
				detectedWriterIds: [],
			});
		});
		let signalEnteredRecovery = () => {};
		const enteredRecovery = new Promise<void>((resolve) => {
			signalEnteredRecovery = resolve;
		});
		let signalReleaseRecovery = () => {};
		const releaseRecovery = new Promise<void>((resolve) => {
			signalReleaseRecovery = resolve;
		});
		const onUpdated = vi.fn();
		const service = createCodexConfigurationSyncService({
			listSessions: () => [],
			onUpdated,
			reconcileRetainedTerminalInput: async () => {
				signalEnteredRecovery();
				await releaseRecovery;
			},
		});
		const scanning = service.scan();
		await enteredRecovery;
		const before = await readCodexConfigurationSyncStore();
		const writerConfigurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const localConfiguration = parse(await readFile(writerConfigurationPath, "utf8"));
		localConfiguration.model = "not-yet-observed-local-setting";
		await writeFile(writerConfigurationPath, stringify(localConfiguration));
		const preservedHookTrust = await readFile(hookTrustPath, "utf8");
		const observation = (await service.getState()).sourceObservations[0];
		if (!observation) throw new Error("缺少隔离来源记录");
		const request = {
			action,
			items: [
				{
					entryKind: "source_observation" as const,
					changeId: observation.observationId,
					expectedVersion: observation.version,
					idempotencyKey: randomUUID(),
				},
			],
		};
		try {
			let completed = false;
			const operation = service.batchAction(request).then((result) => {
				completed = true;
				return result;
			});
			await vi.waitFor(() => expect(completed).toBe(true), { timeout: 1_000 });
			const result = await operation;
			expect(result.results[0]?.status).toBe("applied");
			expect(onUpdated).toHaveBeenCalledWith(result.state.revision);
			const processed = result.state.sourceObservations[0];
			if (!processed) throw new Error("缺少已处理来源记录");
			expect(processed.reminderDisposition).toBe(action === "defer" ? "deferred" : "confirmed");
			expect(processed.acknowledgedAt).toEqual(expect.any(Number));
			const replay = await service.batchAction(request);
			expect(replay.results[0]?.status).toBe("replayed");
			expect(replay.state.sourceObservations[0]?.acknowledgedAt).toBe(processed.acknowledgedAt);
			const after = await readCodexConfigurationSyncStore();
			expect(after.sources).toEqual(before.sources);
			expect(after.writers).toEqual(before.writers);
			expect(after.changes).toEqual(before.changes);
			expect(await readFile(hookTrustPath, "utf8")).toBe(preservedHookTrust);
			expect(await readFile(pluginCacheProbePath, "utf8")).toBe("保留插件缓存原文");
			expect(parse(await readFile(writerConfigurationPath, "utf8")).model).toBe("not-yet-observed-local-setting");
			expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe('model="initial-model"\n');
		} finally {
			signalReleaseRecovery();
			await scanning;
			await service.close();
		}
	});
	it("来源暂不可核验时保持待处理，其他有效项继续；原文件恢复后可重试原操作身份", async () => {
		const first = await createWriter("temporarily-unreadable"),
			second = await createWriter("available");
		for (const [binding, field, value] of [
			[first, "model", "selected-model"],
			[second, "model_reasoning_effort", "high"],
		] as const) {
			const path = join(binding.configurationHomeDirectoryPath, "config.toml");
			const configuration = parse(await readFile(path, "utf8"));
			configuration[field] = value;
			await writeFile(path, stringify(configuration));
		}
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await service.scan();
			const state = await service.getState();
			const items = [first, second].map((binding) => {
				const change = state.changes.find((entry) => entry.sourceWriterId === binding.writerId);
				if (!change) throw new Error("缺少设置提案");
				return {
					entryKind: "settings_proposal" as const,
					changeId: change.changeId,
					expectedVersion: change.version,
					idempotencyKey: randomUUID(),
				};
			});
			const path = join(first.configurationHomeDirectoryPath, "config.toml");
			await rename(path, `${path}.temporarily-unavailable`);
			const partial = await service.batchAction({ action: "approve", items });
			expect(partial.results.map((result) => result.status)).toEqual(["source_unverifiable", "applied"]);
			await rename(`${path}.temporarily-unavailable`, path);
			expect(
				(await service.batchAction({ action: "approve", items })).results.map((result) => result.status),
			).toEqual(["applied", "replayed"]);
		} finally {
			await service.close();
		}
	});
	it("旧版已确认来源提示不会因迁移重弹，信任差异只展示实际变化的字段", async () => {
		const binding = await createWriter("legacy-source");
		const store = await readCodexConfigurationSyncStore();
		store.schemaVersion = 1;
		store.changes.push({
			changeId: "legacy-confirmed-source",
			version: 1,
			sourceWriterId: binding.writerId,
			sourceIdentity: binding.sourceIdentity,
			fieldKey: JSON.stringify(["config.toml", "hooks", "state", `${sourceHome}/hooks.json:stop:0:0`]),
			previous: { value: { enabled: false }, definitionDigest: "before" },
			value: { value: { enabled: false }, definitionDigest: "after" },
			observedAt: 1,
			mergeStatus: "shared_default_updated",
			acknowledgedAt: 42,
			targets: [],
		});
		await writeFile(
			join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"),
			JSON.stringify(store),
		);
		expect((await readCodexConfigurationSyncStore()).sourceObservations[0]).toMatchObject({
			acknowledgedAt: 42,
			reminderDisposition: "confirmed",
		});
		const differences = describeCodexConfigurationSettingDifferences(
			{ value: { enabled: false, trusted_hash: "previously-saved" } },
			{ value: { enabled: false } },
		);
		expect(differences).toHaveLength(1);
		expect(differences[0]?.label).toBe("信任绑定");
		expect(differences[0]?.previous).toContain("已保存信任决定");
		expect(differences[0]?.current).toBe("未保存信任决定");
		const contentDifferences = describeCodexConfigurationSettingDifferences(
			{ value: { trusted_hash: "same-definition", trusted_content_hash: "previous-content" } },
			{ value: { trusted_hash: "same-definition", trusted_content_hash: "confirmed-content" } },
		);
		expect(contentDifferences).toHaveLength(1);
		expect(contentDifferences[0]?.label).toBe("内容信任绑定");
		expect(contentDifferences[0]?.previous).toContain("已保存信任决定");
		expect(contentDifferences[0]?.current).toContain("已保存信任决定");
	});
	it("批量部分失败继续处理有效提案；审批、稍后、拒绝与跨重启幂等互相独立", async () => {
		const binding = await createWriter("approval-source");
		const filePath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(filePath, "utf8"));
		configuration.model = "approved-model";
		configuration.model_reasoning_effort = "high";
		configuration.hide_agent_reasoning = true;
		await writeFile(filePath, stringify(configuration));
		const dependencies = { listSessions: () => [], onUpdated: () => {} };
		const service = createCodexConfigurationSyncService(dependencies);
		await service.scan();
		const state = await service.getState();
		const model = state.changes.find((change) => change.fieldLabel.endsWith(" · model"));
		const effort = state.changes.find((change) => change.fieldLabel.endsWith(" · model_reasoning_effort"));
		const hiddenReasoning = state.changes.find((change) => change.fieldLabel.endsWith(" · hide_agent_reasoning"));
		if (!model || !effort || !hiddenReasoning) throw new Error("缺少预期提案");
		const item = (change: NonNullable<typeof model>) => ({
			entryKind: "settings_proposal" as const,
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
		});
		await expect(service.synchronize({ ...item(model), synchronizeExistingSessions: true })).rejects.toThrow("审批");
		const request = { action: "approve" as const, items: [{ ...item(effort), expectedVersion: 99999 }, item(model)] };
		const approved = await service.batchAction(request);
		expect(approved.results.map((result) => result.status)).toEqual(["stale_version", "applied"]);
		expect(approved.state.changes.find((change) => change.changeId === model.changeId)).toMatchObject({
			approvalStatus: "approved",
			targets: [],
		});
		const deferred = await service.batchAction({ action: "defer", items: [item(effort)] });
		expect(deferred.state.changes.find((change) => change.changeId === effort.changeId)).toMatchObject({
			approvalStatus: "pending",
			acknowledgedAt: expect.any(Number),
		});
		await service.batchAction({ action: "reject", items: [item(hiddenReasoning)] });
		await service.close();
		const restarted = createCodexConfigurationSyncService(dependencies);
		try {
			expect((await restarted.batchAction(request)).results.map((result) => result.status)).toEqual([
				"stale_version",
				"replayed",
			]);
			const future = await createWriter("after-approval");
			expect(
				parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")),
			).toMatchObject({ model: "approved-model" });
			expect(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).not.toContain(
				'model_reasoning_effort = "high"',
			);
			expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe('model="initial-model"\n');
			expect(parse(await readFile(filePath, "utf8")).hide_agent_reasoning).toBe(true);
		} finally {
			await restarted.close();
		}
	});
	it("旧记录迁移保留已采用的默认与原始事实，不生成新设置审批", async () => {
		const binding = await createWriter("legacy");
		const store = await readCodexConfigurationSyncStore();
		const fieldKey = JSON.stringify(["config.toml", "model"]);
		store.schemaVersion = 1;
		store.sources[binding.sourceIdentity].fields[fieldKey] = { value: "legacy-adopted" };
		store.changes.push({
			changeId: "legacy-change",
			version: 1,
			sourceWriterId: binding.writerId,
			sourceIdentity: binding.sourceIdentity,
			fieldKey,
			previous: { value: "initial-model" },
			value: { value: "legacy-adopted" },
			observedAt: 1,
			mergeStatus: "shared_default_updated",
			acknowledgedAt: null,
			targets: [],
		});
		await writeFile(
			join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"),
			JSON.stringify(store),
		);
		const migrated = await readCodexConfigurationSyncStore();
		expect(migrated.changes[0]).toMatchObject({
			recordKind: "historical_record",
			approvalStatus: "historical",
			mergeStatus: "shared_default_updated",
		});
		expect(migrated.sources[binding.sourceIdentity].fields[fieldKey].value).toBe("legacy-adopted");
	});
	it("扫描只登记提案，未来 writer 在审批前保留原默认", async () => {
		const binding = await createWriter("detected-location");
		const filePath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(filePath, "utf8"));
		configuration.model = "local-choice";
		await writeFile(filePath, stringify(configuration));
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await service.scan();
			const state = await service.getState();
			expect(
				(await readCodexConfigurationSyncStore()).sources[binding.sourceIdentity].fields[
					JSON.stringify(["config.toml", "model"])
				].value,
			).toBe("initial-model");
			expect(state.changes[0]).toMatchObject({ approvalStatus: "pending", recordKind: "settings_proposal" });
			const future = await createWriter("future-before-approval");
			expect(parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
				"initial-model",
			);
		} finally {
			await service.close();
		}
	});
	it("两次定义切换、十个位置、三个 hook 只产生一个来源提示且保留六十条原始记录", async () => {
		const bindings = await Promise.all(Array.from({ length: 10 }, (_, index) => createWriter(`location-${index}`)));
		await mutateCodexConfigurationSyncStore((store) => {
			const fields = Object.fromEntries(
				["stop", "user_prompt_submit", "pre_tool_use"].map((event) => [
					JSON.stringify(["config.toml", "hooks", "state", `plugin:fixture@market:hooks.json:${event}:0:0`]),
					{ value: { enabled: false, trusted_hash: "unchanged-trust" }, definitionDigest: "version-one" },
				]),
			);
			for (const binding of bindings) {
				const writer = store.writers[binding.writerId];
				writer.lastObservedFields = structuredClone(fields);
				writer.mergeBaselineFields = structuredClone(fields);
			}
			const firstBinding = bindings[0];
			if (!firstBinding) throw new Error("缺少 writer fixture");
			store.sources[firstBinding.sourceIdentity].fields = structuredClone(fields);
			for (const definitionDigest of ["version-two", "version-three"])
				for (const binding of bindings)
					mergeObservedCodexConfigurationWriter(
						store,
						store.writers[binding.writerId],
						Object.fromEntries(
							Object.entries(fields).map(([key, field]) => [key, { ...field, definitionDigest }]),
						),
					);
			expect(store.changes).toHaveLength(60);
			expect(store.changes.filter((change) => change.approvalStatus === "pending")).toHaveLength(0);
			expect(store.sourceObservations).toHaveLength(1);
			expect(store.sourceObservations[0]?.rawChangeIds).toHaveLength(60);
		});
	});
});
