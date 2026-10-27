import type * as ChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import type * as FileSystem from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type * as OperatingSystem from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createTempDir } from "../../utilities/temp-dir";

const volumeQueryFixture = vi.hoisted(() => ({
	fixtureRoot: "",
	slowSourceHome: "",
	slowDeviceNumber: 16_777_233n,
	reliableDeviceNumber: 16_777_237n,
	slowDeviceNodeInode: 1n,
	blockSlowVolumeQueries: false,
	onSlowVolumeQueryStarted: undefined as (() => void) | undefined,
	pendingSlowVolumeQueries: [] as Array<() => void>,
	systemQueriesStartedWhileStoreLocked: 0,
	systemQueryCount: 0,
}));
vi.mock("node:os", async (original) => ({
	...(await original<typeof OperatingSystem>()),
	platform: () => "darwin",
}));
vi.mock("node:fs", async (original) => {
	const filesystem = await original<typeof FileSystem>();
	return {
		...filesystem,
		lstatSync: (...parameters: Parameters<typeof filesystem.lstatSync>) => {
			const path = `${parameters[0]}`;
			if (path.startsWith("/dev/fixture-")) {
				const metadata = filesystem.lstatSync(volumeQueryFixture.fixtureRoot, { bigint: true });
				const isSlowDevice = path === "/dev/fixture-slow-volume";
				return new Proxy(metadata, {
					get: (target, key) => {
						if (key === "isBlockDevice") return () => true;
						if (key === "rdev")
							return isSlowDevice
								? volumeQueryFixture.slowDeviceNumber
								: volumeQueryFixture.reliableDeviceNumber;
						if (key === "ino") return isSlowDevice ? volumeQueryFixture.slowDeviceNodeInode : 1n;
						if (key === "ctimeNs") return 1_700_000_000n;
						return Reflect.get(target, key);
					},
				});
			}
			const metadata = filesystem.lstatSync(...parameters);
			if (!metadata || typeof metadata.dev !== "bigint") return metadata;
			return new Proxy(metadata, {
				get: (target, key) =>
					key === "dev"
						? path.startsWith(volumeQueryFixture.slowSourceHome)
							? volumeQueryFixture.slowDeviceNumber
							: volumeQueryFixture.reliableDeviceNumber
						: Reflect.get(target, key),
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
			if (!["/bin/df", "/usr/sbin/diskutil", "/usr/sbin/sysctl"].includes(binary))
				return childProcess.execFile(binary, arguments_, options, callback);
			volumeQueryFixture.systemQueryCount++;
			if (existsSync(`${getCodexConfigurationSyncDirectory()}.lock`))
				volumeQueryFixture.systemQueriesStartedWhileStoreLocked++;
			const isSlowVolume = arguments_.some(
				(argument) =>
					argument.startsWith(volumeQueryFixture.slowSourceHome) || argument === "/dev/fixture-slow-volume",
			);
			const stdout =
				binary === "/usr/sbin/sysctl"
					? "6FDD548B-1612-4B05-8E0E-7FEDB02AFF84\n"
					: binary === "/bin/df"
						? `Filesystem Mounted on\n/dev/fixture-${isSlowVolume ? "slow" : "reliable"}-volume /fixture-mount\n`
						: "<plist><dict><key>VolumeUUID</key><string>92B0DA1E-D7BD-434B-A92A-866E8EF81502</string></dict></plist>";
			if (isSlowVolume && volumeQueryFixture.blockSlowVolumeQueries) {
				let settled = false;
				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					callback(new Error("隔离卷查询达到真实命令超时"), "", "");
				}, options.timeout);
				volumeQueryFixture.pendingSlowVolumeQueries.push(() => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					callback(null, stdout, "");
				});
				volumeQueryFixture.onSlowVolumeQueryStarted?.();
				return;
			}
			queueMicrotask(() => callback(null, stdout, ""));
		},
	};
});

