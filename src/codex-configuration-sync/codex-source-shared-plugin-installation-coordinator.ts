import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	access,
	cp,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	symlink,
	writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, stringify, type TomlTable } from "smol-toml";
import { z } from "zod";
import { resolveUserCodexHomeDirectoryPath } from "../codex-conversation-storage/codex-conversation-storage-home";
import { prepareCodexPersistentDirectoryIdentity } from "../codex-conversation-storage/codex-persistent-directory-identity";
import type { CodexConfigurationWriterBinding } from "../core/codex-configuration-sync-contract";
import { redactSecretShapedSubstringsInCommandLineText } from "../diagnostics/process-command-line-text-truncation-and-secret-redaction";
import {
	measureTaskSessionStartupPhase,
	recordTaskSessionStartDiagnostic,
} from "../diagnostics/task-session-start-diagnostics-logger";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	assertCodexAutomaticPluginGitWorkingDirectory,
	buildCodexAutomaticPluginInstallationGitEnvironment,
} from "./codex-automatic-plugin-installation-git-environment";
import { configurationDigest, configurationTable } from "./codex-configuration-field-projection";
import {
	mutateCodexConfigurationSyncActiveStore,
	readCodexConfigurationSyncLookupStore,
} from "./codex-configuration-sync-store";
import {
	assertCodexConfigurationWriterBindingIdentity,
	buildCodexConfigurationWriterEnvironment,
	prepareCodexConfigurationWriterBinding,
} from "./codex-configuration-writer-binding";
import { formatCodexConfigurationOverrideTomlValue } from "./codex-native-configuration-override-toml-value";
import { createCodexPluginRemoteRevisionProbeTransaction } from "./codex-plugin-remote-revision-probe-transaction";
import { claimCodexSourcePluginInstallationControllerOwnership } from "./codex-source-plugin-installation-controller-ownership";
import { codexSourceSharedPluginNativeLaunchPreparationIntentSchema as preparationIntentSchema } from "./codex-source-shared-plugin-native-launch-preparation-intent-contract";

const executeFile = promisify(execFile);
const nativeSegment = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const codexConfigurationAssignmentPattern = /^\s*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\s*=/;
const NATIVE_PLUGIN_INSTALLATION_COMMAND_HARD_TIMEOUT_MS = 180_000;
const nativeMarketplaceUpgradeResultSchema = z.object({
	selectedMarketplaces: z.array(z.string()),
	upgradedRoots: z.array(z.string()),
	errors: z.array(z.unknown()),
});
const nativePluginInstallationResultSchema = z.object({
	pluginId: z.string(),
	installedPath: z.string(),
	version: z.string(),
});
const marketplaceSourceSchema = z.object({
	name: z.string().regex(nativeSegment),
	source: z.string(),
	ref: z.string().nullable(),
	sparsePaths: z.array(z.string()),
});
type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;
const nativeAttemptSchema = z.object({
	attemptId: z.string().uuid(),
	operationKey: z.string(),
	kind: z.enum(["marketplace_upgrade", "plugin_install"]),
	selection: z.string(),
	stdoutPath: z.string(),
	stderrPath: z.string(),
	processMarker: z.string(),
	targetDirectoryPath: z.string().optional(),
	initiatingWriterId: z.string().optional(),
	nativeExecutableRealPath: z.string().optional(),
	nativeExecutableIdentityDigest: z.string().optional(),
	startedAtMs: z.number(),
	processId: z.number().optional(),
	exitedAtMs: z.number().optional(),
	exitCode: z.number().nullable().optional(),
});
type NativeAttempt = z.infer<typeof nativeAttemptSchema>;
const installationStateSchema = z.object({
	schemaVersion: z.literal(1),
	sourceIdentity: z.string(),
	writerId: z.string(),
	configurationHomeDirectoryPath: z.string(),
	configurationDigest: z.string(),
	nativeExecutableIdentityDigest: z.string(),
	installerHome: z.string(),
	baseWriterMarketplaceConfigurationDigest: z.string(),
	marketplaces: z.array(marketplaceSourceSchema),
	pluginKeys: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/)),
	phase: z.enum(["checking_marketplaces", "installing_plugins", "ready", "waiting_for_evidence"]),
	attemptCount: z.number().int().nonnegative(),
	retryEvidenceFingerprint: z.string().optional(),
	failureReason: z.string().optional(),
	automaticRecoveryCondition: z.literal("native_owner_exited_or_source_network_binary_or_directory_facts_changed"),
	completedMarketplaceNames: z.array(z.string()),
	completedMarketplaceRevisions: z.record(z.string(), z.string()).default({}),
	pluginKeysRequiringInstallation: z.array(z.string()),
	completedPluginInstallations: z.record(
		z.string(),
		z.object({
			installedPath: z.string(),
			directoryIdentity: z.string(),
			nativeAttemptId: z.string().uuid().optional(),
			reusedCompletionEvidenceStatePath: z.string().optional(),
		}),
	),
	activeNativeAttempt: nativeAttemptSchema.optional(),
	lastCompletedNativeAttemptId: z.string().uuid().optional(),
	updatedAtMs: z.number(),
	nextEvidenceObservationAtMs: z.number().optional(),
});
type InstallationState = z.infer<typeof installationStateSchema>;

type PreparationIntent = z.infer<typeof preparationIntentSchema>;
const nativeInstallMetadataSchema = z.object({
	source_type: z.literal("git"),
	source: z.string(),
	ref_name: z.string().nullable(),
	sparse_paths: z.array(z.string()),
	revision: z.string().min(1),
});

