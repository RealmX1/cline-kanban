import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { z } from "zod";
import {
	getManagedCodexConversationStorageHomeDirectoryPath,
	preserveCodexConfigurationSourceFileResolution,
	resolveCanonicalUserCodexHomeForManagedStorage,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import {
	configurationDigest,
	configurationTable,
	projectCodexConfigurationFields,
	relocateCodexHookStateSourcePaths,
} from "./codex-configuration-field-projection";
import { type CodexConfigurationSyncStore, getCodexConfigurationSyncDirectory } from "./codex-configuration-sync-store";
import {
	assertCodexConfigurationWriterBindingIdentity,
	codexDirectoryIdentity,
} from "./codex-configuration-writer-binding";

const snapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		sourceIdentity: z.string(),
		sourceHomeDirectoryPath: z.string(),
		capturedAtMs: z.number(),
		sourceWriterId: z.string().nullable(),
		agentConfigurationFiles: z
			.record(z.string().regex(/^captured-agent-configuration-[a-f0-9]{64}\.toml$/), z.string())
			.optional(),
		configurationFiles: z.record(
			z.string().regex(/^(?:config\.toml|[\w.-]+\.config\.toml|hooks\.json)$/),
			z.string(),
		),
	})
	.refine((snapshot) => Object.hasOwn(snapshot.configurationFiles, "config.toml"), "Codex 初始化快照缺少主配置。");

export function removeCodexDesktopConfiguration(configuration: TomlTable) {
	delete configuration.desktop;
	if (configurationTable(configuration.profiles))
		for (const profile of Object.values(configuration.profiles))
			if (configurationTable(profile)) removeCodexDesktopConfiguration(profile);
}

async function persistSnapshotAtomically(path: string, content: string) {
	const pendingPath = `${path}.${randomUUID()}.pending`;
	try {
		const file = await open(pendingPath, "wx", 0o600);
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(pendingPath, path);
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	} finally {
		await rm(pendingPath, { force: true });
	}
}

function codexConfigurationInitializationSnapshotDirectory(sourceIdentity: string) {
	return join(
		getCodexConfigurationSyncDirectory(),
		"source-initialization-snapshots",
		configurationDigest(sourceIdentity),
	);
}