let fixture: ReturnType<typeof createTempDir>;
let reliableSourceHome: string;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-store-lock-volume-query-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	volumeQueryFixture.fixtureRoot = fixture.path;
	volumeQueryFixture.slowSourceHome = join(fixture.path, "slow-volume-source-home");
	reliableSourceHome = join(fixture.path, "reliable-volume-source-home");
	volumeQueryFixture.slowDeviceNumber += 32n;
	volumeQueryFixture.reliableDeviceNumber += 32n;
	volumeQueryFixture.slowDeviceNodeInode++;
	volumeQueryFixture.blockSlowVolumeQueries = false;
	volumeQueryFixture.pendingSlowVolumeQueries = [];
	volumeQueryFixture.systemQueriesStartedWhileStoreLocked = 0;
	volumeQueryFixture.systemQueryCount = 0;
	for (const home of [volumeQueryFixture.slowSourceHome, reliableSourceHome]) {
		await mkdir(home);
		await writeFile(join(home, "config.toml"), 'model="fixture-model"\n');
	}
});
afterEach(() => {
	releaseSlowVolumeQueries();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
function prepareWriterForSource(sourceHome: string) {
	return prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		runtimeSessionIncarnationId: randomUUID(),
	});
}
function holdSlowVolumeQueriesUntilExplicitRelease() {
	volumeQueryFixture.slowDeviceNodeInode++;
	volumeQueryFixture.blockSlowVolumeQueries = true;
	return new Promise<void>((resolve) => {
		volumeQueryFixture.onSlowVolumeQueryStarted = resolve;
	});
}
function releaseSlowVolumeQueries() {
	volumeQueryFixture.blockSlowVolumeQueries = false;
	volumeQueryFixture.onSlowVolumeQueryStarted = undefined;
	for (const release of volumeQueryFixture.pendingSlowVolumeQueries.splice(0)) release();
}

