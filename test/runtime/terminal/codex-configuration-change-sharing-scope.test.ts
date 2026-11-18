import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	codexConfigurationPropagationReceiptBelongsToCurrentTarget,
	retainProtectedTargetDecisionAfterRejectedCompensation,
} from "../../../src/codex-configuration-sync/codex-configuration-change-sharing-scope";
import * as configurationProposalApproval from "../../../src/codex-configuration-sync/codex-configuration-proposal-approval";
import {
	type CodexConfigurationSyncService,
	createCodexConfigurationSyncService,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { requireDefinedTestFixtureValue } from "../../utilities/require-defined-test-fixture-value";
import { createTempDir } from "../../utilities/temp-dir";

const renderingFieldKey = JSON.stringify(["config.toml", "tui", "alternate_screen"]);
let fixture: ReturnType<typeof createTempDir>;
let sourceHome: string;
let sync: CodexConfigurationSyncService;
beforeEach(async () => {
	fixture = createTempDir("codex-change-sharing-scope-");
	fixture.path = await realpath(fixture.path);
	sourceHome = join(fixture.path, "isolated-codex-home");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceHome);
	await mkdir(sourceHome);
	await writeFile(
		join(sourceHome, "config.toml"),
		stringify({ model: "initial-model", tui: { alternate_screen: "always" } }),
	);
	sync = createCodexConfigurationSyncService({
		getSessionSummary: () => null,
		listSessions: () => [],
		onUpdated: () => {},
	});
});
afterEach(async () => {
	await sync.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
const prepareWriter = (
	conversationSessionId: string,
	previousBinding?: Awaited<ReturnType<typeof prepareCodexConfigurationWriterBinding>>,
) =>
	prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		workspaceId: "scope-fixture",
		conversationSessionId,
		runtimeSessionIncarnationId: randomUUID(),
		previousBinding,
	});
async function changeRendering(binding: Awaited<ReturnType<typeof prepareWriter>>, value: string) {
	const path = join(binding.configurationHomeDirectoryPath, "config.toml");
	const configuration = parse(await readFile(path, "utf8"));
	configuration.tui = { alternate_screen: value };
	await writeFile(path, stringify(configuration));
	await sync.scan();
	return requireDefinedTestFixtureValue(
		(await sync.getState()).changes.find(
			(change) => change.sourceWriterId === binding.writerId && change.fieldKey === renderingFieldKey,
		),
	);
}

