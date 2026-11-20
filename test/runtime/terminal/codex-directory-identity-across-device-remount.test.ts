import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import type * as FileSystem from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type * as OperatingSystem from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import type * as PersistentDirectoryIdentityModule from "../../../src/codex-conversation-storage/codex-persistent-directory-identity";
import { prepareCodexPersistentDirectoryIdentity } from "../../../src/codex-conversation-storage/codex-persistent-directory-identity";
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
	secondaryVolumeRootPath: "",
	secondaryVolumeDevice: 16780000n,
	secondaryVolumeUuid: "47A26899-D62C-41D6-920C-460C5BF6DB5B",
	volumeQueryOccurredWhileStoreLocked: false,
	secondaryVolumeQueryFails: false,
	secondaryVolumeQueryCount: 0,
	deferSecondaryVolumeQueries: false,
	pendingSecondaryVolumeQueryCallbacks: [] as Array<() => void>,
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
			if (parameters[0] === "/dev/fixture-disk" || parameters[0] === "/dev/fixture-secondary-disk") {
				remount.deviceNodeReadCount++;
				if (remount.deviceNodeReadCount === remount.replaceDeviceNodeOnRead) remount.deviceNodeInode++;
				const metadata = filesystem.lstatSync(sourceHome, { bigint: true });
				const deviceNodeInode = remount.deviceNodeInode;
				const deviceNodeNumber =
					parameters[0] === "/dev/fixture-secondary-disk" ? remount.secondaryVolumeDevice : remount.device;
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
				get: (target, key) =>
					key === "dev"
						? remount.secondaryVolumeRootPath && String(parameters[0]).startsWith(remount.secondaryVolumeRootPath)
							? remount.secondaryVolumeDevice
							: remount.device
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
			if (binary === "/usr/sbin/sysctl") {
				queueMicrotask(() => callback(null, `${remount.bootSessionUuid}\n`, ""));
				return;
			}
			if (["/bin/df", "/usr/sbin/diskutil"].includes(binary)) {
				remount.volumeQueryCount++;
				const secondaryVolume =
					arguments_.includes("/dev/fixture-secondary-disk") ||
					Boolean(
						remount.secondaryVolumeRootPath &&
							String(arguments_.at(-1)).startsWith(remount.secondaryVolumeRootPath),
					);
				if (secondaryVolume) remount.secondaryVolumeQueryCount++;
				const respond = () => {
					if (binary === "/usr/sbin/diskutil" && remount.changeDeviceNodeDuringVolumeQuery)
						remount.deviceNodeInode++;
					callback(
						remount.volumeQueryFails || (secondaryVolume && remount.secondaryVolumeQueryFails)
							? new Error("fixture-volume-query-unavailable")
							: null,
						binary === "/bin/df"
							? `Filesystem Mounted on\n${secondaryVolume ? "/dev/fixture-secondary-disk" : "/dev/fixture-disk"} /fixture-mount\n`
							: `<plist><dict><key>VolumeUUID</key><string>${secondaryVolume ? remount.secondaryVolumeUuid : remount.volumeUuid}</string></dict></plist>`,
						"",
					);
				};
				if (secondaryVolume && remount.deferSecondaryVolumeQueries)
					remount.pendingSecondaryVolumeQueryCallbacks.push(respond);
				else queueMicrotask(respond);
				return;
			}
			return childProcess.execFile(binary, arguments_, options, callback);
		},
	};
});

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let _storageHome: string;
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
	remount.secondaryVolumeRootPath = "";
	remount.secondaryVolumeDevice += 32n;
	remount.volumeQueryOccurredWhileStoreLocked = false;
	remount.secondaryVolumeQueryFails = false;
	remount.secondaryVolumeQueryCount = 0;
	remount.deferSecondaryVolumeQueries = false;
	remount.pendingSecondaryVolumeQueryCallbacks = [];
	sourceHome = join(fixture.path, ".codex");
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), 'model="fixture-model"\n');
	_storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
const evidenceRoot = () => join(fixture.path, ".cline", "kanban", "codex-persistent-directory-identity-evidence");
const codexDirectoryIdentity = prepareCodexPersistentDirectoryIdentity;
const createWriter = async () => ({
	sourceIdentity: await prepareCodexPersistentDirectoryIdentity(sourceHome),
});
const assertCodexConfigurationWriterBindingIdentity = async (binding: Awaited<ReturnType<typeof createWriter>>) => {
	await prepareCodexPersistentDirectoryIdentity(sourceHome, { expectedIdentity: binding.sourceIdentity });
};
describe("Codex 目录身份的卷挂载核验", () => {
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

	it("缺少旧清单时原设备身份可启动，新挂载继续等核验证据", async () => {
		remount.volumeQueryFails = true;
		const binding = await createWriter();
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		remount.volumeQueryFails = false;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		remount.device -= 4n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/原绑定证据/);
	});

	it("其他平台继续精确核验原设备身份，不套用 macOS 的恢复路径", async () => {
		remount.platform = "linux";
		const binding = await createWriter();
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).resolves.toBeUndefined();
		remount.device -= 4n;
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/身份/);
	});

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