describe("配置 store 锁不等待卷系统查询", () => {
	it.each(["source_observation", "writer_preparation"] as const)(
		"%s 的慢查询尚未放行时，另一可靠来源的 Task 可完成准备且不先 ELOCKED 失败",
		async (slowOperationKind) => {
			await prepareWriterForSource(volumeQueryFixture.slowSourceHome);
			const reliableBinding = await prepareWriterForSource(reliableSourceHome);
			volumeQueryFixture.systemQueriesStartedWhileStoreLocked = 0;
			const slowQueryStarted = holdSlowVolumeQueriesUntilExplicitRelease();
			const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
			const slowOperation = (
				slowOperationKind === "source_observation"
					? service.scan()
					: prepareWriterForSource(volumeQueryFixture.slowSourceHome)
			).catch(() => undefined);
			try {
				await slowQueryStarted;
				const reliableStartupResult = await prepareWriterForSource(reliableSourceHome).then(
					(binding) => ({ kind: "prepared" as const, binding }),
					(error: NodeJS.ErrnoException) => ({ kind: "failed" as const, code: error.code }),
				);
				expect(reliableStartupResult.kind === "failed" ? reliableStartupResult.code : "prepared").toBe("prepared");
				if (reliableStartupResult.kind === "prepared")
					expect(reliableStartupResult.binding.sourceIdentity).toBe(reliableBinding.sourceIdentity);
				expect(volumeQueryFixture.blockSlowVolumeQueries).toBe(true);
				expect(volumeQueryFixture.systemQueriesStartedWhileStoreLocked).toBe(0);
			} finally {
				releaseSlowVolumeQueries();
				await slowOperation;
				await service.close();
			}
		},
	);

	it("锁外预取等待期间真实替换来源目录，锁内重核验仍拒绝并保留原决定", async () => {
		const binding = await prepareWriterForSource(volumeQueryFixture.slowSourceHome);
		const originalStore = await readCodexConfigurationSyncStore();
		const manifestPath = join(dirname(binding.configurationHomeDirectoryPath), "writer-binding.json");
		const originalManifest = await readFile(manifestPath, "utf8");
		const slowQueryStarted = holdSlowVolumeQueriesUntilExplicitRelease();
		const preparingWriter = prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: volumeQueryFixture.slowSourceHome,
			previousBinding: binding,
			runtimeSessionIncarnationId: randomUUID(),
		}).then(
			() => "prepared",
			() => "rejected",
		);
		await slowQueryStarted;
		await rename(volumeQueryFixture.slowSourceHome, `${volumeQueryFixture.slowSourceHome}-preserved-original`);
		await mkdir(volumeQueryFixture.slowSourceHome);
		await writeFile(join(volumeQueryFixture.slowSourceHome, "config.toml"), 'model="untrusted-replacement"\n');
		releaseSlowVolumeQueries();
		expect(await preparingWriter).toBe("rejected");
		expect((await readCodexConfigurationSyncStore()).sources).toEqual(originalStore.sources);
		expect(Object.keys((await readCodexConfigurationSyncStore()).writers)).toEqual(
			Object.keys(originalStore.writers),
		);
		expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
		await rm(volumeQueryFixture.slowSourceHome, { recursive: true });
		await rename(`${volumeQueryFixture.slowSourceHome}-preserved-original`, volumeQueryFixture.slowSourceHome);
		await expect(prepareWriterForSource(volumeQueryFixture.slowSourceHome)).resolves.toHaveProperty(
			"sourceIdentity",
			binding.sourceIdentity,
		);
	});

	it("持锁身份调用不发起系统查询，退出异步锁作用域后仍可正常补证", async () => {
		const binding = await prepareWriterForSource(volumeQueryFixture.slowSourceHome);
		volumeQueryFixture.slowDeviceNodeInode++;
		volumeQueryFixture.systemQueriesStartedWhileStoreLocked = 0;
		const queriesBeforeLockedVerification = volumeQueryFixture.systemQueryCount;
		await expect(
			mutateCodexConfigurationSyncStore(() =>
				codexDirectoryIdentity(volumeQueryFixture.slowSourceHome, { expectedIdentity: binding.sourceIdentity }),
			),
		).rejects.toThrow(/卷身份暂不可核验/);
		expect(volumeQueryFixture.systemQueryCount).toBe(queriesBeforeLockedVerification);
		expect(volumeQueryFixture.systemQueriesStartedWhileStoreLocked).toBe(0);
		await expect(
			codexDirectoryIdentity(volumeQueryFixture.slowSourceHome, { expectedIdentity: binding.sourceIdentity }),
		).resolves.toBe(binding.sourceIdentity);
		expect(volumeQueryFixture.systemQueryCount).toBeGreaterThan(queriesBeforeLockedVerification);
	});

	it.each(["directory", "device_node"] as const)(
		"预取完成后等待 store 锁期间替换 %s，取得锁后重新核验并拒绝，不在锁内补查",
		async (replacedEntity) => {
			const binding = await prepareWriterForSource(volumeQueryFixture.slowSourceHome);
			const originalStore = await readCodexConfigurationSyncStore();
			let releaseStoreMutation: () => void = () => {};
			let markStoreMutationStarted: () => void = () => {};
			const storeMutationStarted = new Promise<void>((resolve) => {
				markStoreMutationStarted = resolve;
			});
			const storeMutationMayFinish = new Promise<void>((resolve) => {
				releaseStoreMutation = resolve;
			});
			const heldStoreMutation = mutateCodexConfigurationSyncStore(async () => {
				markStoreMutationStarted();
				await storeMutationMayFinish;
			});
			await storeMutationStarted;
			const acquireStoreLock = lockfile.lock;
			let markWriterWaitingForStoreLock: () => void = () => {};
			const writerWaitingForStoreLock = new Promise<void>((resolve) => {
				markWriterWaitingForStoreLock = resolve;
			});
			const storeLockAttemptObserver = vi.spyOn(lockfile, "lock").mockImplementation((...parameters) => {
				markWriterWaitingForStoreLock();
				return acquireStoreLock(...parameters);
			});
			const preparingWriter = prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: volumeQueryFixture.slowSourceHome,
				previousBinding: binding,
				runtimeSessionIncarnationId: randomUUID(),
			}).then(
				() => "prepared",
				() => "rejected",
			);
			try {
				await writerWaitingForStoreLock;
				const queriesAfterPreflight = volumeQueryFixture.systemQueryCount;
				if (replacedEntity === "directory") {
					await rename(
						volumeQueryFixture.slowSourceHome,
						`${volumeQueryFixture.slowSourceHome}-preserved-original`,
					);
					await mkdir(volumeQueryFixture.slowSourceHome);
				} else volumeQueryFixture.slowDeviceNodeInode++;
				releaseStoreMutation();
				await heldStoreMutation;
				expect(await preparingWriter).toBe("rejected");
				expect(volumeQueryFixture.systemQueryCount).toBe(queriesAfterPreflight);
				expect((await readCodexConfigurationSyncStore()).sources).toEqual(originalStore.sources);
				expect(Object.keys((await readCodexConfigurationSyncStore()).writers)).toEqual(
					Object.keys(originalStore.writers),
				);
				if (replacedEntity === "directory") {
					await rm(volumeQueryFixture.slowSourceHome, { recursive: true });
					await rename(
						`${volumeQueryFixture.slowSourceHome}-preserved-original`,
						volumeQueryFixture.slowSourceHome,
					);
				}
				storeLockAttemptObserver.mockRestore();
				await expect(prepareWriterForSource(volumeQueryFixture.slowSourceHome)).resolves.toHaveProperty(
					"sourceIdentity",
					binding.sourceIdentity,
				);
			} finally {
				releaseStoreMutation();
				await heldStoreMutation;
				await preparingWriter;
			}
		},
	);
});
