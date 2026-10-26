import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { parse, stringify, type TomlTable } from "smol-toml";
import { z } from "zod";
import { configurationDigest } from "../codex-configuration-sync/codex-configuration-field-projection";
import { getCodexConfigurationSyncDirectory } from "../codex-configuration-sync/codex-configuration-sync-store";
import { codexConfigurationWriterBindingSchema } from "../core/codex-configuration-sync-contract";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { preserveCodexHookTrustDuringConfigurationRefresh } from "./preserve-codex-hook-trust-during-configuration-refresh";

export function resolveUserCodexHomeDirectoryPath(environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
	return environment.CODEX_HOME?.trim()
		? resolve(cwd, environment.CODEX_HOME.trim())
		: join(environment.HOME?.trim() || homedir(), ".codex");
}

// 只接受原生转录布局，不能从任意文件名猜出存储目录。
export function inferCodexHomeDirectoryPathFromTranscriptPath(transcriptPath: string | null | undefined) {
	if (!transcriptPath || !isAbsolute(transcriptPath)) return undefined;
	const parts = resolve(transcriptPath).split(sep);
	const index = Math.max(parts.lastIndexOf("sessions"), parts.lastIndexOf("archived_sessions"));
	return index > 0 ? parts.slice(0, index).join(sep) || sep : undefined;
}

export function getManagedCodexConversationStorageHomeDirectoryPath() {
	return join(getRuntimeHomePath(), "codex-conversation-storage-home");
}

export function isManagedCodexConversationStorageHome(homeDirectoryPath: string) {
	return resolve(homeDirectoryPath) === resolve(getManagedCodexConversationStorageHomeDirectoryPath());
}