function coordinationDirectory(binding: CodexConfigurationWriterBinding) {
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (!shared) throw new Error("Codex 插件安装能力尚未覆盖当前原生程序。");
	return join(shared.pluginsDirectoryCanonicalPath, ".kanban-source-installation-coordination");
}
async function readState(statePath: string): Promise<InstallationState | undefined> {
	try {
		if (!(await lstat(statePath)).isFile()) throw new Error("Codex 插件恢复记录不是普通文件。");
		return installationStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
async function saveState(statePath: string, state: InstallationState) {
	state.updatedAtMs = Date.now();
	await lockedFileSystem.writeTextFileAtomic(statePath, JSON.stringify(installationStateSchema.parse(state)), {
		lock: null,
		durable: true,
		fileMode: 0o600,
	});
	const progressPath = join(dirname(statePath), "source-installation-progress-events.jsonl");
	try {
		if (!(await lstat(progressPath)).isFile()) throw new Error("Codex 插件恢复历史不是普通文件。");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const history = await open(progressPath, "a", 0o600);
	try {
		await history.writeFile(
			`${JSON.stringify({ sourceIdentity: state.sourceIdentity, writerId: state.writerId, configurationDigest: state.configurationDigest, phase: state.phase, attemptCount: state.attemptCount, nativeAttempt: state.activeNativeAttempt, failureReason: state.failureReason ?? null, observedAtMs: state.updatedAtMs, actualFilesystemWriter: "unknown" })}\n`,
		);
		await history.sync();
	} finally {
		await history.close();
	}
}

async function readPreparationIntent(path: string) {
	if (!(await lstat(path)).isFile()) throw new Error("Codex 插件安装准备意图不是普通文件。");
	return preparationIntentSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
async function savePreparationIntent(path: string, intent: PreparationIntent) {
	if (intent.status === "pending")
		await mutateCodexConfigurationSyncActiveStore(
			(store) => {
				const writer = store.writers[intent.writerId];
				if (!writer || writer.binding.sourceIdentity !== intent.sourceIdentity)
					throw new Error("插件恢复意图缺少精确 writer 归属。");
				writer.pendingSourceSharedPluginInstallationPreparations ??= {};
				writer.pendingSourceSharedPluginInstallationPreparations[path] = preparationIntentSchema.parse(intent);
			},
			{ selection: { scope: "lookup", writerIds: [intent.writerId] } },
		);
	await lockedFileSystem.writeTextFileAtomic(path, JSON.stringify(preparationIntentSchema.parse(intent)), {
		lock: null,
		durable: true,
		fileMode: 0o600,
	});
	if (intent.status === "completed")
		await mutateCodexConfigurationSyncActiveStore(
			(store) => {
				const writer = store.writers[intent.writerId];
				if (writer?.pendingSourceSharedPluginInstallationPreparations) {
					delete writer.pendingSourceSharedPluginInstallationPreparations[path];
					if (!Object.keys(writer.pendingSourceSharedPluginInstallationPreparations).length)
						delete writer.pendingSourceSharedPluginInstallationPreparations;
				}
			},
			{ selection: { scope: "lookup", writerIds: [intent.writerId] } },
		);
}
function assertNativeAttemptReceiptPaths(attempt: NativeAttempt, sourceDirectory: string) {
	const directory = join(sourceDirectory, `native-attempt-${attempt.attemptId}`);
	if (
		attempt.stdoutPath !== join(directory, "native.stdout.json") ||
		attempt.stderrPath !== join(directory, "native.stderr.log") ||
		attempt.processMarker !== join(directory, "native-logs")
	)
		throw new Error("Codex 原生安装回执路径不属于当前来源尝试。");
}
function mergeConfigurationTables(target: TomlTable, patch: TomlTable) {
	for (const [key, value] of Object.entries(patch)) {
		if (configurationTable(value) && configurationTable(target[key])) mergeConfigurationTables(target[key], value);
		else target[key] = structuredClone(value);
	}
}
function nestedConfigurationAssignment(key: string, value: unknown): TomlTable {
	const segments = key.split(".").map((segment) => segment.trim());
	if (segments.length === 0 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment)))
		throw new Error("Codex 配置覆盖的键无法核验。");
	const root: TomlTable = {};
	let cursor = root;
	for (const segment of segments.slice(0, -1)) {
		const next: TomlTable = {};
		cursor[segment] = next;
		cursor = next;
	}
	const leaf = segments[segments.length - 1];
	if (!leaf) throw new Error("Codex 配置覆盖的键无法核验。");
	cursor[leaf] = value as TomlTable[string];
	return root;
}
function codexConfigurationOverrideDocument(assignment: string): TomlTable {
	try {
		const parsed = parse(assignment);
		if (!configurationTable(parsed)) throw new Error("Codex 配置覆盖不是 TOML 表。");
		return parsed;
	} catch (error) {
		const separator = assignment.indexOf("=");
		if (separator < 1 || !codexConfigurationAssignmentPattern.test(assignment))
			throw new Error("Codex 配置覆盖缺少键或等号。", { cause: error });
		const key = assignment.slice(0, separator).trim();
		const rawValue = assignment.slice(separator + 1);
		let value: unknown = rawValue;
		try {
			value = parse(`value = ${rawValue}`).value;
		} catch {
			// 原生 CLI 接受未加引号的字符串，例如 model_reasoning_effort=high。
			value = rawValue;
		}
		return nestedConfigurationAssignment(key, value);
	}
}
async function effectiveLaunchConfiguration(binding: CodexConfigurationWriterBinding, arguments_: string[]) {
	const configuration = parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8"));
	let profileName: string | undefined;
	const overrides: TomlTable[] = [];
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		if (argument === "--") break;
		if (argument === "-p" || argument === "--profile") profileName = arguments_[++index];
		else if (argument?.startsWith("--profile=")) profileName = argument.slice(10);
		else if (argument === "--enable" || argument === "--disable") {
			const feature = arguments_[++index];
			if (feature) overrides.push({ features: { [feature]: argument === "--enable" } });
		} else if (argument?.startsWith("--enable=") || argument?.startsWith("--disable=")) {
			overrides.push({
				features: { [argument.slice(argument.indexOf("=") + 1)]: argument.startsWith("--enable=") },
			});
		} else {
			const fusedAssignment = argument?.startsWith("-c") ? argument.slice(2).replace(/^=/, "") : undefined;
			const value =
				argument === "-c" || argument === "--config"
					? arguments_[++index]
					: argument?.startsWith("--config=")
						? argument.slice(9)
						: fusedAssignment && codexConfigurationAssignmentPattern.test(fusedAssignment)
							? fusedAssignment
							: undefined;
			// 位置提示可能以 -c 开头，但没有 --。只有键值覆盖才进入解析，避免把提示词当成 TOML。
			if (value) overrides.push(codexConfigurationOverrideDocument(value));
		}
	}
	const selectedProfile =
		profileName && configurationTable(configuration.profiles) ? configuration.profiles[profileName] : undefined;
	if (configurationTable(selectedProfile)) mergeConfigurationTables(configuration, selectedProfile);
	for (const override of overrides) mergeConfigurationTables(configuration, override);
	return configuration;
}
function configuredMarketplaceSources(configuration: TomlTable): MarketplaceSource[] {
	return Object.entries(configurationTable(configuration.marketplaces) ? configuration.marketplaces : {})
		.filter(([, value]) => configurationTable(value) && value.source_type === "git")
		.map(([name, value]) => {
			if (!nativeSegment.test(name) || !configurationTable(value) || typeof value.source !== "string")
				throw new Error("Codex Git marketplace 的来源或名称暂不可核验。");
			return marketplaceSourceSchema.parse({
				name,
				source: value.source,
				ref: value.ref ?? null,
				sparsePaths: value.sparse_paths ?? [],
			});
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}
function configuredPluginKeys(configuration: TomlTable, marketplaces: MarketplaceSource[]) {
	const names = new Set(marketplaces.map((marketplace) => marketplace.name));
	return Object.keys(configurationTable(configuration.plugins) ? configuration.plugins : {})
		.filter((key) => {
			const [plugin, marketplace, extra] = key.split("@");
			return !extra && nativeSegment.test(plugin ?? "") && names.has(marketplace ?? "");
		})
		.sort();
}
async function marketplaceMetadata(binding: CodexConfigurationWriterBinding, marketplace: MarketplaceSource) {
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (!shared) return undefined;
	const root = join(shared.marketplaceInstallationDirectoryCanonicalPath, marketplace.name);
	try {
		if (!(await lstat(root)).isDirectory()) throw new Error("Codex marketplace 安装根不是普通目录，保留现场。");
		const metadata = nativeInstallMetadataSchema.parse(
			JSON.parse(await readFile(join(root, ".codex-marketplace-install.json"), "utf8")),
		);
		if (
			metadata.source !== marketplace.source ||
			metadata.ref_name !== marketplace.ref ||
			configurationDigest(metadata.sparse_paths) !== configurationDigest(marketplace.sparsePaths)
		)
			return undefined;
		for (const manifest of [
			".agents/plugins/marketplace.json",
			".agents/plugins/api_marketplace.json",
			".claude-plugin/marketplace.json",
		]) {
			try {
				const contents: unknown = JSON.parse(await readFile(join(root, manifest), "utf8"));
				if (configurationTable(contents) && contents.name === marketplace.name && Array.isArray(contents.plugins))
					return metadata;
			} catch {
				/* 缺失的格式可由另一个原生格式补证。 */
			}
		}
		return undefined;
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code === "ENOENT" ||
			error instanceof z.ZodError ||
			error instanceof SyntaxError
		)
			return undefined;
		throw error;
	}
}
async function installedPlugin(binding: CodexConfigurationWriterBinding, pluginKey: string) {
	const [name, marketplace] = pluginKey.split("@");
	if (!name || !marketplace || !nativeSegment.test(name) || !nativeSegment.test(marketplace))
		throw new Error("Codex 插件身份无法核验。");
	const base = join(
		binding.sourceSharedPluginInstallationDirectoriesBinding?.pluginsDirectoryCanonicalPath ?? "",
		"cache",
		marketplace,
		name,
	);
	try {
		if (!(await lstat(base)).isDirectory()) throw new Error("Codex 插件安装根不是普通目录，保留现场。");
		const versions = (await readdir(base, { withFileTypes: true })).filter((entry) => !entry.name.startsWith("."));
		const onlyVersion = versions[0];
		if (versions.length !== 1 || !onlyVersion?.isDirectory()) return undefined;
		const installedPath = join(base, onlyVersion.name);
		for (const manifest of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"]) {
			try {
				const contents: unknown = JSON.parse(await readFile(join(installedPath, manifest), "utf8"));
				if (configurationTable(contents) && contents.name === name)
					return {
						installedPath: await realpath(installedPath),
						directoryIdentity: await prepareCodexPersistentDirectoryIdentity(installedPath),
					};
			} catch {
				/* 下一种原生 manifest 格式仍可补证。 */
			}
		}
		return undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

type MarketplacePluginSourceSpec =
	| { kind: "local"; path: string }
	| { kind: "git"; url: string; ref: string | null; sha: string | null };

async function marketplacePluginSource(
	binding: CodexConfigurationWriterBinding,
	marketplace: MarketplaceSource,
	pluginName: string,
): Promise<MarketplacePluginSourceSpec | undefined> {
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (!shared) return undefined;
	const root = join(shared.marketplaceInstallationDirectoryCanonicalPath, marketplace.name);
	for (const manifest of [
		".agents/plugins/marketplace.json",
		".agents/plugins/api_marketplace.json",
		".claude-plugin/marketplace.json",
	]) {
		try {
			const contents: unknown = JSON.parse(await readFile(join(root, manifest), "utf8"));
			if (!configurationTable(contents) || !Array.isArray(contents.plugins)) continue;
			for (const plugin of contents.plugins) {
				if (!configurationTable(plugin) || plugin.name !== pluginName) continue;
				const source = plugin.source;
				if (typeof source === "string") return { kind: "local", path: resolve(root, source) };
				if (!configurationTable(source)) return undefined;
				if (typeof source.path === "string" && (source.source === "local" || source.source === undefined))
					return { kind: "local", path: resolve(root, source.path) };
				if (
					typeof source.url === "string" &&
					(source.source === "url" || source.source === "git" || source.source === "git-subdir")
				)
					return {
						kind: "git",
						url: source.url,
						ref: typeof source.ref === "string" ? source.ref : null,
						sha: typeof source.sha === "string" ? source.sha : null,
					};
				return undefined;
			}
		} catch {
			/* 另一种原生 marketplace 清单仍可补证。 */
		}
	}
	return undefined;
}

async function localPluginSourceFilesMatch(sourcePath: string, installedPath: string) {
	const visit = async (directory: string, relativeDirectory = ""): Promise<boolean> => {
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
		if (!entries) return false;
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const relativePath = join(relativeDirectory, entry.name);
			const sourceEntry = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!(await visit(sourceEntry, relativePath))) return false;
				continue;
			}
			if (!entry.isFile()) return false;
			try {
				const [sourceBytes, installedBytes] = await Promise.all([
					readFile(sourceEntry),
					readFile(join(installedPath, relativePath)),
				]);
				if (!sourceBytes.equals(installedBytes)) return false;
			} catch {
				return false;
			}
		}
		return true;
	};
	try {
		if (!(await lstat(sourcePath)).isDirectory()) return false;
	} catch {
		return false;
	}
	return visit(sourcePath);
}

async function installedGitRevision(installedPath: string, environment: NodeJS.ProcessEnv, workingDirectory: string) {
	try {
		await lstat(join(installedPath, ".git"));
		const { stdout } = await executeFile("git", ["rev-parse", "HEAD"], {
			cwd: installedPath,
			env: buildCodexAutomaticPluginInstallationGitEnvironment(environment, workingDirectory),
			timeout: 5_000,
			maxBuffer: 1024 * 1024,
		});
		const revision = stdout.trim().toLowerCase();
		return /^[0-9a-f]{40}$/.test(revision) ? revision : undefined;
	} catch {
		return undefined;
	}
}

async function remoteGitRevision(
	url: string,
	ref: string | null,
	environment: NodeJS.ProcessEnv,
	workingDirectory: string,
) {
	try {
		const { stdout } = await executeFile(
			"git",
			["ls-remote", "--", url, ...(ref ? [`refs/heads/${ref}`, ref] : ["HEAD"])],
			{
				cwd: workingDirectory,
				env: buildCodexAutomaticPluginInstallationGitEnvironment(environment, workingDirectory),
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
			},
		);
		const revision = stdout
			.split("\n")
			.map((line) => line.trim().split(/\s+/)[0]?.toLowerCase() ?? "")
			.find((candidate) => /^[0-9a-f]{40}$/.test(candidate));
		return revision;
	} catch {
		return undefined;
	}
}

async function installedPluginPositivelyDiffersFromActivatedSource(input: {
	remoteRevisionProbes?: ReturnType<typeof createCodexPluginRemoteRevisionProbeTransaction>;
	binding: CodexConfigurationWriterBinding;
	state: Pick<InstallationState, "completedPluginInstallations" | "completedMarketplaceRevisions" | "installerHome">;
	environment: NodeJS.ProcessEnv;
	marketplace: MarketplaceSource;
	pluginKey: string;
}) {
	const pluginName = input.pluginKey.split("@")[0];
	if (!pluginName) return false;
	const installed = await installedPlugin(input.binding, input.pluginKey);
	if (!installed) return false;
	const source = await marketplacePluginSource(input.binding, input.marketplace, pluginName);
	if (!source) return false;
	const metadata = await marketplaceMetadata(input.binding, input.marketplace);
	const completed = input.state.completedPluginInstallations[input.pluginKey];
	const acceptedForActivatedRevision =
		metadata !== undefined &&
		completed?.directoryIdentity === installed.directoryIdentity &&
		input.state.completedMarketplaceRevisions[input.marketplace.name] === metadata.revision;
	if (source.kind === "local") {
		// 已按当前 marketplace revision 完成的缓存允许用户改脚本；只有尚未绑定的旧缓存才和激活树对照。
		if (acceptedForActivatedRevision) return false;
		return !(await localPluginSourceFilesMatch(source.path, installed.installedPath));
	}
	const installedRevision = await installedGitRevision(
		installed.installedPath,
		input.environment,
		input.state.installerHome,
	);
	if (!installedRevision) return false;
	const expected =
		source.sha?.toLowerCase() ??
		(await (input.remoteRevisionProbes?.read(source.url, source.ref) ??
			remoteGitRevision(source.url, source.ref, input.environment, input.state.installerHome)));
	if (!expected) return false;
	return installedRevision !== expected;
}

async function assertActualExecutable(
	binding: CodexConfigurationWriterBinding,
	binary: string,
	environment: NodeJS.ProcessEnv,
	cwd: string,
) {
	const expected = binding.sourceSharedPluginInstallationDirectoriesBinding?.nativeCapabilityEvidence;
	if (!expected) return;
	let path: string | undefined;
	for (const candidate of isAbsolute(binary) || binary.includes("/")
		? [resolve(cwd, binary)]
		: (environment.PATH ?? "").split(delimiter).map((directory) => resolve(cwd, directory, binary))) {
		try {
			path = await realpath(candidate);
			break;
		} catch {
			/* 与最终 spawn 使用同一个显式 PATH。 */
		}
	}
	if (!path) throw new Error("实际 Codex binary 暂不可读，等待原可执行文件恢复。");
	const metadata = await lstat(path, { bigint: true });
	const digest = configurationDigest([
		path,
		`${metadata.dev}`,
		`${metadata.ino}`,
		`${metadata.size}`,
		`${metadata.mtimeNs}`,
	]);
	if (
		path !== expected.nativeExecutableRealPath ||
		digest !== expected.nativeExecutableIdentityDigest ||
		(
			await executeFile(binary, ["--version"], { cwd, env: environment, timeout: 3_000, maxBuffer: 4096 })
		).stdout.trim() !== expected.nativeBinaryVersion
	)
		throw new Error("实际 Codex binary 或能力在配置准备后发生变化，等待下一代重新核验。");
}

export function terminateDetachedNativeInstallationProcessGroup(pid: number | undefined) {
	if (pid === undefined || pid <= 0 || pid === process.pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* 直接子进程已退出。 */
			}
		}
	}
}
async function nativeAttemptStillRunning(attempt: NativeAttempt, environment: NodeJS.ProcessEnv) {
	// nonce 先持久化并进入有效 log_dir 参数；即使在写 PID 前中断，也能从原生命令行补证。
	// detached 后 git 等后代留在同一进程组，父进程被杀后仍要用已落盘 PID 识别。
	const { stdout } = await executeFile("ps", ["-axww", "-o", "pid=,pgid=,command="], {
		env: { ...environment, LC_ALL: "C" },
		timeout: 5_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout.split("\n").some((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (!match) return false;
		const pid = Number(match[1]);
		const processGroupId = Number(match[2]);
		const command = match[3] ?? "";
		if (pid === process.pid) return false;
		if (command.includes(attempt.processMarker)) return true;
		if (attempt.processId === undefined) return false;
		if (pid === attempt.processId) return true;
		return processGroupId === attempt.processId && /(^|\/|\s)git(\s|$)/.test(command);
	});
}
function nativeInstallationMustNotLaunchOverLiveWriter(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("原生插件安装所有者仍在执行") ||
		message.includes("插件安装控制器仍在执行") ||
		message.includes("来源域安装锁失去归属")
	);
}
async function sourceDomainHasLiveNativeAttempt(
	binding: CodexConfigurationWriterBinding,
	environment: NodeJS.ProcessEnv,
) {
	const directory = coordinationDirectory(binding);
	const names = await readdir(directory).catch(() => [] as string[]);
	for (const name of names) {
		if (!/^source-installation-[a-f0-9]{64}\.json$/.test(name)) continue;
		const state = await readState(join(directory, name));
		if (state?.activeNativeAttempt && (await nativeAttemptStillRunning(state.activeNativeAttempt, environment)))
			return true;
	}
	return false;
}
async function readNativeCompletion(attempt: NativeAttempt) {
	try {
		if (!(await lstat(attempt.stdoutPath)).isFile()) return undefined;
		const value: unknown = JSON.parse(await readFile(attempt.stdoutPath, "utf8"));
		const result =
			attempt.kind === "marketplace_upgrade"
				? nativeMarketplaceUpgradeResultSchema.safeParse(value)
				: nativePluginInstallationResultSchema.safeParse(value);
		return result.success ? result.data : undefined;
	} catch {
		return undefined;
	}
}

async function reuseCompletedPluginInstallationFromSourceDomain(input: {
	binding: CodexConfigurationWriterBinding;
	state: InstallationState;
	statePath: string;
	pluginKey: string;
	installed: NonNullable<Awaited<ReturnType<typeof installedPlugin>>>;
}) {
	const marketplace = input.state.marketplaces.find((source) => input.pluginKey.endsWith(`@${source.name}`));
	if (!marketplace) return undefined;
	const metadata = await marketplaceMetadata(input.binding, marketplace);
	if (!metadata) return undefined;
	const directory = coordinationDirectory(input.binding);
	for (const name of await readdir(directory)) {
		if (!/^source-installation-[a-f0-9]{64}\.json$/.test(name)) continue;
		const evidenceStatePath = join(directory, name);
		if (evidenceStatePath === input.statePath) continue;
		const evidence = await readState(evidenceStatePath);
		const completion = evidence?.completedPluginInstallations[input.pluginKey];
		if (
			!evidence ||
			evidence.sourceIdentity !== input.binding.sourceIdentity ||
			configurationDigest(evidence.marketplaces.find((source) => source.name === marketplace.name) ?? null) !==
				configurationDigest(marketplace) ||
			evidence.completedMarketplaceRevisions[marketplace.name] !== metadata.revision ||
			!completion?.nativeAttemptId ||
			completion.directoryIdentity !== input.installed.directoryIdentity ||
			completion.installedPath !== input.installed.installedPath
		)
			continue;
		const nativeReceiptPath = join(directory, `native-attempt-${completion.nativeAttemptId}`, "native.stdout.json");
		try {
			if (!(await lstat(nativeReceiptPath)).isFile()) continue;
			const receipt = nativePluginInstallationResultSchema.parse(
				JSON.parse(await readFile(nativeReceiptPath, "utf8")),
			);
			if (
				receipt.pluginId !== input.pluginKey ||
				(await realpath(receipt.installedPath)) !== input.installed.installedPath
			)
				continue;
			return { ...completion, reusedCompletionEvidenceStatePath: evidenceStatePath };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof z.ZodError) continue;
			throw error;
		}
	}
	return undefined;
}

