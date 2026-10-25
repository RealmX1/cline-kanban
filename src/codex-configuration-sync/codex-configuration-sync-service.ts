import { type FSWatcher, watch } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	type CodexConfigurationResolveConflictRequest,
	type CodexConfigurationResolveTargetConflictRequest,
	type CodexConfigurationSynchronizeRequest,
	type CodexConfigurationSyncState,
	codexConfigurationSyncStateSchema,
} from "../core/codex-configuration-sync-contract";
import { resolveSessionFacets } from "../core/session-activity";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-control-socket-request-connection";
import type { CodexAppServerRequestPort } from "../rvf-automatic-closeout/codex-native-conversation-prefix";
import {
	type CodexConfigurationFields,
	configurationDigest,
	configurationFieldAddress,
	configurationTable,
	projectCodexConfigurationFields,
	readCodexHookDefinitionDigest,
	sameConfigurationField,
	summarizeConfigurationField,
} from "./codex-configuration-field-projection";
import {
	mergeObservedCodexConfigurationWriter,
	reconcileCodexConfigurationUserSourceFields,
} from "./codex-configuration-incremental-merge";
import {
	type CodexConfigurationSyncStore,
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
	type StoredCodexConfigurationChange,
} from "./codex-configuration-sync-store";
import {
	assertCodexConfigurationWriterBindingIdentity,
	codexDirectoryIdentity,
} from "./codex-configuration-writer-binding";

type SessionTarget = { workspaceId: string; summary: RuntimeTaskSessionSummary };
interface CodexConfigurationSyncServiceDependencies {
	listSessions: () => SessionTarget[];
	onUpdated: (revision: number) => void;
	withOwnerConnection?: <T>(
		summary: RuntimeTaskSessionSummary,
		operation: (port: CodexAppServerRequestPort) => Promise<T>,
	) => Promise<T>;
}

function publicState(store: CodexConfigurationSyncStore, sessions: SessionTarget[]): CodexConfigurationSyncState {
	return codexConfigurationSyncStateSchema.parse({
		revision: store.revision,
		observationProblem: store.observationProblem,
		changes: [...store.changes].reverse().map((change) => {
			const writer = store.writers[change.sourceWriterId];
			const { fileName, keyPath } = configurationFieldAddress(change.fieldKey);
			return {
				changeId: change.changeId,
				version: change.version,
				sourceWriterId: change.sourceWriterId,
				sourceConversationSessionId: writer?.binding.conversationSessionId ?? "用户全局配置",
				sourceWorkspaceId: writer?.binding.workspaceId ?? "",
				fieldLabel: keyPath.includes("state")
					? `${fileName} · hook ${keyPath.at(-1)?.split(":").slice(-3).join(":")}`
					: `${fileName} · ${keyPath.join(".")}`,
				previousValueSummary: summarizeConfigurationField(change.fieldKey, change.previous),
				valueSummary: summarizeConfigurationField(change.fieldKey, change.value),
				observedAt: change.observedAt,
				mergeStatus:
					change.mergeStatus === "shared_default_updated" &&
					!sameConfigurationField(store.sources[change.sourceIdentity]?.fields[change.fieldKey], change.value)
						? "superseded"
						: change.mergeStatus,
				acknowledgedAt: change.acknowledgedAt,
				eligibleTargetCount: sessions.filter(
					({ summary }) =>
						summary.agentId === "codex" &&
						summary.codexConfigurationWriterBinding?.sourceIdentity === change.sourceIdentity &&
						summary.codexConfigurationWriterBinding.writerId !== change.sourceWriterId,
				).length,
				targets: change.targets,
			};
		}),
	});
}

