import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type * as FileSystemPromises from "node:fs/promises";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type * as OperatingSystem from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexConfigurationSyncDirectory } from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { createTempDir } from "../../utilities/temp-dir";

const markerRace = vi.hoisted(() => ({
	markerPath: "",
	interceptCanonicalMarkerRewrite: false,
	markerHasBeenTruncated: false,
	onMarkerTruncated: undefined as (() => void) | undefined,
	releaseMarkerWrite: undefined as (() => void) | undefined,
	interceptAtomicMarkerPublication: false,
	onAtomicMarkerPublicationPending: undefined as (() => void) | undefined,
	releaseAtomicMarkerPublication: undefined as (() => void) | undefined,
	pendingMarkerPublicationPath: "",
	readsDuringTruncationStoreLockHeld: [] as boolean[],
	failMarkerParentSynchronization: false,
	completedMarkerPublicationRenames: 0,
	markerSynchronizationPaths: [] as string[],
	operatingSystemPlatform: "linux" as NodeJS.Platform,
	markerOpenRequests: [] as { path: string; flags: string | number }[],
	failMarkerFileSynchronization: false,
}));
vi.mock("node:os", async (original) => ({
	...(await original<typeof OperatingSystem>()),
	platform: () => markerRace.operatingSystemPlatform,
}));
vi.mock("node:fs/promises", async (original) => {
	const filesystem = await original<typeof FileSystemPromises>();
	return {
		...filesystem,
		open: async (...parameters: Parameters<typeof filesystem.open>) => {
			const handle = await filesystem.open(...parameters);
			const path = `${parameters[0]}`;
			const fileOpenFlags = parameters[1] ?? "r";
			if (
				markerRace.markerPath &&
				(path === markerRace.markerPath ||
					path.startsWith(`${markerRace.markerPath}.tmp.`) ||
					path === dirname(markerRace.markerPath))
			) {
				markerRace.markerOpenRequests.push({ path, flags: fileOpenFlags });
				const synchronizeHandle = handle.sync.bind(handle);
				vi.spyOn(handle, "sync").mockImplementation(async () => {
					markerRace.markerSynchronizationPaths.push(path);
					if (markerRace.operatingSystemPlatform === "win32") {
						// 模拟 Windows 句柄合同，不把宿主 POSIX 对只读句柄的 sync 支持当作 Windows 能力。
						if (path === dirname(markerRace.markerPath))
							throw Object.assign(new Error("受控 Windows 目录同步不支持"), { code: "EINVAL" });
						if (fileOpenFlags === "r")
							throw Object.assign(new Error("受控 Windows 只读句柄缺少 GENERIC_WRITE"), { code: "EACCES" });
					}
					if (path !== dirname(markerRace.markerPath) && markerRace.failMarkerFileSynchronization)
						throw Object.assign(new Error("受控 canonical 标记文件 fsync 失败"), { code: "EIO" });
					if (
						path === dirname(markerRace.markerPath) &&
						markerRace.completedMarkerPublicationRenames > 0 &&
						markerRace.failMarkerParentSynchronization
					)
						throw Object.assign(new Error("受控 canonical 标记父目录 fsync 失败"), { code: "EIO" });
					await synchronizeHandle();
				});
			}
			return handle;
		},
		readFile: (...parameters: Parameters<typeof filesystem.readFile>) => {
			if (`${parameters[0]}` === markerRace.markerPath && markerRace.markerHasBeenTruncated)
				markerRace.readsDuringTruncationStoreLockHeld.push(
					existsSync(`${getCodexConfigurationSyncDirectory()}.lock`),
				);
			return filesystem.readFile(...parameters);
		},
		writeFile: async (...parameters: Parameters<typeof filesystem.writeFile>) => {
			if (`${parameters[0]}` === markerRace.markerPath && markerRace.interceptCanonicalMarkerRewrite) {
				// 普通 writeFile 先截断再写正文；用真实空文件和显式屏障固定这个合法中间态。
				await filesystem.writeFile(parameters[0], "", parameters[2]);
				markerRace.markerHasBeenTruncated = true;
				const markerWriteMayContinue = new Promise<void>((resolve) => {
					markerRace.releaseMarkerWrite = resolve;
				});
				markerRace.onMarkerTruncated?.();
				await markerWriteMayContinue;
			}
			return filesystem.writeFile(...parameters);
		},
		rename: async (...parameters: Parameters<typeof filesystem.rename>) => {
			if (`${parameters[1]}` === markerRace.markerPath && markerRace.interceptAtomicMarkerPublication) {
				markerRace.pendingMarkerPublicationPath = `${parameters[0]}`;
				const markerMayBePublished = new Promise<void>((resolve) => {
					markerRace.releaseAtomicMarkerPublication = resolve;
				});
				markerRace.onAtomicMarkerPublicationPending?.();
				await markerMayBePublished;
			}
			await filesystem.rename(...parameters);
			if (`${parameters[1]}` === markerRace.markerPath) markerRace.completedMarkerPublicationRenames += 1;
		},
	};
});

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let storageHome: string;
beforeEach(async () => {
	fixture = createTempDir("codex-canonical-marker-concurrent-reader-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	markerRace.markerPath = "";
	markerRace.interceptCanonicalMarkerRewrite = false;
	markerRace.markerHasBeenTruncated = false;
	markerRace.onMarkerTruncated = undefined;
	markerRace.releaseMarkerWrite = undefined;
	markerRace.interceptAtomicMarkerPublication = false;
	markerRace.onAtomicMarkerPublicationPending = undefined;
	markerRace.releaseAtomicMarkerPublication = undefined;
	markerRace.pendingMarkerPublicationPath = "";
	markerRace.readsDuringTruncationStoreLockHeld = [];
	markerRace.failMarkerParentSynchronization = false;
	markerRace.completedMarkerPublicationRenames = 0;
	markerRace.markerSynchronizationPaths = [];
	markerRace.operatingSystemPlatform = "linux";
	markerRace.markerOpenRequests = [];
	markerRace.failMarkerFileSynchronization = false;
	sourceHome = join(fixture.path, ".codex");
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), 'model="original-model"\n');
	storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
	markerRace.markerPath = join(storageHome, "canonical-user-codex-home.json");
});
afterEach(() => {
	markerRace.releaseMarkerWrite?.();
	markerRace.releaseAtomicMarkerPublication?.();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
function prepareWriter() {
	return prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		runtimeSessionIncarnationId: randomUUID(),
	});
}