async function runNativeInstallationOperation(input: {
	binding: CodexConfigurationWriterBinding;
	state: InstallationState;
	statePath: string;
	environment: NodeJS.ProcessEnv;
	binary: string;
	kind: NativeAttempt["kind"];
	selection: string;
	abortSignal: AbortSignal;
}) {
	const { state, statePath } = input;
	await assertCodexAutomaticPluginGitWorkingDirectory(state.installerHome);
	const sourceDirectory = coordinationDirectory(input.binding);
	if (
		dirname(state.installerHome) !== sourceDirectory ||
		!(await lstat(state.installerHome)).isDirectory() ||
		(await realpath(state.installerHome)) !== state.installerHome
	)
		throw new Error("Codex 原生安装器目录归属不符，保留恢复现场。");
	const installerConfigurationPath = join(state.installerHome, "config.toml");
	if (!(await lstat(installerConfigurationPath)).isFile()) throw new Error("Codex 原生安装器配置不是普通文件。");
	const installerMarketplaceSources = configuredMarketplaceSources(
		parse(await readFile(installerConfigurationPath, "utf8")),
	);
	if (configurationDigest(installerMarketplaceSources) !== configurationDigest(state.marketplaces))
		throw new Error("Codex 原生安装器的完整 marketplace 来源已变化，未执行安装。");
	const shared = input.binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (
		!shared ||
		(await realpath(join(state.installerHome, "plugins"))) !== shared.pluginsDirectoryCanonicalPath ||
		(await realpath(join(state.installerHome, ".tmp", "marketplaces"))) !==
			shared.marketplaceInstallationDirectoryCanonicalPath
	)
		throw new Error("Codex 原生安装器的共享桥接归属不符。");
	const operationKey = `${input.kind}:${input.selection}`;
	let attempt = state.activeNativeAttempt;
	if (attempt) {
		assertNativeAttemptReceiptPaths(attempt, sourceDirectory);
		const completion = await readNativeCompletion(attempt);
		const confirmedCompletedExit = attempt.exitCode === 0 && attempt.exitedAtMs !== undefined && completion;
		if (!confirmedCompletedExit && (await nativeAttemptStillRunning(attempt, input.environment)))
			throw new Error("原生插件安装所有者仍在执行，保持机器等待；确认退出后自动补证。");
		if (
			completion &&
			(attempt.exitCode === undefined || attempt.exitCode === 0) &&
			attempt.operationKey === operationKey
		) {
			state.lastCompletedNativeAttemptId = attempt.attemptId;
			delete state.activeNativeAttempt;
			return completion;
		}
		delete state.activeNativeAttempt;
	}
	const attemptId = randomUUID();
	const attemptDirectory = join(coordinationDirectory(input.binding), `native-attempt-${attemptId}`);
	await mkdir(attemptDirectory, { mode: 0o700 });
	attempt = {
		attemptId,
		operationKey,
		kind: input.kind,
		selection: input.selection,
		stdoutPath: join(attemptDirectory, "native.stdout.json"),
		stderrPath: join(attemptDirectory, "native.stderr.log"),
		processMarker: join(attemptDirectory, "native-logs"),
		initiatingWriterId: input.binding.writerId,
		nativeExecutableRealPath: shared.nativeCapabilityEvidence.nativeExecutableRealPath,
		nativeExecutableIdentityDigest: shared.nativeCapabilityEvidence.nativeExecutableIdentityDigest,
		targetDirectoryPath:
			input.kind === "marketplace_upgrade"
				? join(shared.marketplaceInstallationDirectoryCanonicalPath, input.selection)
				: join(shared.pluginsDirectoryCanonicalPath, "cache", ...input.selection.split("@").reverse()),
		startedAtMs: Date.now(),
	};
	state.activeNativeAttempt = attempt;
	await saveState(statePath, state);
	const stdout = await open(attempt.stdoutPath, "wx", 0o600),
		stderr = await open(attempt.stderrPath, "wx", 0o600);
	try {
		const args =
			input.kind === "marketplace_upgrade"
				? ["plugin", "marketplace", "upgrade", input.selection, "--json"]
				: ["plugin", "add", input.selection, "--json"];
		if (input.kind === "marketplace_upgrade") {
			const configurationPath = join(state.installerHome, "config.toml");
			const configuration = parse(await readFile(configurationPath, "utf8"));
			configuration.plugins = {};
			await lockedFileSystem.writeTextFileAtomic(configurationPath, stringify(configuration), {
				lock: null,
				durable: true,
				fileMode: 0o600,
			});
		}
		const child = spawn(
			input.binding.sourceSharedPluginInstallationDirectoriesBinding?.nativeCapabilityEvidence
				.nativeExecutableRealPath ?? input.binary,
			[...args, "-c", `log_dir=${JSON.stringify(attempt.processMarker)}`],
			{
				cwd: state.installerHome,
				env: {
					...buildCodexAutomaticPluginInstallationGitEnvironment(input.environment, state.installerHome),
					CODEX_HOME: state.installerHome,
					CODEX_SQLITE_HOME: input.binding.sqliteHomeDirectoryPath,
				},
				stdio: ["ignore", stdout.fd, stderr.fd],
				detached: true,
				signal: input.abortSignal,
			},
		);
		const completion = new Promise<number | null>((resolveExit, rejectExit) => {
			child.once("error", rejectExit);
			child.once("close", (code) => resolveExit(code));
		});
		attempt.processId = child.pid;
		await saveState(statePath, state);
		const killInstallationProcessGroup = () => terminateDetachedNativeInstallationProcessGroup(child.pid);
		const hardTimeout = setTimeout(killInstallationProcessGroup, NATIVE_PLUGIN_INSTALLATION_COMMAND_HARD_TIMEOUT_MS);
		const abortKill = () => killInstallationProcessGroup();
		if (input.abortSignal.aborted) abortKill();
		else input.abortSignal.addEventListener("abort", abortKill, { once: true });
		try {
			attempt.exitCode = await completion;
		} finally {
			clearTimeout(hardTimeout);
			input.abortSignal.removeEventListener("abort", abortKill);
		}
		attempt.exitedAtMs = Date.now();
		await stdout.sync();
		await stderr.sync();
		await lockedFileSystem.writeTextFileAtomic(
			join(attemptDirectory, "native-completion.json"),
			JSON.stringify(attempt),
			{ lock: null, durable: true, fileMode: 0o600 },
		);
		await saveState(statePath, state);
		const result = await readNativeCompletion(attempt);
		if (attempt.exitCode !== 0 || !result) {
			const reason = redactSecretShapedSubstringsInCommandLineText(
				(await readFile(attempt.stderrPath, "utf8")).slice(-2000),
			);
			throw new Error(
				`Codex 原生插件操作未完成：${input.kind} ${input.selection}；${reason || `exit=${String(attempt.exitCode)}`}`,
			);
		}
		delete state.activeNativeAttempt;
		state.lastCompletedNativeAttemptId = attempt.attemptId;
		return result;
	} finally {
		await stdout.close();
		await stderr.close();
	}
}