export function createCodexConfigurationSyncService(deps: CodexConfigurationSyncServiceDependencies) {
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let debounce: NodeJS.Timeout | undefined;
	let scanning: Promise<void> | null = null;
	let recovering: Promise<void> | null = null;
	let lastPublishedRevision = -1;
	const watchers = new Map<string, FSWatcher>();
	const publish = async () => {
		const revision = (await readCodexConfigurationSyncStore()).revision;
		if (lastPublishedRevision !== revision) {
			lastPublishedRevision = revision;
			deps.onUpdated(revision);
		}
	};
	const withOwnerConnection =
		deps.withOwnerConnection ??
		((summary, operation) =>
			withRunningCodexAppServerControlSocketConnection(operation, {
				socketPath: summary.codexNativeSessionControlEndpoint?.socketPath ?? "",
				clientName: "kanban_configuration_sync",
				requestTimeoutMs: 5_000,
			}));
	const observe = async () => {
		await mutateCodexConfigurationSyncStore(async (store) => {
			let problem: string | null = null;
			for (const [sourceIdentity, source] of Object.entries(store.sources)) {
				try {
					if ((await codexDirectoryIdentity(source.home)) !== sourceIdentity) throw new Error("来源身份已变化");
					const fileNames = [
						"config.toml",
						...(await readdir(source.home)).filter((name) => /^[\w.-]+\.config\.toml$/.test(name)),
					];
					reconcileCodexConfigurationUserSourceFields(
						store,
						sourceIdentity,
						await projectCodexConfigurationFields({
							home: source.home,
							sourceHome: source.home,
							fileNames,
							previousFields: source.observedUserFields,
							onHookDefinitionObservationProblem: () => {
								problem = "部分 hook 来源或定义暂不可核验；保留既有决定，恢复后自动补扫。";
							},
						}),
					);
				} catch {
					problem = "部分配置来源暂不可读；恢复原目录后将自动补扫。";
				}
			}
			for (const writer of Object.values(store.writers)) {
				if (writer.binding.purpose !== "native_session" || writer.retiredAt) continue;
				try {
					await assertCodexConfigurationWriterBindingIdentity(writer.binding);
					writer.fileNames = [
						...new Set([
							...writer.fileNames,
							...(await readdir(writer.binding.configurationHomeDirectoryPath)).filter((name) =>
								/^[\w.-]+\.config\.toml$/.test(name),
							),
						]),
					];
					const unavailableObservedHookFieldKeys = new Set<string>();
					const observed = await projectCodexConfigurationFields({
						home: writer.binding.configurationHomeDirectoryPath,
						sourceHome: await realpath(writer.binding.sourceHomeDirectoryPath),
						fileNames: writer.fileNames,
						previousFields: writer.lastObservedFields,
						onHookDefinitionObservationProblem: (fieldKey) => {
							unavailableObservedHookFieldKeys.add(fieldKey);
							problem = "部分会话 hook 来源或定义暂不可核验；保留既有决定，恢复后自动补扫。";
						},
					});
					// 丢失回执后的保存结果属于已登记操作，不伪装成目标用户的新决定或新通知。
					for (const change of store.changes) {
						const pendingTarget = change.targets.find(
							(target) =>
								target.writerId === writer.binding.writerId &&
								target.writeSubmissionStartedAt &&
								["accepted", "pending_reload"].includes(target.status),
						);
						if (
							pendingTarget &&
							!unavailableObservedHookFieldKeys.has(change.fieldKey) &&
							sameConfigurationField(observed[change.fieldKey], change.value)
						) {
							if (change.value === undefined) delete writer.lastObservedFields[change.fieldKey];
							else writer.lastObservedFields[change.fieldKey] = change.value;
							if (pendingTarget.diskSavedAt === null) {
								pendingTarget.diskSavedAt = Date.now();
								store.revision++;
							}
						}
					}
					mergeObservedCodexConfigurationWriter(store, writer, observed);
					const ownerSummary = deps
						.listSessions()
						.find(
							(item) =>
								item.workspaceId === writer.binding.workspaceId &&
								item.summary.taskId === writer.binding.conversationSessionId,
						)?.summary;
					if (
						ownerSummary?.runtimeSessionIncarnationId === writer.binding.runtimeSessionIncarnationId &&
						resolveSessionFacets(ownerSummary).liveness === "exited"
					)
						writer.retiredAt = Date.now();
				} catch {
					problem = "部分会话配置暂不可读或归属发生变化；保留决定，原归属恢复后自动补扫。";
				}
			}
			for (const change of store.changes)
				for (const target of change.targets) {
					if (target.status === "conflict" && target.conflictingTargetValueDigest) {
						const writer = store.writers[target.writerId];
						if (writer) {
							const digest = configurationDigest(writer.lastObservedFields[change.fieldKey] ?? null);
							if (digest !== target.conflictingTargetValueDigest) {
								target.conflictingTargetValueDigest = digest;
								store.revision++;
							}
						}
					}
				}
			if (store.observationProblem !== problem) {
				store.observationProblem = problem;
				store.revision++;
			}
		});
	};
	const reconcileSubsequentStartAdoption = async () => {
		const store = await readCodexConfigurationSyncStore();
		for (const change of store.changes)
			for (const target of change.targets) {
				if (target.status !== "pending_next_start") continue;
				const summary = deps
					.listSessions()
					.find(
						(item) =>
							item.workspaceId === target.workspaceId && item.summary.taskId === target.conversationSessionId,
					)?.summary;
				const binding = summary?.codexConfigurationWriterBinding;
				const replacement = binding && store.writers[binding.writerId];
				const endpoint = summary?.codexNativeSessionControlEndpoint;
				const nativeSessionId = summary?.agentNativeConversationSessionIdentity?.nativeSessionId;
				const { fileName, keyPath } = configurationFieldAddress(change.fieldKey);
				const joinedKeyPath = keyPath.join(".");
				if (
					!summary ||
					!binding ||
					!replacement ||
					!endpoint ||
					!nativeSessionId ||
					resolveSessionFacets(summary).liveness !== "live" ||
					binding.writerId === target.writerId ||
					binding.sourceIdentity !== change.sourceIdentity ||
					binding.launchSharedVersion < change.version ||
					endpoint.runtimeSessionIncarnationId !== binding.runtimeSessionIncarnationId ||
					endpoint.workspaceId !== target.workspaceId ||
					endpoint.conversationSessionId !== target.conversationSessionId ||
					keyPath.includes("profiles") ||
					replacement.overrideKeyPaths.some(
						(override) => joinedKeyPath === override || joinedKeyPath.startsWith(`${override}.`),
					) ||
					!sameConfigurationField(replacement.launchBaselineFields[change.fieldKey], change.value) ||
					!sameConfigurationField(store.sources[change.sourceIdentity]?.fields[change.fieldKey], change.value)
				)
					continue;
				const fingerprint = configurationDigest([
					binding.writerId,
					endpoint,
					nativeSessionId,
					summary.lastHookAt,
					replacement.lastObservedFields[change.fieldKey],
				]);
				if (
					target.startupVerificationEvidenceFingerprint === fingerprint &&
					(target.startupVerificationAttemptCount ?? 0) >= 3
				)
					continue;
				await mutateCodexConfigurationSyncStore((latest) => {
					const current = latest.changes
						.find((item) => item.changeId === change.changeId)
						?.targets.find((item) => item.writerId === target.writerId);
					if (current) {
						current.startupVerificationAttemptCount =
							current.startupVerificationEvidenceFingerprint === fingerprint
								? (current.startupVerificationAttemptCount ?? 0) + 1
								: 1;
						current.startupVerificationEvidenceFingerprint = fingerprint;
					}
				});
				try {
					await assertCodexConfigurationWriterBindingIdentity(binding);
					await withOwnerConnection(summary, async (port) => {
						const loaded = z
							.object({ data: z.array(z.string()) })
							.parse(await port.request("thread/loaded/list", {}));
						if (!loaded.data.includes(nativeSessionId)) return;
						const response = z
							.object({
								config: z.record(z.string(), z.unknown()),
								layers: z
									.array(z.object({ name: z.object({ type: z.string(), file: z.string().optional() }) }))
									.nullable(),
							})
							.parse(await port.request("config/read", { includeLayers: true }));
						if (
							!response.layers?.some(
								(layer) =>
									layer.name.type === "user" &&
									layer.name.file === join(binding.configurationHomeDirectoryPath, fileName),
							)
						)
							return;
						let actual: unknown = response.config;
						for (const key of keyPath)
							actual = configurationTable(actual)
								? actual[
										key.startsWith(`${store.sources[change.sourceIdentity].home}/`)
											? `${binding.configurationHomeDirectoryPath}${key.slice(store.sources[change.sourceIdentity].home.length)}`
											: key
									]
								: undefined;
						if (!isDeepStrictEqual(actual, change.value?.value)) return;
						await mutateCodexConfigurationSyncStore((latest) => {
							const liveSummary = deps
								.listSessions()
								.find(
									(item) =>
										item.workspaceId === target.workspaceId &&
										item.summary.taskId === target.conversationSessionId,
								)?.summary;
							const current = latest.changes
								.find((item) => item.changeId === change.changeId)
								?.targets.find((item) => item.writerId === target.writerId);
							if (
								!current ||
								liveSummary?.runtimeSessionIncarnationId !== binding.runtimeSessionIncarnationId ||
								resolveSessionFacets(liveSummary).liveness !== "live"
							)
								return;
							Object.assign(current, {
								status: "applied",
								reason: "后续原生进程已加载原线程，并核验启动配置。",
								appliedAtStartupByWriterId: binding.writerId,
								appliedAtStartupAt: Date.now(),
								diskSavedAt: binding.createdAt,
								recoveryCondition: null,
							});
							latest.revision++;
						});
					});
				} catch {
					/* 不把保存的基线冒充加载；原线程或配置证据变化后自动续验。 */
				}
			}
	};
	const applyTarget = async (changeId: string, writerId: string) => {
		const store = await readCodexConfigurationSyncStore();
		const change = store.changes.find((item) => item.changeId === changeId);
		const target = change?.targets.find((item) => item.writerId === writerId);
		const writer = store.writers[writerId];
		if (!change || !target || !writer || ["applied", "conflict", "not_applicable"].includes(target.status)) return;
		const summary = deps
			.listSessions()
			.find(
				(item) =>
					item.workspaceId === writer.binding.workspaceId &&
					item.summary.taskId === writer.binding.conversationSessionId,
			)?.summary;
		const update = async (patch: Partial<typeof target>) =>
			mutateCodexConfigurationSyncStore((latest) => {
				const latestChange = latest.changes.find((item) => item.changeId === changeId);
				const latestTarget = latestChange?.targets.find((item) => item.writerId === writerId);
				const sourceDecisionIsCurrent = sameConfigurationField(
					latest.sources[change.sourceIdentity]?.fields[change.fieldKey],
					change.value,
				);
				const guardedPatch: Partial<typeof target> = sourceDecisionIsCurrent
					? patch
					: {
							...patch,
							status: "conflict",
							reason: "共享默认已有较新决定，旧操作已停止传播；已确认的保存事实继续保留。",
							recoveryCondition: null,
						};
				if (
					latestTarget &&
					Object.entries(guardedPatch).some(
						([key, value]) => !isDeepStrictEqual(latestTarget[key as keyof typeof latestTarget], value),
					)
				) {
					Object.assign(latestTarget, guardedPatch);
					latest.revision++;
				}
				return Boolean(latestTarget && sourceDecisionIsCurrent);
			});
		if (!sameConfigurationField(store.sources[change.sourceIdentity]?.fields[change.fieldKey], change.value)) {
			await update({
				status: "conflict",
				reason: "共享默认已有较新决定，旧操作已停止传播。",
				recoveryCondition: null,
			});
			return;
		}
		if (
			!summary ||
			summary.codexConfigurationWriterBinding?.writerId !== writerId ||
			summary.runtimeSessionIncarnationId !== writer.binding.runtimeSessionIncarnationId
		) {
			await update({
				status: "pending_next_start",
				reason: "原写入者已退出；共享默认供后续启动使用，保留原副本决定。",
				recoveryCondition: "同一来源的会话下次启动",
			});
			return;
		}
		const endpoint = summary.codexNativeSessionControlEndpoint;
		if (
			!endpoint ||
			endpoint.workspaceId !== writer.binding.workspaceId ||
			endpoint.conversationSessionId !== writer.binding.conversationSessionId ||
			endpoint.runtimeSessionIncarnationId !== writer.binding.runtimeSessionIncarnationId
		) {
			await update({
				status: "pending_reload",
				reason: "当前会话没有可核验的原所有者端点。",
				recoveryCondition: "原所有者控制端点恢复或会话自然重启",
			});
			return;
		}
		let current: CodexConfigurationFields;
		const unavailableHookFieldKeys = new Set<string>();
		try {
			await assertCodexConfigurationWriterBindingIdentity(writer.binding);
			current = await projectCodexConfigurationFields({
				home: writer.binding.configurationHomeDirectoryPath,
				sourceHome: await realpath(writer.binding.sourceHomeDirectoryPath),
				fileNames: writer.fileNames,
				previousFields: writer.lastObservedFields,
				onHookDefinitionObservationProblem: (fieldKey) => unavailableHookFieldKeys.add(fieldKey),
			});
		} catch {
			await update({
				status: "pending_reload",
				reason: "目标目录身份待恢复，未写入活副本。",
				recoveryCondition: "原目录归属恢复",
			});
			return;
		}
		if (unavailableHookFieldKeys.has(change.fieldKey)) {
			await update({
				status: "pending_reload",
				evidenceFingerprint: undefined,
				attemptCount: 0,
				reason: "目标 hook 来源或定义暂不可核验，保留既有决定。",
				recoveryCondition: "同一来源定义恢复可读后自动重验",
			});
			return;
		}
		let socketIdentity: string | null = null;
		try {
			const metadata = await lstat(endpoint.socketPath);
			socketIdentity = configurationDigest([metadata.dev, metadata.ino, metadata.mtimeMs]);
		} catch {
			/* 缺少 socket 时保留未知，后续实体恢复会改变证据。 */
		}
		const fingerprint = configurationDigest([
			endpoint,
			socketIdentity,
			summary.pid,
			summary.lastHookAt,
			writer.nativeBinaryVersion,
			current,
		]);
		const { fileName, keyPath } = configurationFieldAddress(change.fieldKey);
		if (change.value?.definitionDigest || change.previous?.definitionDigest) {
			const hookKey = keyPath.at(-1) ?? "";
			const definitionDigest = await readCodexHookDefinitionDigest(
				writer.binding.configurationHomeDirectoryPath,
				await realpath(writer.binding.sourceHomeDirectoryPath),
				hookKey,
			);
			if (!definitionDigest) {
				await update({
					status: "pending_reload",
					evidenceFingerprint: undefined,
					attemptCount: 0,
					reason: "目标 hook 定义暂不可核验，未把未知判断为定义不符。",
					recoveryCondition: "同一来源定义恢复可读后自动重验",
				});
				return;
			}
			if (definitionDigest !== (change.value?.definitionDigest ?? change.previous?.definitionDigest)) {
				await update({
					status: "not_applicable",
					reason: "hook 来源或定义摘要不同，不能继承此信任决定。",
					recoveryCondition: null,
				});
				return;
			}
		}
		if (target.evidenceFingerprint === fingerprint && target.attemptCount >= 3) return;
		const nativeKeyPath = keyPath.map((key) =>
			key.startsWith(`${store.sources[change.sourceIdentity].home}/`)
				? `${writer.binding.configurationHomeDirectoryPath}${key.slice(store.sources[change.sourceIdentity].home.length)}`
				: key,
		);
		if (
			writer.overrideKeyPaths.some(
				(override) => keyPath.join(".") === override || keyPath.join(".").startsWith(`${override}.`),
			)
		) {
			await update({
				status: "pending_next_start",
				reason: "启动参数覆盖此字段，当前进程不能采用共享值。",
				recoveryCondition: "不再覆盖此字段的后续启动",
			});
			return;
		}
		if (
			!(await update({
				evidenceFingerprint: fingerprint,
				attemptCount: target.evidenceFingerprint === fingerprint ? target.attemptCount + 1 : 1,
				status: "accepted",
				reason: "已登记操作，正在核验原所有者。",
				recoveryCondition: "回执缺失时先读取磁盘和原所有者，再幂等重载",
			}))
		)
			return;
		try {
			await withOwnerConnection(summary, async (port) => {
				const nativeId = summary.agentNativeConversationSessionIdentity?.nativeSessionId;
				const loaded = z.object({ data: z.array(z.string()) }).parse(await port.request("thread/loaded/list", {}));
				if (!nativeId || !loaded.data.includes(nativeId)) throw new Error("原线程未加载");
				if (configurationTable(change.value?.value) && typeof change.value.value.trusted_hash === "string") {
					const hooks = z
						.object({
							data: z.array(
								z.object({ hooks: z.array(z.object({ key: z.string(), currentHash: z.string() })) }),
							),
						})
						.parse(await port.request("hooks/list", { cwds: [summary.workspacePath] }));
					const expectedHash = change.value.value.trusted_hash;
					if (
						!hooks.data
							.flatMap((item) => item.hooks)
							.some((hook) => hook.key === nativeKeyPath.at(-1) && hook.currentHash === expectedHash)
					) {
						await update({
							status: "not_applicable",
							reason: "原生定义哈希与待继承的信任哈希不匹配。",
							recoveryCondition: null,
						});
						return;
					}
				}
				const filePath = join(writer.binding.configurationHomeDirectoryPath, fileName);
				const readOwnerTargetConfigurationLayer = async () => {
					const config = z
						.object({
							layers: z
								.array(
									z.object({
										name: z.object({ type: z.string(), file: z.string().optional() }),
										version: z.string(),
									}),
								)
								.nullable(),
						})
						.parse(await port.request("config/read", { includeLayers: true }));
					return config.layers?.find((item) => item.name.type === "user" && item.name.file === filePath);
				};
				let layer = await readOwnerTargetConfigurationLayer();
				if (!layer) {
					await update({
						status: "pending_next_start",
						reason: "目标 profile 配置层当前未加载。",
						recoveryCondition: "使用该 profile 的后续启动",
					});
					return;
				}
				// 原所有者版本夹住目标投影；后续提交仍由同一版本拒绝窗口内的新写入。
				let versionBoundTargetFields: CodexConfigurationFields | undefined;
				for (let snapshotReadAttempt = 0; snapshotReadAttempt < 3; snapshotReadAttempt++) {
					const observedTargetFields = await projectCodexConfigurationFields({
						home: writer.binding.configurationHomeDirectoryPath,
						sourceHome: await realpath(writer.binding.sourceHomeDirectoryPath),
						fileNames: writer.fileNames,
						previousFields: writer.lastObservedFields,
						onHookDefinitionObservationProblem: (fieldKey) => {
							if (fieldKey === change.fieldKey)
								throw new Error("版本夹取期间目标 hook 定义暂不可核验，恢复后重验配置。");
						},
					});
					const confirmedLayer = await readOwnerTargetConfigurationLayer();
					if (!confirmedLayer) throw new Error("目标配置层在读取期间不再加载");
					if (layer.version === confirmedLayer.version) {
						versionBoundTargetFields = observedTargetFields;
						break;
					}
					layer = confirmedLayer;
				}
				if (!versionBoundTargetFields) throw new Error("目标配置持续变化，等待稳定证据后自动恢复");
				if (
					!sameConfigurationField(
						versionBoundTargetFields[change.fieldKey],
						writer.mergeBaselineFields[change.fieldKey],
					) &&
					!sameConfigurationField(versionBoundTargetFields[change.fieldKey], change.value)
				) {
					await update({
						status: "conflict",
						reason: "目标会话已对同一字段作出另一决定，已保留双方。",
						recoveryCondition: null,
						conflictingTargetValueDigest: configurationDigest(versionBoundTargetFields[change.fieldKey] ?? null),
						conflictHistory: [
							...(target.conflictHistory ?? []),
							{ observedAt: Date.now(), value: versionBoundTargetFields[change.fieldKey] },
						],
					});
					return;
				}
				const diskAlreadySaved = sameConfigurationField(versionBoundTargetFields[change.fieldKey], change.value);
				const supportsVerifiedReload =
					writer.nativeBinaryVersion === "codex-cli 0.164.0" &&
					keyPath[0] === "hooks" &&
					keyPath[1] === "state" &&
					(keyPath.at(-1)?.startsWith(`${store.sources[change.sourceIdentity].home}/hooks.json:`) ||
						keyPath.at(-1)?.startsWith(`${store.sources[change.sourceIdentity].home}/config.toml:`));
				// 在提交可能开始之前持久保存；失去回执不能换一个操作身份盲写。
				await observe();
				if (!(await update({ writeSubmissionStartedAt: Date.now(), expectedNativeVersion: layer.version }))) return;
				const response = z
					.object({ status: z.enum(["ok", "okOverridden"]), filePath: z.string(), version: z.string() })
					.parse(
						await port.request("config/batchWrite", {
							filePath,
							expectedVersion: layer.version,
							reloadUserConfig: supportsVerifiedReload,
							edits: diskAlreadySaved
								? []
								: [
										{
											keyPath: nativeKeyPath.map((key) => JSON.stringify(key)).join("."),
											value: change.value?.value ?? null,
											mergeStrategy: "replace",
										},
									],
						}),
					);
				if (response.filePath !== filePath) throw new Error("回执目录归属不符");
				const saved = await projectCodexConfigurationFields({
					home: writer.binding.configurationHomeDirectoryPath,
					sourceHome: await realpath(writer.binding.sourceHomeDirectoryPath),
					fileNames: writer.fileNames,
					previousFields: writer.lastObservedFields,
					onHookDefinitionObservationProblem: (fieldKey) => {
						if (fieldKey === change.fieldKey) throw new Error("目标 hook 定义待恢复，尚不能核验磁盘回执。");
					},
				});
				if (!sameConfigurationField(saved[change.fieldKey], change.value)) throw new Error("磁盘值尚未匹配");
				await observe();
				await mutateCodexConfigurationSyncStore((latest) => {
					const liveWriter = latest.writers[writerId];
					if (liveWriter) {
						if (change.value === undefined) {
							delete liveWriter.mergeBaselineFields[change.fieldKey];
							delete liveWriter.lastObservedFields[change.fieldKey];
						} else {
							liveWriter.mergeBaselineFields[change.fieldKey] = change.value;
							liveWriter.lastObservedFields[change.fieldKey] = change.value;
						}
					}
				});
				const reloaded = supportsVerifiedReload && response.status === "ok";
				await update({
					diskSavedAt: Date.now(),
					ownerReloadedAt: reloaded ? Date.now() : null,
					status: reloaded ? "applied" : "pending_next_start",
					reason: reloaded ? "原所有者已保存并重载 hook 决定。" : "已保存；此设置按原生生命周期在后续启动采用。",
					recoveryCondition: reloaded ? null : "后续原生会话启动",
				});
			});
		} catch {
			await observe();
			await update({
				status: "pending_reload",
				reason: "原所有者暂不可达、版本冲突或回执未确认；保留实际未知状态。",
				recoveryCondition: "同一证据最多三次；端点、进程或配置证据变化后自动恢复",
			});
		}
	};
	const recover = (): Promise<void> => {
		if (recovering) return recovering;
		recovering = (async () => {
			await reconcileSubsequentStartAdoption();
			const store = await readCodexConfigurationSyncStore();
			// 撤销和禁用先处理；更晚的重新启用仍由版本和冲突门禁决定。
			const restrictive = (change: StoredCodexConfigurationChange) =>
				change.value === undefined ||
				change.value.value === false ||
				(configurationTable(change.value.value) && change.value.value.enabled === false) ||
				(configurationTable(change.previous?.value) &&
					typeof change.previous.value.trusted_hash === "string" &&
					(!configurationTable(change.value.value) || typeof change.value.value.trusted_hash !== "string"));
			const changes = [...store.changes].sort(
				(left, right) => Number(restrictive(right)) - Number(restrictive(left)) || left.version - right.version,
			);
			for (const change of changes)
				for (const target of change.targets)
					if (["accepted", "pending_reload"].includes(target.status))
						await applyTarget(change.changeId, target.writerId);
		})().finally(() => {
			recovering = null;
		});
		return recovering;
	};
	const refreshWatchers = async () => {
		const store = await readCodexConfigurationSyncStore();
		const paths = [
			getCodexConfigurationSyncDirectory(),
			...Object.values(store.sources).map((source) => source.home),
			...Object.values(store.writers)
				.filter((writer) => writer.binding.purpose === "native_session" && !writer.retiredAt)
				.map((writer) => writer.binding.configurationHomeDirectoryPath),
		];
		const watchedPaths = new Set(paths);
		for (const [path, watcher] of watchers)
			if (!watchedPaths.has(path)) {
				watcher.close();
				watchers.delete(path);
			}
		for (const path of paths)
			if (!watchers.has(path))
				try {
					const watcher = watch(path, (_event, filename) => {
						if (stopped || filename?.toString().includes("pending-configuration-sync-state")) return;
						// 内部状态写入不重新触发扫描；新绑定由周期补扫发现。
						if (path === getCodexConfigurationSyncDirectory()) return;
						clearTimeout(debounce);
						debounce = setTimeout(() => {
							void scan().catch(() => {});
						}, 250);
						debounce.unref();
					});
					watcher.on("error", () => {
						watcher.close();
						watchers.delete(path);
					});
					watchers.set(path, watcher);
					watcher.unref();
				} catch {
					/* 不可监听时仍有启动、接管与周期补扫。 */
				}
	};
	const scan = (): Promise<void> => {
		if (scanning) return scanning;
		scanning = (async () => {
			await observe();
			await recover();
			if (!stopped) await refreshWatchers();
			await publish();
		})().finally(() => {
			scanning = null;
		});
		return scanning;
	};
	const mutateChange = async (
		input:
			| CodexConfigurationSynchronizeRequest
			| CodexConfigurationResolveConflictRequest
			| { changeId: string; expectedVersion: number; idempotencyKey: string },
		kind: "synchronize" | "resolve_conflict" | "acknowledge",
	) => {
		await observe();
		await mutateCodexConfigurationSyncStore((store) => {
			const requestDigest = configurationDigest([kind, input]);
			const receipt = store.mutationReceipts[input.idempotencyKey];
			if (receipt) {
				if (receipt.requestDigest !== requestDigest) throw new Error("幂等键已用于另一配置操作。");
				return;
			}
			const change = store.changes.find((item) => item.changeId === input.changeId);
			if (!change || change.version !== input.expectedVersion)
				throw new Error("配置决定版本已变化，请刷新后重新选择。");
			const source = store.sources[change.sourceIdentity];
			if (kind === "resolve_conflict" && "resolution" in input) {
				if (change.mergeStatus !== "conflict") throw new Error("此配置变更已不处于冲突状态。");
				if (!sameConfigurationField(source.fields[change.fieldKey], change.sharedValueAtConflict))
					throw new Error("共享值已有更新，不能用旧冲突覆盖新决定。");
				if (input.resolution === "use_session_value") {
					if (change.value === undefined) delete source.fields[change.fieldKey];
					else source.fields[change.fieldKey] = change.value;
					const writer = store.writers[change.sourceWriterId];
					if (writer) {
						if (change.value === undefined) delete writer.mergeBaselineFields[change.fieldKey];
						else writer.mergeBaselineFields[change.fieldKey] = change.value;
					}
					change.mergeStatus = "shared_default_updated";
				} else change.mergeStatus = "kept_shared_value";
				change.version = ++store.revision;
				source.version = store.revision;
			}
			if (kind === "synchronize" && "synchronizeExistingSessions" in input && input.synchronizeExistingSessions) {
				if (
					change.mergeStatus !== "shared_default_updated" ||
					!sameConfigurationField(source.fields[change.fieldKey], change.value)
				)
					throw new Error("此决定已冲突或被较新决定取代，未传播旧值。");
				for (const { workspaceId, summary } of deps.listSessions()) {
					if (summary.agentId !== "codex") continue;
					const binding = summary.codexConfigurationWriterBinding;
					if (binding?.writerId === change.sourceWriterId) continue;
					if (binding && binding.sourceIdentity !== change.sourceIdentity) continue;
					const writerId = binding?.writerId ?? `legacy:${workspaceId}:${summary.taskId}`;
					if (change.targets.some((target) => target.writerId === writerId)) continue;
					change.targets.push({
						writerId,
						conversationSessionId: summary.taskId,
						workspaceId,
						status: binding ? "accepted" : "pending_next_start",
						reason: binding ? "等待原所有者应用。" : "旧共享配置会话保留现场，自然重启时进入隔离方案。",
						attemptCount: 0,
						acceptedAt: Date.now(),
						diskSavedAt: null,
						ownerReloadedAt: null,
						recoveryCondition: binding ? "原所有者可达" : "会话自然重启",
					});
				}
			}
			if (kind !== "resolve_conflict") change.acknowledgedAt = Date.now();
			store.mutationReceipts[input.idempotencyKey] = { requestDigest, changeId: change.changeId };
			store.revision++;
		});
		await recover();
		await publish();
		return publicState(await readCodexConfigurationSyncStore(), deps.listSessions());
	};
	const resolveTargetConflict = async (input: CodexConfigurationResolveTargetConflictRequest) => {
		await observe();
		await mutateCodexConfigurationSyncStore(async (store) => {
			const requestDigest = configurationDigest(["resolve_target_conflict", input]);
			const receipt = store.mutationReceipts[input.idempotencyKey];
			if (receipt) {
				if (receipt.requestDigest !== requestDigest) throw new Error("幂等键已用于另一操作。");
				return;
			}
			const change = store.changes.find((item) => item.changeId === input.changeId);
			const target = change?.targets.find((item) => item.writerId === input.targetWriterId);
			const writer = store.writers[input.targetWriterId];
			if (!change || change.version !== input.expectedVersion || !target || target.status !== "conflict" || !writer)
				throw new Error("目标冲突版本已变化。");
			await assertCodexConfigurationWriterBindingIdentity(writer.binding);
			const current = await projectCodexConfigurationFields({
				home: writer.binding.configurationHomeDirectoryPath,
				sourceHome: await realpath(writer.binding.sourceHomeDirectoryPath),
				fileNames: writer.fileNames,
				previousFields: writer.lastObservedFields,
				onHookDefinitionObservationProblem: (fieldKey) => {
					if (fieldKey === change.fieldKey) throw new Error("目标 hook 定义暂不可核验，恢复后再处理冲突。");
				},
			});
			if (configurationDigest(current[change.fieldKey] ?? null) !== input.expectedTargetValueDigest)
				throw new Error("目标会话已有新决定，请刷新后处理。");
			if (input.resolution === "use_source_change") {
				if (!sameConfigurationField(store.sources[change.sourceIdentity].fields[change.fieldKey], change.value))
					throw new Error("来源决定已被较新默认取代。");
				if (current[change.fieldKey] === undefined) delete writer.mergeBaselineFields[change.fieldKey];
				else writer.mergeBaselineFields[change.fieldKey] = current[change.fieldKey];
				target.status = "accepted";
				target.reason = "已明确选择来源决定，等待原所有者应用。";
				target.attemptCount = 0;
				delete target.evidenceFingerprint;
			} else {
				target.status = "not_applicable";
				target.reason = "已明确保留目标会话自己的决定。";
				target.recoveryCondition = null;
			}
			target.conflictHistory = [
				...(target.conflictHistory ?? []),
				{ observedAt: Date.now(), value: current[change.fieldKey], resolution: input.resolution },
			];
			for (const localConflict of store.changes)
				if (
					localConflict.sourceWriterId === writer.binding.writerId &&
					localConflict.fieldKey === change.fieldKey &&
					localConflict.mergeStatus === "conflict"
				) {
					localConflict.mergeStatus =
						input.resolution === "use_source_change"
							? "target_conflict_source_change_selected"
							: "target_conflict_target_value_kept";
					localConflict.acknowledgedAt = Date.now();
					localConflict.version = ++store.revision;
				}
			store.mutationReceipts[input.idempotencyKey] = { requestDigest, changeId: change.changeId };
			store.revision++;
		});
		await recover();
		await publish();
		return publicState(await readCodexConfigurationSyncStore(), deps.listSessions());
	};
	return {
		getState: async () => {
			await scan();
			return publicState(await readCodexConfigurationSyncStore(), deps.listSessions());
		},
		scan,
		synchronize: (input: CodexConfigurationSynchronizeRequest) => mutateChange(input, "synchronize"),
		resolveConflict: (input: CodexConfigurationResolveConflictRequest) => mutateChange(input, "resolve_conflict"),
		resolveTargetConflict,
		acknowledge: (input: { changeId: string; expectedVersion: number; idempotencyKey: string }) =>
			mutateChange(input, "acknowledge"),
		start: () => {
			timer = setInterval(() => {
				void scan().catch(() => {});
			}, 5_000);
			timer.unref();
			void scan().catch(() => {});
		},
		close: async () => {
			stopped = true;
			clearInterval(timer);
			clearTimeout(debounce);
			for (const watcher of watchers.values()) watcher.close();
			watchers.clear();
			await Promise.all([scanning, recovering]);
		},
	};
}
export type CodexConfigurationSyncService = ReturnType<typeof createCodexConfigurationSyncService>;
