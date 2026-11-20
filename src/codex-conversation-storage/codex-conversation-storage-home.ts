import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse, type TomlTable } from "smol-toml";
import { z } from "zod";
import { legacyCodexConfigurationWriterBindingSchema } from "../core/legacy-codex-configuration-writer-binding-schema";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { formatCodexConfigurationOverrideTomlValue } from "./codex-native-configuration-override-toml-value";
import {
	prepareCodexPersistentDirectoryIdentity,
	resolveCodexPersistentDirectoryIdentity,
} from "./codex-persistent-directory-identity";
import { getLegacyCodexConfigurationDirectory } from "./legacy-codex-configuration-writer-binding";
import { preserveCodexHookTrustDuringConfigurationRefresh } from "./preserve-codex-hook-trust-during-configuration-refresh";

export async function resolveVerifiedSeparateCodexSqliteHomeForAuxiliaryProcess(
	transcriptHome: string,
	binding: { sqliteHomeDirectoryPath: string; sqliteDirectoryIdentity: string } | null | undefined,
): Promise<string | undefined> {
	if (!binding || resolve(binding.sqliteHomeDirectoryPath) === resolve(transcriptHome)) return undefined;
	const sqliteHome = await realpath(binding.sqliteHomeDirectoryPath);
	if (sqliteHome === (await realpath(transcriptHome))) return undefined;
	await prepareCodexPersistentDirectoryIdentity(sqliteHome, { expectedIdentity: binding.sqliteDirectoryIdentity });
	return sqliteHome;
}

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
	const managed = getManagedCodexConversationStorageHomeDirectoryPath();
	if (resolve(homeDirectoryPath) === resolve(managed)) return true;
	try {
		return realpathSync(homeDirectoryPath) === realpathSync(managed);
	} catch {
		return false;
	}
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

const canonicalUserCodexHomeMarkerSchema = z.object({
	sourceHomeDirectoryPath: z.string().min(1),
	physicalSourceHomeDirectoryPath: z.string().min(1).optional(),
});

function resolveVerifiedCodexWriterBridgeHistoryHome(inferredHome: string, recordedHome?: string | null) {
	const writersDirectoryPath = join(getLegacyCodexConfigurationDirectory(), "writers");
	const lexicalRelativePathParts = relative(writersDirectoryPath, inferredHome).split(sep);
	const isLexicalWriterHome =
		lexicalRelativePathParts.length === 2 &&
		lexicalRelativePathParts[1] === "configuration-home" &&
		legacyCodexConfigurationWriterBindingSchema.shape.writerId.safeParse(lexicalRelativePathParts[0]).success;
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
		!legacyCodexConfigurationWriterBindingSchema.shape.writerId.safeParse(physicalRelativePathParts[0]).success
	) {
		if (isLexicalWriterHome) throw new Error("Codex 配置写入者目录身份不符，未改写历史归属。");
		return undefined;
	}
	const manifestPath = join(dirname(physicalInferredHome), "writer-binding.json");
	if (!lstatSync(manifestPath).isFile()) throw new Error("Codex 历史桥接绑定不是普通文件。");
	const binding = legacyCodexConfigurationWriterBindingSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
	if (
		binding.writerId !== physicalRelativePathParts[0] ||
		binding.configurationHomeDirectoryPath !== physicalInferredHome
	)
		throw new Error("Codex 配置写入者清单目录身份不符，未改写历史归属。");
	const physicalHistoryHome = realpathSync(binding.conversationStorageHomeDirectoryPath);
	const historyMetadata = lstatSync(physicalHistoryHome, { bigint: true });
	if (!historyMetadata.isDirectory() || (recordedHome && realpathSync(recordedHome) !== physicalHistoryHome))
		throw new Error("Codex 历史目录身份或保存的历史归属不符，等待原目录恢复。");
	resolveCodexPersistentDirectoryIdentity(
		physicalHistoryHome,
		{
			expectedIdentity: binding.storageDirectoryIdentity,
			boundAtMs: binding.createdAt,
			legacyBindingManifestPath: manifestPath,
		},
		false,
	);
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

function collectCodexConfigurationRelativeFileReferences(configuration: TomlTable): string[] {
	const references = [
		configuration.model_instructions_file,
		configuration.experimental_instructions_file,
		configuration.experimental_compact_prompt_file,
		configuration.model_catalog_json,
	];
	if (isCodexConfigurationTable(configuration.agents))
		for (const role of Object.values(configuration.agents))
			if (isCodexConfigurationTable(role)) references.push(role.config_file);
	return [
		...references.filter((value): value is string => typeof value === "string" && !!value && !isAbsolute(value)),
		...(isCodexConfigurationTable(configuration.profiles)
			? Object.values(configuration.profiles)
					.filter(isCodexConfigurationTable)
					.flatMap(collectCodexConfigurationRelativeFileReferences)
			: []),
	];
}