async function retryEvidenceFingerprint(
	binding: CodexConfigurationWriterBinding,
	state: InstallationState,
	environment: NodeJS.ProcessEnv,
) {
	await assertCodexAutomaticPluginGitWorkingDirectory(state.installerHome);
	const facts: unknown[] = [
		binding.sourceSharedPluginInstallationDirectoriesBinding?.nativeCapabilityEvidence.nativeExecutableIdentityDigest,
	];
	if (state.activeNativeAttempt)
		facts.push(
			await nativeAttemptStillRunning(state.activeNativeAttempt, environment),
			await readFile(state.activeNativeAttempt.stdoutPath, "utf8").catch(() => "native_completion_unavailable"),
		);
	for (const path of [
		binding.sourceSharedPluginInstallationDirectoriesBinding?.pluginsDirectoryCanonicalPath,
		binding.sqliteHomeDirectoryPath,
		join(binding.sourceHomeDirectoryPath, "auth.json"),
	]) {
		try {
			if (path) {
				const metadata = await lstat(path, { bigint: true });
				facts.push([path, `${metadata.mode}`, `${metadata.mtimeNs}`]);
			}
		} catch {
			facts.push([path, "unavailable"]);
		}
	}
	const urls = new Set(state.marketplaces.map((marketplace) => marketplace.source));
	for (const marketplace of state.marketplaces) {
		facts.push(await marketplaceMetadata(binding, marketplace));
		const root = join(
			binding.sourceSharedPluginInstallationDirectoriesBinding?.marketplaceInstallationDirectoryCanonicalPath ?? "",
			marketplace.name,
		);
		try {
			for (const name of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
				try {
					const manifest: unknown = JSON.parse(await readFile(join(root, name), "utf8"));
					if (configurationTable(manifest) && Array.isArray(manifest.plugins))
						for (const plugin of manifest.plugins) {
							if (
								configurationTable(plugin) &&
								configurationTable(plugin.source) &&
								typeof plugin.source.url === "string"
							)
								urls.add(plugin.source.url);
							if (
								configurationTable(plugin) &&
								configurationTable(plugin.source) &&
								typeof plugin.source.path === "string"
							) {
								const sourcePath = resolve(root, plugin.source.path);
								try {
									const metadata = await lstat(sourcePath, { bigint: true });
									facts.push([sourcePath, `${metadata.mode}`, `${metadata.mtimeNs}`, `${metadata.ino}`]);
								} catch {
									facts.push([sourcePath, "plugin_source_unavailable"]);
								}
							}
						}
				} catch {
					/* 来源不可读也是证据，不能冒充可用。 */
				}
			}
		} catch {
			/* 后续由原生入口补齐。 */
		}
	}
	for (const key of state.pluginKeys) facts.push(await installedPlugin(binding, key));
	for (const url of urls) {
		try {
			facts.push([
				url,
				(
					await executeFile("git", ["ls-remote", "--", url], {
						env: buildCodexAutomaticPluginInstallationGitEnvironment(environment, state.installerHome),
						cwd: state.installerHome,
						timeout: 5_000,
						maxBuffer: 1024 * 1024,
					})
				).stdout,
			]);
		} catch {
			facts.push([url, "source_revision_probe_unavailable"]);
		}
	}
	return configurationDigest(facts);
}
async function observeRetryEvidenceFingerprint(
	binding: CodexConfigurationWriterBinding,
	state: InstallationState,
	environment: NodeJS.ProcessEnv,
) {
	try {
		return await retryEvidenceFingerprint(binding, state, environment);
	} catch (error) {
		return configurationDigest(["source_evidence_unavailable", (error as NodeJS.ErrnoException).code ?? "unknown"]);
	}
}

