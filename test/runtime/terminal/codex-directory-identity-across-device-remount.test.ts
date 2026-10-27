import type * as ChildProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type * as FileSystem from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type * as OperatingSystem from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	assertCodexConfigurationWriterBindingIdentity,
	codexDirectoryIdentity,
	prepareCodexConfigurationWriterBinding,
} from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	prepareManagedCodexConversationStorageHome,
	resolveRecordedCodexConversationHome,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import type * as PersistentDirectoryIdentityModule from "../../../src/codex-conversation-storage/codex-persistent-directory-identity";
import { resolveCodexPersistentDirectoryIdentity } from "../../../src/codex-conversation-storage/codex-persistent-directory-identity";
import { createTempDir } from "../../utilities/temp-dir";

const remount = vi.hoisted(() => ({
	device: 16777233n,
	volumeUuid: "92B0DA1E-D7BD-434B-A92A-866E8EF81502",
	volumeQueryFails: false,
	volumeQueryCount: 0,
	deviceNodeInode: 1n,
	bootSessionUuid: "6FDD548B-1612-4B05-8E0E-7FEDB02AFF84",
	changeDeviceNodeDuringVolumeQuery: false,
	deviceNodeReadCount: 0,
	replaceDeviceNodeOnRead: 0,
	platform: "darwin",
}));
vi.mock("node:os", async (original) => ({
	...(await original<typeof OperatingSystem>()),
	platform: () => remount.platform,
}));
vi.mock("node:fs", async (original) => {
	const filesystem = await original<typeof FileSystem>();
	return {
		...filesystem,
		lstatSync: (...parameters: Parameters<typeof filesystem.lstatSync>) => {
			if (parameters[0] === "/dev/fixture-disk") {
				remount.deviceNodeReadCount++;
				if (remount.deviceNodeReadCount === remount.replaceDeviceNodeOnRead) remount.deviceNodeInode++;
				const metadata = filesystem.lstatSync(sourceHome, { bigint: true });
				const deviceNodeInode = remount.deviceNodeInode;
				const deviceNodeNumber = remount.device;
				return new Proxy(metadata, {
					get: (target, key) => {
						if (key === "isBlockDevice") return () => true;
						if (key === "rdev") return deviceNodeNumber;
						if (key === "ino") return deviceNodeInode;
						return Reflect.get(target, key);
					},
				});
			}
			const metadata = filesystem.lstatSync(...parameters);
			if (!metadata || typeof metadata.dev !== "bigint") return metadata;
			return new Proxy(metadata, {
				get: (target, key) => (key === "dev" ? remount.device : Reflect.get(target, key)),
			});
		},
	};
});
vi.mock("node:child_process", async (original) => {
	const childProcess = await original<typeof ChildProcess>();
	return {
		...childProcess,
		execFile: (
			binary: string,
			arguments_: readonly string[],
			options: ChildProcess.ExecFileOptionsWithStringEncoding,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (binary === "/usr/sbin/sysctl") {
				queueMicrotask(() => callback(null, `${remount.bootSessionUuid}\n`, ""));
				return;
			}
			if (["/bin/df", "/usr/sbin/diskutil"].includes(binary)) {
				remount.volumeQueryCount++;
				queueMicrotask(() => {
					if (binary === "/usr/sbin/diskutil" && remount.changeDeviceNodeDuringVolumeQuery)
						remount.deviceNodeInode++;
					callback(
						remount.volumeQueryFails ? new Error("fixture-volume-query-unavailable") : null,
						binary === "/bin/df"
							? "Filesystem Mounted on\n/dev/fixture-disk /fixture-mount\n"
							: `<plist><dict><key>VolumeUUID</key><string>${remount.volumeUuid}</string></dict></plist>`,
						"",
					);
				});
				return;
			}
			return childProcess.execFile(binary, arguments_, options, callback);
		},
	};
});

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let storageHome: string;
beforeEach(async () => {
	fixture = createTempDir("codex-persistent-directory-identity-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	remount.device += 32n;
	remount.platform = "darwin";
	remount.volumeUuid = "92B0DA1E-D7BD-434B-A92A-866E8EF81502";
	remount.volumeQueryFails = false;
	remount.deviceNodeInode++;
	remount.bootSessionUuid = "6FDD548B-1612-4B05-8E0E-7FEDB02AFF84";
	remount.changeDeviceNodeDuringVolumeQuery = false;
	remount.deviceNodeReadCount = 0;
	remount.replaceDeviceNodeOnRead = 0;
	sourceHome = join(fixture.path, ".codex");
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), 'model="fixture-model"\n');
	storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
const evidenceRoot = () => join(fixture.path, ".cline", "kanban", "codex-persistent-directory-identity-evidence");
const createWriter = () =>
	prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		workspaceId: "fixture-workspace",
		conversationSessionId: "fixture-session",
		runtimeSessionIncarnationId: randomUUID(),
	});

