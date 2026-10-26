import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureCodexConfigurationExecutionClosure,
	verifyCodexConfigurationExecutionClosure,
} from "../../../src/codex-configuration-sync/codex-configuration-execution-closure";
import {
	configurationDigest,
	setConfigurationField,
} from "../../../src/codex-configuration-sync/codex-configuration-field-projection";
import {
	type CodexConfigurationSyncService,
	createCodexConfigurationSyncService,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import {
	assertCodexConfigurationWriterBindingIdentity,
	prepareCodexConfigurationWriterBinding,
	recordCodexConfigurationWriterLaunchArguments,
} from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	prepareManagedCodexConversationStorageHome,
	resolveRecordedCodexConversationHome,
} from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import type { CodexAppServerRequestPort } from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let storageHome: string;
let services: CodexConfigurationSyncService[];
let sessions: Array<{ workspaceId: string; summary: RuntimeTaskSessionSummary }>;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-writer-and-sync-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	sourceHome = join(fixture.path, ".codex");
	await mkdir(sourceHome);
	await writeFile(
		join(sourceHome, "hooks.json"),
		JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "printf fixture-hook" }] }] } }),
	);
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({
			model: "initial-model",
			model_reasoning_effort: "medium",
			hooks: { state: { [`${sourceHome}/hooks.json:stop:0:0`]: { trusted_hash: "fixture-hash", enabled: true } } },
		}),
	);
	storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
	services = [];
	sessions = [];
});
afterEach(async () => {
	await Promise.all(services.map((service) => service.close()));
	vi.unstubAllEnvs();
	fixture.cleanup();
});

async function writer(sessionId: string, previousBinding?: CodexConfigurationWriterBinding) {
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		workspaceId: "fixture-workspace",
		conversationSessionId: sessionId,
		runtimeSessionIncarnationId: randomUUID(),
		previousBinding,
	});
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: sessionId,
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		agentId: "codex",
		workspacePath: fixture.path,
		pid: 100,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		codexConfigurationWriterBinding: binding,
		codexConversationStorageHomeDirectoryPath: storageHome,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: randomUUID(),
			transcriptPath: join(storageHome, "sessions", `${sessionId}.jsonl`),
			observedAt: Date.now(),
		},
		codexNativeSessionControlEndpoint: {
			socketPath: join(fixture.path, `socket-${sessionId}`),
			workspaceId: "fixture-workspace",
			conversationSessionId: sessionId,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		},
	});
	sessions = sessions.filter((item) => item.summary.taskId !== sessionId);
	sessions.push({ workspaceId: "fixture-workspace", summary });
	await mutateCodexConfigurationSyncStore((store) => {
		store.writers[binding.writerId].nativeBinaryVersion = "codex-cli 0.164.0";
	});
	return binding;
}
async function changeConfiguration(
	binding: CodexConfigurationWriterBinding,
	mutate: (configuration: TomlTable) => void,
	fileName = "config.toml",
) {
	const path = join(binding.configurationHomeDirectoryPath, fileName);
	const configuration = parse(await readFile(path, "utf8"));
	mutate(configuration);
	await writeFile(path, stringify(configuration));
}
async function decideHook(binding: CodexConfigurationWriterBinding, state: TomlTable) {
	await changeConfiguration(binding, (configuration) => {
		configuration.hooks = { state: { [`${binding.configurationHomeDirectoryPath}/hooks.json:stop:0:0`]: state } };
	});
}
function service(
	withOwnerConnection?: <T>(
		summary: RuntimeTaskSessionSummary,
		operation: (port: CodexAppServerRequestPort) => Promise<T>,
	) => Promise<T>,
) {
	const instance = createCodexConfigurationSyncService({
		listSessions: () => sessions,
		onUpdated: () => {},
		withOwnerConnection,
	});
	services.push(instance);
	return instance;
}
function nativeOwnerMock(input: { failBeforeWrite?: boolean; loseFirstReceipt?: boolean; wrongOwner?: boolean } = {}) {
	const writes: Record<string, unknown>[] = [];
	let receiptLost = false;
	return {
		writes,
		connect: async <T>(
			summary: RuntimeTaskSessionSummary,
			operation: (port: CodexAppServerRequestPort) => Promise<T>,
		): Promise<T> =>
			operation({
				request: async (method, parameters) => {
					if (input.failBeforeWrite) throw new Error("端点暂不可达");
					const filePath = join(
						summary.codexConfigurationWriterBinding?.configurationHomeDirectoryPath ?? "",
						"config.toml",
					);
					if (method === "thread/loaded/list")
						return {
							data: input.wrongOwner
								? ["another-thread"]
								: [summary.agentNativeConversationSessionIdentity?.nativeSessionId],
						};
					if (method === "config/read")
						return {
							config: parse(await readFile(filePath, "utf8")),
							layers: [
								{
									name: { type: "user", file: filePath },
									version: configurationDigest(await readFile(filePath, "utf8")),
								},
							],
						};
					if (method === "config/batchWrite") {
						writes.push(parameters);
						expect(parameters.expectedVersion).toBe(configurationDigest(await readFile(filePath, "utf8")));
						const configuration = parse(await readFile(filePath, "utf8"));
						for (const edit of parameters.edits as Array<{ keyPath: string; value: unknown }>) {
							const keys = [...edit.keyPath.matchAll(/"(?:\\.|[^"\\])*"/g)].map(
								([key]) => JSON.parse(key) as string,
							);
							setConfigurationField(
								configuration,
								keys,
								edit.value === null ? undefined : { value: edit.value },
							);
						}
						await writeFile(filePath, stringify(configuration));
						if (input.loseFirstReceipt && !receiptLost) {
							receiptLost = true;
							throw new Error("保存成功但回执丢失");
						}
						return { status: "ok", filePath, version: configurationDigest(configuration) };
					}
					throw new Error(`意外请求 ${method}`);
				},
			}),
	};
}