// 配置可以共享软链，会话与数据库的写入路径必须属于所选目录本身。
export async function assertCodexStorageWritablePathInsideHome(home: string, destination: string) {
	const child = relative(resolve(home), resolve(destination));
	if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))
		throw new Error("Codex 写入路径超出绑定目录，已保留现场。");
	let current = resolve(home);
	for (const part of child.split(sep)) {
		current = join(current, part);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error(`Codex 存储写入路径包含软链，拒绝覆盖：${current}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

const canonicalUserCodexHomeMarkerSchema = z.object({ sourceHomeDirectoryPath: z.string().min(1) });

function resolveVerifiedCodexWriterBridgeHistoryHome(inferredHome: string, recordedHome?: string | null) {
	const writersDirectoryPath = join(getCodexConfigurationSyncDirectory(), "writers");
	const lexicalRelativePathParts = relative(writersDirectoryPath, inferredHome).split(sep);
	const isLexicalWriterHome =
		lexicalRelativePathParts.length === 2 &&
		lexicalRelativePathParts[1] === "configuration-home" &&
		codexConfigurationWriterBindingSchema.shape.writerId.safeParse(lexicalRelativePathParts[0]).success;
	let physicalInferredHome: string;
	let physicalWritersDirectoryPath: string;
	try {
		physicalInferredHome = realpathSync(inferredHome);
		physicalWritersDirectoryPath = realpathSync(writersDirectoryPath);
	} catch (error) {
		if (!isLexicalWriterHome && ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
			return undefined;
		throw error;
	}
	const physicalRelativePathParts = relative(physicalWritersDirectoryPath, physicalInferredHome).split(sep);
	if (
		physicalRelativePathParts.length !== 2 ||
		physicalRelativePathParts[1] !== "configuration-home" ||
		!codexConfigurationWriterBindingSchema.shape.writerId.safeParse(physicalRelativePathParts[0]).success
	) {
		if (isLexicalWriterHome) throw new Error("Codex 配置写入者目录身份不符，未改写历史归属。");
		return undefined;
	}
	const manifestPath = join(dirname(physicalInferredHome), "writer-binding.json");
	if (!lstatSync(manifestPath).isFile()) throw new Error("Codex 历史桥接绑定不是普通文件。");
	const binding = codexConfigurationWriterBindingSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
	if (
		binding.writerId !== physicalRelativePathParts[0] ||
		binding.configurationHomeDirectoryPath !== physicalInferredHome
	)
		throw new Error("Codex 配置写入者清单目录身份不符，未改写历史归属。");
	const physicalHistoryHome = realpathSync(binding.conversationStorageHomeDirectoryPath);
	const historyMetadata = lstatSync(physicalHistoryHome, { bigint: true });
	if (
		!historyMetadata.isDirectory() ||
		configurationDigest([physicalHistoryHome, `${historyMetadata.dev}`, `${historyMetadata.ino}`]) !==
			binding.storageDirectoryIdentity ||
		(recordedHome && realpathSync(recordedHome) !== physicalHistoryHome)
	)
		throw new Error("Codex 历史目录身份或保存的历史归属不符，等待原目录恢复。");
	for (const name of ["sessions", "archived_sessions", "thread-writer-locks"]) {
		const bridgePath = join(physicalInferredHome, name);
		const historyDirectoryPath = join(physicalHistoryHome, name);
		if (
			!lstatSync(bridgePath).isSymbolicLink() ||
			!lstatSync(historyDirectoryPath).isDirectory() ||
			realpathSync(bridgePath) !== realpathSync(historyDirectoryPath)
		)
			throw new Error("Codex 历史或原生写锁桥接归属不符，等待原桥接恢复。");
	}
	return recordedHome ?? binding.conversationStorageHomeDirectoryPath;
}

export function resolveRecordedCodexConversationHome(input: {
	codexConversationStorageHomeDirectoryPath?: string | null;
	transcriptPath?: string | null;
	environment?: NodeJS.ProcessEnv;
	workingDirectoryPath?: string;
}) {
	const inferredHome = inferCodexHomeDirectoryPathFromTranscriptPath(input.transcriptPath);
	// 同步接口供历史缓存与持久状态漏斗使用；仅对物理归属匹配的 writer 核验绑定与桥接。
	const verifiedBridgeHistoryHome = inferredHome
		? resolveVerifiedCodexWriterBridgeHistoryHome(inferredHome, input.codexConversationStorageHomeDirectoryPath)
		: undefined;
	return (
		verifiedBridgeHistoryHome ??
		inferredHome ??
		input.codexConversationStorageHomeDirectoryPath ??
		resolveUserCodexHomeDirectoryPath(input.environment, input.workingDirectoryPath)
	);
}

async function linkExistingSharedCodexConfigurationEntry(source: string, destination: string) {
	try {
		await lstat(source);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		await symlink(source, destination, (await lstat(source)).isDirectory() ? "junction" : "file");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (
			!(await lstat(destination)).isSymbolicLink() ||
			resolve(dirname(destination), await readlink(destination)) !== source
		)
			throw new Error(`Codex 共享配置入口已被替换，保留现场并停止启动：${destination}`);
	}
}

function isCodexConfigurationTable(value: unknown): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function preserveCodexConfigurationSourceFileResolution(
	configuration: TomlTable,
	sourceConfigurationDirectoryPath: string,
) {
	// 只重定位 Codex 已知的文件引用；命令、参数和 URI 各自遵循原生语义。
	for (const key of [
		"model_instructions_file",
		"experimental_instructions_file",
		"experimental_compact_prompt_file",
		"model_catalog_json",
	]) {
		const value = configuration[key];
		if (typeof value === "string" && !isAbsolute(value))
			configuration[key] = resolve(sourceConfigurationDirectoryPath, value);
	}
	if (isCodexConfigurationTable(configuration.agents))
		for (const role of Object.values(configuration.agents)) {
			if (!isCodexConfigurationTable(role)) continue;
			const configFile = role.config_file;
			if (typeof configFile === "string" && !isAbsolute(configFile))
				role.config_file = resolve(sourceConfigurationDirectoryPath, configFile);
		}
	if (isCodexConfigurationTable(configuration.profiles))
		for (const profile of Object.values(configuration.profiles))
			if (isCodexConfigurationTable(profile))
				preserveCodexConfigurationSourceFileResolution(profile, sourceConfigurationDirectoryPath);
}

async function readExistingCodexConfigurationText(configurationPath: string) {
	try {
		return await readFile(configurationPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function refreshManagedCodexConfigurationSnapshot(input: {
	sourceConfigurationPath: string;
	targetHomeDirectoryPath: string;
	configurationFileName: string;
	relocatedHookSourceFilePaths: ReadonlyMap<string, string>;
}) {
	const { sourceConfigurationPath, targetHomeDirectoryPath, configurationFileName, relocatedHookSourceFilePaths } =
		input;
	const snapshotPath = join(targetHomeDirectoryPath, configurationFileName);
	await assertCodexStorageWritablePathInsideHome(targetHomeDirectoryPath, snapshotPath);
	// 旧目录可能仍有原生 writer；只做首次初始化，绝不刷新活配置。
	try {
		await lstat(snapshotPath);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const configuration = parse(await readExistingCodexConfigurationText(sourceConfigurationPath));
	if (configuration.cli_auth_credentials_store === "keyring")
		throw new Error("当前 Codex 使用 keyring 登录；专用会话目录尚不支持共享该认证方式，原有会话保持原目录。");
	configuration.sqlite_home = targetHomeDirectoryPath;
	preserveCodexConfigurationSourceFileResolution(configuration, dirname(sourceConfigurationPath));
	preserveCodexHookTrustDuringConfigurationRefresh({
		configuration,
		persistedManagedConfiguration: {},
		relocatedHookSourceFilePaths,
	});
	// 排他创建关闭了最后检查到 rename 的覆盖窗口；原生先创建时保留原生结果。
	try {
		await writeFile(snapshotPath, stringify(configuration), { mode: 0o600, flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export async function prepareManagedCodexConversationStorageHome(sourceHomeDirectoryPath: string) {
	const target = getManagedCodexConversationStorageHomeDirectoryPath();
	await mkdir(target, { recursive: true, mode: 0o700 });
	if ((await lstat(target)).isSymbolicLink()) throw new Error("看板 Codex 专用目录是软链，未改写任何配置。");
	if (resolve(sourceHomeDirectoryPath) === resolve(target)) return target;
	const targetNativeHookSourceHomeDirectoryPath = await realpath(target);
	let sourceNativeHookSourceHomeDirectoryPath = resolve(sourceHomeDirectoryPath);
	try {
		sourceNativeHookSourceHomeDirectoryPath = await realpath(sourceHomeDirectoryPath);
		if (sourceNativeHookSourceHomeDirectoryPath === targetNativeHookSourceHomeDirectoryPath)
			throw new Error("用户目录与看板 Codex 专用目录指向同一物理位置，未改写任何配置。");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const release = await lockfile.lock(target, {
		realpath: false,
		retries: { retries: 20, minTimeout: 25, maxTimeout: 100 },
	});
	try {
		const sourceMarkerPath = join(target, "canonical-user-codex-home.json");
		await assertCodexStorageWritablePathInsideHome(target, sourceMarkerPath);
		let savedSource: string | undefined;
		try {
			savedSource = canonicalUserCodexHomeMarkerSchema.parse(
				JSON.parse(await readFile(sourceMarkerPath, "utf8")),
			).sourceHomeDirectoryPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (savedSource && savedSource !== resolve(sourceHomeDirectoryPath))
			throw new Error("看板 Codex 专用目录绑定了另一套用户配置；保留原绑定，不能混用账号。");
		let sourceEntries: string[] = [];
		try {
			sourceEntries = await readdir(sourceHomeDirectoryPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const name of [
			"auth.json",
			".credentials.json",
			"AGENTS.md",
			"skills",
			"plugins",
			"rules",
			"hooks.json",
			"prompts",
			"marketplaces",
		])
			await linkExistingSharedCodexConfigurationEntry(join(sourceHomeDirectoryPath, name), join(target, name));
		const configurationFileNames = ["config.toml", ...sourceEntries.filter((name) => name.endsWith(".config.toml"))];
		// 原生来源键先规范化 home，再附加文件名；不能规范化共享文件软链本身或扩大账号绑定范围。
		const relocatedHookSourceFilePaths = new Map(
			[...configurationFileNames, ...(sourceEntries.includes("hooks.json") ? ["hooks.json"] : [])].map((name) => [
				join(sourceNativeHookSourceHomeDirectoryPath, name),
				join(targetNativeHookSourceHomeDirectoryPath, name),
			]),
		);
		for (const configurationFileName of configurationFileNames)
			await refreshManagedCodexConfigurationSnapshot({
				sourceConfigurationPath: join(sourceHomeDirectoryPath, configurationFileName),
				targetHomeDirectoryPath: target,
				configurationFileName,
				relocatedHookSourceFilePaths,
			});
		await writeFile(sourceMarkerPath, JSON.stringify({ sourceHomeDirectoryPath: resolve(sourceHomeDirectoryPath) }), {
			mode: 0o600,
		});
		return target;
	} finally {
		await release();
	}
}

export function buildCodexConversationStorageEnvironment(
	homeDirectoryPath: string,
): Record<string, string | undefined> {
	return {
		CODEX_HOME: homeDirectoryPath,
		...(isManagedCodexConversationStorageHome(homeDirectoryPath) ? { CODEX_SQLITE_HOME: homeDirectoryPath } : {}),
		CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
	};
}

export function getCodexConversationMigrationRecordPath(sourceHomeDirectoryPath: string, nativeSessionId: string) {
	const key = createHash("sha256")
		.update(JSON.stringify([resolve(sourceHomeDirectoryPath), nativeSessionId]))
		.digest("hex");
	return join(getRuntimeHomePath(), "codex-conversation-storage-migrations", `${key}.json`);
}

const migrationHomeBindingRecordSchema = z.object({
	nativeSessionId: z.string().uuid(),
	sourceHomeDirectoryPath: z.string(),
	targetHomeDirectoryPath: z.string(),
	stage: z.enum(["copy_started", "copied", "bound", "source_archived", "rolled_back"]),
	familyRootNativeSessionId: z.string().uuid().optional(),
});

export async function resolveMigratedCodexConversationHome(sourceHomeDirectoryPath: string, nativeSessionId: string) {
	const canonicalSourceHome = await resolveCanonicalUserCodexHomeForManagedStorage(sourceHomeDirectoryPath);
	let contents: string;
	try {
		contents = await readFile(getCodexConversationMigrationRecordPath(canonicalSourceHome, nativeSessionId), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return sourceHomeDirectoryPath;
		throw error;
	}
	let record = migrationHomeBindingRecordSchema.parse(JSON.parse(contents));
	if (
		record.nativeSessionId !== nativeSessionId ||
		resolve(record.sourceHomeDirectoryPath) !== resolve(canonicalSourceHome)
	)
		throw new Error("Codex 迁移记录的身份或来源目录不匹配。");
	if (record.familyRootNativeSessionId && record.familyRootNativeSessionId !== nativeSessionId)
		record = migrationHomeBindingRecordSchema.parse(
			JSON.parse(
				await readFile(
					getCodexConversationMigrationRecordPath(canonicalSourceHome, record.familyRootNativeSessionId),
					"utf8",
				),
			),
		);
	if (record.stage === "bound" || record.stage === "source_archived") {
		if (resolve(record.targetHomeDirectoryPath) !== resolve(getManagedCodexConversationStorageHomeDirectoryPath()))
			throw new Error("Codex 迁移记录指向非受管目标目录。");
		return record.targetHomeDirectoryPath;
	}
	return record.sourceHomeDirectoryPath;
}

export async function resolveCanonicalUserCodexHomeForManagedStorage(homeDirectoryPath: string) {
	if (resolve(homeDirectoryPath) !== resolve(getManagedCodexConversationStorageHomeDirectoryPath()))
		return homeDirectoryPath;
	const marker = canonicalUserCodexHomeMarkerSchema.parse(
		JSON.parse(await readFile(join(homeDirectoryPath, "canonical-user-codex-home.json"), "utf8")),
	);
	return marker.sourceHomeDirectoryPath;
}

export async function withCodexConversationStorageOperationLock<T>(
	homeDirectoryPath: string,
	nativeSessionId: string,
	operation: () => Promise<T>,
) {
	const canonicalHome = await resolveCanonicalUserCodexHomeForManagedStorage(homeDirectoryPath);
	const recordPath = getCodexConversationMigrationRecordPath(canonicalHome, nativeSessionId);
	await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(recordPath, { realpath: false });
	try {
		return await operation();
	} finally {
		await release();
	}
}