async function reuseLegacyMarketplaceInstallation(input: {
	binding: CodexConfigurationWriterBinding;
	marketplace: MarketplaceSource;
	environment: NodeJS.ProcessEnv;
	isolatedGitWorkingDirectoryPath: string;
}) {
	await assertCodexAutomaticPluginGitWorkingDirectory(input.isolatedGitWorkingDirectoryPath);
	if (await marketplaceMetadata(input.binding, input.marketplace)) return;
	const shared = input.binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (!shared) return;
	const destination = join(shared.marketplaceInstallationDirectoryCanonicalPath, input.marketplace.name);
	try {
		await lstat(destination);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// 仅首次迁入共享安装目录时读取同源旧快照，退休 writer 的可用安装也保留复用资格。
	const store = await readCodexConfigurationSyncLookupStore({
		legacyMarketplaceInstallationSourceIdentities: [input.binding.sourceIdentity],
	});
	for (const writer of Object.values(store.writers)) {
		if (
			writer.binding.sourceIdentity !== input.binding.sourceIdentity ||
			writer.binding.sourceSharedPluginInstallationDirectoriesBinding
		)
			continue;
		try {
			await assertCodexConfigurationWriterBindingIdentity(writer.binding);
			const root = join(
				writer.binding.configurationHomeDirectoryPath,
				".tmp",
				"marketplaces",
				input.marketplace.name,
			);
			if (!(await lstat(root)).isDirectory()) continue;
			const metadata = nativeInstallMetadataSchema.parse(
				JSON.parse(await readFile(join(root, ".codex-marketplace-install.json"), "utf8")),
			);
			if (
				metadata.source !== input.marketplace.source ||
				metadata.ref_name !== input.marketplace.ref ||
				configurationDigest(metadata.sparse_paths) !== configurationDigest(input.marketplace.sparsePaths)
			)
				continue;
			if (!(await lstat(join(root, ".git"))).isDirectory()) continue;
			const gitEnvironment = buildCodexAutomaticPluginInstallationGitEnvironment(
				input.environment,
				input.isolatedGitWorkingDirectoryPath,
			);
			const revision = (
				await executeFile("git", ["-C", root, "rev-parse", "HEAD"], {
					env: gitEnvironment,
					cwd: input.isolatedGitWorkingDirectoryPath,
					timeout: 5_000,
					maxBuffer: 4096,
				})
			).stdout.trim();
			if (revision !== metadata.revision) continue;
			try {
				await executeFile(
					"git",
					[
						"--no-optional-locks",
						"--git-dir",
						join(root, ".git"),
						"--work-tree",
						root,
						"-c",
						"core.fsmonitor=false",
						"diff",
						"--no-ext-diff",
						"--no-textconv",
						"--quiet",
						"HEAD",
						"--",
					],
					{
						env: gitEnvironment,
						cwd: input.isolatedGitWorkingDirectoryPath,
						timeout: 5_000,
						maxBuffer: 4096,
					},
				);
			} catch {
				continue;
			}
			const copyPath = join(
				shared.marketplaceInstallationDirectoryCanonicalPath,
				`.kanban-legacy-marketplace-copy-${randomUUID()}`,
			);
			await cp(root, copyPath, { recursive: true, dereference: false, errorOnExist: true, force: false });
			await rename(copyPath, destination);
			if (await marketplaceMetadata(input.binding, input.marketplace)) return;
			throw new Error("复制的原生 marketplace 安装树未通过完整来源核验，保留现场。");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof z.ZodError) continue;
			throw error;
		}
	}
}

function nativeReadOnlyMarketplaceArguments(
	binding: CodexConfigurationWriterBinding,
	marketplaces: MarketplaceSource[],
	arguments_: string[],
	configuration: TomlTable,
) {
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (!shared) return arguments_;
	const localReadView = structuredClone(
		configurationTable(configuration.marketplaces) ? configuration.marketplaces : {},
	);
	for (const marketplace of marketplaces) {
		const existing = localReadView[marketplace.name];
		localReadView[marketplace.name] = {
			...(configurationTable(existing) ? existing : {}),
			source_type: "local",
			source: join(shared.marketplaceInstallationDirectoryCanonicalPath, marketplace.name),
		};
	}
	// 原生 dotted path 不解析引号；覆盖完整 table 才能正确保留包含点号的 marketplace 名称。
	const overrides = ["-c", `marketplaces=${formatCodexConfigurationOverrideTomlValue(localReadView)}`];
	const separator = arguments_.indexOf("--");
	return separator < 0
		? [...arguments_, ...overrides]
		: [...arguments_.slice(0, separator), ...overrides, ...arguments_.slice(separator)];
}