describe("单次 Codex 配置共享范围", () => {
	it("等待来源证据期间可撤销尚未执行的范围请求，不要求先恢复来源", async () => {
		const source = await prepareWriter("source");
		const change = await changeRendering(source, "never");
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[source.writerId].retiredAt = Date.now();
		});
		const pending = await sync.setChangeSharingScope({
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		const current = requireDefinedTestFixtureValue(
			pending.changes.find((entry) => entry.changeId === change.changeId),
		);
		await sync.setChangeSharingScope({
			changeId: current.changeId,
			expectedVersion: current.version,
			targetScope: "profile",
			idempotencyKey: randomUUID(),
		});
		await sync.scan();
		const record = requireDefinedTestFixtureValue(
			(await readCodexConfigurationSyncStore()).changes.find((entry) => entry.changeId === change.changeId),
		);
		expect(record.pendingSharingScopeMutation).toBeUndefined();
		expect(record.changeSharingScope).toMatchObject({
			currentScope: "profile",
			requestedScope: "profile",
			withdrawalStatus: "not_requested",
		});
	});
	it("来源在扫描与提交之间再次修改时，锁内重读拒绝旧范围请求", async () => {
		const source = await prepareWriter("source");
		const change = await changeRendering(source, "never");
		const prepare = configurationProposalApproval.prepareCodexConfigurationProposalIdentityVolumeObservations;
		vi.spyOn(
			configurationProposalApproval,
			"prepareCodexConfigurationProposalIdentityVolumeObservations",
		).mockImplementationOnce(async (ids) => {
			await prepare(ids);
			const path = join(source.configurationHomeDirectoryPath, "config.toml");
			const current = parse(await readFile(path, "utf8"));
			current.tui = { alternate_screen: "auto" };
			await writeFile(path, stringify(current));
		});
		await expect(
			sync.setChangeSharingScope({
				changeId: change.changeId,
				expectedVersion: change.version,
				targetScope: "session_only",
				idempotencyKey: randomUUID(),
			}),
		).rejects.toThrow("来源已有较新修改");
		await sync.scan();
		expect(
			(await readCodexConfigurationSyncStore()).profiles[source.codexConfigurationProfileId ?? ""].fields[
				renderingFieldKey
			]?.value,
		).toBe("auto");
	});
	it("来源暂缺归属时持久受理请求，跨重启限制重试，同一原生会话继承证据恢复后自动完成", async () => {
		const source = await prepareWriter("source");
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[source.writerId].nativeConversationSessionId = "original-native";
		});
		const change = await changeRendering(source, "never");
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[source.writerId].retiredAt = Date.now();
		});
		const request = {
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "session_only" as const,
			idempotencyKey: randomUUID(),
		};
		const pending = await sync.setChangeSharingScope(request);
		expect(pending.changes.find((entry) => entry.changeId === change.changeId)?.changeSharingScope).toMatchObject({
			currentScope: "profile",
			requestedScope: "session_only",
			withdrawalStatus: "pending",
		});
		await sync.close();
		sync = createCodexConfigurationSyncService({
			getSessionSummary: () => null,
			listSessions: () => [],
			onUpdated: () => {},
		});
		for (let retry = 0; retry < 5; retry++) await sync.scan();
		expect(
			(await readCodexConfigurationSyncStore()).changes.find((entry) => entry.changeId === change.changeId)
				?.sharingScopeRecoveryAttemptCount,
		).toBe(3);
		const continuing = await prepareWriter("source", source);
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[continuing.writerId].nativeConversationSessionId = "original-native";
		});
		await sync.scan();
		const restored = await readCodexConfigurationSyncStore();
		expect(restored.changes.find((entry) => entry.changeId === change.changeId)?.changeSharingScope).toMatchObject({
			currentScope: "session_only",
			withdrawalStatus: "completed",
		});
		expect(restored.profiles[continuing.codexConfigurationProfileId ?? ""].fields[renderingFieldKey]?.value).toBe(
			"always",
		);
	});
	it("来源会话后续 A→B→A 修改不能借旧记录改动本次范围", async () => {
		const source = await prepareWriter("source");
		const first = await changeRendering(source, "never");
		await changeRendering(source, "auto");
		await changeRendering(source, "never");
		await expect(
			sync.setChangeSharingScope({
				changeId: first.changeId,
				expectedVersion: first.version,
				targetScope: "session_only",
				idempotencyKey: randomUUID(),
			}),
		).rejects.toThrow("来源已有较新修改");
	});
	it("完整权限组双向切换时同时恢复审批、沙箱与写入配置", async () => {
		const source = await prepareWriter("source");
		const configurationPath = join(source.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		Object.assign(configuration, {
			approval_policy: "never",
			sandbox_mode: "danger-full-access",
			sandbox_workspace_write: { network_access: true },
		});
		await writeFile(configurationPath, stringify(configuration));
		await sync.scan();
		let change = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.exceptionGroup === "permissions"),
		);
		await sync.setChangeSharingScope({
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "profile",
			idempotencyKey: randomUUID(),
		});
		let store = await readCodexConfigurationSyncStore();
		const profileId = source.codexConfigurationProfileId ?? "";
		expect(store.profiles[profileId].fields[JSON.stringify(["config.toml", "approval_policy"])]?.value).toBe("never");
		expect(store.profiles[profileId].fields[JSON.stringify(["config.toml", "sandbox_mode"])]?.value).toBe(
			"danger-full-access",
		);
		change = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find(
				(entry) =>
					entry.sharingScope === "profile" && entry.fieldKey === JSON.stringify(["config.toml", "sandbox_mode"]),
			),
		);
		await sync.setChangeSharingScope({
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		store = await readCodexConfigurationSyncStore();
		for (const key of ["approval_policy", "sandbox_mode", "sandbox_workspace_write"])
			expect(Object.keys(store.profiles[profileId].fields).some((fieldKey) => fieldKey.includes(key))).toBe(false);
		const resumed = await prepareWriter("source", source);
		expect(parse(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8"))).toMatchObject({
			approval_policy: "never",
			sandbox_mode: "danger-full-access",
			sandbox_workspace_write: { network_access: true },
		});
	});
	it("自动共享可撤回，来源保留局部值且正常续接后下一次修改恢复默认共享", async () => {
		const source = await prepareWriter("source");
		const target = await prepareWriter("target");
		const change = await changeRendering(source, "never");
		const request = {
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "session_only" as const,
			idempotencyKey: randomUUID(),
		};
		await sync.setChangeSharingScope(request);
		await sync.setChangeSharingScope(request);
		const store = await readCodexConfigurationSyncStore();
		const profile =
			store.profiles[requireDefinedTestFixtureValue(store.writers[source.writerId].codexConfigurationProfileId)];
		expect(profile.fields[renderingFieldKey]?.value).toBe("always");
		expect(
			store.changes
				.find((entry) => entry.changeId === change.changeId)
				?.targets.find((entry) => entry.writerId === target.writerId)?.status,
		).toBe("not_applicable");
		const resumed = await prepareWriter("source", source);
		expect(
			parse(await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8")).tui,
		).toMatchObject({ alternate_screen: "never" });
		await changeRendering(resumed, "auto");
		const next = await readCodexConfigurationSyncStore();
		expect(next.profiles[profile.profileId].fields[renderingFieldKey]?.value).toBe("auto");
	});
	it("局部模型分享后可撤回完整值，反馈过期后仍能切换本次范围", async () => {
		const source = await prepareWriter("source");
		const path = join(source.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(path, "utf8"));
		configuration.model = "local-model";
		await writeFile(path, stringify(configuration));
		await sync.scan();
		let change = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.sourceWriterId === source.writerId),
		);
		await mutateCodexConfigurationSyncStore((store) => {
			requireDefinedTestFixtureValue(
				store.changes.find((entry) => entry.changeId === change.changeId),
			).feedbackExpiresAtMs = Date.now() - 1;
		});
		await sync.scan();
		change = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.changeId === change.changeId),
		);
		await sync.setChangeSharingScope({
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "profile",
			idempotencyKey: randomUUID(),
		});
		const shared = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.changeId === change.changeId),
		);
		expect(shared.changeSharingScope?.currentScope).toBe("profile");
		await sync.setChangeSharingScope({
			changeId: shared.changeId,
			expectedVersion: shared.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		const store = await readCodexConfigurationSyncStore();
		expect(
			store.profiles[requireDefinedTestFixtureValue(store.writers[source.writerId].codexConfigurationProfileId)]
				.fields[JSON.stringify(["config.toml", "model"])]?.value,
		).toBe("initial-model");
	});
	it("较新 profile 决定即使 A→B→A 同值也不被旧撤回覆盖", async () => {
		const source = await prepareWriter("source");
		const another = await prepareWriter("another");
		const original = await changeRendering(source, "never");
		await changeRendering(another, "auto");
		await changeRendering(another, "never");
		const current = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.changeId === original.changeId),
		);
		await sync.setChangeSharingScope({
			changeId: current.changeId,
			expectedVersion: current.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		const store = await readCodexConfigurationSyncStore();
		expect(
			store.profiles[requireDefinedTestFixtureValue(store.writers[source.writerId].codexConfigurationProfileId)]
				.fields[renderingFieldKey]?.value,
		).toBe("never");
		expect(
			(await sync.getState()).changes.find((entry) => entry.changeId === current.changeId)?.changeSharingScope
				?.conflicts.length,
		).toBeGreaterThan(0);
	});
	it("权限组未观察字段的后续版本不能借缺键跳过 A→B→A", async () => {
		const source = await prepareWriter("source");
		const configurationPath = join(source.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		Object.assign(configuration, {
			approval_policy: "never",
			sandbox_mode: "danger-full-access",
		});
		await writeFile(configurationPath, stringify(configuration));
		await sync.scan();
		const change = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.exceptionGroup === "permissions"),
		);
		const sandboxKey = JSON.stringify(["config.toml", "sandbox_mode"]);
		await mutateCodexConfigurationSyncStore((store) => {
			const entry = requireDefinedTestFixtureValue(
				store.changes.find((candidate) => candidate.changeId === change.changeId),
			);
			entry.sourceFieldMutationVersionsAtObservation = {
				[JSON.stringify(["config.toml", "approval_policy"])]: 0,
			};
			const writer = store.writers[source.writerId];
			writer.localFieldMutationVersions = {
				...(writer.localFieldMutationVersions ?? {}),
				[sandboxKey]: 2,
			};
		});
		const current = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.changeId === change.changeId),
		);
		await expect(
			sync.setChangeSharingScope({
				changeId: current.changeId,
				expectedVersion: current.version,
				targetScope: "profile",
				idempotencyKey: randomUUID(),
			}),
		).rejects.toThrow("来源已有较新修改");
	});
	it("尚未执行的目标在撤回后恢复分享前的局部覆盖", async () => {
		const source = await prepareWriter("source");
		const target = await prepareWriter("target");
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[target.writerId].localExceptionOverrides = {
				[renderingFieldKey]: {
					profileVersionAtSelection: 0,
					fields: { [renderingFieldKey]: { value: "auto" } },
				},
			};
		});
		const change = await changeRendering(source, "never");
		const current = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.changeId === change.changeId),
		);
		await sync.setChangeSharingScope({
			changeId: current.changeId,
			expectedVersion: current.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		const store = await readCodexConfigurationSyncStore();
		expect(
			store.writers[target.writerId].localExceptionOverrides?.[renderingFieldKey]?.fields[renderingFieldKey]?.value,
		).toBe("auto");
		const resumed = await prepareWriter("target", target);
		const resumedConfiguration = parse(
			await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8"),
		);
		expect(resumedConfiguration.tui).toEqual({ alternate_screen: "auto" });
	});
	it("删除字段的补偿被拒绝后，正常续接保留目标后续新值", async () => {
		const source = await prepareWriter("source");
		const target = await prepareWriter("target");
		const change = await changeRendering(source, "never");
		await mutateCodexConfigurationSyncStore((store) => {
			const writer = store.writers[target.writerId];
			writer.localExceptionOverrides = {
				[renderingFieldKey]: {
					profileVersionAtSelection: store.profiles[target.codexConfigurationProfileId ?? ""].version,
					fields: {},
					deletedFieldKeys: [renderingFieldKey],
				},
			};
			const compensation = requireDefinedTestFixtureValue(
				store.changes.find((entry) => entry.changeId === change.changeId),
			);
			retainProtectedTargetDecisionAfterRejectedCompensation(
				writer,
				{ ...compensation, compensationForChangeId: change.changeId, value: undefined },
				{ [renderingFieldKey]: { value: "never" } },
			);
		});
		const resumed = await prepareWriter("target", target);
		const resumedConfiguration = parse(
			await readFile(join(resumed.configurationHomeDirectoryPath, "config.toml"), "utf8"),
		);
		expect(resumedConfiguration.tui).toEqual({ alternate_screen: "never" });
	});
	it("任务局部权限分享后再撤回，续接来源保持 task_local", async () => {
		const source = await prepareWriter("source");
		const configurationPath = join(source.configurationHomeDirectoryPath, "config.toml");
		const configuration = parse(await readFile(configurationPath, "utf8"));
		configuration.approval_policy = "never";
		await writeFile(configurationPath, stringify(configuration));
		await sync.scan();
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[source.writerId].taskPermissionSelectionSourceAtLaunch = "task_local";
		});
		const change = requireDefinedTestFixtureValue(
			(await sync.getState()).changes.find((entry) => entry.exceptionGroup === "permissions"),
		);
		const shared = await sync.setChangeSharingScope({
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "profile",
			idempotencyKey: randomUUID(),
		});
		const sharedChange = requireDefinedTestFixtureValue(
			shared.changes.find((entry) => entry.changeId === change.changeId),
		);
		await sync.setChangeSharingScope({
			changeId: sharedChange.changeId,
			expectedVersion: sharedChange.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		const store = await readCodexConfigurationSyncStore();
		expect(store.writers[source.writerId].pendingSessionProfileBinding).toMatchObject({
			onlyUpdatePermissionSelectionSource: true,
			permissionSelectionSource: "task_local",
		});
	});
	it("受保护补偿被拒绝后保留目标的新决定，迟到回执不能认领新的传播代", () => {
		const fieldKey = renderingFieldKey;
		const writer = {
			localExceptionOverrides: {
				[fieldKey]: {
					profileVersionAtSelection: 1,
					fields: { [fieldKey]: { value: "always" } },
				},
			},
		} as Parameters<typeof retainProtectedTargetDecisionAfterRejectedCompensation>[0];
		retainProtectedTargetDecisionAfterRejectedCompensation(
			writer,
			{ compensationForChangeId: "shared", fieldKey, value: { value: "always" } } as Parameters<
				typeof retainProtectedTargetDecisionAfterRejectedCompensation
			>[1],
			{ [fieldKey]: { value: "never" } },
		);
		expect(writer.localExceptionOverrides?.[fieldKey]?.fields[fieldKey]?.value).toBe("never");
		expect(
			codexConfigurationPropagationReceiptBelongsToCurrentTarget({
				capturedAcceptedProfileFieldVersion: 4,
				currentAcceptedProfileFieldVersion: 9,
				capturedTargetAcceptedAt: 10,
				currentTargetAcceptedAt: 10,
			}),
		).toBe(false);
		expect(
			codexConfigurationPropagationReceiptBelongsToCurrentTarget({
				capturedAcceptedProfileFieldVersion: 4,
				currentAcceptedProfileFieldVersion: 4,
				capturedTargetAcceptedAt: 10,
				currentTargetAcceptedAt: 11,
			}),
		).toBe(false);
	});
	it("期望版本与幂等键保护不同意图，回执可在服务重启后核验", async () => {
		const source = await prepareWriter("source");
		const change = await changeRendering(source, "never");
		const input = {
			changeId: change.changeId,
			expectedVersion: change.version,
			targetScope: "session_only" as const,
			idempotencyKey: randomUUID(),
		};
		await sync.setChangeSharingScope(input);
		await sync.close();
		sync = createCodexConfigurationSyncService({
			getSessionSummary: () => null,
			listSessions: () => [],
			onUpdated: () => {},
		});
		expect(
			await sync.getMutationReceipt({ idempotencyKey: input.idempotencyKey, expectedSharingScopeMutation: input }),
		).toMatchObject({ changeId: change.changeId });
		await expect(sync.setChangeSharingScope({ ...input, targetScope: "profile" })).rejects.toThrow("幂等");
		await expect(
			sync.setChangeSharingScope({ ...input, targetScope: "profile", idempotencyKey: randomUUID() }),
		).rejects.toThrow("版本");
	});
});
