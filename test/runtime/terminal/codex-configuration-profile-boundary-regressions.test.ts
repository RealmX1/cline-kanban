import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCodexArgumentsUsingCompleteProfilePermissions,
	codexConfigurationPermissionMode,
} from "../../../src/codex-configuration-sync/codex-configuration-profile-launch-settings";
import {
	createCodexConfigurationProfile,
	enqueueCodexConfigurationProfileAdoptionForWriter,
	updateCodexConfigurationProfileFields,
} from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareCodexRemoteConversationLaunchPlan } from "../../../src/codex-native-session-control-host/codex-remote-conversation-launch-plan";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { CodexConfigurationWriterBinding } from "../../../src/core/codex-configuration-sync-contract";
import { requireDefinedTestFixtureValue } from "../../utilities/require-defined-test-fixture-value";
import { createTempDir } from "../../utilities/temp-dir";

const modelFieldKey = JSON.stringify(["config.toml", "model"]);
const ordinaryFieldKey = JSON.stringify(["config.toml", "hide_agent_reasoning"]);
let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
beforeEach(async () => {
	fixture = createTempDir("codex-profile-boundary-regressions-");
	fixture.path = await realpath(fixture.path);
	sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	await mkdir(sourceHome);
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({
			model: "initial-profile-model",
			model_reasoning_effort: "medium",
			approval_policy: "untrusted",
			sandbox_mode: "workspace-write",
		}),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

async function writer(previousBinding?: CodexConfigurationWriterBinding, profileId?: string, sessionModelId?: string) {
	return prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		workspaceId: "boundary-fixture-workspace",
		conversationSessionId: "boundary-fixture-session",
		runtimeSessionIncarnationId: randomUUID(),
		previousBinding,
		codexConfigurationProfileId: profileId,
		sessionModelId,
	});
}