export async function prepareCodexSharedPluginInstallationForNativeLaunch(input: {
	binding: CodexConfigurationWriterBinding;
	binary: string;
	environment: NodeJS.ProcessEnv;
	nativeLaunchArguments: string[];
	workingDirectory?: string;
	recoverPreparationIntentPath?: string;
}) {
	const { binding } = input;
	const shared = binding.sourceSharedPluginInstallationDirectoriesBinding;
	if (!shared)
		return {
			arguments: input.nativeLaunchArguments,
			status: "unverified_native_capability" as const,
			nativeUpgradeCount: 0,
			nativePluginInstallationCount: 0,
		};
	await assertCodexConfigurationWriterBindingIdentity(binding);
	await assertActualExecutable(binding, input.binary, input.environment, input.workingDirectory ?? process.cwd());
	let configuration = await effectiveLaunchConfiguration(binding, input.nativeLaunchArguments);
	const baseConfiguration = await effectiveLaunchConfiguration(binding, []);
	const baseWriterMarketplaceConfigurationDigest = configurationDigest([
		configuredMarketplaceSources(baseConfiguration),
		configuredPluginKeys(baseConfiguration, configuredMarketplaceSources(baseConfiguration)),
		configurationTable(baseConfiguration.features) ? (baseConfiguration.features.plugins ?? null) : null,
	]);
	let preparationIntent: PreparationIntent | undefined;
	const intentDirectory = join(coordinationDirectory(binding), "native-launch-preparation-intents");
	if (input.recoverPreparationIntentPath) {
		if (dirname(input.recoverPreparationIntentPath) !== intentDirectory)
			throw new Error("Codex 插件准备意图超出当前来源域。");
		preparationIntent = await readPreparationIntent(input.recoverPreparationIntentPath);
		if (
			preparationIntent.writerId !== binding.writerId ||
			preparationIntent.sourceIdentity !== binding.sourceIdentity ||
			preparationIntent.baseWriterMarketplaceConfigurationDigest !== baseWriterMarketplaceConfigurationDigest
		)
			throw new Error("Codex 插件准备意图与当前来源配置不符，保留原意图等待有效条件恢复。");
		configuration = parse(preparationIntent.effectiveConfigurationToml);
	}
	if (configurationTable(configuration.features) && configuration.features.plugins === false)
		return {
			arguments: input.nativeLaunchArguments,
			status: "ready" as const,
			nativeUpgradeCount: 0,
			nativePluginInstallationCount: 0,
		};
	const originalMarketplaceSources = configuredMarketplaceSources(configuration);
	const originalPluginKeys = configuredPluginKeys(configuration, originalMarketplaceSources);
	const marketplaces = originalMarketplaceSources;
	if (!marketplaces.length)
		return {
			arguments: input.nativeLaunchArguments,
			status: "ready" as const,
			nativeUpgradeCount: 0,
			nativePluginInstallationCount: 0,
		};
	const pluginKeys = originalPluginKeys;
	const digest = configurationDigest([binding.sourceIdentity, marketplaces, pluginKeys]);
	const stateDirectory = coordinationDirectory(binding);
	await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
	if (!(await lstat(stateDirectory)).isDirectory() || (await realpath(stateDirectory)) !== stateDirectory)
		throw new Error("Codex 来源域协调目录不是原绑定的普通目录。");
	const statePath = join(stateDirectory, `source-installation-${digest}.json`);
	if (dirname(statePath) !== stateDirectory) throw new Error("Codex 插件恢复路径超出绑定来源域。");
	if (preparationIntent && preparationIntent.sourceInstallationStatePath !== statePath)
		throw new Error("Codex 插件准备意图的完整来源已变化。");
	await mkdir(intentDirectory, { recursive: true, mode: 0o700 });
	if (!(await lstat(intentDirectory)).isDirectory() || (await realpath(intentDirectory)) !== intentDirectory)
		throw new Error("Codex 插件准备意图目录归属不符。");
	preparationIntent ??= {
		schemaVersion: 1,
		intentId: randomUUID(),
		writerId: binding.writerId,
		sourceIdentity: binding.sourceIdentity,
		baseWriterMarketplaceConfigurationDigest,
		effectiveConfigurationToml: stringify(configuration),
		sourceInstallationStatePath: statePath,
		status: "pending",
		createdAtMs: Date.now(),
		nextEvidenceObservationAtMs: Date.now() + 30_000,
	};
	const intentPath = input.recoverPreparationIntentPath ?? join(intentDirectory, `${preparationIntent.intentId}.json`);
	await savePreparationIntent(intentPath, preparationIntent);
	const abort = new AbortController();
	const diagnosticContext = {
		workspaceId: binding.workspaceId ?? "(unknown)",
		taskId: binding.conversationSessionId ?? "(auxiliary)",
		requestedAgentId: "codex" as const,
		effectiveAgentId: "codex" as const,
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
	};
	const lockRequestedAt = performance.now();
	try {
		const result = await lockedFileSystem.withLock(
			{
				type: "directory",
				path: shared.pluginsDirectoryCanonicalPath,
				lockfilePath: join(stateDirectory, "native-source-installation.lock"),
				retries: { retries: 600, minTimeout: 100, maxTimeout: 250, factor: 1.1 },
				onCompromised: (error) => abort.abort(error),
			},
			async () => {
				const lockWaitMs = Math.round(performance.now() - lockRequestedAt);
				void recordTaskSessionStartDiagnostic({
					...diagnosticContext,
					event: "phase_completed",
					phase: "codex_plugin_source_lock_wait",
					elapsedMs: lockWaitMs,
					phaseDurationMs: lockWaitMs,
					error: null,
					session: null,
				});
				await assertCodexConfigurationWriterBindingIdentity(binding);
				const finishOwnership = await claimCodexSourcePluginInstallationControllerOwnership({
					coordinationDirectoryPath: stateDirectory,
					sourceInstallationStatePath: statePath,
					environment: input.environment,
					assertPreviousNativeOperationHasExited: async (previousStatePath) => {
						const previous = await readState(previousStatePath);
						const native = previous?.activeNativeAttempt;
						if (!native) return;
						assertNativeAttemptReceiptPaths(native, stateDirectory);
						const completed =
							native.exitCode === 0 && native.exitedAtMs !== undefined && (await readNativeCompletion(native));
						if (!completed && (await nativeAttemptStillRunning(native, input.environment)))
							throw new Error("原生插件安装所有者仍在执行，保持来源域机器等待；确认退出后自动接续。");
					},
				});
				try {
					let state = await readState(statePath);
					if (state && (state.sourceIdentity !== binding.sourceIdentity || state.configurationDigest !== digest))
						throw new Error("Codex 插件恢复记录与当前来源或完整配置不符。");
					if (!state) {
						const installerHome = join(stateDirectory, `native-installer-${randomUUID()}`);
						await mkdir(join(installerHome, ".tmp"), { recursive: true, mode: 0o700 });
						await symlink(shared.pluginsDirectoryCanonicalPath, join(installerHome, "plugins"), "junction");
						await symlink(
							shared.marketplaceInstallationDirectoryCanonicalPath,
							join(installerHome, ".tmp", "marketplaces"),
							"junction",
						);
						for (const file of ["auth.json", ".credentials.json"]) {
							const source = join(binding.sourceHomeDirectoryPath, file);
							try {
								await access(source);
								await symlink(source, join(installerHome, file));
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
							}
						}
						const nativeConfiguration = structuredClone(configuration);
						// 原生升级只激活 marketplace，插件逐项安装后各自登记完成，避免中断丢失阶段。
						delete nativeConfiguration.profiles;
						nativeConfiguration.plugins = {};
						nativeConfiguration.sqlite_home = binding.sqliteHomeDirectoryPath;
						await writeFile(join(installerHome, "config.toml"), stringify(nativeConfiguration), {
							mode: 0o600,
							flag: "wx",
						});
						state = {
							schemaVersion: 1,
							sourceIdentity: binding.sourceIdentity,
							writerId: binding.writerId,
							configurationHomeDirectoryPath: binding.configurationHomeDirectoryPath,
							configurationDigest: digest,
							baseWriterMarketplaceConfigurationDigest,
							nativeExecutableIdentityDigest: shared.nativeCapabilityEvidence.nativeExecutableIdentityDigest,
							installerHome,
							marketplaces,
							pluginKeys,
							phase: "checking_marketplaces",
							attemptCount: 0,
							completedMarketplaceNames: [],
							completedMarketplaceRevisions: {},
							pluginKeysRequiringInstallation: [],
							completedPluginInstallations: {},
							automaticRecoveryCondition:
								"native_owner_exited_or_source_network_binary_or_directory_facts_changed",
							updatedAtMs: Date.now(),
						};
					}
					const remoteRevisionProbes = createCodexPluginRemoteRevisionProbeTransaction((url, ref) =>
						measureTaskSessionStartupPhase(
							{ ...diagnosticContext, phase: "codex_plugin_remote_revision_query" },
							async () => {
								const revision = await remoteGitRevision(url, ref, input.environment, state.installerHome);
								if (!revision) throw new Error("插件远端 revision 查询未取得可信结果。");
								return revision;
							},
						).catch(() => undefined),
					);

					let nativeUpgradeCount = 0,
						nativePluginInstallationCount = 0;
					const reusable = async () => {
						if (
							!(
								await Promise.all(marketplaces.map((marketplace) => marketplaceMetadata(binding, marketplace)))
							).every(Boolean) ||
							!(await Promise.all(pluginKeys.map((key) => installedPlugin(binding, key)))).every(Boolean)
						)
							return false;
						for (const key of pluginKeys) {
							const marketplace = marketplaces.find((source) => key.endsWith(`@${source.name}`));
							if (!marketplace) return false;
							if (
								await installedPluginPositivelyDiffersFromActivatedSource({
									remoteRevisionProbes,
									binding,
									state,
									environment: input.environment,
									marketplace,
									pluginKey: key,
								})
							)
								return false;
						}
						return true;
					};
					const rejectWhileNativeWriterLives = async () => {
						if (
							state.activeNativeAttempt &&
							(await nativeAttemptStillRunning(state.activeNativeAttempt, input.environment))
						)
							throw new Error("原生插件安装所有者仍在执行，保持机器等待；确认退出后自动补证。");
					};
					const observeTransactionRetryEvidenceFingerprint = async () => {
						await reusable();
						// 原始网络探测可能先恢复；本事务仍缓存未知结果，必须将这项缺证也纳入恢复条件。
						return configurationDigest([
							await observeRetryEvidenceFingerprint(binding, state, input.environment),
							await remoteRevisionProbes.hasUnverifiedRevisionProbes(),
						]);
					};
					const mustCheckNativeRevision =
						binding.purpose === "native_session" && !input.recoverPreparationIntentPath;
					await rejectWhileNativeWriterLives();
					if (
						!mustCheckNativeRevision &&
						state.attemptCount === 0 &&
						(await reusable()) &&
						!(await remoteRevisionProbes.hasUnverifiedRevisionProbes())
					) {
						state.phase = "ready";
						await saveState(statePath, state);
						return {
							arguments: nativeReadOnlyMarketplaceArguments(
								binding,
								marketplaces,
								input.nativeLaunchArguments,
								configuration,
							),
							status: "ready" as const,
							statePath,
							nativeUpgradeCount,
							nativePluginInstallationCount,
						};
					}
					await rejectWhileNativeWriterLives();
					if (
						state.phase === "ready" &&
						!mustCheckNativeRevision &&
						(await reusable()) &&
						!(await remoteRevisionProbes.hasUnverifiedRevisionProbes())
					)
						return {
							arguments: nativeReadOnlyMarketplaceArguments(
								binding,
								marketplaces,
								input.nativeLaunchArguments,
								configuration,
							),
							status: "ready" as const,
							statePath,
							nativeUpgradeCount,
							nativePluginInstallationCount,
						};
					if (state.phase === "ready") {
						state.phase = "checking_marketplaces";
						state.attemptCount = 0;
						state.completedMarketplaceNames = [];
						state.pluginKeysRequiringInstallation = [];
					}
					if (state.attemptCount >= 3) {
						const evidence = await observeTransactionRetryEvidenceFingerprint();
						if (state.retryEvidenceFingerprint !== evidence) {
							state.attemptCount = 0;
							state.retryEvidenceFingerprint = evidence;
						}
						state.nextEvidenceObservationAtMs = Date.now() + 30_000;
						await saveState(statePath, state);
					}
					while (state.attemptCount < 3) {
						// 相同物理根与完整来源允许新一代接续；原生在途尝试保留原始发起者和 executable 证据。
						state.writerId = binding.writerId;
						state.configurationHomeDirectoryPath = binding.configurationHomeDirectoryPath;
						state.baseWriterMarketplaceConfigurationDigest = baseWriterMarketplaceConfigurationDigest;
						state.nativeExecutableIdentityDigest = shared.nativeCapabilityEvidence.nativeExecutableIdentityDigest;
						state.attemptCount++;
						await saveState(statePath, state);
						try {
							for (const marketplace of marketplaces) {
								const currentMetadata = await marketplaceMetadata(binding, marketplace);
								if (
									state.completedMarketplaceNames.includes(marketplace.name) &&
									currentMetadata?.revision === state.completedMarketplaceRevisions[marketplace.name]
								)
									continue;
								state.completedMarketplaceNames = state.completedMarketplaceNames.filter(
									(name) => name !== marketplace.name,
								);
								await reuseLegacyMarketplaceInstallation({
									binding,
									marketplace,
									environment: input.environment,
									isolatedGitWorkingDirectoryPath: state.installerHome,
								});
								const previous = await marketplaceMetadata(binding, marketplace);
								remoteRevisionProbes.invalidateAfterSourceInstallationFactsChanged();
								const result = nativeMarketplaceUpgradeResultSchema.parse(
									await measureTaskSessionStartupPhase(
										{ ...diagnosticContext, phase: "codex_native_marketplace_update" },
										() =>
											runNativeInstallationOperation({
												...input,
												state,
												statePath,
												kind: "marketplace_upgrade",
												selection: marketplace.name,
												abortSignal: abort.signal,
											}),
									),
								);
								if (
									result.errors.length ||
									!result.selectedMarketplaces.includes(marketplace.name) ||
									!(await marketplaceMetadata(binding, marketplace))
								)
									throw new Error("原生 marketplace 升级未给出匹配来源的完整激活事实。");
								nativeUpgradeCount += result.upgradedRoots.length;
								const activated = await marketplaceMetadata(binding, marketplace);
								if (
									result.upgradedRoots.length ||
									!previous ||
									(state.completedMarketplaceRevisions[marketplace.name] &&
										state.completedMarketplaceRevisions[marketplace.name] !== activated?.revision)
								)
									for (const key of pluginKeys.filter((key) => key.endsWith(`@${marketplace.name}`))) {
										if (!state.pluginKeysRequiringInstallation.includes(key))
											state.pluginKeysRequiringInstallation.push(key);
										delete state.completedPluginInstallations[key];
									}
								state.completedMarketplaceNames.push(marketplace.name);
								if (activated) state.completedMarketplaceRevisions[marketplace.name] = activated.revision;
								await saveState(statePath, state);
							}
							state.phase = "installing_plugins";
							await saveState(statePath, state);
							for (const key of pluginKeys) {
								const marketplace = marketplaces.find((source) => key.endsWith(`@${source.name}`));
								const sourceDiffers = Boolean(
									marketplace &&
										(await installedPluginPositivelyDiffersFromActivatedSource({
											remoteRevisionProbes,
											binding,
											state,
											environment: input.environment,
											marketplace,
											pluginKey: key,
										})),
								);
								if (sourceDiffers) {
									if (!state.pluginKeysRequiringInstallation.includes(key))
										state.pluginKeysRequiringInstallation.push(key);
									delete state.completedPluginInstallations[key];
								}
								const installed = await installedPlugin(binding, key);
								const completed = state.completedPluginInstallations[key];
								if (
									installed &&
									(!state.pluginKeysRequiringInstallation.includes(key) ||
										completed?.directoryIdentity === installed.directoryIdentity)
								)
									continue;
								if (installed && !sourceDiffers) {
									const reused = await reuseCompletedPluginInstallationFromSourceDomain({
										binding,
										state,
										statePath,
										pluginKey: key,
										installed,
									});
									if (reused) {
										state.completedPluginInstallations[key] = reused;
										await saveState(statePath, state);
										continue;
									}
								}
								remoteRevisionProbes.invalidateAfterSourceInstallationFactsChanged();
								const result = nativePluginInstallationResultSchema.parse(
									await measureTaskSessionStartupPhase(
										{ ...diagnosticContext, phase: "codex_native_plugin_installation" },
										() =>
											runNativeInstallationOperation({
												...input,
												state,
												statePath,
												kind: "plugin_install",
												selection: key,
												abortSignal: abort.signal,
											}),
									),
								);
								const current = await installedPlugin(binding, key);
								if (
									!current ||
									result.pluginId !== key ||
									(await realpath(result.installedPath)) !== current.installedPath
								)
									throw new Error("原生插件安装完成回执与实际插件目录不符。");
								state.completedPluginInstallations[key] = {
									...current,
									nativeAttemptId: state.lastCompletedNativeAttemptId,
								};
								nativePluginInstallationCount++;
								await saveState(statePath, state);
							}
							if (!(await reusable())) throw new Error("原生 marketplace 激活与插件安装尚未同时完成。");
							if (await remoteRevisionProbes.hasUnverifiedRevisionProbes())
								throw new Error("插件远端 revision 尚不可核验，保留完整缓存与待更新状态。");
							state.phase = "ready";
							delete state.failureReason;
							delete state.activeNativeAttempt;
							await saveState(statePath, state);
							return {
								arguments: nativeReadOnlyMarketplaceArguments(
									binding,
									marketplaces,
									input.nativeLaunchArguments,
									configuration,
								),
								status: "ready" as const,
								statePath,
								nativeUpgradeCount,
								nativePluginInstallationCount,
							};
						} catch (error) {
							if (abort.signal.aborted)
								throw new Error("Codex 来源域安装锁失去归属，原尝试保留，确认原生进程退出后自动补证。");
							state.phase = "waiting_for_evidence";
							state.failureReason = redactSecretShapedSubstringsInCommandLineText(
								error instanceof Error ? error.message : String(error),
							);
							state.retryEvidenceFingerprint = await observeTransactionRetryEvidenceFingerprint();
							state.nextEvidenceObservationAtMs = Date.now() + 30_000;
							await saveState(statePath, state);
							if (
								state.activeNativeAttempt &&
								(await nativeAttemptStillRunning(state.activeNativeAttempt, input.environment))
							)
								break;
							if (abort.signal.aborted) break;
						}
					}
					await rejectWhileNativeWriterLives();
					if (await reusable())
						return {
							arguments: nativeReadOnlyMarketplaceArguments(
								binding,
								marketplaces,
								input.nativeLaunchArguments,
								configuration,
							),
							status: "ready_with_pending_native_update" as const,
							statePath,
							nativeUpgradeCount,
							nativePluginInstallationCount,
						};
					throw new Error(
						`Codex 插件安装正在等待机器补证，条件恢复后自动接续。恢复记录：${statePath}；${state.failureReason ?? "来源待核验"}`,
					);
				} finally {
					await finishOwnership();
				}
			},
		);
		preparationIntent.status = result.status === "ready" ? "completed" : "pending";
		delete preparationIntent.failureReason;
		return result;
	} catch (error) {
		preparationIntent.failureReason = redactSecretShapedSubstringsInCommandLineText(
			error instanceof Error ? error.message : String(error),
		);
		await assertCodexConfigurationWriterBindingIdentity(binding);
		const persistedInstallation = (await readState(statePath)) ?? {
			completedPluginInstallations: {},
			completedMarketplaceRevisions: {},
			installerHome: binding.configurationHomeDirectoryPath,
		};
		let activatedSourceDiffers = false;
		for (const key of pluginKeys) {
			const marketplace = marketplaces.find((source) => key.endsWith(`@${source.name}`));
			if (
				marketplace &&
				(await installedPluginPositivelyDiffersFromActivatedSource({
					binding,
					state: persistedInstallation,
					environment: input.environment,
					marketplace,
					pluginKey: key,
				}))
			)
				activatedSourceDiffers = true;
		}
		if (
			!activatedSourceDiffers &&
			!nativeInstallationMustNotLaunchOverLiveWriter(error) &&
			!(await sourceDomainHasLiveNativeAttempt(binding, input.environment)) &&
			(await Promise.all(marketplaces.map((source) => marketplaceMetadata(binding, source)))).every(Boolean) &&
			(await Promise.all(pluginKeys.map((key) => installedPlugin(binding, key)))).every(Boolean)
		)
			return {
				arguments: nativeReadOnlyMarketplaceArguments(
					binding,
					marketplaces,
					input.nativeLaunchArguments,
					configuration,
				),
				status: "ready_with_pending_native_update" as const,
				statePath,
				nativeUpgradeCount: 0,
				nativePluginInstallationCount: 0,
				nativeMutationEvidenceCoverage: "unknown_after_source_controller_error" as const,
			};
		throw new Error(
			`Codex 插件安装正在等待机器补证，条件恢复后自动接续。准备意图：${intentPath}；${preparationIntent.failureReason}`,
		);
	} finally {
		preparationIntent.nextEvidenceObservationAtMs = Date.now() + 30_000;
		await savePreparationIntent(intentPath, preparationIntent);
	}
}