function configurationPathIsInside(directory: string, path: string) {
	const child = relative(directory, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function captureCodexAgentConfigurationReferences(input: {
	configuration: TomlTable;
	copyFrom: string;
	sourceHome: string;
	snapshotDirectory: string;
	agentConfigurationFiles: Record<string, string>;
}) {
	const { configuration, copyFrom, sourceHome, snapshotDirectory, agentConfigurationFiles } = input;
	if (configurationTable(configuration.agents))
		for (const role of Object.values(configuration.agents)) {
			if (!configurationTable(role) || typeof role.config_file !== "string") continue;
			const originalPath = role.config_file;
			const capturedFileName = `captured-agent-configuration-${configurationDigest(originalPath)}.toml`;
			role.config_file = join(snapshotDirectory, capturedFileName);
			if (Object.hasOwn(agentConfigurationFiles, capturedFileName)) continue;
			const configurationPath =
				copyFrom !== sourceHome && configurationPathIsInside(sourceHome, originalPath)
					? resolve(copyFrom, relative(sourceHome, originalPath))
					: originalPath;
			if (
				copyFrom !== sourceHome &&
				(!configurationPathIsInside(copyFrom, await realpath(configurationPath)) ||
					!(await lstat(configurationPath)).isFile())
			)
				throw new Error("Codex 旧角色配置缺少已核验的内部副本，恢复后自动重试；不会重新读取外部设置。");
			const capturedConfiguration = parse(await readFile(configurationPath, "utf8"));
			removeCodexDesktopConfiguration(capturedConfiguration);
			preserveCodexConfigurationSourceFileResolution(capturedConfiguration, dirname(configurationPath));
			// 先登记身份，角色之间循环引用时也只捕获一次。
			agentConfigurationFiles[capturedFileName] = "";
			await captureCodexAgentConfigurationReferences({ ...input, configuration: capturedConfiguration });
			agentConfigurationFiles[capturedFileName] = stringify(capturedConfiguration);
		}
	if (configurationTable(configuration.profiles))
		for (const profile of Object.values(configuration.profiles))
			if (configurationTable(profile))
				await captureCodexAgentConfigurationReferences({ ...input, configuration: profile });
}

export function relocateCodexCapturedAgentConfigurationReferences(
	configuration: TomlTable,
	snapshotDirectory: string,
	agentConfigurationFiles: Readonly<Record<string, string>>,
) {
	if (configurationTable(configuration.agents))
		for (const role of Object.values(configuration.agents)) {
			if (!configurationTable(role) || typeof role.config_file !== "string") continue;
			const capturedFileName = `captured-agent-configuration-${configurationDigest(role.config_file)}.toml`;
			if (Object.hasOwn(agentConfigurationFiles, capturedFileName))
				role.config_file = join(snapshotDirectory, capturedFileName);
		}
	if (configurationTable(configuration.profiles))
		for (const profile of Object.values(configuration.profiles))
			if (configurationTable(profile))
				relocateCodexCapturedAgentConfigurationReferences(profile, snapshotDirectory, agentConfigurationFiles);
}

export async function readVerifiedCodexConfigurationInitializationSnapshot(
	sourceIdentity: string,
	sourceHome: string,
	reference?: CodexConfigurationSyncStore["sources"][string]["configurationInitialization"],
) {
	const directory = codexConfigurationInitializationSnapshotDirectory(sourceIdentity);
	if (
		(await realpath(directory)) !==
		join(
			await realpath(getCodexConfigurationSyncDirectory()),
			"source-initialization-snapshots",
			configurationDigest(sourceIdentity),
		)
	)
		throw new Error("Codex 初始化快照目录身份不符。");
	const snapshotFilePath = join(directory, "configuration-initialization-snapshot.json");
	if (reference && reference.snapshotFilePath !== snapshotFilePath) throw new Error("Codex 初始化快照引用不符。");
	if (!(await lstat(snapshotFilePath)).isFile()) throw new Error("Codex 初始化快照不是普通文件。");
	const snapshot = snapshotSchema.parse(JSON.parse(await readFile(snapshotFilePath, "utf8")));
	if (
		snapshot.sourceIdentity !== sourceIdentity ||
		snapshot.sourceHomeDirectoryPath !== sourceHome ||
		(reference && reference.snapshotDigest !== configurationDigest(snapshot))
	)
		throw new Error("Codex 初始化快照归属或摘要不符，已保留现场。");
	return snapshot;
}

// 调用者持有配置存储锁；先提交不可变快照，再进行可重放的 writer 初始化。
export async function ensureCodexConfigurationInitializationSnapshot(
	store: CodexConfigurationSyncStore,
	sourceIdentity: string,
	sourceHome: string,
) {
	const directory = codexConfigurationInitializationSnapshotDirectory(sourceIdentity);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const snapshotFilePath = join(directory, "configuration-initialization-snapshot.json");
	const source = store.sources[sourceIdentity];
	const reference = source?.configurationInitialization;
	let snapshot: z.infer<typeof snapshotSchema>;
	try {
		snapshot = await readVerifiedCodexConfigurationInitializationSnapshot(sourceIdentity, sourceHome, reference);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || reference) throw error;
		let copyFrom = sourceHome;
		let sourceWriterId: string | null = null;
		if (source) {
			const candidates = Object.values(store.writers)
				.filter((writer) => writer.binding.sourceIdentity === sourceIdentity)
				.sort(
					(left, right) =>
						Number(right.binding.purpose === "native_session") -
							Number(left.binding.purpose === "native_session") ||
						right.binding.createdAt - left.binding.createdAt,
				);
			for (const writer of candidates) {
				try {
					await assertCodexConfigurationWriterBindingIdentity(writer.binding);
					copyFrom = writer.binding.configurationHomeDirectoryPath;
					sourceWriterId = writer.binding.writerId;
					break;
				} catch {
					/* 一份副本不可用时继续核验同来源的其他持久副本。 */
				}
			}
			if (
				!sourceWriterId &&
				Object.values(store.legacySessionProfileAdoptions).some(
					(adoption) =>
						adoption.sourceIdentity === sourceIdentity &&
						store.profiles[adoption.profileId]?.sourceIdentity === sourceIdentity,
				)
			) {
				const historyHome = getManagedCodexConversationStorageHomeDirectoryPath();
				if (
					!(await lstat(historyHome)).isDirectory() ||
					!(await lstat(join(historyHome, "canonical-user-codex-home.json"))).isFile() ||
					(await realpath(await resolveCanonicalUserCodexHomeForManagedStorage(historyHome))) !== sourceHome ||
					!(await lstat(join(historyHome, "config.toml"))).isFile()
				)
					throw new Error("Codex 旧会话内部配置副本归属不符，保留现场等待恢复。");
				await codexDirectoryIdentity(sourceHome, { expectedIdentity: sourceIdentity });
				copyFrom = await realpath(historyHome);
			}
			if (copyFrom === sourceHome)
				throw new Error(
					"Codex 初始化等待同来源的 Kanban 副本恢复核验；不会重新导入外部配置，下次启动或补扫自动重试。",
				);
		}
		const configurationFiles: Record<string, string> = {};
		const agentConfigurationFiles: Record<string, string> = {};
		for (const name of new Set([
			"config.toml",
			"hooks.json",
			...(await readdir(copyFrom)).filter((name) => /^[\w.-]+\.config\.toml$/.test(name)),
		])) {
			let text = "";
			try {
				if (copyFrom !== sourceHome && !(await lstat(join(copyFrom, name))).isFile()) {
					if (name === "hooks.json") continue;
					throw new Error("Codex 内部配置不是普通文件，保留现场等待恢复。");
				}
				text = await readFile(join(copyFrom, name), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				if (name !== "config.toml") continue;
			}
			if (name.endsWith(".toml")) {
				const configuration = parse(text);
				removeCodexDesktopConfiguration(configuration);
				preserveCodexConfigurationSourceFileResolution(configuration, copyFrom);
				await captureCodexAgentConfigurationReferences({
					configuration,
					copyFrom,
					sourceHome,
					snapshotDirectory: directory,
					agentConfigurationFiles,
				});
				relocateCodexHookStateSourcePaths(configuration, await realpath(copyFrom), sourceHome);
				text = stringify(configuration);
			}
			configurationFiles[name] = text;
		}
		snapshot = snapshotSchema.parse({
			schemaVersion: 1,
			sourceIdentity,
			sourceHomeDirectoryPath: sourceHome,
			capturedAtMs: Date.now(),
			sourceWriterId,
			configurationFiles,
			agentConfigurationFiles,
		});
		await persistSnapshotAtomically(snapshotFilePath, JSON.stringify(snapshot));
	}
	// 派生文件可以从已提交快照恢复；恢复不再接触外部配置内容。
	for (const [name, content] of Object.entries({
		...snapshot.configurationFiles,
		...snapshot.agentConfigurationFiles,
	})) {
		const path = join(directory, name);
		try {
			if (!(await lstat(path)).isFile()) throw new Error("Codex 快照配置被替换，已保留现场。");
			if ((await readFile(path, "utf8")) === content) continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await persistSnapshotAtomically(path, content);
	}
	try {
		await symlink(join(sourceHome, "plugins"), join(directory, "plugins"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if ((await readlink(join(directory, "plugins"))) !== join(sourceHome, "plugins"))
		throw new Error("Codex 初始化快照的插件来源桥接不符。");
	const fields = await projectCodexConfigurationFields({
		home: directory,
		sourceHome,
		fileNames: Object.keys(snapshot.configurationFiles).filter((name) => name.endsWith(".toml")),
		previousFields: source?.fields,
		onHookDefinitionObservationProblem: () => {
			store.observationProblem = "部分初始 Hook 定义待核验，保留未知信任。";
		},
	});
	if (!source) {
		store.sources[sourceIdentity] = {
			home: sourceHome,
			version: store.revision,
			fields,
			observedUserFields: structuredClone(fields),
		};
	}
	const initializedSource = store.sources[sourceIdentity];
	if (!initializedSource) throw new Error("Codex 初始化来源尚未持久恢复。");
	if (!reference) {
		initializedSource.configurationInitialization = {
			status: "snapshot_persisted",
			snapshotFilePath,
			snapshotDigest: configurationDigest(snapshot),
			capturedAtMs: snapshot.capturedAtMs,
		};
		store.revision++;
	}
	return {
		directory,
		agentConfigurationFiles: snapshot.agentConfigurationFiles ?? {},
		source: initializedSource,
		fieldKeys: Object.keys(fields),
		fileNames: Object.keys(snapshot.configurationFiles).filter((name) => name.endsWith(".toml")),
	};
}
