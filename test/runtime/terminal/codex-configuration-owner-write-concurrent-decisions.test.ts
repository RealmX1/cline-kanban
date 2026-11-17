import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify, type TomlTable } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import type { CodexAppServerRequestPort } from "../../../src/codex-native-session-protocol/codex-native-conversation-history";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import { withExplicitApprovalOfObservedCodexConfigurationProposals } from "../../utilities/explicitly-approve-observed-codex-configuration-proposals";
import { requireDefinedTestFixtureValue } from "../../utilities/require-defined-test-fixture-value";
import { createTempDir } from "../../utilities/temp-dir";

interface NativeRequestBarrier {
	method: string;
	phase: "before" | "after";
	reached: Promise<void>;
	release: () => void;
	pause: (method: string, phase: "before" | "after") => Promise<void>;
}
let fixtureDirectory: ReturnType<typeof createTempDir>;
let sourceHomeDirectoryPath: string;
let conversationStorageHomeDirectoryPath: string;
let configurationServices: CodexConfigurationSyncService[];
let nativeRequestBarriers: NativeRequestBarrier[];
let sessionTargets: Array<{ workspaceId: string; summary: RuntimeTaskSessionSummary }>;
const originalHookDecision = { enabled: true, trusted_hash: "fixture-hash" };
const propagatedHookDecision = { enabled: false, trusted_hash: "fixture-hash" };
const newerHookDecision = { enabled: true };

beforeEach(async () => {
	fixtureDirectory = createTempDir("codex-configuration-owner-write-concurrent-decisions-");
	fixtureDirectory.path = await realpath(fixtureDirectory.path);
	vi.stubEnv("HOME", fixtureDirectory.path);
	sourceHomeDirectoryPath = join(fixtureDirectory.path, ".codex");
	vi.stubEnv("CODEX_HOME", sourceHomeDirectoryPath);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHomeDirectoryPath);
	await mkdir(sourceHomeDirectoryPath);
	await writeFile(
		join(sourceHomeDirectoryPath, "hooks.json"),
		JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "printf fixture-hook" }] }] } }),
	);
	await writeFile(
		join(sourceHomeDirectoryPath, "config.toml"),
		stringify({
			model: "initial-model",
			model_reasoning_effort: "medium",
			hooks: { state: { [`${sourceHomeDirectoryPath}/hooks.json:stop:0:0`]: originalHookDecision } },
		}),
	);
	conversationStorageHomeDirectoryPath = await prepareManagedCodexConversationStorageHome(sourceHomeDirectoryPath);
	configurationServices = [];
	nativeRequestBarriers = [];
	sessionTargets = [];
});
afterEach(async () => {
	for (const barrier of nativeRequestBarriers) barrier.release();
	await Promise.all(configurationServices.map((service) => service.close()));
	vi.unstubAllEnvs();
	fixtureDirectory.cleanup();
});

function createNativeRequestBarrier(method: string, phase: "before" | "after" = "before") {
	let signalReached = () => {};
	let release = () => {};
	let alreadyPaused = false;
	const reached = new Promise<void>((resolve) => {
		signalReached = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const barrier: NativeRequestBarrier = {
		method,
		phase,
		reached,
		release,
		pause: async (requestMethod, requestPhase) => {
			if (alreadyPaused || requestMethod !== method || requestPhase !== phase) return;
			alreadyPaused = true;
			signalReached();
			await released;
		},
	};
	nativeRequestBarriers.push(barrier);
	return barrier;
}

async function createConfigurationWriter(conversationSessionId: string) {
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: conversationStorageHomeDirectoryPath,
		workspaceId: "concurrent-decisions-workspace",
		conversationSessionId,
		runtimeSessionIncarnationId: randomUUID(),
	});
	const summary = runtimeTaskSessionSummarySchema.parse({
		taskId: conversationSessionId,
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		agentId: "codex",
		workspacePath: fixtureDirectory.path,
		pid: 100,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		codexConfigurationWriterBinding: binding,
		codexConversationStorageHomeDirectoryPath: conversationStorageHomeDirectoryPath,
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: randomUUID(),
			transcriptPath: join(conversationStorageHomeDirectoryPath, "sessions", `${conversationSessionId}.jsonl`),
			observedAt: Date.now(),
		},
		codexNativeSessionControlEndpoint: {
			socketPath: join(fixtureDirectory.path, `socket-${conversationSessionId}`),
			workspaceId: "concurrent-decisions-workspace",
			conversationSessionId,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		},
	});
	sessionTargets.push({ workspaceId: "concurrent-decisions-workspace", summary });
	await mutateCodexConfigurationSyncStore((store) => {
		store.writers[binding.writerId].nativeBinaryVersion = "codex-cli 0.164.0";
	});
	return binding;
}

