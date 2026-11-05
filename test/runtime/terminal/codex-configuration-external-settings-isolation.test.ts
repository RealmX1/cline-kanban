import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectCodexConfigurationFields } from "../../../src/codex-configuration-sync/codex-configuration-field-projection";
import {
	ensureCodexConfigurationSourceProfile,
	updateCodexConfigurationProfileFields,
} from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	codexDirectoryIdentity,
	prepareCodexConfigurationWriterBinding,
} from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	getManagedCodexConversationStorageHomeDirectoryPath,
	prepareManagedCodexConversationStorageHome,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
const modelFieldKey = JSON.stringify(["config.toml", "model"]);
const desktopFieldKey = JSON.stringify(["config.toml", "desktop", "conversationDetailMode"]);
const createWriter = (purpose: "native_session" | "auxiliary_process" = "native_session") =>
	prepareCodexConfigurationWriterBinding({
		purpose,
		storageHome: sourceHome,
		runtimeSessionIncarnationId: randomUUID(),
	});

beforeEach(async () => {
	fixture = createTempDir("codex-external-settings-isolation-");
	fixture.path = await realpath(fixture.path);
	sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	await mkdir(sourceHome);
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({
			model: "imported-model",
			desktop: { conversationDetailMode: "STEPS_PROSE" },
			features: { shell_snapshot: false },
		}),
	);
	await writeFile(join(sourceHome, "extra.config.toml"), 'model = "imported-extra"\n');
	await writeFile(join(sourceHome, "hooks.json"), '{"hooks":{}}');
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("Codex 外部配置只导入一次", () => {
	it("先准备历史目录并中断后，首个 writer 和 hooks 复用首次持久快照", async () => {
		const storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
		const initialStore = await readCodexConfigurationSyncStore();
		expect(Object.values(initialStore.sources)[0]?.configurationInitialization?.status).toBe("snapshot_persisted");
		await writeFile(join(sourceHome, "config.toml"), 'model = "changed-between-startup-phases"\n');
		await writeFile(join(sourceHome, "hooks.json"), '{"hooks":{"external-change":[]}}');
		await writeFile(join(sourceHome, "later.config.toml"), 'model = "later-external-file"\n');
		await prepareManagedCodexConversationStorageHome(sourceHome);
		for (const purpose of ["native_session", "auxiliary_process"] as const) {
			const writer = await prepareCodexConfigurationWriterBinding({
				purpose,
				storageHome,
				runtimeSessionIncarnationId: randomUUID(),
			});
			expect(parse(await readFile(join(writer.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
				"imported-model",
			);
			await expect(readFile(join(writer.configurationHomeDirectoryPath, "later.config.toml"))).rejects.toMatchObject(
				{
					code: "ENOENT",
				},
			);
			expect(await readFile(join(writer.configurationHomeDirectoryPath, "hooks.json"), "utf8")).toBe('{"hooks":{}}');
		}
		expect(parse(await readFile(join(storageHome, "config.toml"), "utf8")).model).toBe("imported-model");
		expect(await readFile(join(storageHome, "hooks.json"), "utf8")).toBe('{"hooks":{}}');
	});
	it.each(["valid", "wrong_source", "symlinked_copy"])(
		"无 writer 的旧会话从已核验历史副本恢复：%s",
		async (copyStatus) => {
			const storageHome = getManagedCodexConversationStorageHomeDirectoryPath();
			await mkdir(storageHome, { recursive: true });
			await writeFile(
				join(storageHome, "canonical-user-codex-home.json"),
				JSON.stringify({ sourceHomeDirectoryPath: copyStatus === "wrong_source" ? fixture.path : sourceHome }),
			);
			await writeFile(join(storageHome, "config.toml"), 'model = "legacy-internal-model"\ninternal_only = true\n');
			if (copyStatus === "symlinked_copy") {
				await rm(join(storageHome, "config.toml"));
				await symlink(join(sourceHome, "config.toml"), join(storageHome, "config.toml"));
			}
			const sourceIdentity = await codexDirectoryIdentity(sourceHome);
			const fields = await projectCodexConfigurationFields({
				home: sourceHome,
				sourceHome,
				fileNames: ["config.toml"],
				onHookDefinitionObservationProblem: () => {},
			});
			await mutateCodexConfigurationSyncStore((store) => {
				store.sources[sourceIdentity] = {
					home: sourceHome,
					version: ++store.revision,
					fields,
					observedUserFields: fields,
				};
				const profile = ensureCodexConfigurationSourceProfile(store, sourceIdentity);
				updateCodexConfigurationProfileFields(store, profile.profileId, {
					[modelFieldKey]: { value: "accepted-default" },
				});
				store.legacySessionProfileAdoptions.legacy = {
					workspaceId: "isolated-workspace",
					conversationSessionId: "legacy-session",
					nativeSessionId: "legacy-native-session",
					profileId: profile.profileId,
					sourceIdentity,
					reason: "等待独立 writer",
					attemptCount: 0,
				};
			});
			await writeFile(join(sourceHome, "config.toml"), 'model = "external-after-upgrade"\nexternal_only = true\n');
			if (copyStatus !== "valid") {
				await expect(createWriter()).rejects.toThrow();
				expect(
					(await readCodexConfigurationSyncStore()).sources[sourceIdentity].configurationInitialization,
				).toBeUndefined();
				await writeFile(
					join(storageHome, "canonical-user-codex-home.json"),
					JSON.stringify({ sourceHomeDirectoryPath: sourceHome }),
				);
				await rm(join(storageHome, "config.toml"));
				await writeFile(
					join(storageHome, "config.toml"),
					'model = "legacy-internal-model"\ninternal_only = true\n',
				);
			}
			for (const writer of [await createWriter(), await createWriter()]) {
				const configuration = parse(
					await readFile(join(writer.configurationHomeDirectoryPath, "config.toml"), "utf8"),
				);
				expect(configuration.model).toBe("accepted-default");
				expect(configuration.external_only).toBeUndefined();
			}
			const reference = (await readCodexConfigurationSyncStore()).sources[sourceIdentity]
				.configurationInitialization;
			if (!reference) throw new Error("缺少迁移后的快照引用");
			const snapshot = JSON.parse(await readFile(reference.snapshotFilePath, "utf8"));
			expect(parse(snapshot.configurationFiles["config.toml"])).toMatchObject({
				model: "legacy-internal-model",
				internal_only: true,
			});
		},
	);
	it.each(["changed", "deleted", "unreadable"])(
		"角色配置引用捕获内部副本，外部 %s 不影响未来 writer",
		async (mutation) => {
			const rolePath = join(sourceHome, "worker.config.toml");
			await writeFile(rolePath, 'model = "captured-worker"\n');
			await writeFile(
				join(sourceHome, "config.toml"),
				stringify({ agents: { worker: { config_file: "worker.config.toml" } } }),
			);
			await createWriter();
			await rm(rolePath);
			if (mutation === "changed") await writeFile(rolePath, 'model = "external-worker"\n');
			if (mutation === "unreadable") await mkdir(rolePath);
			const writer = await createWriter();
			const configuration = parse(
				await readFile(join(writer.configurationHomeDirectoryPath, "config.toml"), "utf8"),
			);
			const reference = (configuration.agents as { worker: { config_file: string } }).worker.config_file;
			expect(reference.startsWith(sourceHome)).toBe(false);
			expect((await lstat(reference)).isFile()).toBe(true);
			expect(parse(await readFile(reference, "utf8")).model).toBe("captured-worker");
		},
	);
	it("内联 profile 的嵌套角色配置及循环引用只捕获一次，重启后恢复相同快照", async () => {
		const agentsDirectory = join(sourceHome, "agents");
		await mkdir(agentsDirectory);
		const workerPath = join(agentsDirectory, "worker.toml");
		const reviewerPath = join(agentsDirectory, "reviewer.toml");
		await writeFile(
			workerPath,
			stringify({ model: "worker-A", agents: { reviewer: { config_file: "reviewer.toml" } } }),
		);
		await writeFile(
			reviewerPath,
			stringify({ model: "reviewer-A", agents: { worker: { config_file: workerPath } } }),
		);
		await writeFile(
			join(sourceHome, "config.toml"),
			stringify({ profiles: { team: { agents: { worker: { config_file: workerPath } } } } }),
		);
		await prepareManagedCodexConversationStorageHome(sourceHome);
		const source = Object.values((await readCodexConfigurationSyncStore()).sources)[0];
		const snapshotFilePath = source?.configurationInitialization?.snapshotFilePath;
		if (!snapshotFilePath) throw new Error("缺少快照引用");
		const originalSnapshot = await readFile(snapshotFilePath, "utf8");
		const capturedFiles = JSON.parse(originalSnapshot).agentConfigurationFiles as Record<string, string>;
		expect(Object.keys(capturedFiles)).toHaveLength(2);
		await rm(agentsDirectory, { recursive: true });
		for (const name of Object.keys(capturedFiles)) await rm(join(dirname(snapshotFilePath), name));
		const writer = await createWriter();
		const configuration = parse(await readFile(join(writer.configurationHomeDirectoryPath, "config.toml"), "utf8"));
		const profile = (configuration.profiles as { team: { agents: { worker: { config_file: string } } } }).team;
		const worker = parse(await readFile(profile.agents.worker.config_file, "utf8"));
		expect(worker.model).toBe("worker-A");
		const reviewer = parse(
			await readFile((worker.agents as { reviewer: { config_file: string } }).reviewer.config_file, "utf8"),
		);
		expect(reviewer.model).toBe("reviewer-A");
		expect((reviewer.agents as { worker: { config_file: string } }).worker.config_file).toBe(
			profile.agents.worker.config_file,
		);
		expect(await readFile(snapshotFilePath, "utf8")).toBe(originalSnapshot);
	});
	it.each(["native_session", "auxiliary_process"] as const)(
		"旧 writer 的嵌套角色在 profile 覆盖后仍绑定内部快照：%s",
		async (purpose) => {
			const rolePath = join(sourceHome, "agents", "worker.toml");
			await mkdir(dirname(rolePath));
			await writeFile(rolePath, 'model = "captured-worker"\n');
			const roles = {
				worker: { config_file: "agents/worker.toml" },
				reviewer: { config_file: rolePath },
			};
			await writeFile(
				join(sourceHome, "config.toml"),
				stringify({ model: "before-profile", agents: roles, profiles: { team: { agents: roles } } }),
			);
			const previousBinding = await createWriter();
			const previousConfigurationPath = join(previousBinding.configurationHomeDirectoryPath, "config.toml");
			const previousConfiguration = parse(await readFile(previousConfigurationPath, "utf8"));
			const legacyRoles = { worker: { config_file: rolePath }, reviewer: { config_file: rolePath } };
			previousConfiguration.agents = legacyRoles;
			previousConfiguration.profiles = { team: { agents: legacyRoles } };
			await writeFile(previousConfigurationPath, stringify(previousConfiguration));
			const internalRolePath = join(previousBinding.configurationHomeDirectoryPath, "agents", "worker.toml");
			await mkdir(dirname(internalRolePath));
			await writeFile(internalRolePath, 'model = "verified-internal-worker"\n');
			await mutateCodexConfigurationSyncStore((store) => {
				delete store.sources[previousBinding.sourceIdentity].configurationInitialization;
				updateCodexConfigurationProfileFields(store, previousBinding.codexConfigurationProfileId ?? "missing", {
					[modelFieldKey]: { value: "accepted-default" },
				});
			});
			await rm(join(getCodexConfigurationSyncDirectory(), "source-initialization-snapshots"), { recursive: true });
			await writeFile(rolePath, 'model = "unaccepted-external-worker"\n');
			const migrated = await prepareCodexConfigurationWriterBinding({
				purpose,
				storageHome: previousBinding.conversationStorageHomeDirectoryPath,
				previousBinding,
				runtimeSessionIncarnationId: randomUUID(),
			});
			await rm(rolePath);
			const restarted = await prepareCodexConfigurationWriterBinding({
				purpose,
				storageHome: migrated.conversationStorageHomeDirectoryPath,
				previousBinding: migrated,
				runtimeSessionIncarnationId: randomUUID(),
			});
			for (const writer of [migrated, restarted, await createWriter(purpose)]) {
				const configuration = parse(
					await readFile(join(writer.configurationHomeDirectoryPath, "config.toml"), "utf8"),
				);
				expect(configuration.model).toBe("accepted-default");
				const roleGroups = [
					configuration.agents,
					(configuration.profiles as { team: { agents: unknown } }).team.agents,
				] as { worker: { config_file: string }; reviewer: { config_file: string } }[];
				for (const roleGroup of roleGroups) {
					expect(roleGroup.worker.config_file).toBe(roleGroup.reviewer.config_file);
					expect(roleGroup.worker.config_file).toContain("source-initialization-snapshots");
					expect(parse(await readFile(roleGroup.worker.config_file, "utf8")).model).toBe(
						"verified-internal-worker",
					);
				}
			}
		},
	);
	it.each(["missing", "digest_changed"])(
		"初始化快照 %s 时公开未知状态且不重新导入，原快照恢复后自动补扫",
		async (failure) => {
			const binding = await createWriter();
			const store = await readCodexConfigurationSyncStore();
			const reference = store.sources[binding.sourceIdentity].configurationInitialization;
			if (!reference) throw new Error("缺少初始化快照引用");
			const originalSnapshot = await readFile(reference.snapshotFilePath, "utf8");
			if (failure === "missing") await rm(reference.snapshotFilePath);
			else
				await writeFile(
					reference.snapshotFilePath,
					JSON.stringify({ ...JSON.parse(originalSnapshot), capturedAtMs: 0 }),
				);
			await writeFile(join(sourceHome, "config.toml"), 'model = "changed-external-during-recovery"\n');
			const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
			try {
				await service.scan();
				expect((await service.getState()).observationProblem).toContain("初始化快照");
				await expect(createWriter()).rejects.toThrow();
				await writeFile(reference.snapshotFilePath, originalSnapshot);
				await service.scan();
				expect((await service.getState()).observationProblem).toBeNull();
				expect((await createWriter()).launchConfigurationDigest).toBe(binding.launchConfigurationDigest);
			} finally {
				await service.close();
			}
		},
	);
	it("writer 已初始化后首次建立历史存储目录，也使用已捕获的内部快照", async () => {
		await createWriter();
		await writeFile(join(sourceHome, "config.toml"), 'model = "later-external-model"\n');
		await writeFile(join(sourceHome, "new.config.toml"), 'model = "later-external-file"\n');
		const storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
		expect(parse(await readFile(join(storageHome, "config.toml"), "utf8")).model).toBe("imported-model");
		await expect(readFile(join(storageHome, "new.config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("已有历史存储目录不再复制后来新增的外部配置，缺失的旧配置也不触发再次导入", async () => {
		const storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
		await createWriter();
		await rm(join(storageHome, "config.toml"));
		await writeFile(join(sourceHome, "new.config.toml"), 'model = "later-external-file"\n');
		await prepareManagedCodexConversationStorageHome(sourceHome);
		await expect(readFile(join(storageHome, "new.config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(storageHome, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("保留默认处理同字段所有展示候选时，profile 与会话局部选择均保持原值", async () => {
		const bindings = [await createWriter(), await createWriter()];
		for (const [index, binding] of bindings.entries()) {
			const path = join(binding.configurationHomeDirectoryPath, "config.toml");
			const configuration = parse(await readFile(path, "utf8"));
			configuration.model = `local-choice-${index}`;
			await writeFile(path, stringify(configuration));
		}
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await service.scan();
			const suggestions = (await service.getState()).changes.filter((change) => change.approvalStatus === "pending");
			expect(suggestions).toHaveLength(2);
			await service.batchAction({
				action: "reject",
				items: suggestions.map((change) => ({
					entryKind: "settings_proposal",
					changeId: change.changeId,
					expectedVersion: change.version,
					idempotencyKey: randomUUID(),
				})),
			});
			const store = await readCodexConfigurationSyncStore();
			for (const [index, binding] of bindings.entries()) {
				expect(
					parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8")).model,
				).toBe(`local-choice-${index}`);
				expect(store.writers[binding.writerId].localExceptionOverrides?.model?.fields[modelFieldKey]?.value).toBe(
					`local-choice-${index}`,
				);
			}
			expect(Object.values(store.profiles)[0]?.fields[modelFieldKey]?.value).toBe("imported-model");
		} finally {
			await service.close();
		}
	});
	it("旧外部审批和传播归档，历史应用事实保留且全部执行入口拒绝重新激活", async () => {
		const binding = await createWriter();
		const changeId = randomUUID();
		await mutateCodexConfigurationSyncStore((store) => {
			store.changes.push({
				changeId,
				sourceWriterId: `user-source:${binding.sourceIdentity}`,
				sourceIdentity: binding.sourceIdentity,
				fieldKey: modelFieldKey,
				previous: { value: "older" },
				value: { value: "imported-model" },
				version: ++store.revision,
				observedAt: 1,
				recordKind: "settings_proposal",
				approvalStatus: "pending",
				mergeStatus: "conflict",
				acknowledgedAt: null,
				targets: ["applied", "accepted", "pending_reload", "pending_next_start", "conflict"].map(
					(status, index) => ({
						writerId: `${index}`,
						conversationSessionId: "old-target",
						workspaceId: "isolated",
						status: status as "applied" | "accepted" | "pending_reload" | "pending_next_start" | "conflict",
						reason: "原始历史",
						attemptCount: 2,
						acceptedAt: 1,
						diskSavedAt: index === 0 ? 2 : null,
						ownerReloadedAt: index === 0 ? 3 : null,
						recoveryCondition: "原始恢复条件",
					}),
				),
			});
		});
		const migrated = await readCodexConfigurationSyncStore();
		const change = migrated.changes.find((entry) => entry.changeId === changeId);
		if (!change) throw new Error("缺少旧外部记录");
		expect(change).toMatchObject({ approvalStatus: "historical", mergeStatus: "superseded" });
		expect(change.targets.map((target) => target.status)).toEqual([
			"applied",
			"not_applicable",
			"not_applicable",
			"not_applicable",
			"conflict",
		]);
		expect(change.targets[0]).toMatchObject({ diskSavedAt: 2, ownerReloadedAt: 3, reason: "原始历史" });
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			const input = { changeId, expectedVersion: change.version, idempotencyKey: randomUUID() };
			expect(
				(await service.batchAction({ action: "approve", items: [{ ...input, entryKind: "settings_proposal" }] }))
					.results[0].status,
			).toBe("not_approvable");
			await expect(
				service.synchronize({ ...input, idempotencyKey: randomUUID(), synchronizeExistingSessions: true }),
			).rejects.toThrow();
			await expect(
				service.resolveConflict({ ...input, idempotencyKey: randomUUID(), resolution: "use_session_value" }),
			).rejects.toThrow();
			const once = await readCodexConfigurationSyncStore();
			await service.scan();
			expect((await readCodexConfigurationSyncStore()).changes).toEqual(once.changes);
		} finally {
			await service.close();
		}
	});
	it.each(["modified", "added", "deleted", "unreadable"])(
		"外部配置 %s 不产生审批也不进入未来 writer",
		async (mutation) => {
			const first = await createWriter();
			const firstText = await readFile(join(first.configurationHomeDirectoryPath, "config.toml"), "utf8");
			if (mutation === "modified") {
				await writeFile(join(sourceHome, "config.toml"), 'model = "external-new"\nnew_setting = true\n');
				await writeFile(join(sourceHome, "extra.config.toml"), 'model = "external-extra"\n');
				await writeFile(join(sourceHome, "hooks.json"), '{"hooks":{"changed":[]}}');
			} else if (mutation === "added")
				await writeFile(join(sourceHome, "new.config.toml"), 'model = "external-new"\n');
			else if (mutation === "deleted") {
				await rm(join(sourceHome, "config.toml"));
				await rm(join(sourceHome, "extra.config.toml"));
				await rm(join(sourceHome, "hooks.json"));
			} else {
				await rename(join(sourceHome, "config.toml"), join(sourceHome, "external-config-preserved.toml"));
				await mkdir(join(sourceHome, "config.toml"));
			}
			const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
			try {
				await service.scan();
				expect((await service.getState()).changes).toEqual([]);
				expect((await service.getState()).observationProblem).toBeNull();
				for (const purpose of ["native_session", "auxiliary_process"] as const) {
					const future = await createWriter(purpose);
					const configuration = parse(
						await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8"),
					);
					expect(configuration.model).toBe("imported-model");
					expect(configuration.desktop).toBeUndefined();
					expect(configuration.new_setting).toBeUndefined();
					expect(future.launchConfigurationDigest).toBe(first.launchConfigurationDigest);
					expect(await readFile(join(future.configurationHomeDirectoryPath, "hooks.json"), "utf8")).toBe(
						'{"hooks":{}}',
					);
					expect(
						parse(await readFile(join(future.configurationHomeDirectoryPath, "extra.config.toml"), "utf8")).model,
					).toBe("imported-extra");
					await expect(
						readFile(join(future.configurationHomeDirectoryPath, "new.config.toml")),
					).rejects.toMatchObject({ code: "ENOENT" });
				}
				expect(await readFile(join(first.configurationHomeDirectoryPath, "config.toml"), "utf8")).toBe(firstText);
			} finally {
				await service.close();
			}
		},
	);

	it("外部主配置不可读时仍可审批内部建议，desktop 不可共享或编辑", async () => {
		const binding = await createWriter();
		const configurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		configuration.model = "internal-choice";
		await writeFile(configurationPath, stringify(configuration));
		await rm(join(sourceHome, "config.toml"));
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await service.scan();
			const state = await service.getState();
			const proposal = state.changes.find((change) => change.approvalStatus === "pending");
			if (!proposal) throw new Error("缺少内部设置提案");
			expect(
				state.profiles?.flatMap((profile) => profile.fields).some((field) => field.fieldKey === desktopFieldKey),
			).toBe(false);
			const result = await service.batchAction({
				action: "approve",
				items: [
					{
						entryKind: "settings_proposal",
						changeId: proposal.changeId,
						expectedVersion: proposal.version,
						idempotencyKey: randomUUID(),
					},
				],
			});
			expect(result.results[0].status).toBe("applied");
			expect(result.state.profiles?.[0].fields.find((field) => field.fieldKey === modelFieldKey)?.value).toBe(
				"internal-choice",
			);
		} finally {
			await service.close();
		}
	});

	it("快照已落盘但状态提交中断时，重试恢复同一导入而不读取变化后的外部文件", async () => {
		const binding = await createWriter();
		const storePath = join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json");
		const store = JSON.parse(await readFile(storePath, "utf8"));
		store.sources = {};
		store.profiles = {};
		store.writers = {};
		store.defaultCodexConfigurationProfileId = null;
		await writeFile(storePath, JSON.stringify(store));
		await writeFile(join(sourceHome, "config.toml"), 'model = "changed-after-interruption"\n');
		const recovered = await createWriter();
		expect(recovered.launchConfigurationDigest).toBe(binding.launchConfigurationDigest);
	});

	it("升级从已核验的 Kanban 副本迁移并保留接受的 profile，迁移幂等", async () => {
		const binding = await createWriter();
		await mutateCodexConfigurationSyncStore((store) => {
			delete store.sources[binding.sourceIdentity].configurationInitialization;
			updateCodexConfigurationProfileFields(store, binding.codexConfigurationProfileId ?? "missing-profile", {
				[modelFieldKey]: { value: "accepted-default" },
			});
		});
		await rm(join(getCodexConfigurationSyncDirectory(), "source-initialization-snapshots"), {
			recursive: true,
			force: true,
		});
		await writeFile(join(sourceHome, "config.toml"), 'model = "unaccepted-external"\nnew_setting = true\n');
		const migrated = await createWriter();
		const repeated = await createWriter();
		for (const writer of [migrated, repeated]) {
			const configuration = parse(
				await readFile(join(writer.configurationHomeDirectoryPath, "config.toml"), "utf8"),
			);
			expect(configuration.model).toBe("accepted-default");
			expect(configuration.new_setting).toBeUndefined();
		}
	});
});
