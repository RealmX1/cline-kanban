import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeObservedCodexConfigurationWriter } from "../../../src/codex-configuration-sync/codex-configuration-incremental-merge";
import { buildCodexArgumentsUsingCompleteProfilePermissions } from "../../../src/codex-configuration-sync/codex-configuration-profile-launch-settings";
import {
	createCodexConfigurationProfile,
	expireCodexConfigurationProfileFeedbackSuggestions,
	updateCodexConfigurationProfileFields,
} from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { isCodexConfigurationSourceObservationStillCurrent } from "../../../src/codex-configuration-sync/codex-configuration-proposal-approval";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import {
	appendCodexProfileAdoptionRetainedInput,
	createCodexProfileAdoptionRetainedInput,
	listUnrestoredCodexProfileAdoptionRetainedInput,
	readCodexProfileAdoptionRetainedInput,
} from "../../../src/codex-configuration-sync/codex-profile-adoption-retained-terminal-input";
import { prepareCodexRemoteConversationLaunchPlan } from "../../../src/codex-native-session-control-host/codex-remote-conversation-launch-plan";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { requireDefinedTestFixtureValue } from "../../utilities/require-defined-test-fixture-value";
import { createTempDir } from "../../utilities/temp-dir";

const modelFieldKey = JSON.stringify(["config.toml", "model"]);
const effortFieldKey = JSON.stringify(["config.toml", "model_reasoning_effort"]);
const ordinaryFieldKey = JSON.stringify(["config.toml", "features", "shell_snapshot"]);
let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-profiles-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	await mkdir(sourceHome);
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({ model: "initial-model", model_reasoning_effort: "medium", features: { shell_snapshot: false } }),
	);
	await writeFile(
		join(sourceHome, "hooks.json"),
		JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

async function writer(sessionId: string, profileId?: string) {
	return prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		workspaceId: "profiles-fixture",
		conversationSessionId: sessionId,
		runtimeSessionIncarnationId: randomUUID(),
		codexConfigurationProfileId: profileId,
	});
}