describe("Codex canonical 来源标记的并发读取", () => {
	it("已有原归属在重复准备与 writer 并发启动时始终可读，保留原生决定和账号归属", async () => {
		const originalBinding = await prepareWriter();
		const originalConfigurationPath = join(originalBinding.configurationHomeDirectoryPath, "config.toml");
		const nativeConfiguration = parse(await readFile(originalConfigurationPath, "utf8"));
		nativeConfiguration.model = "native-local-decision";
		await writeFile(originalConfigurationPath, stringify(nativeConfiguration));
		const originalConfigurationText = await readFile(originalConfigurationPath, "utf8");
		const originalMarkerText = await readFile(markerRace.markerPath, "utf8");
		const originalMarkerMetadata = await lstat(markerRace.markerPath, { bigint: true });
		await writeFile(join(sourceHome, "config.toml"), 'model="new-user-default"\n');
		const markerTruncated = new Promise<"marker_truncated">((resolve) => {
			markerRace.onMarkerTruncated = () => resolve("marker_truncated");
		});
		markerRace.interceptCanonicalMarkerRewrite = true;
		const repeatedPreparation = prepareManagedCodexConversationStorageHome(sourceHome);
		try {
			await Promise.race([markerTruncated, repeatedPreparation.then(() => "preparation_completed")]);
			const startup = await prepareWriter().then(
				(binding) => ({ kind: "prepared", sourceHome: binding.sourceHomeDirectoryPath }),
				(error: Error) => ({
					kind: "failed",
					errorName: error.name,
					message: error.message,
					readsDuringTruncationStoreLockHeld: markerRace.readsDuringTruncationStoreLockHeld,
				}),
			);
			expect(startup).toEqual({ kind: "prepared", sourceHome });
			expect(await readFile(originalConfigurationPath, "utf8")).toBe(originalConfigurationText);
			expect(parse(await readFile(join(storageHome, "config.toml"), "utf8")).model).toBe("original-model");
		} finally {
			markerRace.releaseMarkerWrite?.();
			markerRace.releaseAtomicMarkerPublication?.();
			await repeatedPreparation;
			markerRace.interceptCanonicalMarkerRewrite = false;
			markerRace.markerHasBeenTruncated = false;
		}
		expect(await readFile(markerRace.markerPath, "utf8")).toBe(originalMarkerText);
		const markerMetadataAfterRepeatedPreparation = await lstat(markerRace.markerPath, { bigint: true });
		expect(markerMetadataAfterRepeatedPreparation.ino).toBe(originalMarkerMetadata.ino);
		expect(markerMetadataAfterRepeatedPreparation.mtimeNs).toBe(originalMarkerMetadata.mtimeNs);
		const wrongSource = join(fixture.path, "different-account-home");
		await mkdir(wrongSource);
		await expect(prepareManagedCodexConversationStorageHome(wrongSource)).rejects.toThrow("不能混用账号");
	});

	it("首次发布标记时并发读取只见不存在或完整JSON，发布后 writer 能核验原来源", async () => {
		await rm(markerRace.markerPath);
		const markerTruncated = new Promise<"marker_truncated">((resolve) => {
			markerRace.onMarkerTruncated = () => resolve("marker_truncated");
		});
		const atomicMarkerPublicationPending = new Promise<"atomic_publication_pending">((resolve) => {
			markerRace.onAtomicMarkerPublicationPending = () => resolve("atomic_publication_pending");
		});
		markerRace.interceptCanonicalMarkerRewrite = true;
		markerRace.interceptAtomicMarkerPublication = true;
		const firstPublication = prepareManagedCodexConversationStorageHome(sourceHome);
		try {
			const publicationStage = await Promise.race([
				markerTruncated,
				atomicMarkerPublicationPending,
				firstPublication.then(() => "preparation_completed"),
			]);
			const markerVisibility = await readFile(markerRace.markerPath, "utf8").then(
				(text) => ({ kind: "present" as const, text }),
				(error: NodeJS.ErrnoException) => ({ kind: "absent" as const, code: error.code }),
			);
			if (publicationStage === "preparation_completed") {
				if (markerVisibility.kind !== "present") throw new Error("发布完成后原归属标记仍不可读。");
				expect(JSON.parse(markerVisibility.text)).toEqual({ sourceHomeDirectoryPath: sourceHome });
			} else {
				expect(markerVisibility).toEqual({ kind: "absent", code: "ENOENT" });
				if (markerRace.pendingMarkerPublicationPath)
					expect(JSON.parse(await readFile(markerRace.pendingMarkerPublicationPath, "utf8"))).toEqual({
						sourceHomeDirectoryPath: sourceHome,
					});
			}
		} finally {
			markerRace.releaseMarkerWrite?.();
			markerRace.releaseAtomicMarkerPublication?.();
			await firstPublication;
			markerRace.interceptCanonicalMarkerRewrite = false;
			markerRace.markerHasBeenTruncated = false;
		}
		expect(JSON.parse(await readFile(markerRace.markerPath, "utf8"))).toEqual({
			sourceHomeDirectoryPath: sourceHome,
		});
		await expect(prepareWriter()).resolves.toHaveProperty("sourceHomeDirectoryPath", sourceHome);
	});

	it("已有标记损坏仍拒绝且不覆盖未知归属", async () => {
		await writeFile(markerRace.markerPath, "{");
		await expect(prepareManagedCodexConversationStorageHome(sourceHome)).rejects.toThrow(SyntaxError);
		expect(await readFile(markerRace.markerPath, "utf8")).toBe("{");
	});

	it("首次 rename 后父目录 fsync 失败，同来源重试必须补齐持久化才成功", async () => {
		await rm(markerRace.markerPath);
		markerRace.failMarkerParentSynchronization = true;
		await expect(prepareManagedCodexConversationStorageHome(sourceHome)).rejects.toThrow(
			"受控 canonical 标记父目录 fsync 失败",
		);
		expect(markerRace.completedMarkerPublicationRenames).toBe(1);
		expect(JSON.parse(await readFile(markerRace.markerPath, "utf8"))).toEqual({
			sourceHomeDirectoryPath: sourceHome,
		});
		const publishedMarkerMetadata = await lstat(markerRace.markerPath, { bigint: true });
		markerRace.markerSynchronizationPaths = [];
		await expect(prepareManagedCodexConversationStorageHome(sourceHome)).rejects.toThrow(
			"受控 canonical 标记父目录 fsync 失败",
		);
		expect(markerRace.markerSynchronizationPaths).toEqual([markerRace.markerPath, dirname(markerRace.markerPath)]);
		markerRace.failMarkerParentSynchronization = false;
		markerRace.markerSynchronizationPaths = [];
		await expect(prepareManagedCodexConversationStorageHome(sourceHome)).resolves.toBe(storageHome);
		expect(markerRace.markerSynchronizationPaths).toEqual([markerRace.markerPath, dirname(markerRace.markerPath)]);
		expect(markerRace.completedMarkerPublicationRenames).toBe(1);
		const recoveredMarkerMetadata = await lstat(markerRace.markerPath, { bigint: true });
		expect(recoveredMarkerMetadata.ino).toBe(publishedMarkerMetadata.ino);
		expect(recoveredMarkerMetadata.mtimeNs).toBe(publishedMarkerMetadata.mtimeNs);
		await expect(prepareWriter()).resolves.toHaveProperty("sourceHomeDirectoryPath", sourceHome);
	});

	it("Windows 首次发布与同内容重试使用可写文件句柄同步，不打开父目录", async () => {
		markerRace.operatingSystemPlatform = "win32";
		await rm(markerRace.markerPath);
		await expect(prepareManagedCodexConversationStorageHome(sourceHome)).resolves.toBe(storageHome);
		expect(markerRace.completedMarkerPublicationRenames).toBe(1);
		expect(markerRace.markerOpenRequests).toEqual([
			{ path: expect.stringContaining(`${markerRace.markerPath}.tmp.`), flags: "r+" },
		]);
		expect(markerRace.markerSynchronizationPaths).toEqual([markerRace.markerOpenRequests[0]?.path]);
		expect(JSON.parse(await readFile(markerRace.markerPath, "utf8"))).toEqual({
			sourceHomeDirectoryPath: sourceHome,
		});
		const publishedMarkerMetadata = await lstat(markerRace.markerPath, { bigint: true });
		markerRace.markerOpenRequests = [];
		markerRace.markerSynchronizationPaths = [];
		await expect(prepareManagedCodexConversationStorageHome(sourceHome)).resolves.toBe(storageHome);
		expect(markerRace.markerOpenRequests).toEqual([{ path: markerRace.markerPath, flags: "r+" }]);
		expect(markerRace.markerSynchronizationPaths).toEqual([markerRace.markerPath]);
		expect(markerRace.completedMarkerPublicationRenames).toBe(1);
		const retriedMarkerMetadata = await lstat(markerRace.markerPath, { bigint: true });
		expect(retriedMarkerMetadata.ino).toBe(publishedMarkerMetadata.ino);
		expect(retriedMarkerMetadata.mtimeNs).toBe(publishedMarkerMetadata.mtimeNs);
		await expect(prepareWriter()).resolves.toHaveProperty("sourceHomeDirectoryPath", sourceHome);
	});

	it("Windows 可写文件句柄的真实同步故障仍拒绝，恢复后重试成功", async () => {
		markerRace.operatingSystemPlatform = "win32";
		markerRace.failMarkerFileSynchronization = true;
		for (let attempt = 0; attempt < 2; attempt += 1)
			await expect(prepareManagedCodexConversationStorageHome(sourceHome)).rejects.toMatchObject({ code: "EIO" });
		markerRace.failMarkerFileSynchronization = false;
		await expect(prepareManagedCodexConversationStorageHome(sourceHome)).resolves.toBe(storageHome);
		expect(markerRace.markerOpenRequests).toEqual(
			Array.from({ length: 3 }, () => ({ path: markerRace.markerPath, flags: "r+" })),
		);
		expect(markerRace.markerSynchronizationPaths).toEqual(Array.from({ length: 3 }, () => markerRace.markerPath));
		expect(markerRace.completedMarkerPublicationRenames).toBe(0);
	});
});
