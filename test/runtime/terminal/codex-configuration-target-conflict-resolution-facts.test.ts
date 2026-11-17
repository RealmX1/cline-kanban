import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
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
import { createTempDir } from "../../utilities/temp-dir";

let fixtureDirectory: ReturnType<typeof createTempDir>;
let conversationStorageHomeDirectoryPath: string;
let sessionTargets: Array<{ workspaceId: string; summary: RuntimeTaskSessionSummary }>;
let configurationServices: CodexConfigurationSyncService[];
const modelFieldKey = JSON.stringify(["config.toml", "model"]);
beforeEach(async () => {
	fixtureDirectory = createTempDir("codex-configuration-target-conflict-resolution-facts-");
	fixtureDirectory.path = await realpath(fixtureDirectory.path);
	vi.stubEnv("HOME", fixtureDirectory.path);
	const sourceHomeDirectoryPath = join(fixtureDirectory.path, ".codex");
	await mkdir(sourceHomeDirectoryPath);
	await writeFile(join(sourceHomeDirectoryPath, "config.toml"), stringify({ model: "initial-model" }));
	conversationStorageHomeDirectoryPath = await prepareManagedCodexConversationStorageHome(sourceHomeDirectoryPath);
	sessionTargets = [];
	configurationServices = [];
});
afterEach(async () => {
	await Promise.all(configurationServices.map((service) => service.close()));
	vi.unstubAllEnvs();
	fixtureDirectory.cleanup();
});
async function createConfigurationWriter(conversationSessionId: string) {
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: conversationStorageHomeDirectoryPath,
		workspaceId: "target-conflict-workspace",
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
			workspaceId: "target-conflict-workspace",
			conversationSessionId,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		},
	});
	sessionTargets.push({ workspaceId: "target-conflict-workspace", summary });
	return binding;
}
async function readWriterModel(binding: CodexConfigurationWriterBinding) {
	return parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8")).model;
}
async function setWriterModel(binding: CodexConfigurationWriterBinding, model: string) {
	const filePath = join(binding.configurationHomeDirectoryPath, "config.toml");
	const configuration = parse(await readFile(filePath, "utf8"));
	configuration.model = model;
	await writeFile(filePath, stringify(configuration));
}
function createNativeOwnerHarness() {
	const owner = {
		available: true,
		batchWriteRequests: [] as Record<string, unknown>[],
		connect: async <T>(
			summary: RuntimeTaskSessionSummary,
			operation: (port: CodexAppServerRequestPort) => Promise<T>,
		): Promise<T> =>
			operation({
				request: async (method, parameters) => {
					if (!owner.available) throw new Error("原所有者暂不可达");
					const filePath = join(
						summary.codexConfigurationWriterBinding?.configurationHomeDirectoryPath ?? "",
						"config.toml",
					);
					if (method === "thread/loaded/list")
						return { data: [summary.agentNativeConversationSessionIdentity?.nativeSessionId] };
					if (method === "config/read") {
						const text = await readFile(filePath, "utf8");
						return {
							config: parse(text),
							layers: [{ name: { type: "user", file: filePath }, version: configurationDigest(text) }],
						};
					}
					if (method === "config/batchWrite") {
						owner.batchWriteRequests.push(structuredClone(parameters));
						const text = await readFile(filePath, "utf8");
						if (parameters.expectedVersion !== configurationDigest(text)) throw new Error("目标版本已变化");
						const configuration = parse(text);
						for (const edit of parameters.edits as Array<{ keyPath: string; value: unknown }>) {
							const keyPath = [...edit.keyPath.matchAll(/"(?:\\.|[^"\\])*"/g)].map(
								([key]) => JSON.parse(key) as string,
							);
							setConfigurationField(
								configuration,
								keyPath,
								edit.value === null ? undefined : { value: edit.value },
							);
						}
						await writeFile(filePath, stringify(configuration));
						return { status: "ok", filePath, version: configurationDigest(configuration) };
					}
					throw new Error(`意外原生请求 ${method}`);
				},
			}),
	};
	return owner;
}
function createConfigurationService(owner: ReturnType<typeof createNativeOwnerHarness>, approveObserved = true) {
	const rawService = createCodexConfigurationSyncService({
		getSessionSummary: (workspaceId: string, conversationSessionId: string) =>
			sessionTargets.find(
				(session) => session.workspaceId === workspaceId && session.summary.taskId === conversationSessionId,
			)?.summary ?? null,
		listSessions: () => sessionTargets,
		onUpdated: () => {},
		withOwnerConnection: owner.connect,
	});
	const service = approveObserved ? withExplicitApprovalOfObservedCodexConfigurationProposals(rawService) : rawService;
	configurationServices.push(service);
	return service;
}
async function prepareTargetConflict() {
	const sourceWriter = await createConfigurationWriter("source-session");
	const targetWriter = await createConfigurationWriter("target-session");
	const owner = createNativeOwnerHarness();
	owner.available = false;
	const observer = createConfigurationService(owner, false);
	await setWriterModel(sourceWriter, "source-model");
	await observer.scan();
	const suggestion = (await observer.getState()).changes[0];
	const approved = await observer.batchAction({
		action: "approve",
		items: [
			{
				entryKind: "settings_proposal",
				changeId: suggestion.changeId,
				expectedVersion: suggestion.version,
				idempotencyKey: randomUUID(),
			},
		],
	});
	const sourceChange = approved.state.changes.find((change) => change.changeId === suggestion.changeId);
	if (!sourceChange) throw new Error("缺少已批准来源决定");
	await setWriterModel(targetWriter, "target-model");
	await observer.scan();
	// 直接恢复升级前已经存在的已批准传播与目标冲突；新模型调整走限时反馈，不再制造这类冲突。
	await mutateCodexConfigurationSyncStore((store) => {
		const approved = store.changes.find((change) => change.changeId === sourceChange.changeId);
		const local = store.changes.find(
			(change) => change.sourceWriterId === targetWriter.writerId && change.fieldKey === modelFieldKey,
		);
		if (!approved || !local) throw new Error("缺少历史冲突夹具");
		delete approved.codexConfigurationProfileId;
		delete approved.acceptedProfileFieldVersion;
		local.mergeStatus = "conflict";
		local.sharedValueAtConflict = { value: "source-model" };
		approved.targets = [
			{
				writerId: targetWriter.writerId,
				workspaceId: "target-conflict-workspace",
				conversationSessionId: "target-session",
				status: "conflict",
				reason: "升级前已存在的目标决定",
				attemptCount: 0,
				acceptedAt: 1,
				diskSavedAt: null,
				ownerReloadedAt: null,
				recoveryCondition: null,
				conflictingTargetValueDigest: configurationDigest({ value: "target-model" }),
				conflictHistory: [{ observedAt: 1, value: { value: "target-model" } }],
			},
		];
		store.sources[sourceWriter.sourceIdentity].fields[modelFieldKey] = { value: "source-model" };
	});
	await observer.scan();
	const state = await observer.getState();
	const target = state.changes.find((change) => change.changeId === sourceChange.changeId)?.targets[0];
	const localConflict = state.changes.find((change) => change.sourceWriterId === targetWriter.writerId);
	expect(target?.status).toBe("conflict");
	expect(localConflict?.mergeStatus).toBe("conflict");
	await observer.close();
	owner.available = true;
	return {
		sourceWriter,
		targetWriter,
		owner,
		service: createConfigurationService(owner),
		sourceChange,
		localConflict,
		resolutionRequest: {
			changeId: sourceChange.changeId,
			expectedVersion: sourceChange.version,
			idempotencyKey: randomUUID(),
			targetWriterId: targetWriter.writerId,
			expectedTargetValueDigest: target?.conflictingTargetValueDigest ?? "",
		},
	};
}

