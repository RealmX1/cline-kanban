import { EventEmitter } from "node:events";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyCodexNativeSharedPluginInstallationCapability } from "../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-verification";
import { createTempDir } from "../../utilities/temp-dir";

const nativeProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: nativeProcessMocks.spawn }));

const syntheticMarketplaceName = "kanban-installation-capability-probe";
const syntheticPluginKey = `synthetic-hook@${syntheticMarketplaceName}`;
let fixture: ReturnType<typeof createTempDir>;
let installedDirectoryName: string;
let useUnsupportedCacheLayout: boolean;
let omitInstalledDirectory: boolean;
let receiptPluginId: string;
let receiptVersion: string;
let receiptUsesAnotherExistingDirectory: boolean;
let gitCommandStandardOutput: string;
let malformedJsonCommand: "upgrade" | "add" | undefined;
let failingNativeCommand: boolean;
let timeoutNativeCommand: boolean;
let lastSpawnedChild: EventEmitter;

beforeEach(async () => {
	fixture = createTempDir("codex-native-plugin-verification-");
	fixture.path = await realpath(fixture.path);
	installedDirectoryName = "1.0.0";
	useUnsupportedCacheLayout = false;
	omitInstalledDirectory = false;
	receiptPluginId = syntheticPluginKey;
	receiptVersion = "1.0.0";
	receiptUsesAnotherExistingDirectory = false;
	gitCommandStandardOutput = "";
	malformedJsonCommand = undefined;
	failingNativeCommand = false;
	timeoutNativeCommand = false;
	vi.spyOn(process, "kill").mockImplementation(() => {
		lastSpawnedChild.emit("close", null);
		return true;
	});
	nativeProcessMocks.spawn.mockReset();
	nativeProcessMocks.spawn.mockImplementation(
		(binary: string, arguments_: string[], options: { env: NodeJS.ProcessEnv }) => {
			const child = Object.assign(new EventEmitter(), {
				pid: 123456,
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
			});
			lastSpawnedChild = child;
			const finish = (stdout: unknown, exitCode = 0, stderr = "") => {
				if (stdout !== undefined) child.stdout.write(typeof stdout === "string" ? stdout : JSON.stringify(stdout));
				if (stderr) child.stderr.write(stderr);
				child.emit("close", exitCode);
			};
			// Git 也完全替换为内存进程，测试不会执行真实仓库命令。
			if (binary === "git") {
				queueMicrotask(() => finish(gitCommandStandardOutput));
				return child;
			}
			const configurationHome = options.env.CODEX_HOME ?? "";
			if (arguments_.includes("app-server")) {
				child.stdin.on("data", (bytes: Buffer) => {
					const request = JSON.parse(bytes.toString()) as { id?: number; method: string };
					if (request.method === "initialize")
						queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`));
					if (request.method === "hooks/list")
						queueMicrotask(() => {
							child.stdout.write(
								`${JSON.stringify({ id: 2, result: { data: [{ errors: [], hooks: [{ key: `${syntheticPluginKey}:UserPromptSubmit`, currentHash: "stable-native-hook-hash" }] }] } })}\n`,
							);
							child.emit("close", 0);
						});
				});
				return child;
			}
			queueMicrotask(() => {
				void (async () => {
					if (timeoutNativeCommand) {
						vi.advanceTimersByTime(30_000);
						return;
					}
					if (failingNativeCommand) return finish("not-json", 1, "temporary native operation failure");
					if (arguments_.includes("upgrade")) {
						if (malformedJsonCommand === "upgrade") return finish("marketplace upgrade succeeded");
						const marketplaceDirectory = join(
							configurationHome,
							".tmp",
							"marketplaces",
							syntheticMarketplaceName,
						);
						await mkdir(marketplaceDirectory, { recursive: true });
						await writeFile(
							join(marketplaceDirectory, ".codex-marketplace-install.json"),
							"stable-installation-record",
						);
						return finish({ selectedMarketplaces: [syntheticMarketplaceName], upgradedRoots: [], errors: [] });
					}
					if (malformedJsonCommand === "add") return finish("plugin installation succeeded");
					const installedPath = useUnsupportedCacheLayout
						? join(configurationHome, "plugins", "new-cache-layout", installedDirectoryName)
						: join(
								configurationHome,
								"plugins",
								"cache",
								syntheticMarketplaceName,
								"synthetic-hook",
								installedDirectoryName,
							);
					if (!omitInstalledDirectory) {
						await mkdir(join(installedPath, "hooks"), { recursive: true });
						await writeFile(join(installedPath, "hooks", "hooks.json"), "stable-hook-payload");
					}
					const receiptInstalledPath = receiptUsesAnotherExistingDirectory
						? join(configurationHome, "another-installed-plugin")
						: installedPath;
					if (receiptUsesAnotherExistingDirectory) await mkdir(receiptInstalledPath);
					finish({ pluginId: receiptPluginId, installedPath: receiptInstalledPath, version: receiptVersion });
				})().catch((error: unknown) => child.emit("error", error));
			});
			return child;
		},
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	fixture.cleanup();
});

function verifyNativeInstallation() {
	return verifyCodexNativeSharedPluginInstallationCapability({
		nativeExecutableRealPath: join(fixture.path, "isolated-native-executable"),
		isolatedProbeDirectoryPath: fixture.path,
		environment: { PATH: process.env.PATH },
		recordActiveNativeProcess: async () => {},
	});
}

describe("原生插件安装协议与实际布局核验", () => {
	it("Git 成功输出非 JSON 文本不影响原生插件能力核验", async () => {
		gitCommandStandardOutput = "Initialized synthetic Git repository\n";
		await expect(verifyNativeInstallation()).resolves.toMatchObject({ status: "supported" });
	});

	it.each(["1.0.0", "1.0.0-content-digest"])("兼容的唯一版本目录 %s 按实际回执核验并通过", async (directoryName) => {
		installedDirectoryName = directoryName;
		await expect(verifyNativeInstallation()).resolves.toMatchObject({ status: "supported" });
	});

	it("成功回执指向实际存在的新缓存层级时明确不支持", async () => {
		useUnsupportedCacheLayout = true;
		await expect(verifyNativeInstallation()).resolves.toMatchObject({
			status: "unsupported",
			reason: expect.stringContaining("缓存布局不兼容"),
		});
	});

	it("回执目录仍不可读时保留缺证异常以便上层重试", async () => {
		omitInstalledDirectory = true;
		await expect(verifyNativeInstallation()).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["pluginId", "version"])("回执 %s 不属于合成插件时不接受成功", async (field) => {
		if (field === "pluginId") receiptPluginId = "another-plugin@another-marketplace";
		else receiptVersion = "2.0.0";
		await expect(verifyNativeInstallation()).resolves.toMatchObject({
			status: "unsupported",
			reason: expect.stringContaining("插件身份不符"),
		});
	});

	it("回执指向另一实际目录时不把已存在的兼容缓存冒充匹配", async () => {
		receiptUsesAnotherExistingDirectory = true;
		await expect(verifyNativeInstallation()).resolves.toMatchObject({
			status: "unsupported",
			reason: expect.stringContaining("实际插件目录不符"),
		});
	});

	it.each(["upgrade", "add"] as const)("原生 %s 成功退出却输出非 JSON 时明确协议不支持", async (command) => {
		malformedJsonCommand = command;
		await expect(verifyNativeInstallation()).resolves.toMatchObject({
			status: "unsupported",
			reason: expect.stringContaining("JSON 响应"),
		});
	});

	it("非零退出即使输出非 JSON 也保留执行失败以便上层重试", async () => {
		failingNativeCommand = true;
		await expect(verifyNativeInstallation()).rejects.toThrow("隔离插件操作暂未完成（exit=1）");
	});

	it("原生命令超时仍保留缺证异常并回收进程", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		timeoutNativeCommand = true;
		await expect(verifyNativeInstallation()).rejects.toThrow("隔离核验超时");
		expect(process.kill).toHaveBeenCalledWith(process.platform === "win32" ? 123456 : -123456, "SIGKILL");
	});
});
