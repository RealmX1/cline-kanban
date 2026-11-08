import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "smol-toml";
import { z } from "zod";

const syntheticMarketplaceName = "kanban-installation-capability-probe";
const syntheticPluginName = "synthetic-hook";
const syntheticPluginKey = `${syntheticPluginName}@${syntheticMarketplaceName}`;
const nativeCapabilityHookListResponseSchema = z.object({
	data: z.array(
		z.object({
			errors: z.array(z.unknown()),
			hooks: z.array(z.object({ key: z.string(), currentHash: z.string() })),
		}),
	),
});
const nativeMarketplaceUpgradeResponseSchema = z.object({
	selectedMarketplaces: z.array(z.string()),
	upgradedRoots: z.array(z.string()),
	errors: z.array(z.unknown()),
});

export interface CodexNativePluginInstallationCapabilityVerificationResult {
	status: "supported" | "unsupported";
	reason: string;
}

class UnsupportedNativePluginInstallationCapability extends Error {}

// 不继承凭据、用户配置、Git 重定向或 hooks；所有仓库和原生写入都在本次隔离根中。
function buildIsolatedNativeCapabilityProbeEnvironment(
	isolatedProbeRootDirectoryPath: string,
	path: string | undefined,
): NodeJS.ProcessEnv {
	return {
		PATH: path ?? process.env.PATH,
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		HOME: join(isolatedProbeRootDirectoryPath, "isolated-user-home"),
		USERPROFILE: join(isolatedProbeRootDirectoryPath, "isolated-user-home"),
		XDG_CONFIG_HOME: join(isolatedProbeRootDirectoryPath, "isolated-user-configuration"),
		TMPDIR: join(isolatedProbeRootDirectoryPath, "isolated-temporary-files"),
		TEMP: join(isolatedProbeRootDirectoryPath, "isolated-temporary-files"),
		TMP: join(isolatedProbeRootDirectoryPath, "isolated-temporary-files"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(isolatedProbeRootDirectoryPath, "isolated-user-home", ".gitconfig"),
		GIT_ALLOW_PROTOCOL: "file",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_AUTHOR_NAME: "Kanban Capability Probe",
		GIT_AUTHOR_EMAIL: "capability-probe@example.invalid",
		GIT_COMMITTER_NAME: "Kanban Capability Probe",
		GIT_COMMITTER_EMAIL: "capability-probe@example.invalid",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: join(isolatedProbeRootDirectoryPath, "disabled-git-hooks"),
	};
}

export async function verifyCodexNativeSharedPluginInstallationCapability(input: {
	nativeExecutableRealPath: string;
	isolatedProbeDirectoryPath: string;
	environment: NodeJS.ProcessEnv;
	recordActiveNativeProcess: (process: { processId: number; commandMarker: string } | null) => Promise<void>;
}): Promise<CodexNativePluginInstallationCapabilityVerificationResult> {
	const isolatedProbeRootDirectoryPath = input.isolatedProbeDirectoryPath;
	const environment = buildIsolatedNativeCapabilityProbeEnvironment(
		isolatedProbeRootDirectoryPath,
		input.environment.PATH,
	);
	for (const directory of [
		environment.HOME,
		environment.XDG_CONFIG_HOME,
		environment.TMPDIR,
		environment.GIT_CONFIG_VALUE_0,
	])
		if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(environment.GIT_CONFIG_GLOBAL ?? "", "", { mode: 0o600 });
	const nativeProbeDeadlineEpochMs = Date.now() + 30_000;
	let nativeProbeCommandSequenceNumber = 0;
	const executeIsolatedCapabilityProbeCommand = async (
		binary: string,
		arguments_: string[],
		home?: string,
		listHooks = false,
	) => {
		const marker = join(isolatedProbeRootDirectoryPath, `native-command-${++nativeProbeCommandSequenceNumber}`);
		const args = home ? ["-c", `log_dir=${JSON.stringify(marker)}`, ...arguments_] : arguments_;
		const remainingMs = nativeProbeDeadlineEpochMs - Date.now();
		if (remainingMs <= 0) throw new Error("Codex 插件安装隔离核验达到 30 秒预算，等待自动重试。");
		const child = spawn(binary, args, {
			cwd: isolatedProbeRootDirectoryPath,
			env: { ...environment, ...(home ? { CODEX_HOME: home, CODEX_SQLITE_HOME: home } : {}) },
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "",
			stderr = "",
			protocolBuffer = "";
		let protocolResult: unknown;
		let failure: Error | undefined;
		const kill = () => {
			if (!child.pid) return;
			try {
				process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
			}
		};
		const completed = new Promise<number | null>((resolveExit, rejectExit) => {
			child.once("error", rejectExit);
			child.once("close", resolveExit);
		});
		// 先安装处理器，持久记录或协议初始化失败仍须回收本次进程组。
		void completed.catch(() => {});
		child.stderr.on("data", (bytes: Buffer) => {
			stderr = (stderr + bytes.toString()).slice(-8_192);
		});
		child.stdin.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (text: string) => {
			stdout += text;
			if (Buffer.byteLength(stdout) > 1_048_576) {
				failure = new Error("Codex 隔离核验响应超过预算，等待自动重试。");
				kill();
			}
			if (!listHooks) return;
			protocolBuffer += text;
			let newline = protocolBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = protocolBuffer.slice(0, newline);
				protocolBuffer = protocolBuffer.slice(newline + 1);
				try {
					const response: unknown = JSON.parse(line);
					const parsed = z
						.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() })
						.safeParse(response);
					if (parsed.success && parsed.data.id === 1) {
						if (parsed.data.error)
							throw new UnsupportedNativePluginInstallationCapability("原生 initialize 协议不兼容。");
						child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
						child.stdin.write(
							`${JSON.stringify({ id: 2, method: "hooks/list", params: { cwds: [isolatedProbeRootDirectoryPath] } })}\n`,
						);
					} else if (parsed.success && parsed.data.id === 2) {
						if (parsed.data.error)
							throw new UnsupportedNativePluginInstallationCapability("原生 hooks/list 协议不兼容。");
						protocolResult = parsed.data.result;
						child.stdin.end();
					}
				} catch (error) {
					failure = error instanceof Error ? error : new Error("原生核验协议不可读。");
					kill();
				}
				newline = protocolBuffer.indexOf("\n");
			}
		});
		const timeout = setTimeout(() => {
			failure = new Error("Codex 插件安装隔离核验超时，等待自动重试。");
			kill();
		}, remainingMs);
		try {
			if (child.pid)
				await input.recordActiveNativeProcess({
					processId: child.pid,
					commandMarker: home ? marker : isolatedProbeRootDirectoryPath,
				});
			if (listHooks)
				child.stdin.write(
					`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "kanban_plugin_capability_probe", version: "1" }, capabilities: { experimentalApi: true } } })}\n`,
				);
			else child.stdin.end();
			const exitCode = await completed;
			if (failure) throw failure;
			if (exitCode !== 0) {
				if (/unrecognized subcommand|unexpected argument|unknown (?:command|subcommand)/i.test(stderr))
					throw new UnsupportedNativePluginInstallationCapability("原生程序缺少必要的插件安装命令或参数。");
				throw new Error(`隔离插件操作暂未完成（exit=${String(exitCode)}）：${stderr.slice(-1000)}`);
			}
			if (listHooks) return protocolResult;
			if (!home || !stdout.trim()) return null;
			try {
				return JSON.parse(stdout);
			} catch {
				throw new UnsupportedNativePluginInstallationCapability("原生命令成功退出，但未返回兼容的 JSON 响应。");
			}
		} finally {
			clearTimeout(timeout);
			kill();
			await completed.catch(() => {});
			await input.recordActiveNativeProcess(null);
		}
	};
	const repository = join(isolatedProbeRootDirectoryPath, "synthetic-marketplace-repository");
	const sourceHome = join(isolatedProbeRootDirectoryPath, "source-configuration-home");
	const writerHome = join(isolatedProbeRootDirectoryPath, "writer-configuration-home");
	try {
		await mkdir(join(repository, ".agents", "plugins"), { recursive: true });
		await mkdir(join(repository, "plugins", syntheticPluginName, ".codex-plugin"), { recursive: true });
		await mkdir(join(repository, "plugins", syntheticPluginName, "hooks"));
		await writeFile(
			join(repository, ".agents", "plugins", "marketplace.json"),
			JSON.stringify({
				name: syntheticMarketplaceName,
				plugins: [
					{ name: syntheticPluginName, source: { source: "local", path: `./plugins/${syntheticPluginName}` } },
				],
			}),
		);
		await writeFile(
			join(repository, "plugins", syntheticPluginName, ".codex-plugin", "plugin.json"),
			JSON.stringify({ name: syntheticPluginName, version: "1.0.0" }),
		);
		await writeFile(
			join(repository, "plugins", syntheticPluginName, "hooks", "hooks.json"),
			JSON.stringify({
				hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo synthetic-capability-probe" }] }] },
			}),
		);
		// Git stdout 不是 JSON；经一个只在本隔离根内操作的独立调用初始化仓库。
		for (const arguments_ of [
			["init", "--quiet", "--initial-branch=main"],
			["add", "."],
			["commit", "--quiet", "-m", "建立隔离能力样本"],
		]) {
			await executeIsolatedCapabilityProbeCommand("git", ["-C", repository, ...arguments_]);
		}
		await mkdir(sourceHome);
		const configuration = {
			check_for_update_on_startup: false,
			features: { plugins: true, hooks: true, memories: false },
			plugins: { [syntheticPluginKey]: { enabled: true } },
			marketplaces: {
				[syntheticMarketplaceName]: { source_type: "git", source: pathToFileURL(repository).href, ref: "main" },
			},
		};
		await writeFile(join(sourceHome, "config.toml"), stringify({ ...configuration, plugins: {} }), { mode: 0o600 });
		const upgrade = async (home: string) => {
			const parsed = nativeMarketplaceUpgradeResponseSchema.safeParse(
				await executeIsolatedCapabilityProbeCommand(
					input.nativeExecutableRealPath,
					["plugin", "marketplace", "upgrade", "--json"],
					home,
				),
			);
			if (!parsed.success)
				throw new UnsupportedNativePluginInstallationCapability("原生 marketplace 升级响应不兼容。");
			if (parsed.data.errors.length) throw new Error("合成 marketplace 暂未完成安装，等待自动重试。");
		};
		await upgrade(sourceHome);
		const add = z
			.object({ pluginId: z.string(), installedPath: z.string(), version: z.string() })
			.safeParse(
				await executeIsolatedCapabilityProbeCommand(
					input.nativeExecutableRealPath,
					["plugin", "add", syntheticPluginKey, "--json"],
					sourceHome,
				),
			);
		if (!add.success) throw new UnsupportedNativePluginInstallationCapability("原生 plugin add 响应不兼容。");
		if (
			add.data.pluginId !== syntheticPluginKey ||
			add.data.version !== "1.0.0" ||
			!isAbsolute(add.data.installedPath)
		)
			throw new UnsupportedNativePluginInstallationCapability("原生 plugin add 回执与合成插件身份不符。");
		await writeFile(join(sourceHome, "config.toml"), stringify(configuration), { mode: 0o600 });
		const installedPluginCacheDirectoryPath = join(
			sourceHome,
			"plugins",
			"cache",
			syntheticMarketplaceName,
			syntheticPluginName,
		);
		const installationRecord = join(
			sourceHome,
			".tmp",
			"marketplaces",
			syntheticMarketplaceName,
			".codex-marketplace-install.json",
		);
		const readInstalledPluginSnapshot = async () => {
			// 回执目录尚不可读属于缺证；目录已存在后，才判断其布局是否兼容。
			const installedPath = await realpath(add.data.installedPath);
			const metadata = await lstat(installedPath);
			if (!metadata.isDirectory())
				throw new UnsupportedNativePluginInstallationCapability("原生 plugin add 回执未指向插件安装目录。");
			try {
				if (!(await lstat(installedPluginCacheDirectoryPath)).isDirectory())
					throw new UnsupportedNativePluginInstallationCapability("原生插件缓存根不是兼容的普通目录。");
				const versions = (await readdir(installedPluginCacheDirectoryPath, { withFileTypes: true })).filter(
					(entry) => !entry.name.startsWith("."),
				);
				const onlyVersion = versions[0];
				if (versions.length !== 1 || !onlyVersion?.isDirectory())
					throw new UnsupportedNativePluginInstallationCapability("原生插件缓存未提供唯一的安装目录。");
				if (installedPath !== (await realpath(join(installedPluginCacheDirectoryPath, onlyVersion.name))))
					throw new UnsupportedNativePluginInstallationCapability("原生 plugin add 回执与实际插件目录不符。");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR")
					throw new UnsupportedNativePluginInstallationCapability("原生插件实际安装目录与支持的缓存布局不兼容。");
				throw error;
			}
			const installation = await readFile(installationRecord, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT")
					throw new UnsupportedNativePluginInstallationCapability("原生 marketplace 安装记录布局不兼容。");
				throw error;
			});
			return {
				installedPath,
				metadata,
				installation,
				payloadHash: createHash("sha256")
					.update(await readFile(join(installedPath, "hooks", "hooks.json")))
					.digest("hex"),
			};
		};
		const before = await readInstalledPluginSnapshot();
		const readFingerprint = async (home: string) => {
			const response = nativeCapabilityHookListResponseSchema.safeParse(
				await executeIsolatedCapabilityProbeCommand(
					input.nativeExecutableRealPath,
					["app-server", "--stdio"],
					home,
					true,
				),
			);
			if (!response.success) throw new UnsupportedNativePluginInstallationCapability("原生 hook 指纹响应不兼容。");
			if (response.data.data.some((item) => item.errors.length))
				throw new Error("隔离 hook 来源暂不可核验，等待自动补证。");
			const hooks = response.data.data
				.flatMap((item) => item.hooks)
				.filter((hook) => hook.key.startsWith(`${syntheticPluginKey}:`));
			if (hooks.length !== 1)
				throw new UnsupportedNativePluginInstallationCapability("合成插件未提供唯一的原生 hook 指纹。");
			return hooks[0]?.currentHash;
		};
		const fingerprint = await readFingerprint(sourceHome);
		await mkdir(join(writerHome, ".tmp"), { recursive: true });
		await symlink(await realpath(join(sourceHome, "plugins")), join(writerHome, "plugins"), "junction");
		await symlink(
			await realpath(join(sourceHome, ".tmp", "marketplaces")),
			join(writerHome, ".tmp", "marketplaces"),
			"junction",
		);
		await writeFile(join(writerHome, "config.toml"), stringify(configuration), { mode: 0o600 });
		await upgrade(writerHome);
		const after = await readInstalledPluginSnapshot();
		if (
			before.installedPath !== after.installedPath ||
			before.metadata.dev !== after.metadata.dev ||
			before.metadata.ino !== after.metadata.ino ||
			before.installation !== after.installation ||
			before.payloadHash !== after.payloadHash ||
			fingerprint !== (await readFingerprint(writerHome))
		)
			throw new UnsupportedNativePluginInstallationCapability("相同插件内容重复启动后目录或原生指纹发生变化。");
		return { status: "supported", reason: "隔离安装协议、共享记录、目录与原生 hook 指纹稳定性核验通过。" };
	} catch (error) {
		if (error instanceof UnsupportedNativePluginInstallationCapability)
			return { status: "unsupported", reason: error.message };
		throw error;
	}
}