describe("Codex profile 跨代与配置边界回归", () => {
	it.each(["model", "permissions"])("%s 反馈按会话跨 writer 换代替代，旧建议不能审批", async (group) => {
		const first = await writer();
		const fieldKey = group === "model" ? "model" : "approval_policy";
		const changeValue = async (binding: CodexConfigurationWriterBinding, value: string) => {
			const path = join(binding.configurationHomeDirectoryPath, "config.toml");
			const configuration = parse(await readFile(path, "utf8"));
			configuration[fieldKey] = value;
			await writeFile(path, stringify(configuration));
		};
		await changeValue(first, group === "model" ? "older-session-selection" : "on-request");
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await service.scan();
			const before = await service.getState();
			const olderSuggestion = requireDefinedTestFixtureValue(
				before.changes.find((change) => change.exceptionGroup === group && change.approvalStatus === "pending"),
			);
			const replacement = await writer(first);
			await changeValue(replacement, group === "model" ? "latest-session-selection" : "never");
			await service.scan();
			const after = await service.getState();
			expect(
				after.changes.filter((change) => change.exceptionGroup === group && change.approvalStatus === "pending"),
			).toHaveLength(1);
			expect(after.changes.find((change) => change.changeId === olderSuggestion.changeId)?.mergeStatus).toBe(
				"superseded",
			);
			const result = await service.batchAction({
				action: "approve",
				items: [
					{
						entryKind: "settings_proposal",
						changeId: olderSuggestion.changeId,
						expectedVersion: olderSuggestion.version,
						idempotencyKey: randomUUID(),
					},
				],
			});
			expect(result.results[0].status).not.toBe("applied");
		} finally {
			await service.close();
		}
	});
	it("明确重新选择 Task 模型覆盖旧局部选择，同一选择不会覆盖后来的 profile 更新", async () => {
		const first = await writer(undefined, undefined, "first-task-model");
		const replacement = await writer(first, undefined, "new-task-model");
		expect(parse(await readFile(join(replacement.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
			"new-task-model",
		);
		await mutateCodexConfigurationSyncStore((store) => {
			const profileId = requireDefinedTestFixtureValue(
				store.writers[replacement.writerId].codexConfigurationProfileId,
			);
			updateCodexConfigurationProfileFields(store, profileId, { [modelFieldKey]: { value: "new-profile-model" } });
		});
		const resumed = await writer(replacement, undefined, "new-task-model");
		expect(parse(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
			"new-profile-model",
		);
	});
	it.each([false, true])(
		"切换到未包含该字段的 profile；绑定已持久化=%s 时恢复与全新会话一致",
		async (bindingAlreadyPersisted) => {
			const first = await writer();
			const selectedProfileId = await mutateCodexConfigurationSyncStore((store) => {
				const originalProfileId = requireDefinedTestFixtureValue(
					store.writers[first.writerId].codexConfigurationProfileId,
				);
				const selected = createCodexConfigurationProfile(store, {
					name: "独立配置",
					copyFromProfileId: originalProfileId,
				});
				updateCodexConfigurationProfileFields(store, originalProfileId, { [ordinaryFieldKey]: { value: true } });
				return selected.profileId;
			});
			const path = join(first.configurationHomeDirectoryPath, "config.toml");
			await writeFile(path, stringify({ ...parse(await readFile(path, "utf8")), hide_agent_reasoning: true }));
			if (bindingAlreadyPersisted)
				await mutateCodexConfigurationSyncStore((store) => {
					const previous = store.writers[first.writerId];
					previous.lastObservedFields[ordinaryFieldKey] = { value: true };
					previous.mergeBaselineFields[ordinaryFieldKey] = { value: true };
					previous.codexConfigurationProfileId = selectedProfileId;
					previous.localExceptionOverrides = {};
					enqueueCodexConfigurationProfileAdoptionForWriter(store, previous);
				});
			const switched = await writer(first, selectedProfileId);
			const fresh = await writer(undefined, selectedProfileId);
			const readConfiguration = async (binding: CodexConfigurationWriterBinding) =>
				parse(await readFile(join(binding.configurationHomeDirectoryPath, "config.toml"), "utf8"));
			expect((await readConfiguration(switched)).hide_agent_reasoning).toBeUndefined();
			expect((await readConfiguration(switched)).hide_agent_reasoning).toEqual(
				(await readConfiguration(fresh)).hide_agent_reasoning,
			);
		},
	);
	it.each(["model", "model_reasoning_effort", "sandbox_mode"])(
		"升级保留旧会话明确删除的 %s，profile 更新后才取代删除",
		async (fieldName) => {
			const first = await writer();
			const fieldKey = JSON.stringify(["config.toml", fieldName]);
			const path = join(first.configurationHomeDirectoryPath, "config.toml");
			const configuration = parse(await readFile(path, "utf8"));
			delete configuration[fieldName];
			await writeFile(path, stringify(configuration));
			await mutateCodexConfigurationSyncStore((store) => {
				store.schemaVersion = 2;
				store.profiles = {};
				store.defaultCodexConfigurationProfileId = null;
				delete store.writers[first.writerId].lastObservedFields[fieldKey];
				delete store.writers[first.writerId].localExceptionOverrides;
			});
			const migrated = await readCodexConfigurationSyncStore();
			const group =
				fieldName === "model"
					? "model"
					: fieldName === "model_reasoning_effort"
						? "reasoning_effort"
						: "permissions";
			expect(migrated.writers[first.writerId].localExceptionOverrides?.[group]?.deletedFieldKeys).toContain(
				fieldKey,
			);
			const restored = await writer(first);
			expect(
				parse(await readFile(join(restored.configurationHomeDirectoryPath, "config.toml"), "utf8"))[fieldName],
			).toBeUndefined();
			await mutateCodexConfigurationSyncStore((store) => {
				const profileId = requireDefinedTestFixtureValue(
					store.writers[restored.writerId].codexConfigurationProfileId,
				);
				updateCodexConfigurationProfileFields(store, profileId, {
					[fieldKey]: { value: "explicit-profile-update" },
				});
			});
			const afterUpdate = await writer(restored);
			expect(
				parse(await readFile(join(afterUpdate.configurationHomeDirectoryPath, "config.toml"), "utf8"))[fieldName],
			).toBe("explicit-profile-update");
		},
	);
	it("profile 绑定记录按采用字段版本进入原所有者核验，不能以记录 revision 阻断", async () => {
		const first = await writer();
		const profileId = await mutateCodexConfigurationSyncStore((store) => {
			const originalProfileId = requireDefinedTestFixtureValue(
				store.writers[first.writerId].codexConfigurationProfileId,
			);
			const selected = createCodexConfigurationProfile(store, {
				name: "绑定配置",
				copyFromProfileId: originalProfileId,
			});
			updateCodexConfigurationProfileFields(store, selected.profileId, {
				[modelFieldKey]: { value: "selected-profile-model" },
			});
			const previous = store.writers[first.writerId];
			previous.codexConfigurationProfileId = selected.profileId;
			previous.retiredAt = Date.now();
			enqueueCodexConfigurationProfileAdoptionForWriter(store, previous);
			return selected.profileId;
		});
		const replacement = await writer(first, profileId);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "boundary-fixture-session",
			agentId: "codex",
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			workspacePath: fixture.path,
			pid: 10,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			runtimeSessionIncarnationId: replacement.runtimeSessionIncarnationId,
			codexConfigurationWriterBinding: replacement,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "boundary-native-session",
				transcriptPath: join(fixture.path, "boundary-native-session.jsonl"),
				observedAt: 1,
			},
			codexNativeSessionControlEndpoint: {
				workspaceId: "boundary-fixture-workspace",
				conversationSessionId: "boundary-fixture-session",
				runtimeSessionIncarnationId: replacement.runtimeSessionIncarnationId,
				socketPath: join(fixture.path, "owner.sock"),
			},
		});
		const ownerRead = vi.fn();
		const configurationPath = join(replacement.configurationHomeDirectoryPath, "config.toml");
		const service = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "boundary-fixture-workspace", summary }],
			onUpdated: () => {},
			withOwnerConnection: async (_summary, operation) =>
				operation({
					request: async (method) => {
						if (method === "thread/loaded/list") return { data: ["boundary-native-session"] };
						if (method === "config/read") {
							ownerRead();
							return {
								config: parse(await readFile(configurationPath, "utf8")),
								layers: [{ name: { type: "user", file: configurationPath } }],
							};
						}
						throw new Error(`意外的原所有者请求：${method}`);
					},
				}),
		});
		try {
			await service.scan();
			expect(ownerRead).toHaveBeenCalled();
			const store = await readCodexConfigurationSyncStore();
			const targets = store.changes.flatMap((change) =>
				change.targets.filter((target) => target.writerId === first.writerId),
			);
			expect(targets.length).toBeGreaterThan(0);
			expect(targets.every((target) => target.status === "applied")).toBe(true);
		} finally {
			await service.close();
		}
	});
	it.each(["model", "hide_agent_reasoning"])(
		"Kanban 内部 %s 按既有机制更新 profile，未来会话采用新值",
		async (fieldName) => {
			const binding = await writer();
			const path = join(binding.configurationHomeDirectoryPath, "config.toml");
			const value = fieldName === "model" ? "approved-global-model" : true;
			await writeFile(path, stringify({ ...parse(await readFile(path, "utf8")), [fieldName]: value }));
			const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
			try {
				await service.scan();
				const state = await service.getState();
				if (fieldName === "model") {
					const proposal = requireDefinedTestFixtureValue(
						state.changes.find(
							(change) => change.sourceWriterId === binding.writerId && change.approvalStatus === "pending",
						),
					);
					const result = await service.batchAction({
						action: "approve",
						items: [
							{
								entryKind: "settings_proposal",
								changeId: proposal.changeId,
								expectedVersion: proposal.version,
								idempotencyKey: randomUUID(),
							},
						],
					});
					expect(result.results[0].status).toBe("applied");
				}
				const future = await writer();
				expect(
					parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8"))[fieldName],
				).toBe(value);
			} finally {
				await service.close();
			}
		},
	);
	it("未选中的外置原生 profile 不覆盖 Task 的完整受限权限", async () => {
		await writeFile(
			join(sourceHome, "unused.config.toml"),
			stringify({ approval_policy: "never", sandbox_mode: "danger-full-access" }),
		);
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			runtimeSessionIncarnationId: randomUUID(),
			sessionPermissionSelectionSource: "task_local",
			sessionPermissionMode: "ask_for_every_tool_use",
		});
		const fields = (await readCodexConfigurationSyncStore()).writers[binding.writerId].launchBaselineFields;
		const arguments_ = requireDefinedTestFixtureValue(buildCodexArgumentsUsingCompleteProfilePermissions([], fields));
		const plan = prepareCodexRemoteConversationLaunchPlan(
			[...arguments_, "resume", "boundary-native-session"],
			fixture.path,
		);
		expect(plan?.nativeThreadRequestOverrides).toMatchObject({
			approvalPolicy: "untrusted",
			sandbox: "workspace-write",
		});
		expect(codexConfigurationPermissionMode(fields)).toBe("ask_for_every_tool_use");
	});
});
