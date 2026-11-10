import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertCodexAutomaticPluginGitWorkingDirectory,
	buildCodexAutomaticPluginInstallationGitEnvironment,
} from "../../../src/codex-configuration-sync/codex-automatic-plugin-installation-git-environment";
import {
	assertCodexConfigurationWriterBindingIdentity,
	prepareCodexConfigurationWriterBinding,
} from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import * as nativePluginCapabilityEvidence from "../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-evidence";
import * as nativePluginCapabilityVerification from "../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-verification";
import { claimCodexSourcePluginInstallationControllerOwnership } from "../../../src/codex-configuration-sync/codex-source-plugin-installation-controller-ownership";
import {
	prepareAuxiliaryCodexConfigurationLaunch,
	prepareCodexSharedPluginInstallationForNativeLaunch,
	terminateDetachedNativeInstallationProcessGroup,
} from "../../../src/codex-configuration-sync/codex-source-shared-plugin-installation-coordinator";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import { requireDefinedTestFixtureValue } from "../../utilities/require-defined-test-fixture-value";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let binary: string;
vi.mock("../../../src/codex-configuration-sync/codex-native-plugin-installation-capability-verification", () => ({
	verifyCodexNativeSharedPluginInstallationCapability: vi.fn(async () => ({
		status: "supported",
		reason: "合成能力通过",
	})),
}));
beforeEach(async () => {
	fixture = createTempDir("codex-shared-installation-directories-");
	fixture.path = await realpath(fixture.path);
	sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), "");
	binary = join(fixture.path, "codex-native-version-fixture");
	await writeFile(
		binary,
		`#!${process.execPath}\nprocess.stdout.write(process.env.ISOLATED_CODEX_VERSION || 'codex-cli 0.166.0');\n`,
		{ mode: 0o700 },
	);
	vi.mocked(nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability)
		.mockReset()
		.mockResolvedValue({
			status: "supported",
			reason: "合成能力通过",
		});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
const writer = (previousBinding?: CodexConfigurationWriterBinding, version = "codex-cli 0.166.0") =>
	prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		runtimeSessionIncarnationId: randomUUID(),
		previousBinding,
		binary,
		environment: {
			HOME: fixture.path,
			CODEX_HOME: sourceHome,
			CODEX_SQLITE_HOME: sourceHome,
			ISOLATED_CODEX_VERSION: version,
		},
	});