async function bridgeCodexConfigurationRelativeFileReference(
	sourceHome: string,
	managedHome: string,
	reference: string,
) {
	const sourcePath = resolve(sourceHome, reference);
	const destination = resolve(managedHome, reference);
	if (destination === sourcePath) return;
	const targetRelativePath = relative(managedHome, destination);
	if (
		!targetRelativePath ||
		targetRelativePath === ".." ||
		targetRelativePath.startsWith(`..${sep}`) ||
		isAbsolute(targetRelativePath)
	)
		throw new Error(`原生 Codex 配置的相对文件引用超出专用目录，请将其设为绝对路径：${reference}`);
	const sourcePhysicalPath = await realpath(sourcePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (!sourcePhysicalPath) return;
	if (!(await lstat(sourcePhysicalPath)).isFile()) throw new Error(`Codex 配置引用不是普通文件：${reference}`);
	const destinationPhysicalPath = await realpath(destination).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (destinationPhysicalPath === sourcePhysicalPath) return;
	const protectedDirectoryNames = new Set([
		"sessions",
		"archived_sessions",
		"thread-writer-locks",
		"cache",
		".tmp",
		"retired-configuration-snapshots",
	]);
	if (protectedDirectoryNames.has(targetRelativePath.split(sep)[0] ?? ""))
		throw new Error(`Codex 配置引用与专用存储路径冲突：${reference}`);
	await assertCodexStorageWritablePathInsideHome(
		managedHome,
		dirname(destination) === managedHome ? destination : dirname(destination),
	);
	await mkdir(dirname(destination), { mode: 0o700, recursive: true });
	await linkExistingSharedCodexConfigurationEntry(sourcePath, destination);
}

const readCodexNativeProcessTable = promisify(execFile);

async function assertLegacyCodexConfigurationHomeHasNoLiveNativeWriters(homeDirectoryPath: string) {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("无法核对旧 Codex 专用目录的活进程，已保留原配置。");
	const physicalHome = await realpath(homeDirectoryPath);
	const readProcessRows = async () =>
		(
			await readCodexNativeProcessTable("ps", ["-Ao", "pid=,uid=,comm="], {
				timeout: 5_000,
				maxBuffer: 4 * 1024 * 1024,
			})
		).stdout
			.split("\n")
			.flatMap((line) => {
				const [, pid, processUid, command] = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line) ?? [];
				return pid &&
					command &&
					Number(processUid) === uid &&
					/^codex(?:-(?:aarch64|x86_64)-|\.exe$|$)/.test(basename(command.trim()))
					? [pid]
					: [];
			});
	for (const pid of await readProcessRows()) {
		let declaredHome: string | undefined;
		try {
			if (process.platform === "linux") {
				declaredHome = (await readFile(`/proc/${pid}/environ`, "utf8"))
					.split("\0")
					.find((entry) => entry.startsWith("CODEX_HOME="))
					?.slice("CODEX_HOME=".length);
			} else {
				const { stdout } = await readCodexNativeProcessTable("ps", ["-E", "-ww", "-o", "command=", "-p", pid], {
					timeout: 5_000,
					maxBuffer: 2 * 1024 * 1024,
				});
				if (!/\sHOME=/.test(stdout)) throw new Error("进程环境不可读");
				declaredHome = /(?:^|\s)CODEX_HOME=(.*?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/s.exec(stdout.trim())?.[1];
			}
		} catch {
			if (!(await readProcessRows()).includes(pid)) continue;
			throw new Error(`无法核对 Codex 进程 ${pid} 的存储目录，等待原生进程退出后自动重验。`);
		}
		if (!declaredHome) continue;
		if (!isAbsolute(declaredHome))
			throw new Error(`Codex 进程 ${pid} 的存储目录使用相对路径，等待进程退出后转换旧配置。`);
		if (
			(await realpath(declaredHome).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return resolve(declaredHome);
				throw error;
			})) === physicalHome
		)
			throw new Error(`Codex 进程 ${pid} 仍使用旧专用目录，等待其退出后转换原生配置。`);
	}
}

