import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoredCodexConfigurationChangeSharingScope } from "../../../src/codex-configuration-sync/codex-configuration-change-sharing-scope";
import type { CodexConfigurationFieldValue } from "../../../src/codex-configuration-sync/codex-configuration-field-projection";
import {
	reuseConfirmedCodexHookTrust,
	shareObservedCodexHookTrust,
	updateCodexConfigurationProfileFields,
} from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import {
	type CodexConfigurationSyncStore,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { requireDefinedTestFixtureValue } from "../../utilities/require-defined-test-fixture-value";
import { createTempDir } from "../../utilities/temp-dir";

const pluginHookSourceKey = "ponytail@fixture-marketplace:hooks/hooks.json:user_prompt_submit:0:0";
const ordinaryHookSourceKey = "/fixture/hooks.json:user_prompt_submit:0:0";
const confirmedHookTrustState = { trusted_hash: "sha256:definition", trusted_content_hash: "sha256:content" };
const observedHookStateField = (
	value: unknown,
	definitionDigest = "same-definition",
): CodexConfigurationFieldValue => ({ value, definitionDigest });
let isolatedConfigurationFixture: ReturnType<typeof createTempDir>;
let sourceConfigurationHomeDirectoryPath: string;

beforeEach(async () => {
	isolatedConfigurationFixture = createTempDir("codex-hook-trust-sharing-boundaries-");
	isolatedConfigurationFixture.path = await realpath(isolatedConfigurationFixture.path);
	vi.stubEnv("HOME", isolatedConfigurationFixture.path);
	sourceConfigurationHomeDirectoryPath = join(isolatedConfigurationFixture.path, ".codex");
	vi.stubEnv("CODEX_HOME", sourceConfigurationHomeDirectoryPath);
	vi.stubEnv("CODEX_SQLITE_HOME", sourceConfigurationHomeDirectoryPath);
	await mkdir(sourceConfigurationHomeDirectoryPath);
	await writeFile(join(sourceConfigurationHomeDirectoryPath, "config.toml"), 'model="fixture-model"\n');
});
afterEach(() => {
	vi.unstubAllEnvs();
	isolatedConfigurationFixture.cleanup();
});

async function createHookTrustSharingFixture(
	hookSourceKey = pluginHookSourceKey,
	targetHookTrustState: Record<string, unknown> = { enabled: false },
) {
	const writerBinding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceConfigurationHomeDirectoryPath,
		workspaceId: "hook-trust-sharing-fixture",
		conversationSessionId: randomUUID(),
		runtimeSessionIncarnationId: randomUUID(),
	});
	const configurationSyncStore = await readCodexConfigurationSyncStore();
	const originWriter = configurationSyncStore.writers[writerBinding.writerId];
	const originProfileId = requireDefinedTestFixtureValue(originWriter.codexConfigurationProfileId);
	const originProfile = configurationSyncStore.profiles[originProfileId];
	const hookStateFieldKey = JSON.stringify(["config.toml", "hooks", "state", hookSourceKey]);
	configurationSyncStore.profiles = Object.fromEntries(
		[originProfileId, "fixture-target-profile"].map((profileId) => [
			profileId,
			{
				...structuredClone(originProfile),
				profileId,
				fields: { [hookStateFieldKey]: observedHookStateField({ ...targetHookTrustState }) },
				fieldVersions: {},
			},
		]),
	);
	configurationSyncStore.hookTrustDecisions = {};
	configurationSyncStore.changes = [];
	return { configurationSyncStore, originWriter, hookStateFieldKey, sourceIdentity: writerBinding.sourceIdentity };
}

function onlyHookTrustDecision(configurationSyncStore: CodexConfigurationSyncStore) {
	expect(Object.keys(configurationSyncStore.hookTrustDecisions)).toHaveLength(1);
	return Object.values(configurationSyncStore.hookTrustDecisions)[0];
}