describe("Codex 来源域共享插件容器的绑定", () => {
	it("同一次启动在瞬时缺证后自动重试并接续，不要求用户重新启动", async () => {
		const prepareActualCapabilityEvidence =
			nativePluginCapabilityEvidence.prepareCodexNativePluginInstallationCapabilityEvidence;
		vi.spyOn(
			nativePluginCapabilityEvidence,
			"prepareCodexNativePluginInstallationCapabilityEvidence",
		).mockImplementationOnce(async (input) => {
			const pending = await prepareActualCapabilityEvidence(input);
			vi.spyOn(Date, "now").mockReturnValue(pending.nextAttemptAtMs + 1);
			return pending;
		});
		vi.mocked(
			nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
		).mockRejectedValueOnce(new Error("瞬时缺证"));
		const binding = await writer();
		expect(binding.sourceSharedPluginInstallationDirectoriesBinding).toBeDefined();
		expect(
			nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
		).toHaveBeenCalledTimes(2);
	});
	it("机器等待期间用户 Stop 继续有效，不再核验或创建原生 writer", async () => {
		vi.mocked(
			nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
		).mockRejectedValueOnce(new Error("瞬时缺证"));
		const revalidateNativeCapabilityRetryStillAuthorized = vi.fn(() => {
			throw new Error("用户已 Stop");
		});
		await expect(
			prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: sourceHome,
				runtimeSessionIncarnationId: randomUUID(),
				binary,
				environment: { HOME: fixture.path, CODEX_HOME: sourceHome, CODEX_SQLITE_HOME: sourceHome },
				revalidateNativeCapabilityRetryStillAuthorized,
			}),
		).rejects.toThrow("用户已 Stop");
		expect(revalidateNativeCapabilityRetryStillAuthorized).toHaveBeenCalledTimes(1);
		expect(
			nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
		).toHaveBeenCalledTimes(1);
	});
	it("外层租约被夺取也不能越过仍执行中的来源域控制器，完成后继续核验原生子进程", async () => {
		const directory = join(fixture.path, "source-installation-controller-ownership");
		await mkdir(directory);
		const previousNativeOperation = vi.fn(async () => {});
		const input = {
			coordinationDirectoryPath: directory,
			sourceInstallationStatePath: join(directory, `source-installation-${"a".repeat(64)}.json`),
			environment: process.env,
			assertPreviousNativeOperationHasExited: previousNativeOperation,
		};
		const finishFirst = await claimCodexSourcePluginInstallationControllerOwnership(input);
		try {
			await expect(claimCodexSourcePluginInstallationControllerOwnership(input)).rejects.toThrow(/控制器仍在执行/);
			expect(previousNativeOperation).not.toHaveBeenCalled();
		} finally {
			await finishFirst();
		}
		const finishSecond = await claimCodexSourcePluginInstallationControllerOwnership({
			...input,
			sourceInstallationStatePath: join(directory, `source-installation-${"b".repeat(64)}.json`),
		});
		try {
			expect(previousNativeOperation).toHaveBeenCalledExactlyOnceWith(input.sourceInstallationStatePath);
		} finally {
			await finishSecond();
		}
	});
	it("自动安装保持原生 Git 仓库隔离，保留认证与只读 Trace2 观测环境", () => {
		const input = {
			HOME: fixture.path,
			CODEX_HOME: sourceHome,
			GIT_DIR: "/untrusted/repository",
			GIT_WORK_TREE: "/untrusted/worktree",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_PARAMETERS: "unsafe",
			GIT_TRACE2_EVENT: join(fixture.path, "trace.jsonl"),
			PATH: "/usr/bin",
		};
		const environment = buildCodexAutomaticPluginInstallationGitEnvironment(
			input,
			join(fixture.path, "native-installer-home"),
		);
		expect(environment.GIT_DIR).toBeUndefined();
		expect(environment.GIT_WORK_TREE).toBeUndefined();
		expect(environment.GIT_CONFIG_COUNT).toBeUndefined();
		expect(environment.GIT_CONFIG_PARAMETERS).toBeUndefined();
		expect(environment.GIT_CEILING_DIRECTORIES).toBe(join(fixture.path, "native-installer-home"));
		expect(environment.GIT_TRACE2_EVENT).toBe(input.GIT_TRACE2_EVENT);
		expect(input.GIT_DIR).toBe("/untrusted/repository");
	});
	it("私有安装器目录出现 Git 发现标记时拒绝运行原生命令", async () => {
		await assertCodexAutomaticPluginGitWorkingDirectory(fixture.path);
		await mkdir(join(fixture.path, ".git"));
		await expect(assertCodexAutomaticPluginGitWorkingDirectory(fixture.path)).rejects.toThrow(/Git 仓库发现标记/);
	});
	it.each([
		{ enabled: false, arguments: [] },
		{ enabled: true, arguments: ["--disable", "plugins"] },
		{ enabled: true, arguments: ["--disable=plugins"] },
	])("插件功能禁用时保留原生禁用语义，不初始化 Git marketplace：%o", async (selection) => {
		await writeFile(
			join(sourceHome, "config.toml"),
			`[features]\nplugins=${selection.enabled}\n[marketplaces.disabled-fixture]\nsource_type="git"\nsource="file:///unavailable"\n`,
		);
		const binding = await writer();
		expect(
			await prepareCodexSharedPluginInstallationForNativeLaunch({
				binding,
				binary,
				environment: { HOME: fixture.path, CODEX_HOME: binding.configurationHomeDirectoryPath },
				nativeLaunchArguments: selection.arguments,
			}),
		).toMatchObject({
			status: "ready",
			nativeUpgradeCount: 0,
			nativePluginInstallationCount: 0,
			arguments: selection.arguments,
		});
		await expect(
			lstat(join(sourceHome, "plugins", ".kanban-source-installation-coordination")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("未加引号的原生字符串覆盖和以 -c 开头的位置提示不会在 spawn 前被拒绝", async () => {
		await writeFile(
			join(sourceHome, "config.toml"),
			`[features]\nplugins=true\n[marketplaces.disabled-fixture]\nsource_type="git"\nsource="file:///unavailable"\n`,
		);
		const binding = await writer();
		const prompt = "-c heck this";
		const nativeLaunchArguments = [
			"-c",
			"model_reasoning_effort=high",
			"--config=model=debug",
			"-cmodel_reasoning_summary=detailed",
			"--disable",
			"plugins",
			prompt,
		];
		expect(
			await prepareCodexSharedPluginInstallationForNativeLaunch({
				binding,
				binary,
				environment: { HOME: fixture.path, CODEX_HOME: binding.configurationHomeDirectoryPath },
				nativeLaunchArguments,
			}),
		).toMatchObject({
			status: "ready",
			nativeUpgradeCount: 0,
			nativePluginInstallationCount: 0,
			arguments: nativeLaunchArguments,
		});
		await expect(
			lstat(join(sourceHome, "plugins", ".kanban-source-installation-coordination")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
	it("超时终止会结束 detached 原生子进程留下的同组后代", async () => {
		const leader = spawn(
			process.execPath,
			[
				"-e",
				`const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write(String(child.pid)+"\\n");setInterval(()=>{},1000);`,
			],
			{ detached: true, stdio: ["ignore", "pipe", "ignore"] },
		);
		const childPid = await new Promise<number>((resolvePid, rejectPid) => {
			let output = "";
			leader.stdout?.setEncoding("utf8");
			leader.stdout?.on("data", (chunk: string) => {
				output += chunk;
				const line = output.split("\n")[0];
				if (line && /^\d+$/.test(line)) resolvePid(Number(line));
			});
			leader.once("error", rejectPid);
			leader.once("exit", () => rejectPid(new Error("安装进程组组长在写出后代 PID 前退出。")));
		});
		try {
			expect(leader.pid).toBeTypeOf("number");
			terminateDetachedNativeInstallationProcessGroup(leader.pid);
			await vi.waitFor(
				() => {
					expect(() => process.kill(childPid, 0)).toThrow();
					expect(() => process.kill(requireDefinedTestFixtureValue(leader.pid), 0)).toThrow();
				},
				{ timeout: 5_000, interval: 50 },
			);
		} finally {
			terminateDetachedNativeInstallationProcessGroup(leader.pid);
		}
	});
	it("两个根起初不存在时共同创建；只共享 marketplaces 子目录，并保留顶层兼容桥", async () => {
		await mkdir(join(sourceHome, "marketplaces"));
		const first = await writer();
		const second = await writer(first);
		for (const binding of [first, second]) {
			expect(await realpath(join(binding.configurationHomeDirectoryPath, "plugins"))).toBe(
				join(sourceHome, "plugins"),
			);
			expect(await realpath(join(binding.configurationHomeDirectoryPath, ".tmp", "marketplaces"))).toBe(
				join(sourceHome, ".tmp", "marketplaces"),
			);
			expect((await lstat(join(binding.configurationHomeDirectoryPath, ".tmp"))).isSymbolicLink()).toBe(false);
			expect(await realpath(join(binding.configurationHomeDirectoryPath, "marketplaces"))).toBe(
				join(sourceHome, "marketplaces"),
			);
			await assertCodexConfigurationWriterBindingIdentity(binding);
		}
	});
	it.each(["plugins", ".tmp/marketplaces"])("桥接 %s 被改指向时拒绝，不覆盖现场", async (relativePath) => {
		const binding = await writer();
		const wrongRoot = join(fixture.path, "unrelated-installation-root");
		await mkdir(wrongRoot);
		const bridgePath = join(binding.configurationHomeDirectoryPath, relativePath);
		await rm(bridgePath);
		await symlink(wrongRoot, bridgePath, "junction");
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/插件|marketplace/);
		expect(await realpath(bridgePath)).toBe(wrongRoot);
	});
	it.each(["plugins", ".tmp/marketplaces"])(
		"来源共享根 %s 被替换时既拒绝旧绑定，也拒绝悄悄建立新身份",
		async (relativePath) => {
			const binding = await writer();
			const root = join(sourceHome, relativePath);
			await rename(root, `${root}-original`);
			await mkdir(root);
			await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/身份|替换/);
			await expect(writer()).rejects.toThrow(/身份|替换/);
		},
	);
	it("普通 .tmp 被换成软链时拒绝，即使 marketplaces 最终目标仍相同", async () => {
		const binding = await writer();
		const temporaryRoot = join(binding.configurationHomeDirectoryPath, ".tmp");
		await rename(temporaryRoot, `${temporaryRoot}-original`);
		await symlink(`${temporaryRoot}-original`, temporaryRoot, "junction");
		await expect(assertCodexConfigurationWriterBindingIdentity(binding)).rejects.toThrow(/普通目录/);
	});
	it("首次绑定合法的来源软链后记录物理根；自然换代保持历史与 SQLite 归属", async () => {
		const physicalRoot = join(fixture.path, "physical-plugin-installation-container");
		await mkdir(physicalRoot);
		await symlink(physicalRoot, join(sourceHome, "plugins"), "junction");
		const first = await writer();
		const next = await writer(first);
		expect(await realpath(join(next.configurationHomeDirectoryPath, "plugins"))).toBe(physicalRoot);
		expect(next.conversationStorageHomeDirectoryPath).toBe(first.conversationStorageHomeDirectoryPath);
		expect(next.sqliteHomeDirectoryPath).toBe(first.sqliteHomeDirectoryPath);
		await assertCodexConfigurationWriterBindingIdentity(next);
	});
	it("确证不支持时使用完整独立布局；旧绑定仍可接管，换代重新核验后共享", async () => {
		vi.mocked(
			nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
		).mockResolvedValueOnce({ status: "unsupported", reason: "合成布局不兼容" });
		const legacy = await writer(undefined, "codex-cli 0.167.0");
		await assertCodexConfigurationWriterBindingIdentity(legacy);
		const manifest = JSON.parse(
			await readFile(join(legacy.configurationHomeDirectoryPath, "..", "writer-binding.json"), "utf8"),
		);
		expect(legacy).toStrictEqual(manifest);
		expect(manifest.sourceSharedPluginInstallationDirectoriesBinding).toBeUndefined();
		expect(manifest.sourceSharedPluginInstallationDirectoriesCompatibilityObservation).toMatchObject({
			status: "unsupported_native_capability",
			nativeBinaryVersion: "codex-cli 0.167.0",
		});
		await writeFile(binary, `#!${process.execPath}\nprocess.stdout.write('codex-cli 0.168.0');\n`);
		const next = await writer(legacy);
		expect(await realpath(join(next.configurationHomeDirectoryPath, ".tmp", "marketplaces"))).toBe(
			join(sourceHome, ".tmp", "marketplaces"),
		);
		expect((await lstat(join(legacy.configurationHomeDirectoryPath, ".tmp", "marketplaces"))).isSymbolicLink()).toBe(
			false,
		);
		expect((await lstat(join(legacy.configurationHomeDirectoryPath, "plugins"))).isSymbolicLink()).toBe(false);
	});
	it.each(["unsupported", "unverified", "legacy"] as const)(
		"无共享绑定的正常 %s 启动保留原生参数与兼容状态",
		async (compatibilityMode) => {
			vi.mocked(
				nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
			).mockResolvedValueOnce({ status: "unsupported", reason: "合成不兼容" });
			const binding = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: sourceHome,
				runtimeSessionIncarnationId: randomUUID(),
				binary: compatibilityMode === "unsupported" ? binary : undefined,
				environment: { HOME: fixture.path, CODEX_HOME: sourceHome, CODEX_SQLITE_HOME: sourceHome },
			});
			if (compatibilityMode === "legacy") {
				delete binding.sourceSharedPluginInstallationDirectoriesCompatibilityObservation;
				await writeFile(
					join(binding.configurationHomeDirectoryPath, "..", "writer-binding.json"),
					JSON.stringify(binding),
				);
			}
			expect(binding.sourceSharedPluginInstallationDirectoriesBinding).toBeUndefined();
			const nativeLaunchArguments = ["app-server", "--stdio"];
			await expect(
				prepareCodexSharedPluginInstallationForNativeLaunch({
					binding,
					binary,
					environment: { HOME: fixture.path, CODEX_HOME: binding.configurationHomeDirectoryPath },
					nativeLaunchArguments,
				}),
			).resolves.toStrictEqual({
				arguments: nativeLaunchArguments,
				status:
					compatibilityMode === "unsupported" ? "unsupported_native_capability" : "unverified_native_capability",
				nativeUpgradeCount: 0,
				nativePluginInstallationCount: 0,
			});
		},
	);
	it.each([
		{ relativePath: "plugins", expectedError: /归属/ },
		{ relativePath: ".tmp", expectedError: /归属/ },
		{ relativePath: ".tmp/marketplaces", expectedError: /归属/ },
		{ relativePath: "config.toml", expectedError: /主配置暂不可读/ },
		{ relativePath: "../writer-binding.json", expectedError: /清单不是普通文件/ },
	])("不兼容回退准备后 $relativePath 被换为软链时，启动入口拒绝并保留现场", async (replacement) => {
		vi.mocked(
			nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
		).mockResolvedValueOnce({ status: "unsupported", reason: "合成不兼容" });
		const binding = await writer();
		const replacedPath = join(binding.configurationHomeDirectoryPath, replacement.relativePath);
		const preservedOriginalPath = `${replacedPath}-original`;
		const originalMetadata = await lstat(replacedPath);
		await rename(replacedPath, preservedOriginalPath);
		await symlink(preservedOriginalPath, replacedPath, originalMetadata.isDirectory() ? "junction" : "file");
		await expect(
			prepareCodexSharedPluginInstallationForNativeLaunch({
				binding,
				binary,
				environment: { HOME: fixture.path, CODEX_HOME: binding.configurationHomeDirectoryPath },
				nativeLaunchArguments: [],
			}),
		).rejects.toThrow(replacement.expectedError);
		expect((await lstat(replacedPath)).isSymbolicLink()).toBe(true);
		expect(await realpath(replacedPath)).toBe(preservedOriginalPath);
	});
	it("辅助启动和相对路径 binary 使用最终 spawn 的 binary、目录与环境核验能力", async () => {
		const environment = {
			HOME: fixture.path,
			CODEX_HOME: sourceHome,
			CODEX_SQLITE_HOME: sourceHome,
			ISOLATED_CODEX_VERSION: "codex-cli 0.166.0",
		};
		const supported = await prepareAuxiliaryCodexConfigurationLaunch({
			environment,
			cwd: fixture.path,
			binary: "./codex-native-version-fixture",
			nativeLaunchArguments: ["app-server", "--stdio"],
		});
		expect(
			await realpath(join(requireDefinedTestFixtureValue(supported.environment.CODEX_HOME), ".tmp", "marketplaces")),
		).toBe(join(sourceHome, ".tmp", "marketplaces"));
		await writeFile(binary, `#!${process.execPath}\nprocess.stdout.write('codex-cli 0.999.0');\n`);
		const unknown = await prepareAuxiliaryCodexConfigurationLaunch({
			environment: { ...environment, ISOLATED_CODEX_VERSION: "codex-cli 0.999.0" },
			cwd: fixture.path,
			binary,
			nativeLaunchArguments: ["app-server", "--stdio"],
		});
		const unknownManifest = JSON.parse(
			await readFile(
				join(requireDefinedTestFixtureValue(unknown.environment.CODEX_HOME), "..", "writer-binding.json"),
				"utf8",
			),
		);
		expect(unknownManifest.sourceSharedPluginInstallationDirectoriesBinding).toBeDefined();
		expect(
			unknownManifest.sourceSharedPluginInstallationDirectoriesBinding.nativeCapabilityEvidence.nativeBinaryVersion,
		).toBe("codex-cli 0.999.0");
	});
	it("不兼容回退复制完整缓存，原生写入不触碰来源；目录被改指向时拒绝", async () => {
		await mkdir(join(sourceHome, "plugins", "cache"), { recursive: true });
		await mkdir(join(sourceHome, ".tmp", "marketplaces"), { recursive: true });
		await writeFile(join(sourceHome, "plugins", "cache", "cached-hook.py"), "已确认的脚本内容");
		await writeFile(join(sourceHome, ".tmp", "marketplaces", "native-installation-record.json"), "原生安装记录");
		vi.mocked(
			nativePluginCapabilityVerification.verifyCodexNativeSharedPluginInstallationCapability,
		).mockResolvedValueOnce({ status: "unsupported", reason: "合成不兼容" });
		const independent = await writer();
		const independentPluginFile = join(
			independent.configurationHomeDirectoryPath,
			"plugins",
			"cache",
			"cached-hook.py",
		);
		expect(await readFile(independentPluginFile, "utf8")).toBe("已确认的脚本内容");
		expect(
			await readFile(
				join(independent.configurationHomeDirectoryPath, ".tmp", "marketplaces", "native-installation-record.json"),
				"utf8",
			),
		).toBe("原生安装记录");
		await writeFile(independentPluginFile, "只在独立安装中更新");
		expect(await readFile(join(sourceHome, "plugins", "cache", "cached-hook.py"), "utf8")).toBe("已确认的脚本内容");
		await rm(join(independent.configurationHomeDirectoryPath, "plugins"), { recursive: true });
		await symlink(
			join(sourceHome, "plugins"),
			join(independent.configurationHomeDirectoryPath, "plugins"),
			"junction",
		);
		await expect(assertCodexConfigurationWriterBindingIdentity(independent)).rejects.toThrow(/归属/);
	});
	it("不同物理来源的两个共享容器不互相复用", async () => {
		const first = await writer();
		const otherSourceHome = join(fixture.path, "other-physical-codex-source");
		await mkdir(otherSourceHome);
		await writeFile(join(otherSourceHome, "config.toml"), "");
		const other = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: otherSourceHome,
			runtimeSessionIncarnationId: randomUUID(),
			binary,
			environment: { HOME: fixture.path, CODEX_HOME: otherSourceHome },
		});
		expect(other.sourceIdentity).not.toBe(first.sourceIdentity);
		expect(await realpath(join(other.configurationHomeDirectoryPath, "plugins"))).toBe(
			join(otherSourceHome, "plugins"),
		);
		expect(await realpath(join(other.configurationHomeDirectoryPath, ".tmp", "marketplaces"))).toBe(
			join(otherSourceHome, ".tmp", "marketplaces"),
		);
	});
	it("已绑定 binary 被替换后拒绝沿用旧能力，下一代重新绑定实际文件身份", async () => {
		const first = await writer();
		await writeFile(binary, `${await readFile(binary, "utf8")}\n// 替换后的隔离 binary\n`, { mode: 0o700 });
		await expect(
			prepareCodexSharedPluginInstallationForNativeLaunch({
				binding: first,
				binary,
				environment: { HOME: fixture.path, CODEX_HOME: first.configurationHomeDirectoryPath },
				nativeLaunchArguments: [],
			}),
		).rejects.toThrow(/binary|能力/);
		const next = await writer(first);
		expect(
			next.sourceSharedPluginInstallationDirectoriesBinding?.nativeCapabilityEvidence.nativeExecutableIdentityDigest,
		).not.toBe(
			first.sourceSharedPluginInstallationDirectoriesBinding?.nativeCapabilityEvidence
				.nativeExecutableIdentityDigest,
		);
	});
	it("隔离的 curated、remote 与本地插件缓存不触发 Git marketplace 初始化", async () => {
		const binding = await writer();
		const fixturePaths = [
			"openai-curated-remote/google-drive/1.0.0",
			"openai-primary-runtime/example/1.0.0",
			"local-fixture/example/1.0.0",
		];
		for (const path of fixturePaths) {
			await mkdir(join(sourceHome, "plugins", "cache", path), { recursive: true });
			await writeFile(join(sourceHome, "plugins", "cache", path, "fixture-sentinel"), path);
		}
		const before = await Promise.all(
			fixturePaths.map(async (path) => ({
				path,
				metadata: (await lstat(join(sourceHome, "plugins", "cache", path))).ino,
				sentinel: await readFile(join(sourceHome, "plugins", "cache", path, "fixture-sentinel"), "utf8"),
			})),
		);
		const result = await prepareCodexSharedPluginInstallationForNativeLaunch({
			binding,
			binary,
			environment: { HOME: fixture.path, CODEX_HOME: binding.configurationHomeDirectoryPath },
			nativeLaunchArguments: [],
		});
		expect(result).toMatchObject({ status: "ready", nativeUpgradeCount: 0, nativePluginInstallationCount: 0 });
		for (const entry of before) {
			expect((await lstat(join(sourceHome, "plugins", "cache", entry.path))).ino).toBe(entry.metadata);
			expect(await readFile(join(sourceHome, "plugins", "cache", entry.path, "fixture-sentinel"), "utf8")).toBe(
				entry.sentinel,
			);
		}
	});
});