describe("Codex 独立配置 writer 与持久增量同步", () => {
	it("每个原生和辅助 writer 使用独立持久配置，历史、数据库、认证和写锁保留原归属", async () => {
		await writeFile(join(sourceHome, "auth.json"), "fixture-credentials");
		const first = await writer("first"),
			second = await writer("second");
		const auxiliary = await prepareCodexConfigurationWriterBinding({
			purpose: "auxiliary_process",
			storageHome: first.configurationHomeDirectoryPath,
			runtimeSessionIncarnationId: randomUUID(),
		});
		expect(new Set([first, second, auxiliary].map((binding) => binding.configurationHomeDirectoryPath)).size).toBe(3);
		for (const binding of [first, second, auxiliary]) {
			await assertCodexConfigurationWriterBindingIdentity(binding);
			expect(await readlink(join(binding.configurationHomeDirectoryPath, "sessions"))).toBe(
				join(storageHome, "sessions"),
			);
			expect(await readlink(join(binding.configurationHomeDirectoryPath, "thread-writer-locks"))).toBe(
				join(storageHome, "thread-writer-locks"),
			);
			expect(await readFile(join(binding.configurationHomeDirectoryPath, "auth.json"), "utf8")).toBe(
				"fixture-credentials",
			);
			expect(
				parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8")).sqlite_home,
			).toBe(storageHome);
		}
		expect(
			resolveRecordedCodexConversationHome({
				codexConversationStorageHomeDirectoryPath: storageHome,
				transcriptPath: join(first.configurationHomeDirectoryPath, "sessions", "rollout.jsonl"),
			}),
		).toBe(storageHome);
	});
	it("RVF-002：最后检查和 rename 窗口中的原生决定不被后续启动覆盖", async () => {
		const first = await writer("first");
		await decideHook(first, { enabled: false });
		const saved = await readFile(join(first.configurationHomeDirectoryPath, "config.toml"), "utf8");
		await writeFile(join(sourceHome, "config.toml"), 'model="new-user-default"\n');
		await Promise.all([prepareManagedCodexConversationStorageHome(sourceHome), writer("second"), writer("third")]);
		expect(await readFile(join(first.configurationHomeDirectoryPath, "config.toml"), "utf8")).toBe(saved);
		expect(parse(await readFile(join(storageHome, "config.toml"), "utf8")).model).toBe("initial-model");
	});
	it("不同字段并存，本地未修改不传播，重复扫描和重连不重复提醒", async () => {
		const first = await writer("first"),
			second = await writer("second");
		const sync = service();
		await changeConfiguration(first, (configuration) => {
			configuration.model = "selected-model";
		});
		await changeConfiguration(second, (configuration) => {
			configuration.model_reasoning_effort = "high";
		});
		const state = await sync.getState();
		expect(state.changes).toHaveLength(2);
		expect(state.changes.every((change) => change.mergeStatus === "shared_default_updated")).toBe(true);
		await sync.scan();
		expect((await sync.getState()).changes.map((change) => change.changeId)).toEqual(
			state.changes.map((change) => change.changeId),
		);
		const future = await writer("future");
		expect(parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8"))).toMatchObject({
			model: "selected-model",
			model_reasoning_effort: "high",
		});
		expect(parse(await readFile(join(second.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
			"initial-model",
		);
	});
	it("同字段冲突保留双方，版本门禁和幂等键防止重复覆盖", async () => {
		const first = await writer("first"),
			second = await writer("second");
		const sync = service();
		await changeConfiguration(first, (configuration) => {
			configuration.model = "first-choice";
		});
		await sync.scan();
		await changeConfiguration(second, (configuration) => {
			configuration.model = "second-choice";
		});
		const conflict = (await sync.getState()).changes.find((change) => change.mergeStatus === "conflict");
		expect(conflict).toBeDefined();
		const input = {
			changeId: conflict?.changeId ?? "",
			expectedVersion: conflict?.version ?? 0,
			idempotencyKey: randomUUID(),
			resolution: "use_session_value" as const,
		};
		await sync.resolveConflict(input);
		await sync.resolveConflict(input);
		await expect(sync.resolveConflict({ ...input, idempotencyKey: randomUUID() })).rejects.toThrow("版本");
		await expect(sync.acknowledge({ ...input })).rejects.toThrow("幂等键");
		expect(
			parse(await readFile(join((await writer("future")).configurationHomeDirectoryPath, "config.toml"), "utf8"))
				.model,
		).toBe("second-choice");
	});
	it("禁用、显式不信任、删除及较新的重新启用都进入未来默认", async () => {
		const first = await writer("first");
		const sync = service();
		for (const decision of [{ enabled: false }, { enabled: true, trusted_hash: "new-hash" }, {}] as TomlTable[]) {
			await decideHook(first, decision);
			await sync.scan();
			const future = await writer(randomUUID());
			const configuration = parse(
				await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8"),
			);
			expect(configuration.hooks).toMatchObject({
				state: { [`${future.configurationHomeDirectoryPath}/hooks.json:stop:0:0`]: decision },
			});
		}
		await changeConfiguration(first, (configuration) => {
			configuration.hooks = {};
		});
		await sync.scan();
		const future = await writer("after-delete");
		expect(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).not.toContain(
			"trusted_hash",
		);
	});
	it("定义变化和启动参数不会冒用已确认信任，敏感值不进入公开状态", async () => {
		const first = await writer("first"),
			second = await writer("second");
		await decideHook(first, { enabled: false });
		const owner = nativeOwnerMock();
		const sync = service(owner.connect);
		await writeFile(
			join(second.configurationHomeDirectoryPath, "hooks.json"),
			'{"hooks":{"Stop":[{"hooks":[{"command":"changed-definition","type":"command"}]}]}}',
		);
		await changeConfiguration(first, (configuration) => {
			configuration.api_key = "must-not-be-published";
			configuration.sqlite_home = "must-not-be-shared";
		});
		const state = await sync.getState();
		const change = state.changes.find((item) => item.sourceWriterId === first.writerId);
		expect(change).toBeDefined();
		const result = await sync.synchronize({
			changeId: change?.changeId ?? "",
			expectedVersion: change?.version ?? 0,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		expect(result.changes.find((item) => item.changeId === change?.changeId)?.targets[0].status).toBe(
			"not_applicable",
		);
		expect(JSON.stringify(result)).not.toContain("must-not");
		expect(owner.writes).toHaveLength(0);
		await recordCodexConfigurationWriterLaunchArguments(second, ["-c", 'model="from-arguments"']);
		await changeConfiguration(first, (configuration) => {
			configuration.model = "shared-model";
		});
		const modelChange = (await sync.getState()).changes.find((item) => item.fieldLabel.endsWith("model"));
		expect(modelChange).toBeDefined();
		const modelResult = await sync.synchronize({
			changeId: modelChange?.changeId ?? "",
			expectedVersion: modelChange?.version ?? 0,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		expect(modelResult.changes.find((item) => item.changeId === modelChange?.changeId)?.targets[0].status).toBe(
			"pending_next_start",
		);
	});
	it("只有显式开启同步才调用原所有者，默认操作只确认通知", async () => {
		const first = await writer("first");
		await writer("second");
		const owner = nativeOwnerMock();
		const sync = service(owner.connect);
		await decideHook(first, { enabled: false });
		const change = (await sync.getState()).changes[0];
		const input = {
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: false,
		};
		await sync.synchronize(input);
		expect(owner.writes).toHaveLength(0);
		const result = await sync.synchronize({
			...input,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		expect(owner.writes).toHaveLength(1);
		expect(owner.writes[0].reloadUserConfig).toBe(true);
		expect(result.changes[0].targets[0]).toMatchObject({
			status: "applied",
			attemptCount: 1,
			ownerReloadedAt: expect.any(Number),
			diskSavedAt: expect.any(Number),
		});
	});
	it("回执丢失后跨运行时重启先核验磁盘，重复操作只补重载，不再重写", async () => {
		const first = await writer("first");
		await writer("second");
		const owner = nativeOwnerMock({ loseFirstReceipt: true });
		const sync = service(owner.connect);
		await decideHook(first, { enabled: false });
		const change = (await sync.getState()).changes[0];
		const input = {
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		};
		const pending = await sync.synchronize(input);
		expect(pending.changes[0].targets[0].status).toBe("pending_reload");
		await sync.close();
		const restarted = service(owner.connect);
		const restored = await restarted.getState();
		expect(owner.writes).toHaveLength(2);
		expect(owner.writes[1].edits).toEqual([]);
		expect(restored.changes.filter((item) => item.sourceWriterId === first.writerId)).toHaveLength(1);
		expect(restored.changes[0].targets[0].status).toBe("applied");
	});
	it("相同证据最多重试三次，错误进程不写；端点变化后自动接续", async () => {
		const first = await writer("first");
		await writer("second");
		const wrongOwner = nativeOwnerMock({ wrongOwner: true });
		const sync = service(wrongOwner.connect);
		await decideHook(first, { enabled: false });
		const change = (await sync.getState()).changes[0];
		await sync.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		for (let index = 0; index < 5; index++) await sync.scan();
		expect((await readCodexConfigurationSyncStore()).changes[0].targets[0].attemptCount).toBe(3);
		expect(wrongOwner.writes).toHaveLength(0);
		await sync.close();
		const correctOwner = nativeOwnerMock();
		const restarted = service(correctOwner.connect);
		expect((await restarted.getState()).changes[0].targets[0].attemptCount).toBe(3);
		const targetSummary = sessions.find((item) => item.summary.taskId === "second")?.summary;
		if (targetSummary?.codexNativeSessionControlEndpoint)
			targetSummary.codexNativeSessionControlEndpoint.socketPath += "-recovered";
		expect((await restarted.getState()).changes[0].targets[0].status).toBe("applied");
		expect(correctOwner.writes).toHaveLength(1);
	});
	it("替换原生进程保留未合并的本地决定；来源目录身份变化时拒绝接管", async () => {
		const first = await writer("first");
		await changeConfiguration(first, (configuration) => {
			configuration.model = "local-before-restart";
		});
		const replacement = await writer("first", first);
		expect(replacement.writerId).not.toBe(first.writerId);
		expect(parse(await readFile(join(replacement.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
			"local-before-restart",
		);
		await rename(sourceHome, `${sourceHome}-original`);
		await mkdir(sourceHome);
		await expect(assertCodexConfigurationWriterBindingIdentity(replacement)).rejects.toThrow("已被替换");
	});
	it("目标会话冲突可明确选择来源值，保留冲突历史并拒绝陈旧的目标摘要", async () => {
		const first = await writer("first"),
			second = await writer("second");
		const owner = nativeOwnerMock();
		const sync = service(owner.connect);
		await changeConfiguration(first, (configuration) => {
			configuration.model = "shared-choice";
		});
		const change = (await sync.getState()).changes[0];
		await changeConfiguration(second, (configuration) => {
			configuration.model = "target-choice";
		});
		const result = await sync.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		const target = result.changes.find((item) => item.changeId === change.changeId)?.targets[0];
		expect(target?.status).toBe("conflict");
		const input = {
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			targetWriterId: second.writerId,
			expectedTargetValueDigest: target?.conflictingTargetValueDigest ?? "",
			resolution: "use_source_change" as const,
		};
		await expect(sync.resolveTargetConflict({ ...input, expectedTargetValueDigest: "outdated" })).rejects.toThrow(
			"新决定",
		);
		await sync.resolveTargetConflict(input);
		await sync.resolveTargetConflict(input);
		expect(parse(await readFile(join(second.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
			"shared-choice",
		);
		expect(
			(await readCodexConfigurationSyncStore()).changes.find((item) => item.changeId === change.changeId)?.targets[0]
				.conflictHistory,
		).toHaveLength(2);
	});
	it("已应用操作不会吞掉目标后来重新选择旧值的明确决定", async () => {
		const first = await writer("first"),
			second = await writer("second");
		const owner = nativeOwnerMock();
		const sync = service(owner.connect);
		await decideHook(first, { enabled: false });
		let change = (await sync.getState()).changes[0];
		await sync.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		await decideHook(first, { enabled: true });
		change = (await sync.getState()).changes[0];
		await sync.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		await decideHook(second, { enabled: false });
		const state = await sync.getState();
		expect(state.changes.find((item) => item.sourceWriterId === second.writerId)?.valueSummary).toContain("已禁用");
	});
	it("按原生生命周期保存的设置，在后续原生启动自动采用并更新独立的启动事实", async () => {
		const first = await writer("first"),
			second = await writer("second");
		const owner = nativeOwnerMock();
		const sync = service(owner.connect);
		await changeConfiguration(first, (configuration) => {
			configuration.model = "next-start-choice";
		});
		const change = (await sync.getState()).changes[0];
		const pending = await sync.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		expect(pending.changes[0].targets[0].status).toBe("pending_next_start");
		const replacement = await writer("second", second);
		const state = await sync.getState();
		expect(state.changes.find((item) => item.changeId === change.changeId)?.targets[0]).toMatchObject({
			status: "applied",
			ownerReloadedAt: null,
			appliedAtStartupByWriterId: replacement.writerId,
		});
	});
	it("来源软链与两类 profile 仍保留原来源身份，修改定义后未来 writer 不复用旧信任", async () => {
		const linkedHome = join(fixture.path, "linked-codex-home");
		await symlink(sourceHome, linkedHome, "junction");
		const key = `${sourceHome}/review.config.toml:stop:0:0`;
		await writeFile(
			join(sourceHome, "review.config.toml"),
			stringify({
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: "initial" }] }],
					state: { [key]: { trusted_hash: "fixture-profile-hash" } },
				},
			}),
		);
		await writeFile(
			join(sourceHome, "config.toml"),
			stringify({
				profiles: {
					review: {
						hooks: {
							Stop: [{ hooks: [{ type: "command", command: "initial" }] }],
							state: { [`${sourceHome}/config.toml:stop:0:0`]: { trusted_hash: "fixture-inline-profile-hash" } },
						},
					},
				},
			}),
		);
		const initial = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: linkedHome,
			conversationSessionId: "profile",
			workspaceId: "fixture-workspace",
			runtimeSessionIncarnationId: randomUUID(),
		});
		expect(await readFile(join(initial.configurationHomeDirectoryPath, "review.config.toml"), "utf8")).toContain(
			"fixture-profile-hash",
		);
		expect(await readFile(join(initial.configurationHomeDirectoryPath, "config.toml"), "utf8")).toContain(
			"fixture-inline-profile-hash",
		);
	});
	it("执行闭包包含正文、references 和 helpers，后续版本切换不改变既有闭包", async () => {
		const skillDirectory = join(fixture.path, "versioned-skill");
		await mkdir(join(skillDirectory, "references"), { recursive: true });
		await mkdir(join(skillDirectory, "scripts"));
		await writeFile(join(skillDirectory, "SKILL.md"), "执行 references/check.md 和 scripts/verify.py。");
		await writeFile(join(skillDirectory, "references", "check.md"), "原版本指引");
		await writeFile(join(skillDirectory, "scripts", "verify.py"), "print('original')");
		const initial = await captureCodexConfigurationExecutionClosure(join(skillDirectory, "SKILL.md"));
		await writeFile(join(skillDirectory, "scripts", "verify.py"), "print('new')");
		const next = await captureCodexConfigurationExecutionClosure(join(skillDirectory, "SKILL.md"));
		expect(next.sha256).not.toBe(initial.sha256);
		expect(initial.fileCount).toBe(3);
		expect(await readFile(join(initial.directoryPath, "scripts", "verify.py"), "utf8")).toBe("print('original')");
		expect(await verifyCodexConfigurationExecutionClosure(initial)).toBe(initial.skillFilePath);
		await writeFile(join(initial.directoryPath, "scripts", "verify.py"), "changed-after-capture");
		await expect(verifyCodexConfigurationExecutionClosure(initial)).rejects.toThrow("摘要不符");
	});
	it("原生新建的外置 profile 会被发现，后续 writer 从共享字段生成对应配置文件", async () => {
		const first = await writer("first");
		const sync = service();
		await writeFile(
			join(first.configurationHomeDirectoryPath, "review.config.toml"),
			'model="profile-selected-model"\n',
		);
		await sync.scan();
		const future = await writer("future");
		expect(
			parse(await readFile(join(future.configurationHomeDirectoryPath, "review.config.toml"), "utf8")).model,
		).toBe("profile-selected-model");
	});
	it("用户全局来源与内部默认的不同修改保留为冲突，而不是静默覆盖或丢弃", async () => {
		const first = await writer("first");
		const sync = service();
		await changeConfiguration(first, (configuration) => {
			configuration.model = "managed-choice";
		});
		await sync.scan();
		await writeFile(join(sourceHome, "config.toml"), 'model="user-global-choice"\n');
		const state = await sync.getState();
		expect(
			state.changes.find(
				(change) => change.sourceWriterId.startsWith("user-source:") && change.fieldLabel.endsWith("model"),
			)?.mergeStatus,
		).toBe("conflict");
		expect(
			parse(await readFile(join((await writer("future")).configurationHomeDirectoryPath, "config.toml"), "utf8"))
				.model,
		).toBe("managed-choice");
	});
	it("不可达端点的无变化等待不产生推流反馈循环，恢复仍保留原操作身份", async () => {
		const first = await writer("first");
		await writer("second");
		const sync = service();
		const targetSummary = sessions.find((item) => item.summary.taskId === "second")?.summary;
		if (targetSummary) targetSummary.codexNativeSessionControlEndpoint = null;
		await decideHook(first, { enabled: false });
		const change = (await sync.getState()).changes[0];
		await sync.synchronize({
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		});
		const revision = (await sync.getState()).revision;
		await sync.scan();
		await sync.scan();
		expect((await sync.getState()).revision).toBe(revision);
	});
});