describe("Codex 目录跨设备号变化的持久身份", () => {
	it.each(["previous_binding", "writer_home_parent"] as const)(
		"多个有效旧来源存在时 %s 续跑保持 parent 来源及独立决定，新 Task 保持默认旧来源",
		async (parentSelection) => {
			const firstBinding = await createWriter();
			const firstStore = await readCodexConfigurationSyncStore();
			await rm(evidenceRoot(), { recursive: true });
			// 模拟旧部署在第二次挂载先建立了另一个来源，随后两份有效原账本并存。
			await mutateCodexConfigurationSyncStore((store) => {
				store.sources = {};
				store.writers = {};
			});
			remount.device -= 4n;
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.now() + 1_000);
			const secondBinding = await createWriter();
			expect(secondBinding.sourceIdentity).not.toBe(firstBinding.sourceIdentity);
			await mutateCodexConfigurationSyncStore((store) => {
				Object.assign(store.sources, firstStore.sources);
				Object.assign(store.writers, firstStore.writers);
				for (const [binding, model] of [
					[firstBinding, "first-source-shared-model"],
					[secondBinding, "second-source-shared-model"],
				] as const) {
					const source = store.sources[binding.sourceIdentity];
					const modelFieldKey = Object.keys(source.fields).find(
						(key) => source.fields[key].value === "fixture-model",
					);
					if (!modelFieldKey) throw new Error("隔离配置缺少 model 字段。");
					source.fields[modelFieldKey] = { value: model };
					store.writers[binding.writerId].mergeBaselineFields = structuredClone(source.fields);
					store.writers[binding.writerId].lastObservedFields = structuredClone(source.fields);
					store.changes.push({
						changeId: randomUUID(),
						version: ++store.revision,
						sourceWriterId: binding.writerId,
						sourceIdentity: binding.sourceIdentity,
						fieldKey: modelFieldKey,
						value: { value: model },
						observedAt: Date.now(),
						mergeStatus: "shared_default_updated",
						acknowledgedAt: null,
						targets: [
							{
								writerId: binding.writerId,
								conversationSessionId: "fixture-session",
								workspaceId: "fixture-workspace",
								status: "pending_next_start",
								reason: "隔离历史来源决定",
								attemptCount: 0,
								acceptedAt: Date.now(),
								diskSavedAt: null,
								ownerReloadedAt: null,
								recoveryCondition: "下一次原所有者启动",
							},
						],
					});
				}
			});
			await writeFile(
				join(firstBinding.configurationHomeDirectoryPath, "config.toml"),
				'model="first-source-shared-model"\n',
			);
			await writeFile(
				join(secondBinding.configurationHomeDirectoryPath, "config.toml"),
				'model="second-source-shared-model"\n',
			);
			const originalStore = await readCodexConfigurationSyncStore();
			const manifestPaths = [firstBinding, secondBinding].map((binding) =>
				join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json"),
			);
			const originalManifests = await Promise.all(manifestPaths.map((path) => readFile(path, "utf8")));
			await assertCodexConfigurationWriterBindingIdentity(firstBinding);
			await assertCodexConfigurationWriterBindingIdentity(secondBinding);
			const newTask = await createWriter();
			expect(newTask.sourceIdentity).toBe(firstBinding.sourceIdentity);
			expect(await readFile(join(newTask.configurationHomeDirectoryPath, "config.toml"), "utf8")).toContain(
				"first-source-shared-model",
			);
			const resumed = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome:
					parentSelection === "writer_home_parent" ? secondBinding.configurationHomeDirectoryPath : storageHome,
				previousBinding: parentSelection === "previous_binding" ? secondBinding : undefined,
				runtimeSessionIncarnationId: randomUUID(),
			});
			expect(resumed.sourceIdentity).toBe(secondBinding.sourceIdentity);
			expect(resumed.launchSharedVersion).toBe(originalStore.sources[secondBinding.sourceIdentity].version);
			expect(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8")).toContain(
				"second-source-shared-model",
			);
			const resumedStore = await readCodexConfigurationSyncStore();
			expect(resumedStore.sources).toEqual(originalStore.sources);
			expect(resumedStore.changes).toEqual(originalStore.changes);
			expect(await Promise.all(manifestPaths.map((path) => readFile(path, "utf8")))).toEqual(originalManifests);
		},
	);

	it("缓存资格检查后设备节点替换不会签发成功观察，随后查询失败仍拒绝", async () => {
		const binding = await createWriter();
		const mountObservationsDirectory = join(
			evidenceRoot(),
			createHash("sha256").update(JSON.stringify(sourceHome)).digest("hex"),
			"verified-mount-observations",
		);
		const originalObservationNames = await readdir(mountObservationsDirectory);
		const originalObservationContents = await Promise.all(
			originalObservationNames.map((name) => readFile(join(mountObservationsDirectory, name), "utf8")),
		);
		remount.deviceNodeReadCount = 0;
		remount.replaceDeviceNodeOnRead = 3;
		const raceResult = await codexDirectoryIdentity(sourceHome, { expectedIdentity: binding.sourceIdentity }).then(
			() => "accepted",
			() => "rejected",
		);
		expect.soft(raceResult).toBe("rejected");
		expect.soft(await readdir(mountObservationsDirectory)).toEqual(originalObservationNames);
		remount.replaceDeviceNodeOnRead = 0;
		remount.volumeQueryFails = true;
		await expect(codexDirectoryIdentity(sourceHome, { expectedIdentity: binding.sourceIdentity })).rejects.toThrow(
			/卷身份暂不可核验/,
		);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 5_001);
		remount.volumeQueryFails = false;
		await expect(codexDirectoryIdentity(sourceHome, { expectedIdentity: binding.sourceIdentity })).resolves.toBe(
			binding.sourceIdentity,
		);
		expect((await readdir(mountObservationsDirectory)).length).toBe(originalObservationNames.length + 1);
		expect(
			await Promise.all(
				originalObservationNames.map((name) => readFile(join(mountObservationsDirectory, name), "utf8")),
			),
		).toEqual(originalObservationContents);
		vi.setSystemTime(Date.now() + 30_001);
		remount.volumeQueryFails = true;
		await expect(codexDirectoryIdentity(sourceHome, { expectedIdentity: binding.sourceIdentity })).resolves.toBe(
			binding.sourceIdentity,
		);
	});

	it.each(["native_session", "auxiliary_process"] as const)(
		"旧格式先观察仅有 %s 来源，再建新 Task 仍继承原来源及共享决定",
		async (purpose) => {
			const binding = await prepareCodexConfigurationWriterBinding({
				purpose,
				storageHome,
				runtimeSessionIncarnationId: randomUUID(),
			});
			const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
			try {
				await writeFile(join(binding.configurationHomeDirectoryPath, "config.toml"), 'model="shared-decision"\n');
				// 隔离输入快照模拟此前已登记的共享决定，不依赖仍存活的原写入者。
				await mutateCodexConfigurationSyncStore((store) => {
					const source = store.sources[binding.sourceIdentity];
					const fieldKey = Object.keys(source.fields).find((key) => source.fields[key].value === "fixture-model");
					if (!fieldKey) throw new Error("隔离配置缺少 model 字段。");
					source.fields[fieldKey] = { value: "shared-decision" };
					if (purpose === "native_session") store.writers[binding.writerId].retiredAt = Date.now();
				});
				const originalSources = (await readCodexConfigurationSyncStore()).sources;
				const manifestPath = join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json");
				const originalManifest = await readFile(manifestPath, "utf8");
				await rm(evidenceRoot(), { recursive: true });
				remount.device -= 4n;
				await service.scan();
				expect((await readCodexConfigurationSyncStore()).observationProblem).toBeNull();
				const created = await createWriter();
				expect(created.sourceIdentity).toBe(binding.sourceIdentity);
				expect((await readCodexConfigurationSyncStore()).sources).toEqual(originalSources);
				expect(await readFile(join(created.configurationHomeDirectoryPath, "config.toml"), "utf8")).toContain(
					"shared-decision",
				);
				expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
				expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe('model="fixture-model"\n');
			} finally {
				await service.close();
			}
		},
	);

	it("旧格式直接新建 Task 可独立恢复来源，损坏旧历史桥接不阻断可靠来源", async () => {
		const binding = await createWriter();
		await mutateCodexConfigurationSyncStore((store) => {
			const source = store.sources[binding.sourceIdentity];
			const fieldKey = Object.keys(source.fields).find((key) => source.fields[key].value === "fixture-model");
			if (!fieldKey) throw new Error("隔离配置缺少 model 字段。");
			source.fields[fieldKey] = { value: "direct-start-shared-decision" };
			store.writers[binding.writerId].retiredAt = Date.now();
		});
		const originalSources = (await readCodexConfigurationSyncStore()).sources;
		await rm(evidenceRoot(), { recursive: true });
		const brokenBridge = join(binding.configurationHomeDirectoryPath, "sessions");
		await rm(brokenBridge);
		await symlink(sourceHome, brokenBridge);
		remount.device -= 4n;
		const created = await createWriter();
		expect(created.sourceIdentity).toBe(binding.sourceIdentity);
		expect((await readCodexConfigurationSyncStore()).sources).toEqual(originalSources);
		expect(await readFile(join(created.configurationHomeDirectoryPath, "config.toml"), "utf8")).toContain(
			"direct-start-shared-decision",
		);
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/桥接/);
	});

	it.each(["missing_manifest", "mismatched_manifest", "replaced_source"] as const)(
		"旧来源证据为 %s 时不按相同路径静默创建第二来源",
		async (failure) => {
			const binding = await createWriter();
			await rm(evidenceRoot(), { recursive: true });
			const manifestPath = join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json");
			if (failure === "missing_manifest") await rm(manifestPath);
			if (failure === "mismatched_manifest")
				await writeFile(manifestPath, JSON.stringify({ ...binding, sourceIdentity: "0".repeat(64) }));
			if (failure === "replaced_source") {
				await rename(sourceHome, `${sourceHome}-preserved-original`);
				await mkdir(sourceHome);
				await writeFile(join(sourceHome, "config.toml"), 'model="replacement"\n');
			}
			remount.device -= 4n;
			await expect(createWriter()).rejects.toThrow(/来源.*原绑定证据/);
			expect(Object.keys((await readCodexConfigurationSyncStore()).sources)).toEqual([binding.sourceIdentity]);
		},
	);

	it("已成功验证的第二次挂载在缓存过期且卷查询失败后仍可使用，原补证不覆盖", async () => {
		const binding = await createWriter();
		const sourceEvidenceDirectory = join(
			evidenceRoot(),
			createHash("sha256").update(JSON.stringify(sourceHome)).digest("hex"),
		);
		const originalEvidencePath = join(sourceEvidenceDirectory, `${binding.sourceIdentity}.json`);
		const originalEvidence = await readFile(originalEvidencePath, "utf8");
		remount.device -= 4n;
		await assertCodexConfigurationWriterBindingIdentity(binding);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 30_001);
		remount.volumeQueryFails = true;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		expect(await readFile(originalEvidencePath, "utf8")).toBe(originalEvidence);
		expect(await readdir(sourceEvidenceDirectory)).toContain("verified-mount-observations");
	});

	it("进程重建后复用同一次启动的持久挂载观察，新系统启动不能复用旧设备号", async () => {
		const binding = await createWriter();
		remount.device -= 4n;
		await assertCodexConfigurationWriterBindingIdentity(binding);
		remount.volumeQueryFails = true;
		vi.resetModules();
		const restartedProcess = await vi.importActual<typeof PersistentDirectoryIdentityModule>(
			"../../../src/codex-conversation-storage/codex-persistent-directory-identity",
		);
		await expect(
			restartedProcess.prepareCodexPersistentDirectoryIdentity(sourceHome, {
				expectedIdentity: binding.sourceIdentity,
			}),
		).resolves.toBe(binding.sourceIdentity);
		remount.bootSessionUuid = "302519E4-C7A6-426B-92A8-7AA2AD3A8BC1";
		vi.resetModules();
		const restartedSystem = await vi.importActual<typeof PersistentDirectoryIdentityModule>(
			"../../../src/codex-conversation-storage/codex-persistent-directory-identity",
		);
		await expect(
			restartedSystem.prepareCodexPersistentDirectoryIdentity(sourceHome, {
				expectedIdentity: binding.sourceIdentity,
			}),
		).rejects.toThrow(/卷身份暂不可核验/);
	});

	it("设备节点更换使 UUID 缓存和旧观察失效，查询冷却后仍拒绝错误卷并可恢复", async () => {
		const binding = await createWriter();
		remount.device -= 4n;
		await assertCodexConfigurationWriterBindingIdentity(binding);
		remount.deviceNodeInode++;
		remount.volumeQueryFails = true;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷身份暂不可核验/);
		const queriesAfterFailure = remount.volumeQueryCount;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷身份暂不可核验/);
		expect(remount.volumeQueryCount).toBe(queriesAfterFailure);
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 5_001);
		remount.volumeQueryFails = false;
		remount.volumeUuid = "4B2514E3-AD38-4AC1-A28D-F9CBB5DD088A";
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷|变化/);
		vi.setSystemTime(Date.now() + 30_001);
		remount.volumeUuid = "92B0DA1E-D7BD-434B-A92A-866E8EF81502";
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
	});

	it("同一新挂载的并发核验只发起一组卷查询", async () => {
		const binding = await createWriter();
		remount.device -= 4n;
		const queriesBeforeConcurrentChecks = remount.volumeQueryCount;
		await expect(
			Promise.all(
				Array.from({ length: 6 }, () =>
					codexDirectoryIdentity(sourceHome, { expectedIdentity: binding.sourceIdentity }),
				),
			),
		).resolves.toEqual(Array.from({ length: 6 }, () => binding.sourceIdentity));
		expect(remount.volumeQueryCount - queriesBeforeConcurrentChecks).toBe(2);
	});

	it("卷查询进行期间设备节点被替换时不为新节点登记旧查询的成功观察", async () => {
		const binding = await createWriter();
		remount.device -= 4n;
		remount.changeDeviceNodeDuringVolumeQuery = true;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷身份暂不可核验/);
		remount.changeDeviceNodeDuringVolumeQuery = false;
		remount.volumeQueryFails = true;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷身份暂不可核验/);
	});

	it("设备号改变后仍能续接旧绑定，保持来源身份、配置决定和原始清单", async () => {
		const binding = await createWriter();
		const manifestPath = join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json");
		const originalManifest = await readFile(manifestPath, "utf8");
		const originalStore = await readCodexConfigurationSyncStore();
		remount.device -= 4n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		expect(await codexDirectoryIdentity(sourceHome)).toBe(binding.sourceIdentity);
		expect(
			resolveRecordedCodexConversationHome({
				transcriptPath: join(binding.configurationHomeDirectoryPath, "sessions", "2026", "rollout.jsonl"),
			}),
		).toBe(storageHome);
		const resumed = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome,
			previousBinding: binding,
			runtimeSessionIncarnationId: randomUUID(),
		});
		expect(resumed.sourceIdentity).toBe(binding.sourceIdentity);
		expect((await readCodexConfigurationSyncStore()).sources).toEqual(originalStore.sources);
		expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
	});

	it("旧部署没有卷快照时自动补证，历史读取只读，后续重启从持久证据恢复", async () => {
		const binding = await createWriter();
		await rm(evidenceRoot(), { recursive: true });
		remount.device -= 4n;
		const queriesBeforeHistoryRead = remount.volumeQueryCount;
		expect(
			resolveRecordedCodexConversationHome({
				codexConversationStorageHomeDirectoryPath: storageHome,
				transcriptPath: join(binding.configurationHomeDirectoryPath, "sessions", "2026", "rollout.jsonl"),
			}),
		).toBe(storageHome);
		expect(remount.volumeQueryCount).toBe(queriesBeforeHistoryRead);
		await expect(readFile(evidenceRoot())).rejects.toMatchObject({ code: "ENOENT" });
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		// 再次挂载使用第三个设备号，卷、inode 与创建时间仍相同。
		remount.device -= 2n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		expect(await codexDirectoryIdentity(sourceHome)).toBe(binding.sourceIdentity);
	});

	it("同路径真实替换目录仍拒绝旧绑定，恢复原目录后自动恢复资格", async () => {
		const binding = await createWriter();
		await rename(sourceHome, `${sourceHome}-preserved-original`);
		await mkdir(sourceHome);
		remount.device -= 4n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/身份|变化/);
		await rm(sourceHome, { recursive: true });
		await rename(`${sourceHome}-preserved-original`, sourceHome);
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
	});

	it("卷 UUID 改变时即使路径与 inode 相同也拒绝继续", async () => {
		const binding = await createWriter();
		remount.device -= 4n;
		remount.volumeUuid = "4B2514E3-AD38-4AC1-A28D-F9CBB5DD088A";
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷|变化/);
	});

	it("旧目录补证不接受无原清单、绑定后创建的目录或错误 inode 摘要", async () => {
		const binding = await createWriter();
		await rm(evidenceRoot(), { recursive: true });
		remount.device -= 4n;
		expect(() =>
			resolveCodexPersistentDirectoryIdentity(sourceHome, { expectedIdentity: binding.sourceIdentity }),
		).toThrow(/原绑定证据/);
		const legacyBindingManifestPath = join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json");
		expect(() =>
			resolveCodexPersistentDirectoryIdentity(sourceHome, {
				expectedIdentity: binding.sourceIdentity,
				boundAtMs: 1,
				legacyBindingManifestPath,
			}),
		).toThrow(/原绑定证据/);
		expect(() =>
			resolveCodexPersistentDirectoryIdentity(sourceHome, {
				expectedIdentity: createHash("sha256").update("unrelated-inode").digest("hex"),
				boundAtMs: binding.createdAt,
				legacyBindingManifestPath,
			}),
		).toThrow(/inode/);
	});

	it("卷查询暂不可用时原设备身份仍可启动，恢复后补齐证据", async () => {
		remount.volumeQueryFails = true;
		const binding = await createWriter();
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		remount.volumeQueryFails = false;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		remount.device -= 4n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
	});

	it("其他平台继续精确核验原设备身份，不套用 macOS 的恢复路径", async () => {
		remount.platform = "linux";
		const binding = await createWriter();
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		remount.device -= 4n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/身份/);
	});

	it.each(["linux", "win32"])(
		"非 Darwin 平台 %s 的真实目录替换保持原错误契约，原目录恢复后自动恢复资格",
		async (nonDarwinPlatform) => {
			remount.platform = nonDarwinPlatform;
			const binding = await createWriter();
			const manifestPath = join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json");
			const originalManifest = await readFile(manifestPath, "utf8");
			const originalStore = await readCodexConfigurationSyncStore();
			const volumeQueriesBeforeDirectoryReplacement = remount.volumeQueryCount;
			await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
			const preservedOriginalSourceHome = `${sourceHome}-preserved-original`;
			await rename(sourceHome, preservedOriginalSourceHome);
			await mkdir(sourceHome);
			expect(await codexDirectoryIdentity(sourceHome)).not.toBe(binding.sourceIdentity);
			await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow("已被替换");
			expect((await readCodexConfigurationSyncStore()).sources).toEqual(originalStore.sources);
			expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
			await rm(sourceHome, { recursive: true });
			await rename(preservedOriginalSourceHome, sourceHome);
			await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
			expect(remount.volumeQueryCount).toBe(volumeQueriesBeforeDirectoryReplacement);
		},
	);

	it("系统查询失败沿用已核验的同一挂载，跨挂载等待有界冷却后自动补证", async () => {
		const binding = await createWriter();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 30_001);
		remount.volumeQueryFails = true;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		remount.device -= 4n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷身份暂不可核验/);
		const queriesAfterFailure = remount.volumeQueryCount;
		remount.volumeQueryFails = false;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/卷身份暂不可核验/);
		expect(remount.volumeQueryCount).toBe(queriesAfterFailure);
		vi.setSystemTime(Date.now() + 5_001);
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
	});
});