async function readExistingCodexConfigurationText(configurationPath: string) {
	try {
		return await readFile(configurationPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function bridgeNativeCodexConfigurationFile(
	source: string,
	destination: string,
	archiveExisting: boolean,
	linkSource = true,
) {
	try {
		const previous = await lstat(destination);
		if (linkSource && previous.isSymbolicLink() && (await readlink(destination)) === source) return;
		if (!archiveExisting || (!previous.isFile() && !previous.isSymbolicLink()))
			throw new Error("Codex 配置入口归属不明，已保留原文件。");
		const archiveDirectoryPath = join(dirname(destination), "retired-configuration-snapshots");
		await mkdir(archiveDirectoryPath, { mode: 0o700, recursive: true });
		await assertCodexStorageWritablePathInsideHome(dirname(destination), archiveDirectoryPath);
		// 旧 hooks.json 可能指向 writer 快照，保留原链接与归属，避免读取并复制配置秘密。
		const archivePath = join(
			archiveDirectoryPath,
			`${createHash("sha256")
				.update(previous.isSymbolicLink() ? await readlink(destination) : await readFile(destination))
				.digest("hex")}-${destination.slice(dirname(destination).length + 1)}`,
		);
		await assertCodexStorageWritablePathInsideHome(dirname(destination), archivePath);
		await rename(destination, archivePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (linkSource) await symlink(source, destination, "file");
}

export async function resolveManagedCodexNativeConfigurationArguments(
	homeDirectoryPath: string | undefined,
	arguments_: readonly string[],
): Promise<string[]> {
	if (!homeDirectoryPath || !isManagedCodexConversationStorageHome(homeDirectoryPath)) return [];
	const sourceHome = await resolveCanonicalUserCodexHomeForManagedStorage(homeDirectoryPath);
	await prepareManagedCodexConversationStorageHome(sourceHome);
	const physicalSource = await realpath(sourceHome);
	const physicalTarget = await realpath(homeDirectoryPath);
	const configurationFileNames = ["config.toml"];
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		if (argument === "--") break;
		const name =
			argument === "--profile" || argument === "-p"
				? arguments_[++index]
				: /^(?:--profile=|-p=?)([a-zA-Z0-9_-]+)$/.exec(argument ?? "")?.[1];
		if (name && /^[a-zA-Z0-9_-]+$/.test(name)) configurationFileNames.push(`${name}.config.toml`);
	}
	const relocations = new Map(
		[...configurationFileNames, "hooks.json"].map((name) => [join(physicalSource, name), join(physicalTarget, name)]),
	);
	const overrides = new Map<string, unknown>();
	for (const name of configurationFileNames) {
		const original = parse(await readExistingCodexConfigurationText(join(physicalSource, name)));
		const configuration = structuredClone(original);
		for (const reference of collectCodexConfigurationRelativeFileReferences(original))
			await bridgeCodexConfigurationRelativeFileReference(physicalSource, physicalTarget, reference);
		preserveCodexHookTrustDuringConfigurationRefresh({
			configuration,
			persistedManagedConfiguration: {},
			relocatedHookSourceFilePaths: relocations,
		});
		const collectChanges = (previous: TomlTable, resolved: TomlTable, keyPath: string[] = []) => {
			for (const [key, value] of Object.entries(resolved)) {
				const path = [...keyPath, key];
				if (isCodexConfigurationTable(value) && !(key === "state" && keyPath.at(-1) === "hooks")) {
					collectChanges(isCodexConfigurationTable(previous[key]) ? previous[key] : {}, value, path);
				} else {
					const overrideKey = path
						.map((part) => (/^[a-zA-Z0-9_-]+$/.test(part) ? part : JSON.stringify(part)))
						.join(".");
					if (JSON.stringify(previous[key]) !== JSON.stringify(value)) overrides.set(overrideKey, value);
					else overrides.delete(overrideKey);
				}
			}
		};
		collectChanges(original, configuration);
	}
	return [
		...Array.from(overrides, ([key, value]) => [
			"-c",
			`${key}=${formatCodexConfigurationOverrideTomlValue(value)}`,
		]).flat(),
		"-c",
		`sqlite_home=${JSON.stringify(homeDirectoryPath)}`,
	];
}

export async function prepareManagedCodexConversationStorageHome(sourceHomeDirectoryPath: string) {
	const target = getManagedCodexConversationStorageHomeDirectoryPath();
	await mkdir(target, { recursive: true, mode: 0o700 });
	if ((await lstat(target)).isSymbolicLink()) throw new Error("看板 Codex 专用目录是软链，未改写任何配置。");
	if (resolve(sourceHomeDirectoryPath) === resolve(target)) return target;
	await mkdir(sourceHomeDirectoryPath, { recursive: true, mode: 0o700 });
	const physicalSourceHomeDirectoryPath = await realpath(sourceHomeDirectoryPath);
	if (physicalSourceHomeDirectoryPath === (await realpath(target)))
		throw new Error("用户目录与看板 Codex 专用目录指向同一物理位置，未改写任何配置。");
	const release = await lockedFileSystem.acquireLock({
		path: target,
		type: "directory",
		lockfilePath: `${target}.lock`,
		retries: { retries: 20, minTimeout: 25, maxTimeout: 100 },
	});
	try {
		const sourceMarkerPath = join(target, "canonical-user-codex-home.json");
		await assertCodexStorageWritablePathInsideHome(target, sourceMarkerPath);
		let savedSource: z.infer<typeof canonicalUserCodexHomeMarkerSchema> | undefined;
		try {
			savedSource = canonicalUserCodexHomeMarkerSchema.parse(JSON.parse(await readFile(sourceMarkerPath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (
			savedSource &&
			(savedSource.sourceHomeDirectoryPath !== resolve(sourceHomeDirectoryPath) ||
				(savedSource.physicalSourceHomeDirectoryPath !== undefined &&
					savedSource.physicalSourceHomeDirectoryPath !== physicalSourceHomeDirectoryPath))
		)
			throw new Error("看板 Codex 专用目录绑定了另一套用户配置；保留原绑定，不能混用账号。");
		await mkdir(join(sourceHomeDirectoryPath, "plugins"), { mode: 0o700, recursive: true });
		const sourceEntries = await readdir(sourceHomeDirectoryPath);
		for (const name of [
			"auth.json",
			".credentials.json",
			"AGENTS.md",
			"skills",
			"plugins",
			"rules",
			"prompts",
			"marketplaces",
		])
			await linkExistingSharedCodexConfigurationEntry(join(sourceHomeDirectoryPath, name), join(target, name));
		const legacyBridgeConvertedMarkerPath = join(target, "native-configuration-bridge.json");
		await assertCodexStorageWritablePathInsideHome(target, legacyBridgeConvertedMarkerPath);
		const legacyConfigurationFiles = await lstat(legacyBridgeConvertedMarkerPath).then(
			() => false,
			(error) => {
				if (error.code === "ENOENT") return savedSource !== undefined;
				throw error;
			},
		);
		if (legacyConfigurationFiles) await assertLegacyCodexConfigurationHomeHasNoLiveNativeWriters(target);
		const sourceMarketplaceDirectoryPath = join(sourceHomeDirectoryPath, ".tmp", "marketplaces");
		const marketplaceParent = join(target, ".tmp");
		await assertCodexStorageWritablePathInsideHome(target, marketplaceParent);
		const managedMarketplaceDirectoryPath = join(marketplaceParent, "marketplaces");
		const managedMarketplace = await lstat(managedMarketplaceDirectoryPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		// 旧专用 home 的独立 marketplace 副本保留在原卷上，原生插件与 marketplace 同时桥接到来源。
		if (legacyConfigurationFiles && managedMarketplace?.isDirectory()) {
			const archivedMarketplace = join(target, "retired-configuration-snapshots", "native-marketplaces");
			await assertCodexStorageWritablePathInsideHome(target, archivedMarketplace);
			await mkdir(dirname(archivedMarketplace), { recursive: true, mode: 0o700 });
			try {
				await lstat(archivedMarketplace);
				throw new Error("旧 Codex marketplace 归档已存在，保留两份目录供核对。");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await rename(managedMarketplaceDirectoryPath, archivedMarketplace);
		}
		await mkdir(sourceMarketplaceDirectoryPath, { mode: 0o700, recursive: true });
		await mkdir(marketplaceParent, { mode: 0o700, recursive: true });
		await linkExistingSharedCodexConfigurationEntry(sourceMarketplaceDirectoryPath, managedMarketplaceDirectoryPath);
		const sourceConfigurationNames = new Set([
			"config.toml",
			"hooks.json",
			...sourceEntries.filter((name) => name.endsWith(".config.toml")),
		]);
		const legacyConfigurationNames = legacyConfigurationFiles
			? (await readdir(target)).filter((name) => name.endsWith(".config.toml"))
			: [];
		for (const name of new Set([...sourceConfigurationNames, ...legacyConfigurationNames]))
			await bridgeNativeCodexConfigurationFile(
				join(physicalSourceHomeDirectoryPath, name),
				join(target, name),
				legacyConfigurationFiles,
				sourceConfigurationNames.has(name),
			);
		await lockedFileSystem.writeJsonFileAtomic(
			sourceMarkerPath,
			{ sourceHomeDirectoryPath: resolve(sourceHomeDirectoryPath), physicalSourceHomeDirectoryPath },
			{ lock: null, durable: true, fileMode: 0o600 },
		);
		if (legacyConfigurationFiles || !savedSource)
			await lockedFileSystem.writeJsonFileAtomic(
				legacyBridgeConvertedMarkerPath,
				{ schemaVersion: 1 },
				{ lock: null, durable: true, fileMode: 0o600 },
			);
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
	if (!isManagedCodexConversationStorageHome(homeDirectoryPath)) return homeDirectoryPath;
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
	const release = await lockedFileSystem.acquireLock({ path: recordPath, retries: 0 });
	try {
		return await operation();
	} finally {
		await release();
	}
}