async function readWriterConfiguration(binding: CodexConfigurationWriterBinding) {
	return parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8"));
}
async function changeWriterConfiguration(
	binding: CodexConfigurationWriterBinding,
	mutate: (configuration: TomlTable) => void,
) {
	const configuration = await readWriterConfiguration(binding);
	mutate(configuration);
	await writeFile(join(binding.configurationHomeDirectoryPath, "config.toml"), stringify(configuration));
}
async function setWriterHookDecision(binding: CodexConfigurationWriterBinding, decision: TomlTable) {
	await changeWriterConfiguration(binding, (configuration) => {
		configuration.hooks = {
			state: { [`${binding.configurationHomeDirectoryPath}/hooks.json:stop:0:0`]: decision },
		};
	});
}

function createNativeOwnerHarness(input: { barrier?: NativeRequestBarrier; loseFirstReceipt?: boolean } = {}) {
	const batchWriteRequests: Record<string, unknown>[] = [];
	let receiptAlreadyLost = false;
	return {
		batchWriteRequests,
		connect: async <T>(
			summary: RuntimeTaskSessionSummary,
			operation: (port: CodexAppServerRequestPort) => Promise<T>,
		): Promise<T> =>
			operation({
				request: async (method, parameters) => {
					await input.barrier?.pause(method, "before");
					const configurationHomeDirectoryPath =
						summary.codexConfigurationWriterBinding?.configurationHomeDirectoryPath ?? "";
					const filePath = join(configurationHomeDirectoryPath, "config.toml");
					let response: unknown;
					if (method === "thread/loaded/list") {
						response = { data: [summary.agentNativeConversationSessionIdentity?.nativeSessionId] };
					} else if (method === "hooks/list") {
						response = {
							data: [
								{
									hooks: [
										{
											key: `${configurationHomeDirectoryPath}/hooks.json:stop:0:0`,
											currentHash: "fixture-hash",
										},
									],
								},
							],
						};
					} else if (method === "config/read") {
						const text = await readFile(filePath, "utf8");
						response = {
							config: parse(text),
							layers: [{ name: { type: "user", file: filePath }, version: configurationDigest(text) }],
						};
					} else if (method === "config/batchWrite") {
						batchWriteRequests.push(structuredClone(parameters));
						const text = await readFile(filePath, "utf8");
						if (parameters.expectedVersion !== configurationDigest(text)) throw new Error("目标版本已变化");
						const configuration = parse(text);
						const edits = parameters.edits as Array<{ keyPath: string; value: unknown }>;
						for (const edit of edits) {
							const keyPath = [...edit.keyPath.matchAll(/"(?:\\.|[^"\\])*"/g)].map(
								([key]) => JSON.parse(key) as string,
							);
							setConfigurationField(
								configuration,
								keyPath,
								edit.value === null ? undefined : { value: edit.value },
							);
						}
						if (edits.length) await writeFile(filePath, stringify(configuration));
						response = { status: "ok", filePath, version: configurationDigest(await readFile(filePath, "utf8")) };
					} else throw new Error(`意外原生请求 ${method}`);
					await input.barrier?.pause(method, "after");
					if (method === "config/batchWrite" && input.loseFirstReceipt && !receiptAlreadyLost) {
						receiptAlreadyLost = true;
						throw new Error("原所有者已保存但回执丢失");
					}
					return response;
				},
			}),
	};
}
function createConfigurationService(owner?: ReturnType<typeof createNativeOwnerHarness>) {
	const service = withExplicitApprovalOfObservedCodexConfigurationProposals(
		createCodexConfigurationSyncService({
			listSessions: () => sessionTargets,
			onUpdated: () => {},
			withOwnerConnection: owner?.connect,
		}),
	);
	configurationServices.push(service);
	return service;
}
async function prepareSourceDecision(input: { barrier?: NativeRequestBarrier; loseFirstReceipt?: boolean } = {}) {
	const sourceWriter = await createConfigurationWriter("source-session");
	const targetWriter = await createConfigurationWriter("target-session");
	await setWriterHookDecision(sourceWriter, propagatedHookDecision);
	const observer = createConfigurationService();
	await observer.scan();
	const change = (await observer.getState()).changes[0];
	await observer.close();
	const owner = createNativeOwnerHarness(input);
	const service = createConfigurationService(owner);
	return {
		sourceWriter,
		targetWriter,
		owner,
		service,
		change,
		request: {
			changeId: change.changeId,
			expectedVersion: change.version,
			idempotencyKey: randomUUID(),
			synchronizeExistingSessions: true,
		},
	};
}