describe("目标冲突处理的明确选择与实际采用事实", () => {
	it.each([
		{
			resolution: "use_source_change",
			expectedMergeStatus: "target_conflict_source_change_selected",
			expectedTargetStatus: "pending_next_start",
			expectedModel: "source-model",
			expectedWriteCount: 1,
		},
		{
			resolution: "keep_target_value",
			expectedMergeStatus: "target_conflict_target_value_kept",
			expectedTargetStatus: "not_applicable",
			expectedModel: "target-model",
			expectedWriteCount: 0,
		},
	] as const)("$resolution 分别持久保存选择事实、磁盘行为与目标进度，重启和重试不改变语义", async (scenario) => {
		const { sourceWriter, targetWriter, owner, service, sourceChange, localConflict, resolutionRequest } =
			await prepareTargetConflict();
		const request = { ...resolutionRequest, resolution: scenario.resolution };
		const result = await service.resolveTargetConflict(request);
		await service.resolveTargetConflict(request);
		expect(result.changes.find((change) => change.changeId === localConflict?.changeId)).toMatchObject({
			mergeStatus: scenario.expectedMergeStatus,
			acknowledgedAt: expect.any(Number),
		});
		const target = result.changes.find((change) => change.changeId === sourceChange.changeId)?.targets[0];
		expect(target).toMatchObject({ status: scenario.expectedTargetStatus, ownerReloadedAt: null });
		expect(target?.diskSavedAt).toEqual(scenario.expectedWriteCount ? expect.any(Number) : null);
		expect(await readWriterModel(targetWriter)).toBe(scenario.expectedModel);
		expect(owner.batchWriteRequests).toHaveLength(scenario.expectedWriteCount);
		const store = await readCodexConfigurationSyncStore();
		expect(store.sources[sourceWriter.sourceIdentity].fields[modelFieldKey].value).toBe("source-model");
		expect(store.changes.find((change) => change.changeId === localConflict?.changeId)).toMatchObject({
			mergeStatus: scenario.expectedMergeStatus,
			value: { value: "target-model" },
			sharedValueAtConflict: { value: "source-model" },
		});
		const conflictHistory = store.changes.find((change) => change.changeId === sourceChange.changeId)?.targets[0]
			.conflictHistory;
		expect(conflictHistory).toHaveLength(2);
		expect(conflictHistory?.at(-1)).toMatchObject({
			resolution: scenario.resolution,
			value: { value: "target-model" },
		});
		await service.close();
		const restoredConfigurationService = createConfigurationService(owner);
		await restoredConfigurationService.scan();
		const restored = await restoredConfigurationService.getState();
		expect(restored.changes.find((change) => change.changeId === localConflict?.changeId)?.mergeStatus).toBe(
			scenario.expectedMergeStatus,
		);
		expect(restored.changes.find((change) => change.changeId === sourceChange.changeId)?.targets[0].status).toBe(
			scenario.expectedTargetStatus,
		);
		expect(owner.batchWriteRequests).toHaveLength(scenario.expectedWriteCount);
	});
	it("选择来源但原所有者不可达时，只确认选择，保留磁盘与加载未知事实", async () => {
		const { targetWriter, owner, service, sourceChange, localConflict, resolutionRequest } =
			await prepareTargetConflict();
		owner.available = false;
		const result = await service.resolveTargetConflict({ ...resolutionRequest, resolution: "use_source_change" });
		expect(result.changes.find((change) => change.changeId === localConflict?.changeId)?.mergeStatus).toBe(
			"target_conflict_source_change_selected",
		);
		expect(result.changes.find((change) => change.changeId === sourceChange.changeId)?.targets[0]).toMatchObject({
			status: "pending_reload",
			diskSavedAt: null,
			ownerReloadedAt: null,
		});
		expect(await readWriterModel(targetWriter)).toBe("target-model");
		expect(owner.batchWriteRequests).toHaveLength(0);
		await service.close();
		const restoredConfigurationService = createConfigurationService(owner);
		await restoredConfigurationService.scan();
		const restored = await restoredConfigurationService.getState();
		expect(restored.changes.find((change) => change.changeId === localConflict?.changeId)?.mergeStatus).toBe(
			"target_conflict_source_change_selected",
		);
		expect(await readWriterModel(targetWriter)).toBe("target-model");
	});
	it("历史 kept_shared_value 状态继续可读，保留旧记录和冲突历史", async () => {
		const { owner, service, localConflict, resolutionRequest } = await prepareTargetConflict();
		await service.resolveTargetConflict({ ...resolutionRequest, resolution: "keep_target_value" });
		await mutateCodexConfigurationSyncStore((store) => {
			const historicalChange = store.changes.find((change) => change.changeId === localConflict?.changeId);
			if (historicalChange) historicalChange.mergeStatus = "kept_shared_value";
		});
		await service.close();
		const restoredConfigurationService = createConfigurationService(owner);
		await restoredConfigurationService.scan();
		const restored = await restoredConfigurationService.getState();
		expect(restored.changes.find((change) => change.changeId === localConflict?.changeId)?.mergeStatus).toBe(
			"kept_shared_value",
		);
		expect(
			(await readCodexConfigurationSyncStore()).changes.find(
				(change) => change.changeId === resolutionRequest.changeId,
			)?.targets[0].conflictHistory,
		).toHaveLength(2);
	});
});
