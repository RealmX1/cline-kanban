import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "smol-toml";
import {
	preserveCodexConfigurationSourceFileResolution,
	resolveCanonicalUserCodexHomeForManagedStorage,
	resolveUserCodexHomeDirectoryPath,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import {
	type CodexConfigurationWriterBinding,
	codexConfigurationWriterBindingSchema,
} from "../core/codex-configuration-sync-contract";
import {
	configurationDigest,
	configurationFieldAddress,
	projectCodexConfigurationFields,
	relocateCodexHookStateSourcePaths,
	sameConfigurationField,
	setConfigurationField,
} from "./codex-configuration-field-projection";
import {
	mergeObservedCodexConfigurationWriter,
	reconcileCodexConfigurationUserSourceFields,
} from "./codex-configuration-incremental-merge";
import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "./codex-configuration-sync-store";

const execFileAsync = promisify(execFile);
export async function codexDirectoryIdentity(path: string) {
	const physicalPath = await realpath(path);
	const metadata = await lstat(physicalPath, { bigint: true });
	if (!metadata.isDirectory()) throw new Error("Codex 目录归属不再是目录。");
	return configurationDigest([physicalPath, `${metadata.dev}`, `${metadata.ino}`]);
}

async function linkVerifiedDirectoryBridge(source: string, destination: string, directory: boolean) {
	if (directory) await mkdir(source, { recursive: true, mode: 0o700 });
	let metadata: Stats;
	try {
		metadata = await lstat(source);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (directory && metadata.isSymbolicLink()) throw new Error("Codex 历史或写锁目录包含未绑定软链，保留现场。");
	await symlink(source, destination, directory ? "junction" : "file");
}

export async function assertCodexConfigurationWriterBindingIdentity(binding: CodexConfigurationWriterBinding) {
	codexConfigurationWriterBindingSchema.parse(binding);
	const expectedHome = await realpath(
		join(getCodexConfigurationSyncDirectory(), "writers", binding.writerId, "configuration-home"),
	);
	if (binding.configurationHomeDirectoryPath !== expectedHome || (await lstat(expectedHome)).isSymbolicLink())
		throw new Error("Codex 配置写入者目录身份不符，未写入配置。");
	if (
		(await codexDirectoryIdentity(binding.sourceHomeDirectoryPath)) !== binding.sourceIdentity ||
		(await codexDirectoryIdentity(binding.conversationStorageHomeDirectoryPath)) !==
			binding.storageDirectoryIdentity ||
		(await codexDirectoryIdentity(binding.sqliteHomeDirectoryPath)) !== binding.sqliteDirectoryIdentity
	)
		throw new Error("Codex 配置来源或历史目录已被替换，等待原归属恢复。");
	const manifest = codexConfigurationWriterBindingSchema.parse(
		JSON.parse(await readFile(join(dirname(expectedHome), "writer-binding.json"), "utf8")),
	);
	if (configurationDigest(manifest) !== configurationDigest(binding))
		throw new Error("Codex 配置写入者清单与会话绑定不符。");
	if (!(await lstat(join(expectedHome, "config.toml"))).isFile())
		throw new Error("Codex 主配置暂不可读，等待原生所有者恢复；未把缺失文件当作明确删除。");
	for (const name of (await readdir(expectedHome)).filter(
		(name) => name === "config.toml" || name.endsWith(".config.toml"),
	)) {
		if (!(await lstat(join(expectedHome, name))).isFile())
			throw new Error("Codex 独立配置文件被替换为软链或非普通文件。");
	}
	for (const name of ["sessions", "archived_sessions", "thread-writer-locks"]) {
		const path = join(expectedHome, name);
		if (
			!(await lstat(path)).isSymbolicLink() ||
			resolve(dirname(path), await readlink(path)) !== join(binding.conversationStorageHomeDirectoryPath, name)
		)
			throw new Error("Codex 历史或原生写锁桥接被替换，保留现场。");
	}
}

export async function prepareCodexConfigurationWriterBinding(input: {
	purpose: CodexConfigurationWriterBinding["purpose"];
	storageHome: string;
	sqliteHome?: string;
	workspaceId?: string;
	conversationSessionId?: string;
	runtimeSessionIncarnationId: string;
	previousBinding?: CodexConfigurationWriterBinding | null;
	binary?: string;
	environment?: NodeJS.ProcessEnv;
	launchArguments?: string[];
}): Promise<CodexConfigurationWriterBinding> {
	return mutateCodexConfigurationSyncStore(async (store) => {
		const parent =
			input.previousBinding ??
			Object.values(store.writers).find(
				(writer) => writer.binding.configurationHomeDirectoryPath === resolve(input.storageHome),
			)?.binding;
		if (parent) await assertCodexConfigurationWriterBindingIdentity(parent);
		const historyHome = parent?.conversationStorageHomeDirectoryPath ?? input.storageHome;
		await mkdir(historyHome, { recursive: true, mode: 0o700 });
		const sourceHome =
			parent?.sourceHomeDirectoryPath ?? (await resolveCanonicalUserCodexHomeForManagedStorage(historyHome));
		await mkdir(sourceHome, { recursive: true, mode: 0o700 });
		const sourceIdentity = await codexDirectoryIdentity(sourceHome);
		const canonicalSourceHome = await realpath(sourceHome);
		const onHookDefinitionObservationProblem = () => {
			store.observationProblem = "部分 hook 来源或定义暂不可核验；保留既有决定，恢复后自动补扫。";
		};
		const sourceFileNames = [
			"config.toml",
			...(await readdir(sourceHome)).filter((name) => /^[\w.-]+\.config\.toml$/.test(name)),
		];
		const userFields = await projectCodexConfigurationFields({
			home: sourceHome,
			sourceHome: canonicalSourceHome,
			fileNames: sourceFileNames,
			previousFields: store.sources[sourceIdentity]?.observedUserFields,
			onHookDefinitionObservationProblem,
		});
		store.sources[sourceIdentity] ??= {
			home: canonicalSourceHome,
			version: store.revision,
			fields: structuredClone(userFields),
			observedUserFields: userFields,
		};
		reconcileCodexConfigurationUserSourceFields(store, sourceIdentity, userFields);
		const previous = parent && store.writers[parent.writerId];
		if (previous && input.purpose === "native_session") {
			const local = await projectCodexConfigurationFields({
				home: parent.configurationHomeDirectoryPath,
				sourceHome: canonicalSourceHome,
				fileNames: previous.fileNames,
				previousFields: previous.lastObservedFields,
				onHookDefinitionObservationProblem,
			});
			mergeObservedCodexConfigurationWriter(store, previous, local);
		}
		const writerId = randomUUID();
		const writerDirectory = join(getCodexConfigurationSyncDirectory(), "writers", writerId);
		await mkdir(join(writerDirectory, "configuration-home"), { recursive: true, mode: 0o700 });
		const configurationHome = await realpath(join(writerDirectory, "configuration-home"));
		const copyFrom = parent?.configurationHomeDirectoryPath ?? sourceHome;
		const sharedFileNames = Object.keys(store.sources[sourceIdentity].fields).map(
			(key) => configurationFieldAddress(key).fileName,
		);
		const fileNames = [
			...new Set([
				...sourceFileNames,
				...(previous?.fileNames ?? []),
				...sharedFileNames,
				...(await readdir(copyFrom)).filter((name) => /^[\w.-]+\.config\.toml$/.test(name)),
			]),
		];
		const sqliteHome = parent?.sqliteHomeDirectoryPath ?? input.sqliteHome ?? historyHome;
		await mkdir(sqliteHome, { recursive: true, mode: 0o700 });
		for (const name of ["sessions", "archived_sessions", "thread-writer-locks", "shell_snapshots", "memories"])
			await linkVerifiedDirectoryBridge(join(historyHome, name), join(configurationHome, name), true);
		for (const name of ["history.jsonl", "session_index.jsonl"]) {
			try {
				await writeFile(join(historyHome, name), "", { flag: "wx", mode: 0o600 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			await linkVerifiedDirectoryBridge(join(historyHome, name), join(configurationHome, name), false);
		}
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
			await linkVerifiedDirectoryBridge(join(sourceHome, name), join(configurationHome, name), false);
		try {
			await writeFile(join(configurationHome, "hooks.json"), await readFile(join(copyFrom, "hooks.json")), {
				mode: 0o600,
				flag: "wx",
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const fileName of fileNames) {
			let text = "";
			try {
				text = await readFile(join(copyFrom, fileName), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const configuration = parse(text);
			if (configuration.cli_auth_credentials_store === "keyring")
				throw new Error("当前 Codex 认证使用 keyring，配置隔离尚未核验此认证归属。");
			relocateCodexHookStateSourcePaths(configuration, await realpath(copyFrom), canonicalSourceHome);
			if (!parent) {
				const source = store.sources[sourceIdentity];
				for (const fieldKey of new Set([
					...Object.keys(source.observedUserFields),
					...Object.keys(source.fields),
				])) {
					const address = configurationFieldAddress(fieldKey);
					if (address.fileName === fileName)
						setConfigurationField(configuration, address.keyPath, source.fields[fieldKey]);
				}
			}
			if (parent && previous && input.purpose === "native_session") {
				for (const change of store.changes) {
					const pendingTarget = change.targets.find(
						(target) =>
							target.writerId === parent.writerId &&
							["accepted", "pending_reload", "pending_next_start"].includes(target.status),
					);
					if (
						!pendingTarget ||
						!sameConfigurationField(store.sources[sourceIdentity].fields[change.fieldKey], change.value)
					)
						continue;
					if (
						!sameConfigurationField(
							previous.lastObservedFields[change.fieldKey],
							previous.mergeBaselineFields[change.fieldKey],
						) &&
						!sameConfigurationField(previous.lastObservedFields[change.fieldKey], change.value)
					)
						continue;
					const address = configurationFieldAddress(change.fieldKey);
					if (address.fileName === fileName) setConfigurationField(configuration, address.keyPath, change.value);
				}
			}
			configuration.sqlite_home = sqliteHome;
			preserveCodexConfigurationSourceFileResolution(
				configuration,
				await realpath(dirname(join(copyFrom, fileName))),
			);
			relocateCodexHookStateSourcePaths(configuration, canonicalSourceHome, await realpath(configurationHome));
			await writeFile(join(configurationHome, fileName), stringify(configuration), { mode: 0o600, flag: "wx" });
		}
		let baseline = await projectCodexConfigurationFields({
			home: configurationHome,
			sourceHome: canonicalSourceHome,
			fileNames,
			previousFields: previous?.lastObservedFields ?? store.sources[sourceIdentity].fields,
			onHookDefinitionObservationProblem,
		});
		// 来源相同但定义已变时丢弃共享的信任记录，让原生审查重新决定。
		for (const [fieldKey, field] of Object.entries(store.sources[sourceIdentity].fields)) {
			if (
				!field.definitionDigest ||
				!baseline[fieldKey] ||
				baseline[fieldKey].definitionDigest === field.definitionDigest ||
				parent
			)
				continue;
			const address = configurationFieldAddress(fieldKey);
			const filePath = join(configurationHome, address.fileName);
			const configuration = parse(await readFile(filePath, "utf8"));
			relocateCodexHookStateSourcePaths(configuration, await realpath(configurationHome), canonicalSourceHome);
			setConfigurationField(configuration, address.keyPath, undefined);
			relocateCodexHookStateSourcePaths(configuration, canonicalSourceHome, await realpath(configurationHome));
			await writeFile(filePath, stringify(configuration), { mode: 0o600 });
		}
		baseline = await projectCodexConfigurationFields({
			home: configurationHome,
			sourceHome: canonicalSourceHome,
			fileNames,
			previousFields: baseline,
			onHookDefinitionObservationProblem,
		});
		const binding = codexConfigurationWriterBindingSchema.parse({
			schemaVersion: 1,
			writerId,
			purpose: input.purpose,
			workspaceId: input.workspaceId ?? null,
			conversationSessionId: input.conversationSessionId ?? null,
			runtimeSessionIncarnationId: input.runtimeSessionIncarnationId,
			configurationHomeDirectoryPath: configurationHome,
			conversationStorageHomeDirectoryPath: historyHome,
			sqliteHomeDirectoryPath: sqliteHome,
			sourceHomeDirectoryPath: sourceHome,
			sourceIdentity,
			storageDirectoryIdentity: await codexDirectoryIdentity(historyHome),
			sqliteDirectoryIdentity: await codexDirectoryIdentity(sqliteHome),
			launchConfigurationDigest: configurationDigest(baseline),
			launchSharedVersion: store.sources[sourceIdentity].version,
			createdAt: Date.now(),
		});
		await writeFile(join(writerDirectory, "writer-binding.json"), JSON.stringify(binding), {
			mode: 0o600,
			flag: "wx",
		});
		let nativeBinaryVersion: string | null = null;
		let nativeExecutableRealPath: string | null = null;
		let nativeExecutableIdentityDigest: string | null = null;
		if (input.binary)
			try {
				const environment = input.environment ?? process.env;
				for (const candidate of isAbsolute(input.binary)
					? [input.binary]
					: (environment.PATH ?? "")
							.split(delimiter)
							.map((directory) => join(directory, input.binary ?? "codex"))) {
					try {
						nativeExecutableRealPath = await realpath(candidate);
						const metadata = await lstat(nativeExecutableRealPath, { bigint: true });
						nativeExecutableIdentityDigest = configurationDigest([
							nativeExecutableRealPath,
							`${metadata.dev}`,
							`${metadata.ino}`,
							`${metadata.size}`,
							`${metadata.mtimeNs}`,
						]);
						break;
					} catch {
						/* 继续显式 PATH 查找，不启动交互 shell。 */
					}
				}
				nativeBinaryVersion = (
					await execFileAsync(input.binary, ["--version"], {
						env: input.environment,
						timeout: 3_000,
						maxBuffer: 4_096,
					})
				).stdout.trim();
			} catch {
				/* 未核验版本不声明原生重载。 */
			}
		store.writers[writerId] = {
			binding,
			fileNames,
			launchBaselineFields: structuredClone(baseline),
			mergeBaselineFields: baseline,
			lastObservedFields: structuredClone(baseline),
			overrideKeyPaths: [],
			nativeBinaryVersion,
			nativeExecutableRealPath,
			nativeExecutableIdentityDigest,
		};
		if (previous && input.purpose === "native_session") previous.retiredAt = Date.now();
		store.revision++;
		return binding;
	});
}

export function buildCodexConfigurationWriterEnvironment(binding: CodexConfigurationWriterBinding) {
	return { CODEX_HOME: binding.configurationHomeDirectoryPath, CODEX_SQLITE_HOME: binding.sqliteHomeDirectoryPath };
}

export async function prepareAuxiliaryCodexConfigurationEnvironment(environment: NodeJS.ProcessEnv, cwd: string) {
	const home = resolveUserCodexHomeDirectoryPath(environment, cwd);
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "auxiliary_process",
		storageHome: home,
		sqliteHome: environment.CODEX_SQLITE_HOME,
		runtimeSessionIncarnationId: randomUUID(),
	});
	return { ...environment, ...buildCodexConfigurationWriterEnvironment(binding) };
}

export async function recordCodexConfigurationWriterLaunchArguments(
	binding: CodexConfigurationWriterBinding,
	arguments_: string[],
) {
	await mutateCodexConfigurationSyncStore((store) => {
		const writer = store.writers[binding.writerId];
		if (!writer) throw new Error("Codex 配置启动绑定不存在。");
		const overrides: string[] = [];
		for (let index = 0; index < arguments_.length; index++) {
			const argument = arguments_[index];
			if (!argument) continue;
			if (argument === "--") break;
			if (["--enable", "--disable"].includes(argument)) {
				const feature = arguments_[++index];
				if (feature) overrides.push(`features.${feature}`);
				continue;
			}
			if (argument.startsWith("--enable=") || argument.startsWith("--disable=")) {
				overrides.push(`features.${argument.slice(argument.indexOf("=") + 1)}`);
				continue;
			}
			if (["--model", "-m"].includes(argument)) {
				overrides.push("model");
				index++;
				continue;
			}
			const value =
				argument === "-c" || argument === "--config"
					? arguments_[++index]
					: argument.startsWith("--config=")
						? argument.slice(9)
						: argument.startsWith("-c")
							? argument.slice(2)
							: undefined;
			if (value?.includes("=")) {
				// 运行时的 session-flags 信任只作用于注入的 hook，不是用户 hooks.state 的永久覆盖。
				if (value.startsWith("hooks.state=") && value.includes("<session-flags>")) continue;
				overrides.push(value.slice(0, value.indexOf("=")));
			}
		}
		writer.overrideKeyPaths = overrides;
	});
}

export async function findCodexConfigurationWriterByHome(home: string) {
	return Object.values((await readCodexConfigurationSyncStore()).writers).find(
		(writer) => resolve(writer.binding.configurationHomeDirectoryPath) === resolve(home),
	);
}
