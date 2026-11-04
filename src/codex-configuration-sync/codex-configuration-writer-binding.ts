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
} from "../codex-conversation-storage/codex-conversation-storage-home";
import {
	type CodexDirectoryIdentityExpectation,
	prepareCodexDirectoryVolumeObservations,
	prepareCodexPersistentDirectoryIdentity,
} from "../codex-conversation-storage/codex-persistent-directory-identity";
import {
	type CodexConfigurationWriterBinding,
	codexConfigurationWriterBindingSchema,
} from "../core/codex-configuration-sync-contract";
import { resolveCodexNativeDefaultReasoningEffortForModel } from "../terminal/terminal-agent-model-selection";
import {
	type CodexConfigurationFields,
	configurationDigest,
	configurationFieldAddress,
	configurationTable,
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
	codexConfigurationExceptionGroup,
	ensureCodexConfigurationSourceProfile,
	getCodexConfigurationWriterProfile,
	reuseConfirmedCodexHookTrust,
} from "./codex-configuration-profiles";
import {
	type CodexConfigurationSyncStore,
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "./codex-configuration-sync-store";
import {
	assertCodexSourceSharedPluginInstallationDirectoriesBinding,
	linkCodexSourceSharedPluginInstallationDirectories,
	prepareCodexSourceSharedPluginInstallationDirectoriesBinding,
} from "./codex-source-shared-plugin-installation-directories";

const execFileAsync = promisify(execFile);
export async function codexDirectoryIdentity(path: string, expectation?: CodexDirectoryIdentityExpectation) {
	return prepareCodexPersistentDirectoryIdentity(path, expectation);
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

async function assertCodexConfigurationWriterBindingManifest(binding: CodexConfigurationWriterBinding) {
	codexConfigurationWriterBindingSchema.parse(binding);
	const expectedHome = await realpath(
		join(getCodexConfigurationSyncDirectory(), "writers", binding.writerId, "configuration-home"),
	);
	if (binding.configurationHomeDirectoryPath !== expectedHome || (await lstat(expectedHome)).isSymbolicLink())
		throw new Error("Codex 配置写入者目录身份不符，未写入配置。");
	const manifestPath = join(dirname(expectedHome), "writer-binding.json");
	if (!(await lstat(manifestPath)).isFile()) throw new Error("Codex 配置写入者清单不是普通文件。");
	const manifest = codexConfigurationWriterBindingSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
	if (configurationDigest(manifest) !== configurationDigest(binding))
		throw new Error("Codex 配置写入者清单与会话绑定不符。");
	return { expectedHome, manifestPath };
}

export async function resolveVerifiedCodexConfigurationSourceIdentity(
	sourceHome: string,
	store: Pick<CodexConfigurationSyncStore, "sources" | "writers"> &
		Partial<Pick<CodexConfigurationSyncStore, "legacySessionProfileAdoptions">>,
	expectedSourceIdentity?: string,
) {
	const canonicalSourceHome = await realpath(sourceHome);
	const registeredSourceIdentities = Object.entries(store.sources)
		.filter(([identity, source]) =>
			expectedSourceIdentity ? identity === expectedSourceIdentity : source.home === canonicalSourceHome,
		)
		.map(([identity]) => identity);
	if (!registeredSourceIdentities.length && !expectedSourceIdentity) return codexDirectoryIdentity(sourceHome);
	// 来源归属只依赖原清单和来源指纹；退休、辅助 writer 或无关的旧历史桥接均不改变来源资格。
	const candidates = Object.values(store.writers)
		.map((writer) => writer.binding)
		.filter((binding) => registeredSourceIdentities.includes(binding.sourceIdentity))
		.sort((left, right) => left.createdAt - right.createdAt);
	for (const binding of candidates) {
		try {
			if ((await realpath(binding.sourceHomeDirectoryPath)) !== canonicalSourceHome) continue;
			if (store.sources[binding.sourceIdentity]?.home !== canonicalSourceHome) continue;
			const { manifestPath } = await assertCodexConfigurationWriterBindingManifest(binding);
			return await codexDirectoryIdentity(sourceHome, {
				expectedIdentity: binding.sourceIdentity,
				boundAtMs: binding.createdAt,
				legacyBindingManifestPath: manifestPath,
			});
		} catch {
			// 一份旧 writer 损坏不否定其他可独立核验的同来源绑定。
		}
	}
	for (const sourceIdentity of registeredSourceIdentities) {
		if (
			Object.values(store.legacySessionProfileAdoptions ?? {}).some(
				(adoption) => adoption.sourceIdentity === sourceIdentity,
			)
		)
			return codexDirectoryIdentity(sourceHome, { expectedIdentity: sourceIdentity });
	}
	throw new Error("Codex 配置来源缺少可核验的原绑定证据，恢复原清单或目录后自动重试。");
}

export async function assertCodexConfigurationWriterBindingIdentity(binding: CodexConfigurationWriterBinding) {
	const { expectedHome, manifestPath } = await assertCodexConfigurationWriterBindingManifest(binding);
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
	// 清单和桥接先通过核验，设备号漂移才有资格追加身份补证。
	for (const [path, expectedIdentity] of [
		[binding.sourceHomeDirectoryPath, binding.sourceIdentity],
		[binding.conversationStorageHomeDirectoryPath, binding.storageDirectoryIdentity],
		[binding.sqliteHomeDirectoryPath, binding.sqliteDirectoryIdentity],
	] as const)
		await codexDirectoryIdentity(path, {
			expectedIdentity,
			boundAtMs: binding.createdAt,
			legacyBindingManifestPath: manifestPath,
		});
	await assertCodexSourceSharedPluginInstallationDirectoriesBinding(binding);
}

function readCodexLaunchExceptionSelections(arguments_: string[], fields: CodexConfigurationFields) {
	let model: string | undefined,
		effort: string | undefined,
		profileName: string | undefined,
		modelFlag: string | undefined;
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index];
		if (!argument) continue;
		if (argument === "--") break;
		if (["--model", "-m"].includes(argument)) {
			modelFlag = arguments_[++index];
			continue;
		}
		if (["--profile", "-p"].includes(argument)) {
			profileName = arguments_[++index];
			continue;
		}
		if (argument.startsWith("--model=")) {
			modelFlag = argument.slice(8);
			continue;
		}
		if (argument.startsWith("--profile=")) {
			profileName = argument.slice(10);
			continue;
		}
		const override =
			argument === "-c" || argument === "--config"
				? arguments_[++index]
				: argument.startsWith("--config=")
					? argument.slice(9)
					: argument.startsWith("-c")
						? argument.slice(2).replace(/^=/, "")
						: undefined;
		if (!override) continue;
		try {
			const configuration = parse(override);
			if (typeof configuration.model === "string") model = configuration.model;
			if (typeof configuration.model_reasoning_effort === "string") effort = configuration.model_reasoning_effort;
		} catch {
			/* 无法核验的参数留给原生命令解析，不猜测局部选择。 */
		}
	}
	const profileField = (key: string) =>
		profileName
			? (fields[JSON.stringify([`${profileName}.config.toml`, key])]?.value ??
				fields[JSON.stringify(["config.toml", "profiles", profileName, key])]?.value)
			: undefined;
	const profileModel = profileField("model"),
		profileEffort = profileField("model_reasoning_effort");
	return {
		model: modelFlag ?? model ?? (typeof profileModel === "string" ? profileModel : undefined),
		effort: effort ?? (typeof profileEffort === "string" ? profileEffort : undefined),
	};
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
	workingDirectory?: string;
	nativeLaunchArguments?: string[];
	codexConfigurationProfileId?: string;
	sessionModelId?: string;
	sessionReasoningEffortOverride?: string;
	allowTaskReasoningEffortFeedback?: boolean;
	/** profile 没有 model_reasoning_effort 时，模型目录给出的原生默认档。传入后不再探测目录。 */
	nativeDefaultReasoningEffort?: string;
	sessionPermissionMode?: string;
	sessionPermissionSelectionSource?: "profile" | "task_local";
}): Promise<CodexConfigurationWriterBinding> {
	const preflightStoreSnapshot = await readCodexConfigurationSyncStore();
	const preflightParentBinding =
		input.previousBinding ??
		Object.values(preflightStoreSnapshot.writers).find(
			(writer) => writer.binding.configurationHomeDirectoryPath === resolve(input.storageHome),
		)?.binding;
	if (preflightParentBinding) await assertCodexConfigurationWriterBindingIdentity(preflightParentBinding);
	const preflightHistoryHome = preflightParentBinding?.conversationStorageHomeDirectoryPath ?? input.storageHome;
	await mkdir(preflightHistoryHome, { recursive: true, mode: 0o700 });
	const preflightSourceHome =
		preflightParentBinding?.sourceHomeDirectoryPath ??
		(await resolveCanonicalUserCodexHomeForManagedStorage(preflightHistoryHome));
	await mkdir(preflightSourceHome, { recursive: true, mode: 0o700 });
	const preflightSqliteHome =
		preflightParentBinding?.sqliteHomeDirectoryPath ?? input.sqliteHome ?? preflightHistoryHome;
	await mkdir(preflightSqliteHome, { recursive: true, mode: 0o700 });
	await prepareCodexDirectoryVolumeObservations([preflightSourceHome, preflightHistoryHome, preflightSqliteHome]);
	let nativeBinaryVersion: string | null = null;
	let nativeExecutableRealPath: string | null = null;
	let nativeExecutableIdentityDigest: string | null = null;
	if (input.binary)
		try {
			const environment = input.environment ?? process.env;
			for (const candidate of isAbsolute(input.binary) || input.binary.includes("/")
				? [input.binary]
				: (environment.PATH ?? "").split(delimiter).map((directory) => join(directory, input.binary ?? "codex"))) {
				try {
					nativeExecutableRealPath = await realpath(resolve(input.workingDirectory ?? process.cwd(), candidate));
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
					cwd: input.workingDirectory,
					timeout: 3_000,
					maxBuffer: 4_096,
				})
			).stdout.trim();
		} catch {
			/* 未核验版本不声明原生重载。 */
		}
	const preflightSourceIdentity = await resolveVerifiedCodexConfigurationSourceIdentity(
		preflightSourceHome,
		preflightStoreSnapshot,
		preflightParentBinding?.sourceIdentity,
	);
	const sourceSharedPluginInstallationDirectoriesBinding =
		nativeBinaryVersion === "codex-cli 0.166.0" && nativeExecutableRealPath && nativeExecutableIdentityDigest
			? await prepareCodexSourceSharedPluginInstallationDirectoriesBinding({
					sourceHome: preflightSourceHome,
					existingBindings: Object.values(preflightStoreSnapshot.writers)
						.filter((writer) => writer.binding.sourceIdentity === preflightSourceIdentity)
						.map((writer) => writer.binding),
					nativeCapabilityEvidence: {
						nativeBinaryVersion,
						nativeExecutableRealPath,
						nativeExecutableIdentityDigest,
						observedAtMs: Date.now(),
					},
				})
			: undefined;
	// 锁外预取只提供观察；下方持锁后重新选择 parent，并完整重核验当前归属。
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
		const sourceIdentity = await resolveVerifiedCodexConfigurationSourceIdentity(
			sourceHome,
			store,
			parent?.sourceIdentity,
		);
		const canonicalSourceHome = await realpath(sourceHome);
		if (sourceIdentity !== preflightSourceIdentity || canonicalSourceHome !== (await realpath(preflightSourceHome)))
			throw new Error("Codex 插件来源在锁外预取后已变化，等待来源稳定后自动重试。");
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
		const sourceProfile = ensureCodexConfigurationSourceProfile(store, sourceIdentity);
		const selectedProfileId =
			input.codexConfigurationProfileId ??
			previous?.codexConfigurationProfileId ??
			(store.profiles[store.defaultCodexConfigurationProfileId ?? ""]?.sourceIdentity === sourceIdentity
				? store.defaultCodexConfigurationProfileId
				: null) ??
			sourceProfile.profileId;
		const selectedProfile = store.profiles[selectedProfileId];
		if (!selectedProfile || selectedProfile.sourceIdentity !== sourceIdentity)
			throw new Error("所选 Codex profile 不属于当前配置来源，未改变存储或认证归属。");
		if (previous) getCodexConfigurationWriterProfile(store, previous);
		if (previous && input.purpose === "native_session") {
			const local = await projectCodexConfigurationFields({
				home: parent.configurationHomeDirectoryPath,
				sourceHome: canonicalSourceHome,
				fileNames: previous.fileNames,
				previousFields: previous.lastObservedFields,
				onHookDefinitionObservationProblem,
			});
			mergeObservedCodexConfigurationWriter(store, previous, local, true);
		}
		const selectedLocalExceptions =
			previous?.codexConfigurationProfileId === selectedProfileId
				? structuredClone(previous.localExceptionOverrides ?? {})
				: {};
		const launchSelectionFields: CodexConfigurationFields = {};
		const legacySelection = previous?.legacyLaunchExceptionSelectionAtMigration;
		const canPreserveLegacyGroup = (group: "model" | "reasoning_effort" | "permissions") =>
			legacySelection?.profileId === selectedProfileId &&
			!Object.entries(selectedProfile.fieldVersions).some(
				([key, version]) =>
					codexConfigurationExceptionGroup(key) === group && version > legacySelection.profileVersion,
			);
		const observedGroupChangedAfterLaunch = (group: "model" | "reasoning_effort" | "permissions") =>
			previous &&
			[
				...new Set([...Object.keys(previous.lastObservedFields), ...Object.keys(previous.launchBaselineFields)]),
			].some(
				(key) =>
					codexConfigurationExceptionGroup(key) === group &&
					!sameConfigurationField(previous.lastObservedFields[key], previous.launchBaselineFields[key]),
			);
		const argumentSelections = readCodexLaunchExceptionSelections(
			input.nativeLaunchArguments ?? [],
			previous?.lastObservedFields ?? selectedProfile.fields,
		);
		const modelSelection = input.sessionModelId ?? argumentSelections.model;
		if (
			modelSelection &&
			(!previous ||
				(!legacySelection &&
					input.sessionModelId !== undefined &&
					input.sessionModelId !== previous.taskModelSelectionAtLaunch) ||
				(canPreserveLegacyGroup("model") && !observedGroupChangedAfterLaunch("model")))
		) {
			launchSelectionFields[JSON.stringify(["config.toml", "model"])] = { value: modelSelection };
			selectedLocalExceptions.model = {
				profileVersionAtSelection: selectedProfile.version,
				fields: {
					...selectedLocalExceptions.model?.fields,
					[JSON.stringify(["config.toml", "model"])]: { value: modelSelection },
				},
			};
		}
		const taskReasoningEffortSelectionChanged =
			input.sessionReasoningEffortOverride !== previous?.taskReasoningEffortSelectionAtLaunch;
		if (previous && taskReasoningEffortSelectionChanged) {
			delete previous.localExceptionOverrides?.reasoning_effort;
			delete selectedLocalExceptions.reasoning_effort;
		}
		const effortSelection = input.sessionReasoningEffortOverride ?? argumentSelections.effort;
		if (
			effortSelection &&
			(!previous ||
				taskReasoningEffortSelectionChanged ||
				(canPreserveLegacyGroup("reasoning_effort") && !observedGroupChangedAfterLaunch("reasoning_effort")))
		) {
			const key = JSON.stringify(["config.toml", "model_reasoning_effort"]);
			launchSelectionFields[key] = { value: effortSelection };
			selectedLocalExceptions.reasoning_effort = {
				profileVersionAtSelection: selectedProfile.version,
				fields: {
					...selectedLocalExceptions.reasoning_effort?.fields,
					[key]: { value: effortSelection },
				},
			};
		}
		if (
			input.sessionPermissionSelectionSource === "profile" &&
			previous &&
			previous.taskPermissionSelectionSourceAtLaunch !== "profile"
		) {
			delete previous.localExceptionOverrides?.permissions;
			delete selectedLocalExceptions.permissions;
		}
		if (
			input.sessionPermissionMode &&
			input.sessionPermissionSelectionSource !== "profile" &&
			!(
				legacySelection?.profileId === selectedProfileId &&
				(!canPreserveLegacyGroup("permissions") || observedGroupChangedAfterLaunch("permissions"))
			) &&
			(!previous ||
				previous.taskPermissionModeSelectionAtLaunch !== input.sessionPermissionMode ||
				previous.taskPermissionSelectionSourceAtLaunch !== input.sessionPermissionSelectionSource)
		) {
			const approvalKey = JSON.stringify(["config.toml", "approval_policy"]);
			const sandboxKey = JSON.stringify(["config.toml", "sandbox_mode"]);
			const profileMode =
				selectedProfile.fields[approvalKey]?.value === "never" &&
				selectedProfile.fields[sandboxKey]?.value === "danger-full-access"
					? "bypass_all_permission_prompts"
					: "ask_for_every_tool_use";
			if (
				input.sessionPermissionSelectionSource === "task_local" ||
				!selectedProfile.fields[approvalKey] ||
				!selectedProfile.fields[sandboxKey] ||
				input.sessionPermissionMode !== profileMode
			) {
				const permissionFields = {
					[approvalKey]: {
						value: input.sessionPermissionMode === "bypass_all_permission_prompts" ? "never" : "untrusted",
					},
					[sandboxKey]: {
						value:
							input.sessionPermissionMode === "bypass_all_permission_prompts"
								? "danger-full-access"
								: "workspace-write",
					},
				};
				Object.assign(launchSelectionFields, permissionFields);
				selectedLocalExceptions.permissions = {
					profileVersionAtSelection: selectedProfile.version,
					fields: permissionFields,
				};
			}
		}
		const writerId = randomUUID();
		const writerDirectory = join(getCodexConfigurationSyncDirectory(), "writers", writerId);
		await mkdir(join(writerDirectory, "configuration-home"), { recursive: true, mode: 0o700 });
		const configurationHome = await realpath(join(writerDirectory, "configuration-home"));
		const copyFrom = parent?.configurationHomeDirectoryPath ?? sourceHome;
		const sharedFileNames = Object.keys(selectedProfile.fields).map((key) => configurationFieldAddress(key).fileName);
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
		for (const name of ["auth.json", ".credentials.json", "AGENTS.md", "skills", "rules", "prompts", "marketplaces"])
			await linkVerifiedDirectoryBridge(join(sourceHome, name), join(configurationHome, name), false);
		if (sourceSharedPluginInstallationDirectoriesBinding)
			await linkCodexSourceSharedPluginInstallationDirectories(
				sourceHome,
				configurationHome,
				sourceSharedPluginInstallationDirectoriesBinding,
			);
		else await linkVerifiedDirectoryBridge(join(sourceHome, "plugins"), join(configurationHome, "plugins"), false);
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
				const source = {
					observedUserFields: store.sources[sourceIdentity].observedUserFields,
					fields: selectedProfile.fields,
				};
				for (const fieldKey of new Set([
					...Object.keys(source.observedUserFields),
					...Object.keys(source.fields),
				])) {
					const address = configurationFieldAddress(fieldKey);
					if (address.fileName === fileName)
						setConfigurationField(configuration, address.keyPath, source.fields[fieldKey]);
				}
			}
			if (previous) {
				// 休眠副本先追上 profile；仅保留尚未被对应字段的新版本取代的局部例外。
				for (const fieldKey of new Set([
					...Object.keys(previous.lastObservedFields),
					...Object.keys(selectedProfile.fields),
					...Object.keys(selectedProfile.fieldVersions),
				])) {
					const address = configurationFieldAddress(fieldKey);
					if (address.fileName !== fileName) continue;
					const group = codexConfigurationExceptionGroup(fieldKey);
					const local = group && previous.localExceptionOverrides?.[group];
					const groupWasExplicitlyUpdated =
						local &&
						Object.keys(selectedProfile.fieldVersions).some(
							(key) =>
								codexConfigurationExceptionGroup(key) === group &&
								(selectedProfile.fieldVersions[key] ?? 0) > local.profileVersionAtSelection,
						);
					if (
						local &&
						previous.codexConfigurationProfileId === selectedProfileId &&
						!groupWasExplicitlyUpdated &&
						(fieldKey in local.fields || local.deletedFieldKeys?.includes(fieldKey))
					) {
						setConfigurationField(configuration, address.keyPath, local.fields[fieldKey]);
						continue;
					}
					setConfigurationField(configuration, address.keyPath, selectedProfile.fields[fieldKey]);
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
						change.codexConfigurationProfileId ||
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
			for (const [fieldKey, field] of Object.entries(launchSelectionFields)) {
				const address = configurationFieldAddress(fieldKey);
				if (address.fileName === fileName) setConfigurationField(configuration, address.keyPath, field);
			}
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
		// 定义变化时移除过期信任；明确禁用仍保留，避免原生缺省重新启用。
		for (const [fieldKey, field] of Object.entries(selectedProfile.fields)) {
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
			setConfigurationField(
				configuration,
				address.keyPath,
				configurationTable(field.value) && field.value.enabled === false
					? { value: { enabled: false } }
					: undefined,
			);
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
		for (const [fieldKey, field] of Object.entries(baseline)) {
			const trusted = reuseConfirmedCodexHookTrust(store, sourceIdentity, fieldKey, field);
			if (sameConfigurationField(trusted, field)) continue;
			const address = configurationFieldAddress(fieldKey);
			const filePath = join(configurationHome, address.fileName);
			const configuration = parse(await readFile(filePath, "utf8"));
			relocateCodexHookStateSourcePaths(configuration, configurationHome, canonicalSourceHome);
			setConfigurationField(configuration, address.keyPath, trusted);
			relocateCodexHookStateSourcePaths(configuration, canonicalSourceHome, configurationHome);
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
			...(sourceSharedPluginInstallationDirectoriesBinding
				? { sourceSharedPluginInstallationDirectoriesBinding }
				: {
						sourceSharedPluginInstallationDirectoriesCompatibilityObservation: {
							status: "unverified_native_capability",
							nativeBinaryVersion,
							nativeExecutableRealPath,
							automaticRecheckCondition: "next_native_process_generation",
						},
					}),
			storageDirectoryIdentity: await codexDirectoryIdentity(historyHome),
			sqliteDirectoryIdentity: await codexDirectoryIdentity(sqliteHome),
			launchConfigurationDigest: configurationDigest(baseline),
			launchSharedVersion: selectedProfile.version,
			codexConfigurationProfileId: selectedProfileId,
			createdAt: Date.now(),
		});
		await writeFile(join(writerDirectory, "writer-binding.json"), JSON.stringify(binding), {
			mode: 0o600,
			flag: "wx",
		});
		let taskReasoningEffortFeedbackSelection =
			input.allowTaskReasoningEffortFeedback &&
			input.sessionReasoningEffortOverride &&
			previous?.taskReasoningEffortFeedbackSelection?.effort === input.sessionReasoningEffortOverride &&
			previous.taskReasoningEffortFeedbackSelection.profileId === selectedProfileId
				? structuredClone(previous.taskReasoningEffortFeedbackSelection)
				: undefined;
		const profileReasoningEffort =
			selectedProfile.fields[JSON.stringify(["config.toml", "model_reasoning_effort"])]?.value;
		const profileModel = selectedProfile.fields[JSON.stringify(["config.toml", "model"])]?.value;
		let inheritedReasoningEffort = typeof profileReasoningEffort === "string" ? profileReasoningEffort : undefined;
		if (
			inheritedReasoningEffort === undefined &&
			input.allowTaskReasoningEffortFeedback &&
			input.sessionReasoningEffortOverride &&
			!taskReasoningEffortFeedbackSelection
		) {
			try {
				inheritedReasoningEffort =
					input.nativeDefaultReasoningEffort ??
					(await resolveCodexNativeDefaultReasoningEffortForModel(
						input.sessionModelId ?? (typeof profileModel === "string" ? profileModel : undefined),
					));
			} catch {
				inheritedReasoningEffort = input.nativeDefaultReasoningEffort;
			}
		}
		if (
			input.allowTaskReasoningEffortFeedback &&
			input.sessionReasoningEffortOverride &&
			!taskReasoningEffortFeedbackSelection &&
			inheritedReasoningEffort !== input.sessionReasoningEffortOverride
		) {
			taskReasoningEffortFeedbackSelection = {
				selectionId: randomUUID(),
				profileId: selectedProfileId,
				profileVersionAtSelection: selectedProfile.version,
				effort: input.sessionReasoningEffortOverride,
				inheritedFields: structuredClone(
					Object.fromEntries(
						Object.entries(selectedProfile.fields).filter(
							([key]) => codexConfigurationExceptionGroup(key) === "reasoning_effort",
						),
					),
				),
			};
		}
		store.writers[writerId] = {
			taskReasoningEffortSelectionAtLaunch: input.sessionReasoningEffortOverride,
			taskReasoningEffortFeedbackSelection,
			taskModelSelectionAtLaunch: input.sessionModelId,
			taskPermissionModeSelectionAtLaunch: input.sessionPermissionMode,
			taskPermissionSelectionSourceAtLaunch: input.sessionPermissionSelectionSource,
			codexConfigurationProfileId: selectedProfileId,
			consumedProfileFieldVersions: structuredClone(selectedProfile.fieldVersions),
			localExceptionOverrides: selectedLocalExceptions,
			binding,
			fileNames,
			launchBaselineFields: structuredClone(baseline),
			mergeBaselineFields: baseline,
			lastObservedFields: structuredClone(baseline),
			overrideKeyPaths: [],
			nativeBinaryVersion,
			nativeExecutableRealPath,
			nativeExecutableIdentityDigest,
			...(input.purpose === "native_session" &&
			input.workspaceId &&
			input.conversationSessionId &&
			!selectedLocalExceptions.permissions
				? {
						pendingSessionProfileBinding: {
							workspaceId: input.workspaceId,
							conversationSessionId: input.conversationSessionId,
							profileId: selectedProfileId,
							onlyUpdatePermissionSelectionSource: true,
						},
					}
				: {}),
		};
		if (previous && input.purpose === "native_session") previous.retiredAt = Date.now();
		store.revision++;
		return binding;
	});
}

export function buildCodexConfigurationWriterEnvironment(binding: CodexConfigurationWriterBinding) {
	return { CODEX_HOME: binding.configurationHomeDirectoryPath, CODEX_SQLITE_HOME: binding.sqliteHomeDirectoryPath };
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