describe("Codex profile 自动共享", () => {
	it("来源会话改选 profile 后，旧反馈不能更新原 profile", async () => {
		const binding = await writer("profile-rebound-feedback");
		const configurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		configuration.model = "local-model";
		await writeFile(configurationPath, stringify(configuration));
		const sync = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await sync.scan();
			const suggestion = requireDefinedTestFixtureValue(
				(await sync.getState()).changes.find((change) => change.approvalStatus === "pending"),
			);
			await mutateCodexConfigurationSyncStore((store) => {
				const current = store.writers[binding.writerId];
				const replacement = createCodexConfigurationProfile(store, {
					name: "改选配置",
					copyFromProfileId: requireDefinedTestFixtureValue(current.codexConfigurationProfileId),
				});
				current.codexConfigurationProfileId = replacement.profileId;
			});
			const result = await sync.batchAction({
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
			expect(result.results[0]?.status).toBe("stale_version");
			expect(result.state.changes.find((change) => change.changeId === suggestion.changeId)).toMatchObject({
				approvalStatus: "historical",
				mergeStatus: "superseded",
			});
			expect(
				result.state.profiles?.every(
					(profile) => profile.fields.find((field) => field.fieldKey === modelFieldKey)?.value === "initial-model",
				),
			).toBe(true);
		} finally {
			await sync.close();
		}
	});
	it("文件权限变更先显示待核验，跨运行时取得本代原生回合证据后才更新实际权限", async () => {
		const binding = await writer("permission-evidence");
		const transcriptPath = join(fixture.path, "permission-evidence.jsonl");
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "permission-evidence",
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
			codexConfigurationWriterBinding: binding,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "permission-evidence-native",
				transcriptPath,
				observedAt: 1,
			},
		});
		const configurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		Object.assign(configuration, { approval_policy: "on-request", sandbox_mode: "workspace-write" });
		await writeFile(configurationPath, stringify(configuration));
		const observed = vi.fn();
		const dependencies = {
			listSessions: () => [{ workspaceId: "profiles-fixture", summary }],
			onUpdated: () => {},
			onWriterPermissionsObserved: observed,
		};
		const first = createCodexConfigurationSyncService(dependencies);
		await first.scan();
		await first.close();
		expect(observed).toHaveBeenCalledExactlyOnceWith("profiles-fixture", "permission-evidence", null);
		expect(
			(await readCodexConfigurationSyncStore()).writers[binding.writerId].pendingNativePermissionVerificationAtMs,
		).toBeGreaterThan(0);
		await writeFile(
			transcriptPath,
			`${[
				{
					type: "session_meta",
					timestamp: new Date().toISOString(),
					payload: { id: "permission-evidence-native", cwd: fixture.path, source: "cli" },
				},
				{
					type: "turn_context",
					timestamp: new Date(Date.now() + 1000).toISOString(),
					payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } },
				},
			]
				.map((event) => JSON.stringify(event))
				.join("\n")}\n`,
		);
		const recovered = createCodexConfigurationSyncService(dependencies);
		try {
			await recovered.scan();
			expect(observed).toHaveBeenLastCalledWith(
				"profiles-fixture",
				"permission-evidence",
				expect.objectContaining({
					[JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" },
					[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "workspace-write" },
				}),
			);
			expect(
				(await readCodexConfigurationSyncStore()).writers[binding.writerId].pendingNativePermissionVerificationAtMs,
			).toBeUndefined();
		} finally {
			await recovered.close();
		}
	});
	it.each([false, true])(
		"升级保留已有 Task 模型和 CLI Effort；升级后 profile 已改模型=%s 时采用新决定",
		async (modelWasUpdated) => {
			const first = await writer("legacy-local-selections");
			await mutateCodexConfigurationSyncStore((store) => {
				store.schemaVersion = 2;
				store.profiles = {};
				store.defaultCodexConfigurationProfileId = null;
			});
			const migrated = await readCodexConfigurationSyncStore();
			const profileId = requireDefinedTestFixtureValue(migrated.writers[first.writerId].codexConfigurationProfileId);
			if (modelWasUpdated)
				await mutateCodexConfigurationSyncStore((store) =>
					updateCodexConfigurationProfileFields(store, profileId, {
						[modelFieldKey]: { value: "updated-profile-model" },
					}),
				);
			const resumed = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: sourceHome,
				previousBinding: first,
				workspaceId: "profiles-fixture",
				conversationSessionId: "legacy-local-selections",
				runtimeSessionIncarnationId: randomUUID(),
				sessionModelId: "previous-task-model",
				nativeLaunchArguments: ["-c", 'model_reasoning_effort="high"'],
			});
			const actual = parse(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8"));
			expect(actual.model).toBe(modelWasUpdated ? "updated-profile-model" : "previous-task-model");
			expect(actual.model_reasoning_effort).toBe("high");
			await mutateCodexConfigurationSyncStore((store) =>
				updateCodexConfigurationProfileFields(store, profileId, {
					[modelFieldKey]: { value: "later-profile-model" },
				}),
			);
			const afterUpdate = await prepareCodexConfigurationWriterBinding({
				purpose: "native_session",
				storageHome: sourceHome,
				previousBinding: resumed,
				workspaceId: "profiles-fixture",
				conversationSessionId: "legacy-local-selections",
				runtimeSessionIncarnationId: randomUUID(),
				sessionModelId: "previous-task-model",
				nativeLaunchArguments: ["-c", 'model_reasoning_effort="high"'],
			});
			expect(
				parse(await readFile(join(afterUpdate.configurationHomeDirectoryPath, "config.toml"), "utf8")).model,
			).toBe("later-profile-model");
		},
	);
	it("局部模型覆盖只改变选择的字段，恢复时保留其他原生 profile 定义", async () => {
		const configuration = parse(await readFile(join(sourceHome, "config.toml"), "utf8"));
		configuration.profiles = { native_profile: { model: "profile-defined-model" } };
		await writeFile(join(sourceHome, "config.toml"), stringify(configuration));
		const first = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			runtimeSessionIncarnationId: randomUUID(),
			sessionModelId: "task-local-model",
		});
		const resumed = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			previousBinding: first,
			runtimeSessionIncarnationId: randomUUID(),
			sessionModelId: "task-local-model",
		});
		expect(parse(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8"))).toMatchObject({
			model: "task-local-model",
			profiles: { native_profile: { model: "profile-defined-model" } },
		});
	});
	it("完整权限反馈的删除字段跨持久化保留，不被 JSON 丢失", async () => {
		const sourceConfiguration = parse(await readFile(join(sourceHome, "config.toml"), "utf8"));
		Object.assign(sourceConfiguration, { approval_policy: "on-request", sandbox_mode: "workspace-write" });
		await writeFile(join(sourceHome, "config.toml"), stringify(sourceConfiguration));
		const first = await writer("permission-deletion");
		const path = join(first.configurationHomeDirectoryPath, "config.toml");
		const changed = parse(await readFile(path, "utf8"));
		delete changed.sandbox_mode;
		await writeFile(path, stringify(changed));
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await service.scan();
			const suggestion = requireDefinedTestFixtureValue(
				(await service.getState()).changes.find(
					(change) => change.exceptionGroup === "permissions" && change.approvalStatus === "pending",
				),
			);
			const result = await service.batchAction({
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
			expect(result.results[0].status).toBe("applied");
			const future = await writer("after-permission-deletion");
			const adopted = parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8"));
			expect(adopted.approval_policy).toBe("on-request");
			expect(adopted.sandbox_mode).toBeUndefined();
		} finally {
			await service.close();
		}
	});
	it("绑定的持久副作用失败后跨运行时自动补做，幂等重试不会回退到旧 Task 绑定", async () => {
		const binding = await writer("first");
		const initialProfileId = requireDefinedTestFixtureValue(binding.codexConfigurationProfileId);
		const selected = await mutateCodexConfigurationSyncStore((store) =>
			createCodexConfigurationProfile(store, { name: "新归属", copyFromProfileId: initialProfileId }),
		);
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "first",
			agentId: "codex",
			state: "idle",
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
			workspacePath: fixture.path,
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: 0,
			codexConfigurationWriterBinding: binding,
			runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
		});
		let taskProfileId = initialProfileId;
		const listSessions = () => [{ workspaceId: "profiles-fixture", summary }];
		const listTaskProfileBindings = async () => ({
			bindings: [{ workspaceId: "profiles-fixture", conversationSessionId: "first", profileId: taskProfileId }],
			unavailableWorkspaceCount: 0,
		});
		const first = createCodexConfigurationSyncService({
			listSessions,
			listTaskProfileBindings,
			onUpdated: () => {},
			onSessionProfileBound: async () => {
				throw new Error("隔离的持久化失败");
			},
		});
		const request = {
			action: "bind_session" as const,
			profileId: selected.profileId,
			workspaceId: "profiles-fixture",
			conversationSessionId: "first",
			expectedRuntimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			idempotencyKey: "profile-binding-receipt",
		};
		await first.mutateProfile(request);
		await first.close();
		expect(
			(await readCodexConfigurationSyncStore()).writers[binding.writerId].pendingSessionProfileBinding?.profileId,
		).toBe(selected.profileId);
		const replacement = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			previousBinding: binding,
			workspaceId: "profiles-fixture",
			conversationSessionId: "first",
			runtimeSessionIncarnationId: randomUUID(),
			codexConfigurationProfileId: initialProfileId,
		});
		summary.codexConfigurationWriterBinding = replacement;
		summary.runtimeSessionIncarnationId = replacement.runtimeSessionIncarnationId;
		summary.codexConfigurationProfileId = initialProfileId;
		const adopted = vi.fn(async (_workspaceId: string, _sessionId: string, profileId: string) => {
			taskProfileId = profileId;
			summary.codexConfigurationProfileId = profileId;
		});
		const recovered = createCodexConfigurationSyncService({
			listSessions,
			listTaskProfileBindings,
			onUpdated: () => {},
			onSessionProfileBound: adopted,
		});
		try {
			await recovered.mutateProfile(request);
			expect(taskProfileId).toBe(selected.profileId);
			expect(adopted).toHaveBeenCalledTimes(1);
			expect(
				(await readCodexConfigurationSyncStore()).writers[binding.writerId].pendingSessionProfileBinding,
			).toBeUndefined();
			expect(
				(await readCodexConfigurationSyncStore()).writers[replacement.writerId].codexConfigurationProfileId,
			).toBe(selected.profileId);
			expect(
				(await readCodexConfigurationSyncStore()).changes.some(
					(change) =>
						change.codexConfigurationProfileId === selected.profileId &&
						change.targets.some((target) => target.writerId === replacement.writerId),
				),
			).toBe(true);
		} finally {
			await recovered.close();
		}
	});
	it("退休 writer 的权限广播只更新原归属，不能把当前会话绑回旧 profile", async () => {
		const original = await writer("profile-switch");
		const originalProfileId = requireDefinedTestFixtureValue(original.codexConfigurationProfileId);
		const selected = await mutateCodexConfigurationSyncStore((store) =>
			createCodexConfigurationProfile(store, { name: "当前归属", copyFromProfileId: originalProfileId }),
		);
		const replacement = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			previousBinding: original,
			workspaceId: "profiles-fixture",
			conversationSessionId: "profile-switch",
			runtimeSessionIncarnationId: randomUUID(),
			codexConfigurationProfileId: selected.profileId,
		});
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "profile-switch",
			agentId: "codex",
			state: "idle",
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
			workspacePath: fixture.path,
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: 0,
			codexConfigurationWriterBinding: replacement,
			runtimeSessionIncarnationId: replacement.runtimeSessionIncarnationId,
			codexConfigurationProfileId: selected.profileId,
		});
		const adopted = vi.fn();
		const service = createCodexConfigurationSyncService({
			listSessions: () => [{ workspaceId: "profiles-fixture", summary }],
			onUpdated: () => {},
			onSessionProfileBound: adopted,
		});
		try {
			await service.scan();
			adopted.mockClear();
			await mutateCodexConfigurationSyncStore((store) =>
				updateCodexConfigurationProfileFields(store, originalProfileId, {
					[JSON.stringify(["config.toml", "approval_policy"])]: { value: "untrusted" },
				}),
			);
			await service.scan();
			expect(adopted).not.toHaveBeenCalled();
			expect(summary.codexConfigurationProfileId).toBe(selected.profileId);
			expect(
				(await readCodexConfigurationSyncStore()).writers[replacement.writerId].codexConfigurationProfileId,
			).toBe(selected.profileId);
			expect(
				(await readCodexConfigurationSyncStore()).writers[original.writerId].pendingSessionProfileBinding,
			).toBeUndefined();
		} finally {
			await service.close();
		}
	});
	it("旧共享会话保持原存储，登记迁入 profile 的进度与三次重试边界并跨重启保留", async () => {
		await writer("known-source");
		const globalBefore = await readFile(join(sourceHome, "config.toml"), "utf8");
		const summary = runtimeTaskSessionSummarySchema.parse({
			taskId: "legacy",
			agentId: "codex",
			state: "awaiting_review",
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			workspacePath: fixture.path,
			pid: 50,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: "hook",
			exitCode: null,
			codexConversationStorageHomeDirectoryPath: sourceHome,
			runtimeSessionIncarnationId: randomUUID(),
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: randomUUID(),
				transcriptPath: join(sourceHome, "legacy.jsonl"),
				observedAt: 1,
			},
		});
		const acceptedClaims: boolean[] = [];
		const create = () =>
			createCodexConfigurationSyncService({
				listSessions: () => [{ workspaceId: "profiles-fixture", summary }],
				onUpdated: () => {},
				resumeSessionToAdoptProfile: async (input) => {
					acceptedClaims.push(await input.onBeforeProcessReplacement("same-native-completion"));
					return { resumed: false, reason: "隔离模拟启动尚未完成" };
				},
			});
		const first = create();
		for (let index = 0; index < 4; index++) await first.scan();
		await first.close();
		const resumed = create();
		try {
			await resumed.scan();
			const state = await resumed.getState();
			expect(
				state.sessionProfileBindings?.find((binding) => binding.conversationSessionId === "legacy")?.adoptionReason,
			).toContain("尚未完成");
			expect(acceptedClaims).toEqual([true, true, true, false, false]);
			expect(await readFile(join(sourceHome, "config.toml"), "utf8")).toBe(globalBefore);
			expect(summary.codexConversationStorageHomeDirectoryPath).toBe(sourceHome);
		} finally {
			await resumed.close();
		}
	});
	it("普通字段自动采用到所属 profile，其他 profile 保留自己的值", async () => {
		const first = await writer("first");
		const second = await writer("second");
		const anotherProfile = await mutateCodexConfigurationSyncStore((store) =>
			createCodexConfigurationProfile(store, {
				name: "另一组",
				copyFromProfileId: requireDefinedTestFixtureValue(
					store.writers[first.writerId].codexConfigurationProfileId,
				),
			}),
		);
		const third = await writer("third", anotherProfile.profileId);
		await mutateCodexConfigurationSyncStore((store) => {
			const source = store.writers[first.writerId];
			mergeObservedCodexConfigurationWriter(store, source, {
				...source.lastObservedFields,
				[ordinaryFieldKey]: { value: true },
			});
		});
		const store = await readCodexConfigurationSyncStore();
		const profile =
			store.profiles[requireDefinedTestFixtureValue(store.writers[first.writerId].codexConfigurationProfileId)];
		expect(profile.fields[ordinaryFieldKey].value).toBe(true);
		expect(store.profiles[anotherProfile.profileId].fields[ordinaryFieldKey].value).toBe(false);
		expect(store.changes.at(-1)?.approvalStatus).toBe("approved");
		expect(store.changes.at(-1)?.targets.map((target) => target.writerId)).toEqual([second.writerId]);
		expect(store.changes.at(-1)?.targets.some((target) => target.writerId === third.writerId)).toBe(false);
	});
	it("例外仅留最新建议，固定十分钟截止时间，重读不会续期", async () => {
		const binding = await writer("first");
		await mutateCodexConfigurationSyncStore((store) => {
			const source = store.writers[binding.writerId];
			mergeObservedCodexConfigurationWriter(store, source, {
				...source.lastObservedFields,
				[modelFieldKey]: { value: "local-model" },
			});
		});
		let store = await readCodexConfigurationSyncStore();
		const original = requireDefinedTestFixtureValue(store.changes.at(-1));
		expect(original.feedbackExpiresAtMs).toBe(original.observedAt + 600_000);
		expect(
			store.profiles[requireDefinedTestFixtureValue(store.writers[binding.writerId].codexConfigurationProfileId)]
				.fields[modelFieldKey].value,
		).toBe("initial-model");
		await mutateCodexConfigurationSyncStore((latest) => {
			const source = latest.writers[binding.writerId];
			mergeObservedCodexConfigurationWriter(latest, source, {
				...source.lastObservedFields,
				[modelFieldKey]: { value: "new-local-model" },
			});
		});
		store = await readCodexConfigurationSyncStore();
		expect(store.changes.find((change) => change.changeId === original.changeId)?.mergeStatus).toBe("superseded");
		const newest = requireDefinedTestFixtureValue(store.changes.at(-1));
		expireCodexConfigurationProfileFeedbackSuggestions(
			store,
			requireDefinedTestFixtureValue(newest.feedbackExpiresAtMs),
		);
		expect(newest.approvalStatus).toBe("expired");
		expect(store.writers[binding.writerId].lastObservedFields[modelFieldKey].value).toBe("new-local-model");
	});
	it("profile 只清除明确更新字段的局部选择，休眠副本恢复前追上新版本", async () => {
		const binding = await writer("first");
		const configurationPath = join(binding.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		configuration.model = "local-model";
		configuration.model_reasoning_effort = "high";
		await writeFile(configurationPath, stringify(configuration));
		await mutateCodexConfigurationSyncStore((store) => {
			const source = store.writers[binding.writerId];
			mergeObservedCodexConfigurationWriter(store, source, {
				...source.lastObservedFields,
				[modelFieldKey]: { value: "local-model" },
				[effortFieldKey]: { value: "high" },
			});
			updateCodexConfigurationProfileFields(
				store,
				requireDefinedTestFixtureValue(source.codexConfigurationProfileId),
				{
					[ordinaryFieldKey]: { value: true },
				},
			);
		});
		const resumed = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			previousBinding: binding,
			workspaceId: "profiles-fixture",
			conversationSessionId: "first",
			runtimeSessionIncarnationId: randomUUID(),
		});
		let actual = parse(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8"));
		expect(actual.model).toBe("local-model");
		expect(actual.model_reasoning_effort).toBe("high");
		expect(actual.features).toEqual({ shell_snapshot: true });
		await mutateCodexConfigurationSyncStore((store) =>
			updateCodexConfigurationProfileFields(
				store,
				requireDefinedTestFixtureValue(store.writers[resumed.writerId].codexConfigurationProfileId),
				{
					[modelFieldKey]: { value: "profile-model" },
				},
			),
		);
		const restarted = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: sourceHome,
			previousBinding: resumed,
			workspaceId: "profiles-fixture",
			conversationSessionId: "first",
			runtimeSessionIncarnationId: randomUUID(),
		});
		actual = parse(await readFile(join(restarted.configurationHomeDirectoryPath, "config.toml"), "utf8"));
		expect(actual.model).toBe("profile-model");
		expect(actual.model_reasoning_effort).toBe("high");
	});
	it("跨 profile 复用同来源同定义的信任与撤销，启停各自保存", async () => {
		const first = await writer("first");
		const secondProfile = await mutateCodexConfigurationSyncStore((store) =>
			createCodexConfigurationProfile(store, {
				name: "默认禁用",
				copyFromProfileId: requireDefinedTestFixtureValue(
					store.writers[first.writerId].codexConfigurationProfileId,
				),
			}),
		);
		const second = await writer("second", secondProfile.profileId);
		const hookFieldKey = JSON.stringify(["config.toml", "hooks", "state", `${sourceHome}/hooks.json:stop:0:0`]);
		await mutateCodexConfigurationSyncStore((store) => {
			store.profiles[secondProfile.profileId].fields[hookFieldKey] = {
				value: { enabled: false },
				definitionDigest: "same-definition",
			};
			const source = store.writers[first.writerId];
			mergeObservedCodexConfigurationWriter(store, source, {
				...source.lastObservedFields,
				[hookFieldKey]: {
					value: { enabled: true, trusted_hash: "confirmed-native-hash" },
					definitionDigest: "same-definition",
				},
			});
		});
		let store = await readCodexConfigurationSyncStore();
		expect(store.profiles[secondProfile.profileId].fields[hookFieldKey].value).toEqual({
			enabled: false,
			trusted_hash: "confirmed-native-hash",
		});
		expect(store.changes.some((change) => change.targets.some((target) => target.writerId === second.writerId))).toBe(
			true,
		);
		await mutateCodexConfigurationSyncStore((latest) => {
			const source = latest.writers[first.writerId];
			mergeObservedCodexConfigurationWriter(latest, source, {
				...source.lastObservedFields,
				[hookFieldKey]: { value: { enabled: true }, definitionDigest: "same-definition" },
			});
		});
		store = await readCodexConfigurationSyncStore();
		expect(store.profiles[secondProfile.profileId].fields[hookFieldKey].value).toEqual({ enabled: false });
	});
	it("明确反馈一次同时更新 profile 并登记传播，重复请求重放回执", async () => {
		const binding = await writer("first");
		const second = await writer("second");
		const path = join(binding.configurationHomeDirectoryPath, "config.toml");
		await writeFile(path, stringify({ ...parse(await readFile(path, "utf8")), model: "feedback-model" }));
		const sync = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await sync.scan();
			const before = await sync.getState();
			const suggestion = requireDefinedTestFixtureValue(
				before.changes.find((change) => change.approvalStatus === "pending"),
			);
			expect(before.profiles?.[0]?.fields.find((field) => field.fieldKey === modelFieldKey)?.value).toBe(
				"initial-model",
			);
			const input = {
				action: "approve" as const,
				items: [
					{
						entryKind: "settings_proposal" as const,
						changeId: suggestion.changeId,
						expectedVersion: suggestion.version,
						idempotencyKey: randomUUID(),
					},
				],
			};
			const accepted = await sync.batchAction(input);
			expect(accepted.results[0]?.status).toBe("applied");
			expect((await sync.batchAction(input)).results[0]?.status).toBe("replayed");
			expect(
				accepted.state.changes
					.find((change) => change.changeId === suggestion.changeId)
					?.targets.some((target) => target.writerId === second.writerId),
			).toBe(true);
			expect(accepted.state.profiles?.[0]?.fields.find((field) => field.fieldKey === modelFieldKey)?.value).toBe(
				"feedback-model",
			);
			const future = await writer("future");
			expect(parse(await readFile(join(future.configurationHomeDirectoryPath, "config.toml"), "utf8")).model).toBe(
				"feedback-model",
			);
		} finally {
			await sync.close();
		}
	});
	it("运行时重启后的过期建议不能反馈，权限按完整字段组产生一个建议", async () => {
		const binding = await writer("first");
		const path = join(binding.configurationHomeDirectoryPath, "config.toml");
		await writeFile(
			path,
			stringify({
				...parse(await readFile(path, "utf8")),
				approval_policy: "on-request",
				sandbox_mode: "workspace-write",
				sandbox_workspace_write: { network_access: false },
			}),
		);
		const sync = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		await sync.scan();
		const before = await sync.getState();
		await sync.close();
		const suggestion = requireDefinedTestFixtureValue(
			before.changes.find((change) => change.exceptionGroup === "permissions"),
		);
		expect(before.changes.filter((change) => change.approvalStatus === "pending")).toHaveLength(1);
		await mutateCodexConfigurationSyncStore((store) => {
			const change = requireDefinedTestFixtureValue(
				store.changes.find((change) => change.changeId === suggestion.changeId),
			);
			expect(Object.keys(change.relatedFields ?? {})).toHaveLength(3);
			change.feedbackExpiresAtMs = Date.now() - 1;
		});
		const restarted = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			const result = await restarted.batchAction({
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
			expect(result.results[0]?.status).not.toBe("applied");
			expect(result.state.changes.find((change) => change.changeId === suggestion.changeId)?.approvalStatus).toBe(
				"expired",
			);
			expect(parse(await readFile(path, "utf8")).approval_policy).toBe("on-request");
			expect(result.state.profiles?.[0]?.fields.some((field) => field.fieldLabel === "approval_policy")).toBe(false);
		} finally {
			await restarted.close();
		}
	});

	it("权限组的新 profile 决定结束旧反馈，旧完整权限组不能覆盖已接受值", async () => {
		const binding = await writer("permission-group-stale-feedback");
		const path = join(binding.configurationHomeDirectoryPath, "config.toml");
		await writeFile(path, 'approval_policy="never"\nsandbox_mode="workspace-write"\n');
		const sync = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			await sync.scan();
			const suggestion = requireDefinedTestFixtureValue(
				(await sync.getState()).changes.find(
					(change) => change.exceptionGroup === "permissions" && change.approvalStatus === "pending",
				),
			);
			const profileId = requireDefinedTestFixtureValue(binding.codexConfigurationProfileId);
			await mutateCodexConfigurationSyncStore((store) =>
				updateCodexConfigurationProfileFields(store, profileId, {
					[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "read-only" },
				}),
			);
			const result = await sync.batchAction({
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
			expect(result.results[0]?.status).toBe("stale_version");
			expect(result.state.profiles?.find((profile) => profile.profileId === profileId)?.fields).toEqual(
				expect.arrayContaining([expect.objectContaining({ fieldLabel: "sandbox_mode", value: "read-only" })]),
			);
			expect(result.state.changes.find((change) => change.changeId === suggestion.changeId)?.mergeStatus).toBe(
				"superseded",
			);
		} finally {
			await sync.close();
		}
	});
	it("同一字段 A 到 B 再到 A 时，旧的 A 操作仍然失效", async () => {
		const binding = await writer("first");
		await mutateCodexConfigurationSyncStore((store) => {
			const profileId = requireDefinedTestFixtureValue(store.writers[binding.writerId].codexConfigurationProfileId);
			updateCodexConfigurationProfileFields(store, profileId, { [ordinaryFieldKey]: { value: true } });
			const original = requireDefinedTestFixtureValue(store.changes.at(-1));
			updateCodexConfigurationProfileFields(store, profileId, { [ordinaryFieldKey]: { value: false } });
			updateCodexConfigurationProfileFields(store, profileId, { [ordinaryFieldKey]: { value: true } });
			expect(isCodexConfigurationSourceObservationStillCurrent(store, original)).toBe(false);
			expect(
				isCodexConfigurationSourceObservationStillCurrent(
					store,
					requireDefinedTestFixtureValue(store.changes.at(-1)),
				),
			).toBe(true);
		});
	});
	it("升级只继承已采用值，旧待审批转历史且不改 writer 清单", async () => {
		const binding = await writer("first");
		const manifest = join(binding.configurationHomeDirectoryPath, "..", "writer-binding.json");
		const manifestBefore = await readFile(manifest, "utf8");
		await mutateCodexConfigurationSyncStore((store) => {
			const source = store.writers[binding.writerId];
			mergeObservedCodexConfigurationWriter(store, source, {
				...source.lastObservedFields,
				[modelFieldKey]: { value: "unapproved-local" },
			});
			store.schemaVersion = 2;
			store.profiles = {};
			store.defaultCodexConfigurationProfileId = null;
		});
		const migrated = await readCodexConfigurationSyncStore();
		expect(migrated.schemaVersion).toBe(3);
		expect(migrated.changes.every((change) => change.approvalStatus !== "pending")).toBe(true);
		expect(Object.values(migrated.profiles)[0]?.fields[modelFieldKey]?.value).toBe("initial-model");
		expect(migrated.writers[binding.writerId].localExceptionOverrides?.model?.fields[modelFieldKey]?.value).toBe(
			"unapproved-local",
		);
		expect(await readFile(manifest, "utf8")).toBe(manifestBefore);
	});
	it("完整权限覆盖会移除旧旗标，并保留非权限参数和显式沙箱限制", () => {
		const result = buildCodexArgumentsUsingCompleteProfilePermissions(
			[
				"--dangerously-bypass-approvals-and-sandbox",
				"-a=never",
				"-s",
				"danger-full-access",
				"-c",
				'approval_policy="never"',
				"--model",
				"local-model",
				"-c",
				"features.shell_snapshot=true",
			],
			{
				[JSON.stringify(["config.toml", "approval_policy"])]: { value: "on-request" },
				[JSON.stringify(["config.toml", "sandbox_mode"])]: { value: "read-only" },
				[JSON.stringify(["config.toml", "sandbox_workspace_write", "network_access"])]: { value: false },
			},
		);
		expect(result).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(result).toContain('approval_policy="on-request"');
		expect(result).toContain('sandbox_mode="read-only"');
		expect(result).toContain("sandbox_workspace_write.network_access=false");
		const plan = prepareCodexRemoteConversationLaunchPlan(
			[...(result ?? []), "resume", "known-native-session"],
			fixture.path,
		);
		expect(plan?.nativeThreadRequestOverrides).toMatchObject({
			approvalPolicy: "on-request",
			sandbox: "read-only",
			model: "local-model",
			config: { "sandbox_workspace_write.network_access": false },
		});
		expect(result).toContain("local-model");
		expect(result).toContain("features.shell_snapshot=true");
	});
	it("续接窗口的新输入持久保存，重读后保留原身份与原始字节", () => {
		const path = createCodexProfileAdoptionRetainedInput({
			workspaceId: "profiles-fixture",
			conversationSessionId: "first",
			nativeSessionId: randomUUID(),
			profileId: "compatible",
		});
		appendCodexProfileAdoptionRetainedInput(path, Buffer.from("新的草稿"));
		appendCodexProfileAdoptionRetainedInput(path, Buffer.from("\r"));
		expect(listUnrestoredCodexProfileAdoptionRetainedInput().map((entry) => entry.path)).toContain(path);
		expect(Buffer.from(readCodexProfileAdoptionRetainedInput(path).bytesBase64, "base64").toString()).toBe(
			"新的草稿\r",
		);
		expect(readCodexProfileAdoptionRetainedInput(path).status).toBe("capturing");
	});
});