function expectHookDecision(configuration: TomlTable, binding: CodexConfigurationWriterBinding, decision: TomlTable) {
	expect(configuration.hooks).toEqual({
		state: { [`${binding.configurationHomeDirectoryPath}/hooks.json:stop:0:0`]: decision },
	});
}

describe("原所有者写入窗口中的并发配置决定", () => {
	it("撤回本次 hook 信任传播后，较旧账本决定不会重新覆盖较新的 profile 补偿", async () => {
		const source = await createConfigurationWriter("source-session");
		const target = await createConfigurationWriter("target-session");
		await setWriterHookDecision(source, newerHookDecision);
		const service = createConfigurationService(createNativeOwnerHarness());
		await service.scan();
		const change = requireDefinedTestFixtureValue(
			(await service.getState()).changes.find((entry) => entry.sourceWriterId === source.writerId),
		);
		await service.setChangeSharingScope({
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		await service.scan();
		await service.scan();
		expectHookDecision(await readWriterConfiguration(target), target, originalHookDecision);
		expectHookDecision(await readWriterConfiguration(source), source, newerHookDecision);
		const store = await readCodexConfigurationSyncStore();
		expect(store.profiles[source.codexConfigurationProfileId ?? ""].fields[change.fieldKey ?? ""]?.value).toEqual(
			originalHookDecision,
		);
	});
	it("已采用的共享撤回后恢复目标原值，来源保留本次值且补偿不反向共享", async () => {
		const { sourceWriter, targetWriter, service, change } = await prepareSourceDecision();
		await service.scan();
		const current = requireDefinedTestFixtureValue(
			(await service.getState()).changes.find((entry) => entry.changeId === change.changeId),
		);
		expect(current.targets[0].status).toBe("applied");
		await service.setChangeSharingScope({
			changeId: current.changeId,
			expectedVersion: current.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		await service.scan();
		expectHookDecision(await readWriterConfiguration(sourceWriter), sourceWriter, propagatedHookDecision);
		expectHookDecision(await readWriterConfiguration(targetWriter), targetWriter, originalHookDecision);
		const store = await readCodexConfigurationSyncStore();
		const original = requireDefinedTestFixtureValue(
			store.changes.find((entry) => entry.changeId === current.changeId),
		);
		expect(original.changeSharingScope).toMatchObject({
			currentScope: "session_only",
			withdrawalStatus: "completed",
		});
		expect(original.sharingScopeDecisionHistory).toHaveLength(1);
		expect(store.changes.filter((entry) => entry.sourceWriterId === targetWriter.writerId)).toHaveLength(0);
		expect(store.changes.some((entry) => entry.compensationForChangeId === current.changeId)).toBe(true);
	});
	it("传播提交后撤回，迟到的保存不会形成反向共享并在下一次补扫恢复", async () => {
		const barrier = createNativeRequestBarrier("config/batchWrite", "after");
		const { targetWriter, service, change } = await prepareSourceDecision({ barrier });
		const scan = service.scan();
		await barrier.reached;
		try {
			const current = requireDefinedTestFixtureValue(
				(await service.getState()).changes.find((entry) => entry.changeId === change.changeId),
			);
			const withdrawal = service.setChangeSharingScope({
				changeId: current.changeId,
				expectedVersion: current.version,
				targetScope: "session_only",
				idempotencyKey: randomUUID(),
			});
			await vi.waitFor(async () =>
				expect(
					(await readCodexConfigurationSyncStore()).changes.find((entry) => entry.changeId === current.changeId)
						?.changeSharingScope?.currentScope,
				).toBe("session_only"),
			);
			barrier.release();
			await withdrawal;
		} finally {
			barrier.release();
		}
		await scan;
		await service.scan();
		await service.scan();
		expectHookDecision(await readWriterConfiguration(targetWriter), targetWriter, originalHookDecision);
		expect(
			(await readCodexConfigurationSyncStore()).changes.filter(
				(entry) => entry.sourceWriterId === targetWriter.writerId,
			),
		).toHaveLength(0);
	});
	it.each([
		["thread/loaded/list", "before"],
		["config/read", "before"],
		["config/read", "after"],
	] as const)("%s 的 %s 门闩之后保留目标同字段新决定并留下冲突证据", async (method, phase) => {
		const barrier = createNativeRequestBarrier(method, phase);
		const { targetWriter, owner, service, change, request } = await prepareSourceDecision({ barrier });
		const synchronization = service.synchronize(request);
		await barrier.reached;
		try {
			await setWriterHookDecision(targetWriter, newerHookDecision);
		} finally {
			barrier.release();
		}
		const result = await synchronization;
		expectHookDecision(await readWriterConfiguration(targetWriter), targetWriter, newerHookDecision);
		expect(owner.batchWriteRequests).toHaveLength(0);
		expect(result.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe("conflict");
		const storedChange = (await readCodexConfigurationSyncStore()).changes.find(
			(item) => item.changeId === change.changeId,
		);
		expect(storedChange?.targets[0].conflictHistory).toEqual([
			{ observedAt: expect.any(Number), value: { value: newerHookDecision, definitionDigest: expect.any(String) } },
		]);
	});
	it("来源和目标在预检窗口修改不同字段时仍保留两边字段并采用 hook 决定", async () => {
		const barrier = createNativeRequestBarrier("thread/loaded/list");
		const { sourceWriter, targetWriter, owner, service, change, request } = await prepareSourceDecision({ barrier });
		const synchronization = service.synchronize(request);
		await barrier.reached;
		try {
			await changeWriterConfiguration(targetWriter, (configuration) => {
				configuration.model_reasoning_effort = "high";
			});
			await changeWriterConfiguration(sourceWriter, (configuration) => {
				configuration.model = "new-source-model";
			});
		} finally {
			barrier.release();
		}
		const result = await synchronization;
		const configuration = await readWriterConfiguration(targetWriter);
		expect(configuration.model_reasoning_effort).toBe("high");
		expectHookDecision(configuration, targetWriter, propagatedHookDecision);
		expect(owner.batchWriteRequests).toHaveLength(1);
		expect(result.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe("applied");
		const store = await readCodexConfigurationSyncStore();
		expect(store.sources[sourceWriter.sourceIdentity].fields[JSON.stringify(["config.toml", "model"])].value).toBe(
			"initial-model",
		);
		expect(result.changes.find((item) => item.fieldLabel.endsWith(" · model"))).toMatchObject({
			approvalStatus: "pending",
		});
	});
	it("目标在预检期间已经保存同一决定时只补原所有者重载", async () => {
		const barrier = createNativeRequestBarrier("thread/loaded/list");
		const { targetWriter, owner, service, change, request } = await prepareSourceDecision({ barrier });
		const synchronization = service.synchronize(request);
		await barrier.reached;
		try {
			await setWriterHookDecision(targetWriter, propagatedHookDecision);
		} finally {
			barrier.release();
		}
		const result = await synchronization;
		expect(owner.batchWriteRequests).toHaveLength(1);
		expect(owner.batchWriteRequests[0].edits).toEqual([]);
		expect(result.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe("applied");
	});
	it("提交前重新观察来源同字段新决定，停止尚未提交的旧传播", async () => {
		const barrier = createNativeRequestBarrier("thread/loaded/list");
		const { sourceWriter, targetWriter, owner, service, change, request } = await prepareSourceDecision({ barrier });
		const synchronization = service.synchronize(request);
		await barrier.reached;
		try {
			await setWriterHookDecision(sourceWriter, newerHookDecision);
		} finally {
			barrier.release();
		}
		const result = await synchronization;
		expect(owner.batchWriteRequests).toHaveLength(0);
		expectHookDecision(await readWriterConfiguration(targetWriter), targetWriter, originalHookDecision);
		expect(result.changes.find((item) => item.changeId === change.changeId)).toMatchObject({
			mergeStatus: "superseded",
			targets: [{ status: "conflict", diskSavedAt: null, ownerReloadedAt: null }],
		});
	});
	it("保存回执期间来源更新时保留真实保存事实，旧决定不能计为当前采用", async () => {
		const barrier = createNativeRequestBarrier("config/batchWrite", "after");
		const { sourceWriter, targetWriter, owner, service, change, request } = await prepareSourceDecision({ barrier });
		const synchronization = service.synchronize(request);
		await barrier.reached;
		try {
			await setWriterHookDecision(sourceWriter, newerHookDecision);
		} finally {
			barrier.release();
		}
		const result = await synchronization;
		expect(owner.batchWriteRequests).toHaveLength(1);
		expectHookDecision(await readWriterConfiguration(targetWriter), targetWriter, propagatedHookDecision);
		expect(result.changes.find((item) => item.changeId === change.changeId)).toMatchObject({
			mergeStatus: "superseded",
			targets: [{ status: "conflict", diskSavedAt: expect.any(Number), ownerReloadedAt: expect.any(Number) }],
		});
	});
	it("目标在最后提交窗口改变字段时由原所有者版本拒绝，补扫后转为可审计冲突", async () => {
		const barrier = createNativeRequestBarrier("config/batchWrite");
		const { targetWriter, owner, service, change, request } = await prepareSourceDecision({ barrier });
		const synchronization = service.synchronize(request);
		await barrier.reached;
		try {
			await setWriterHookDecision(targetWriter, newerHookDecision);
		} finally {
			barrier.release();
		}
		const result = await synchronization;
		expectHookDecision(await readWriterConfiguration(targetWriter), targetWriter, newerHookDecision);
		expect(result.changes.find((item) => item.changeId === change.changeId)?.targets[0]).toMatchObject({
			status: "conflict",
			diskSavedAt: null,
			ownerReloadedAt: null,
		});
		await service.scan();
		const recovered = await service.getState();
		expect(recovered.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe("conflict");
		expect(owner.batchWriteRequests).toHaveLength(2);
		expect(owner.batchWriteRequests[1].edits).toEqual([expect.objectContaining({ value: newerHookDecision })]);
	});
	it("回执丢失期间来源更新时保存事实与重载未知分开，重启不再传播旧决定", async () => {
		const barrier = createNativeRequestBarrier("config/batchWrite", "after");
		const { sourceWriter, targetWriter, owner, service, change, request } = await prepareSourceDecision({
			barrier,
			loseFirstReceipt: true,
		});
		const synchronization = service.synchronize(request);
		await barrier.reached;
		try {
			await setWriterHookDecision(sourceWriter, newerHookDecision);
		} finally {
			barrier.release();
		}
		const result = await synchronization;
		expectHookDecision(await readWriterConfiguration(targetWriter), targetWriter, propagatedHookDecision);
		expect(result.changes.find((item) => item.changeId === change.changeId)).toMatchObject({
			mergeStatus: "superseded",
			targets: [{ status: "conflict", diskSavedAt: expect.any(Number), ownerReloadedAt: null }],
		});
		await service.close();
		const restoredConfigurationService = createConfigurationService(owner);
		await restoredConfigurationService.scan();
		const restored = await restoredConfigurationService.getState();
		expect(restored.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe("conflict");
		expect(owner.batchWriteRequests).toHaveLength(2);
		expect(owner.batchWriteRequests[1].edits).toEqual([expect.objectContaining({ value: newerHookDecision })]);
	});
	it("回执丢失跨重启恢复时保留一次字段写入，后续只补重载且不生成目标用户决定", async () => {
		const { sourceWriter, owner, service, change, request } = await prepareSourceDecision({ loseFirstReceipt: true });
		const result = await service.synchronize(request);
		expect(result.changes.find((item) => item.changeId === change.changeId)?.targets[0].status).toBe(
			"pending_reload",
		);
		await service.close();
		const restarted = createConfigurationService(owner);
		await restarted.scan();
		const restored = await restarted.getState();
		expect(owner.batchWriteRequests).toHaveLength(2);
		expect(owner.batchWriteRequests[0].edits).toHaveLength(1);
		expect(owner.batchWriteRequests[1].edits).toEqual([]);
		expect(restored.changes).toHaveLength(1);
		expect(restored.changes[0]).toMatchObject({
			sourceWriterId: sourceWriter.writerId,
			targets: [{ status: "applied" }],
		});
	});
});