describe("跨 profile hook 信任的定义与内容边界", () => {
	it("跨 profile 撤回已采用目标时，只核验目标所属 profile 的字段版本", async () => {
		const fixture = await createHookTrustSharingFixture();
		const store = fixture.configurationSyncStore;
		const target = structuredClone(fixture.originWriter);
		target.binding.writerId = randomUUID();
		target.binding.conversationSessionId = randomUUID();
		target.codexConfigurationProfileId = "fixture-target-profile";
		target.lastObservedFields[fixture.hookStateFieldKey] = observedHookStateField({ enabled: false });
		store.writers[target.binding.writerId] = target;
		updateCodexConfigurationProfileFields(
			store,
			requireDefinedTestFixtureValue(fixture.originWriter.codexConfigurationProfileId),
			{ [fixture.hookStateFieldKey]: observedHookStateField(confirmedHookTrustState) },
			{ sourceWriterId: fixture.originWriter.binding.writerId, recordIdenticalFields: true },
		);
		shareObservedCodexHookTrust(
			store,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({ enabled: false }),
			observedHookStateField(confirmedHookTrustState),
		);
		const sourceChange = requireDefinedTestFixtureValue(
			store.changes.find((entry) => entry.sourceWriterId === fixture.originWriter.binding.writerId),
		);
		const targetChange = requireDefinedTestFixtureValue(
			store.changes.find((entry) => entry.codexConfigurationProfileId === target.codexConfigurationProfileId),
		);
		const targetReceipt = requireDefinedTestFixtureValue(
			targetChange.targets.find((entry) => entry.writerId === target.binding.writerId),
		);
		targetReceipt.status = "applied";
		targetReceipt.diskSavedAt = Date.now();
		target.lastObservedFields[fixture.hookStateFieldKey] = requireDefinedTestFixtureValue(targetChange.value);
		fixture.originWriter.lastObservedFields[fixture.hookStateFieldKey] =
			observedHookStateField(confirmedHookTrustState);
		fixture.originWriter.localFieldMutationVersions = { ...sourceChange.sourceFieldMutationVersionsAtObservation };
		setStoredCodexConfigurationChangeSharingScope(store, {
			changeId: sourceChange.changeId,
			expectedVersion: sourceChange.version,
			targetScope: "session_only",
			idempotencyKey: randomUUID(),
		});
		const compensation = store.changes.find(
			(entry) =>
				entry.compensationForChangeId === targetChange.changeId &&
				entry.targets.some((receipt) => receipt.writerId === target.binding.writerId),
		);
		expect(compensation?.value?.value).toEqual({ enabled: false });
		expect(sourceChange.changeSharingScope?.conflicts).toEqual([]);
	});
	it("撤回来源 hook 信任时，同一范围组里的其他 profile 回到传播前决定", () => {
		const fixture = createHookTrustSharingFixture();
		return fixture.then((ready) => {
			updateCodexConfigurationProfileFields(
				ready.configurationSyncStore,
				requireDefinedTestFixtureValue(ready.originWriter.codexConfigurationProfileId),
				{ [ready.hookStateFieldKey]: observedHookStateField(confirmedHookTrustState) },
				{ sourceWriterId: ready.originWriter.binding.writerId, recordIdenticalFields: true },
			);
			shareObservedCodexHookTrust(
				ready.configurationSyncStore,
				ready.originWriter,
				ready.hookStateFieldKey,
				observedHookStateField({ enabled: false }),
				observedHookStateField(confirmedHookTrustState),
			);
			const sourceChange = requireDefinedTestFixtureValue(
				ready.configurationSyncStore.changes.find(
					(entry) => entry.sourceWriterId === ready.originWriter.binding.writerId,
				),
			);
			const propagated = ready.configurationSyncStore.changes.filter(
				(entry) => entry.sharingScope === "all_profiles_hook_trust",
			);
			expect(propagated.length).toBeGreaterThan(0);
			expect(propagated.every((entry) => entry.sharingScopeGroupId === sourceChange.sharingScopeGroupId)).toBe(true);
			ready.originWriter.lastObservedFields = {
				...ready.originWriter.lastObservedFields,
				[ready.hookStateFieldKey]: observedHookStateField(confirmedHookTrustState),
			};
			ready.originWriter.localFieldMutationVersions = {
				...(sourceChange.sourceFieldMutationVersionsAtObservation ?? {}),
			};
			setStoredCodexConfigurationChangeSharingScope(ready.configurationSyncStore, {
				changeId: sourceChange.changeId,
				expectedVersion: sourceChange.version,
				targetScope: "session_only",
				idempotencyKey: randomUUID(),
			});
			expect(
				ready.configurationSyncStore.profiles["fixture-target-profile"].fields[ready.hookStateFieldKey].value,
			).toEqual({ enabled: false });
			expect(onlyHookTrustDecision(ready.configurationSyncStore)?.trustedHash ?? null).toBeNull();
		});
	});
	it("完整确认同时保存和复用两个哈希，保留目标本地禁用", async () => {
		const fixture = await createHookTrustSharingFixture();
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({}),
			observedHookStateField(confirmedHookTrustState),
		);
		expect(
			fixture.configurationSyncStore.profiles["fixture-target-profile"].fields[fixture.hookStateFieldKey].value,
		).toEqual({ enabled: false, ...confirmedHookTrustState });
		expect(onlyHookTrustDecision(fixture.configurationSyncStore)).toMatchObject({
			trustedHash: confirmedHookTrustState.trusted_hash,
			trustedContentHash: confirmedHookTrustState.trusted_content_hash,
		});
	});
	it("仅内容重新确认也更新目录和其他 profile", async () => {
		const fixture = await createHookTrustSharingFixture();
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({ ...confirmedHookTrustState, trusted_content_hash: "previous-content" }),
			observedHookStateField(confirmedHookTrustState),
		);
		expect(onlyHookTrustDecision(fixture.configurationSyncStore).trustedContentHash).toBe(
			confirmedHookTrustState.trusted_content_hash,
		);
		expect(
			fixture.configurationSyncStore.profiles["fixture-target-profile"].fields[fixture.hookStateFieldKey].value,
		).toEqual({ enabled: false, ...confirmedHookTrustState });
	});
	it("未来 profile 的空白字段采用完整确认", async () => {
		const fixture = await createHookTrustSharingFixture();
		fixture.configurationSyncStore.profiles["fixture-target-profile"].fields = {};
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({}),
			observedHookStateField(confirmedHookTrustState),
		);
		expect(
			reuseConfirmedCodexHookTrust(
				fixture.configurationSyncStore,
				fixture.sourceIdentity,
				fixture.hookStateFieldKey,
				observedHookStateField({}),
			),
		).toEqual(observedHookStateField(confirmedHookTrustState));
	});
	it("真实存储 schema 往返后保留内容事实并供重新读取的 profile 采用", async () => {
		const fixture = await createHookTrustSharingFixture();
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({}),
			observedHookStateField(confirmedHookTrustState),
		);
		await mutateCodexConfigurationSyncStore((store) => Object.assign(store, fixture.configurationSyncStore));
		const reloadedStore = await readCodexConfigurationSyncStore();
		expect(onlyHookTrustDecision(reloadedStore).trustedContentHash).toBe(
			confirmedHookTrustState.trusted_content_hash,
		);
		expect(
			reuseConfirmedCodexHookTrust(
				reloadedStore,
				fixture.sourceIdentity,
				fixture.hookStateFieldKey,
				observedHookStateField({}),
			),
		).toEqual(observedHookStateField(confirmedHookTrustState));
	});
	it("旧正向记录缺内容事实时保留目标整组决定", async () => {
		const fixture = await createHookTrustSharingFixture();
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({}),
			observedHookStateField(confirmedHookTrustState),
		);
		delete onlyHookTrustDecision(fixture.configurationSyncStore).trustedContentHash;
		const targetHookField = observedHookStateField({
			enabled: false,
			trusted_hash: "other-definition",
			trusted_content_hash: "other-content",
		});
		expect(
			reuseConfirmedCodexHookTrust(
				fixture.configurationSyncStore,
				fixture.sourceIdentity,
				fixture.hookStateFieldKey,
				targetHookField,
			),
		).toEqual(targetHookField);
	});
	it("旧记录存储往返仍缺少内容事实，不用当前字段补造", async () => {
		const fixture = await createHookTrustSharingFixture();
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({}),
			observedHookStateField(confirmedHookTrustState),
		);
		delete onlyHookTrustDecision(fixture.configurationSyncStore).trustedContentHash;
		await mutateCodexConfigurationSyncStore((store) => Object.assign(store, fixture.configurationSyncStore));
		const reloadedStore = await readCodexConfigurationSyncStore();
		expect(onlyHookTrustDecision(reloadedStore)).not.toHaveProperty("trustedContentHash");
		expect(
			reuseConfirmedCodexHookTrust(
				reloadedStore,
				fixture.sourceIdentity,
				fixture.hookStateFieldKey,
				observedHookStateField({}),
			),
		).toEqual(observedHookStateField({}));
	});
	it("旧撤销决定仍清除两个信任字段", async () => {
		const fixture = await createHookTrustSharingFixture();
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField(confirmedHookTrustState),
			observedHookStateField({}),
		);
		delete onlyHookTrustDecision(fixture.configurationSyncStore).trustedContentHash;
		expect(
			reuseConfirmedCodexHookTrust(
				fixture.configurationSyncStore,
				fixture.sourceIdentity,
				fixture.hookStateFieldKey,
				observedHookStateField({ enabled: false, ...confirmedHookTrustState }),
			),
		).toEqual(observedHookStateField({ enabled: false }));
	});
	it.each(["source", "definition"])("不同 %s 身份不能复用确认", async (changedIdentity) => {
		const fixture = await createHookTrustSharingFixture();
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField({}),
			observedHookStateField(confirmedHookTrustState),
		);
		const targetHookField = observedHookStateField(
			{},
			changedIdentity === "definition" ? "changed-definition" : "same-definition",
		);
		expect(
			reuseConfirmedCodexHookTrust(
				fixture.configurationSyncStore,
				changedIdentity === "source" ? "other-source" : fixture.sourceIdentity,
				fixture.hookStateFieldKey,
				targetHookField,
			),
		).toEqual(targetHookField);
	});
	it.each(["definition", "enabled", "unchanged"])("仅 %s 变化不创建新的信任决定", async (changedField) => {
		const fixture = await createHookTrustSharingFixture();
		const previousHookField = observedHookStateField({ ...confirmedHookTrustState, enabled: true });
		const observedHookField = observedHookStateField(
			{ ...confirmedHookTrustState, enabled: changedField !== "enabled" },
			changedField === "definition" ? "changed-definition" : "same-definition",
		);
		const previousRevision = fixture.configurationSyncStore.revision;
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			previousHookField,
			observedHookField,
		);
		expect(fixture.configurationSyncStore.hookTrustDecisions).toEqual({});
		expect(fixture.configurationSyncStore.revision).toBe(previousRevision);
	});
	it.each([false, true])("撤销或删除完整确认清除两项信任，删除=%s", async (deleteState) => {
		const fixture = await createHookTrustSharingFixture(pluginHookSourceKey, {
			enabled: false,
			...confirmedHookTrustState,
		});
		shareObservedCodexHookTrust(
			fixture.configurationSyncStore,
			fixture.originWriter,
			fixture.hookStateFieldKey,
			observedHookStateField(confirmedHookTrustState),
			deleteState ? undefined : observedHookStateField({}),
		);
		expect(
			fixture.configurationSyncStore.profiles["fixture-target-profile"].fields[fixture.hookStateFieldKey].value,
		).toEqual({ enabled: false });
	});
	it.each([
		{
			hookSourceKey: pluginHookSourceKey,
			targetState: { enabled: false, ...confirmedHookTrustState },
			expectedState: { enabled: false, ...confirmedHookTrustState },
		},
		{ hookSourceKey: pluginHookSourceKey, targetState: { enabled: false }, expectedState: { enabled: false } },
		{
			hookSourceKey: ordinaryHookSourceKey,
			targetState: { enabled: false },
			expectedState: { enabled: false, trusted_hash: confirmedHookTrustState.trusted_hash },
		},
		{
			hookSourceKey: ordinaryHookSourceKey,
			targetState: { enabled: false, ...confirmedHookTrustState },
			expectedState: { enabled: false, ...confirmedHookTrustState },
		},
	])(
		"新观测的无内容正向决定不降级目标：$hookSourceKey，$targetState",
		async ({ hookSourceKey, targetState, expectedState }) => {
			const fixture = await createHookTrustSharingFixture(hookSourceKey, targetState);
			shareObservedCodexHookTrust(
				fixture.configurationSyncStore,
				fixture.originWriter,
				fixture.hookStateFieldKey,
				observedHookStateField(confirmedHookTrustState),
				observedHookStateField({ trusted_hash: confirmedHookTrustState.trusted_hash }),
			);
			expect(
				fixture.configurationSyncStore.profiles["fixture-target-profile"].fields[fixture.hookStateFieldKey].value,
			).toEqual(expectedState);
			expect(onlyHookTrustDecision(fixture.configurationSyncStore).trustedContentHash).toBeNull();
		},
	);
});