const recoveringSourceOperations = new Map<string, Promise<void>>();
const recoveryObservationsNotBeforeMs = new Map<string, number>();
export function recoverPendingCodexSharedPluginInstallations(
	bindings: CodexConfigurationWriterBinding[],
	environment: NodeJS.ProcessEnv = process.env,
) {
	const sourceBindings = new Map<string, CodexConfigurationWriterBinding[]>();
	for (const binding of bindings)
		if (binding.sourceSharedPluginInstallationDirectoriesBinding) {
			const directory = coordinationDirectory(binding);
			sourceBindings.set(directory, [...(sourceBindings.get(directory) ?? []), binding]);
		}
	for (const [directory, candidates] of sourceBindings) {
		if (
			recoveringSourceOperations.has(directory) ||
			(recoveryObservationsNotBeforeMs.get(directory) ?? 0) > Date.now()
		)
			continue;
		recoveryObservationsNotBeforeMs.set(directory, Date.now() + 30_000);
		const operation = (async () => {
			const intentsDirectory = join(directory, "native-launch-preparation-intents");
			const pendingStore = await readCodexConfigurationSyncLookupStore({
				writerIds: candidates.map((binding) => binding.writerId),
			});
			const pendingIntentPaths = new Map<string, unknown>();
			for (const binding of candidates)
				for (const [path, intent] of Object.entries(
					pendingStore.writers[binding.writerId]?.pendingSourceSharedPluginInstallationPreparations ?? {},
				)) {
					if (path === intentsDirectory) {
						for (const name of await readdir(intentsDirectory)) {
							if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
							const discoveredPath = join(intentsDirectory, name),
								discovered = await readPreparationIntent(discoveredPath);
							if (discovered.status === "pending") await savePreparationIntent(discoveredPath, discovered);
						}
						await mutateCodexConfigurationSyncActiveStore(
							(store) => {
								delete store.writers[binding.writerId]?.pendingSourceSharedPluginInstallationPreparations?.[
									path
								];
							},
							{ selection: { scope: "lookup", writerIds: [binding.writerId] } },
						);
					} else pendingIntentPaths.set(path, intent);
				}
			for (const [intentPath, snapshot] of pendingIntentPaths) {
				if (dirname(intentPath) !== intentsDirectory) continue;
				try {
					if (
						!(await lstat(intentPath).then(
							(file) => file.isFile(),
							() => false,
						))
					) {
						const retained = preparationIntentSchema.parse(snapshot);
						const owner = candidates.find(
							(binding) =>
								binding.writerId === retained.writerId && binding.sourceIdentity === retained.sourceIdentity,
						);
						if (!owner) continue;
						await assertCodexConfigurationWriterBindingIdentity(owner);
						await savePreparationIntent(intentPath, retained);
					}
					const intent = await readPreparationIntent(intentPath);
					if (intent.status === "completed") {
						await savePreparationIntent(intentPath, intent);
						continue;
					}
					if (
						dirname(intent.sourceInstallationStatePath) !== directory ||
						!/^source-installation-[a-f0-9]{64}\.json$/.test(
							intent.sourceInstallationStatePath.slice(directory.length + 1),
						)
					)
						throw new Error("Codex 插件准备意图指向了未绑定的安装记录。");
					const state = await readState(intent.sourceInstallationStatePath);
					if ((state?.nextEvidenceObservationAtMs ?? intent.nextEvidenceObservationAtMs) > Date.now()) continue;
					const binding = candidates.find(
						(candidate) =>
							candidate.writerId === intent.writerId && candidate.sourceIdentity === intent.sourceIdentity,
					);
					const shared = binding?.sourceSharedPluginInstallationDirectoriesBinding;
					if (!binding || !shared) continue;
					await prepareCodexSharedPluginInstallationForNativeLaunch({
						binding,
						binary: shared.nativeCapabilityEvidence.nativeExecutableRealPath,
						environment: { ...environment, ...buildCodexConfigurationWriterEnvironment(binding) },
						nativeLaunchArguments: [],
						recoverPreparationIntentPath: intentPath,
					}).catch(() => {});
				} catch {
					/* 单份记录缺证不阻塞同源其他已授权意图；下一观察周期重新核验。 */
				}
			}
		})()
			.catch(() => {})
			.finally(() => recoveringSourceOperations.delete(directory));
		recoveringSourceOperations.set(directory, operation);
	}
	return Promise.all([...recoveringSourceOperations.values()]).then(() => {});
}

export async function prepareAuxiliaryCodexConfigurationLaunch(input: {
	environment: NodeJS.ProcessEnv;
	cwd: string;
	binary: string;
	nativeLaunchArguments: string[];
}) {
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "auxiliary_process",
		storageHome: resolveUserCodexHomeDirectoryPath(input.environment, input.cwd),
		sqliteHome: input.environment.CODEX_SQLITE_HOME,
		runtimeSessionIncarnationId: randomUUID(),
		binary: input.binary,
		environment: input.environment,
		workingDirectory: input.cwd,
	});
	const environment = { ...input.environment, ...buildCodexConfigurationWriterEnvironment(binding) };
	const launch = await prepareCodexSharedPluginInstallationForNativeLaunch({
		binding,
		binary: input.binary,
		environment,
		nativeLaunchArguments: input.nativeLaunchArguments,
		workingDirectory: input.cwd,
	});
	return { environment, nativeLaunchArguments: launch.arguments };
}
