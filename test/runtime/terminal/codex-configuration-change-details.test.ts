import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodexConfigurationTaskSourceContext,
	describeCodexConfigurationChange,
} from "../../../src/codex-configuration-sync/codex-configuration-change-presentation";
import { configurationDigest } from "../../../src/codex-configuration-sync/codex-configuration-field-projection";
import { mergeObservedCodexConfigurationWriter } from "../../../src/codex-configuration-sync/codex-configuration-incremental-merge";
import { updateCodexConfigurationProfileFields } from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	getCodexConfigurationSyncDirectory,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { requireDefinedTestFixtureValue } from "../../utilities/require-defined-test-fixture-value";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
beforeEach(async () => {
	fixture = createTempDir("codex-configuration-change-details-");
	fixture.path = await realpath(fixture.path);
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", join(fixture.path, ".codex"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, "isolated-sqlite"));
	await mkdir(join(fixture.path, ".codex"));
	await writeFile(join(fixture.path, ".codex/config.toml"), 'model="initial"\n');
});
afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

describe("配置记录的完整比较", () => {
	it.each(["subagent_start", "user_prompt_submit"])("%s 保留插件身份、冲突快照与当前共享值", async (event) => {
		const fieldKey = JSON.stringify([
			"config.toml",
			"hooks",
			"state",
			`ponytail@ponytail:hooks/hooks.json:${event}:0:0`,
		]);
		const shared = {
			value: { enabled: false, trusted_content_hash: "current-shared-fingerprint" },
			definitionDigest: "definition",
		};
		await mutateCodexConfigurationSyncStore((store) => {
			store.sources.source = {
				home: join(fixture.path, ".codex"),
				version: 1,
				fields: { [fieldKey]: shared },
				observedUserFields: {},
			};
			store.changes.push({
				changeId: "plugin-change",
				version: 1,
				sourceWriterId: "user-source:source",
				sourceIdentity: "source",
				fieldKey,
				previous: { value: { trusted_content_hash: "previous-fingerprint" }, definitionDigest: "definition" },
				value: { value: { trusted_content_hash: "detected-fingerprint" }, definitionDigest: "definition" },
				sharedValueAtConflict: {
					value: { enabled: true, trusted_content_hash: "conflicting-fingerprint" },
					definitionDigest: "definition",
				},
				mergeStatus: "conflict",
				recordKind: "settings_proposal",
				approvalStatus: "pending",
				observedAt: 1,
				acknowledgedAt: null,
				targets: [],
			});
		});
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			const change = requireDefinedTestFixtureValue((await service.getState()).changes[0]);
			expect(change.fieldLabel).toContain("ponytail@ponytail:hooks/hooks.json");
			expect(change.fieldLabel).toContain(event);
			expect(change.sourceEvidence?.initiator.status).toBe("unknown");
			expect(change.comparison?.expectedSharedValueDigest).toBe(configurationDigest(shared));
			const beforeRead = await readFile(
				join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"),
				"utf8",
			);
			const details = await service.getChangeDetails({ changeId: change.changeId, expectedVersion: change.version });
			expect(
				await readFile(join(getCodexConfigurationSyncDirectory(), "configuration-sync-state.json"), "utf8"),
			).toBe(beforeRead);
			const row = requireDefinedTestFixtureValue(
				details.rows.find((entry) => entry.label.endsWith("trusted_content_hash")),
			);
			expect(row.previous.text).toContain("previous-fingerprint");
			expect(row.detected.text).toContain("detected-fingerprint");
			expect(row.sharedAtConflict?.text).toContain("conflicting-fingerprint");
			expect(row.sharedCurrent?.text).toContain("current-shared-fingerprint");
			await expect(service.getChangeDetails({ changeId: change.changeId, expectedVersion: 99 })).rejects.toThrow(
				"版本",
			);
		} finally {
			await service.close();
		}
	});
	it("Hook 标题明确区分启用、禁用和来源定义变化", async () => {
		const store = await readCodexConfigurationSyncStore();
		const change = {
			changeId: "hook",
			version: 1,
			fieldKey: JSON.stringify(["config.toml", "hooks", "state", "plugin@marketplace:hooks.json:stop:0:0"]),
			sourceWriterId: "profile:automatic-adoption",
			sourceIdentity: "source",
			observedAt: 1,
			mergeStatus: "superseded" as const,
			acknowledgedAt: null,
			targets: [],
		};
		for (const [previous, value, expected] of [
			[{ value: { enabled: true } }, { value: { enabled: false } }, "禁用 Hook"],
			[{ value: { enabled: false } }, { value: { enabled: true } }, "启用 Hook"],
			[
				{ value: { enabled: true }, definitionDigest: "old" },
				{ value: { enabled: true }, definitionDigest: "new" },
				"Hook 来源定义更新",
			],
		] as const) {
			const detail = describeCodexConfigurationChange(store, { ...change, previous, value });
			expect(detail.fieldLabel).toContain(expected);
			expect(detail.sourceEvidence.initiator.status).toBe("unknown");
		}
		const root = describeCodexConfigurationChange(store, change);
		const profile = describeCodexConfigurationChange(store, {
			...change,
			fieldKey: JSON.stringify([
				"config.toml",
				"profiles",
				"restricted-profile",
				"hooks",
				"state",
				"plugin@marketplace:hooks.json:stop:0:0",
			]),
		});
		expect(profile.fieldLabel).toContain("profiles.restricted-profile.hooks.state");
		expect(profile.rows[0]?.label).toContain("restricted-profile");
		expect(profile.fieldLabel).not.toBe(root.fieldLabel);
	});
	it("仅任务来源投影变化也发布界面失效，稳定投影不重复发布", async () => {
		const reference = { workspaceId: "project", taskId: "owner", taskIncarnationCreatedAtEpochMs: 42 };
		let context: CodexConfigurationTaskSourceContext = {
			writerTasks: {},
			taskLinks: { [JSON.stringify(["project", "owner", 42])]: reference },
		};
		const onUpdated = vi.fn();
		const service = createCodexConfigurationSyncService({
			listSessions: () => [],
			onUpdated,
			readTaskSourceContext: async () => context,
		});
		try {
			await service.scan();
			expect(onUpdated).toHaveBeenCalledTimes(1);
			const revision = (await service.getState()).revision;
			context = { writerTasks: {}, taskLinks: {} };
			await service.scan();
			expect((await service.getState()).revision).toBe(revision);
			expect(onUpdated).toHaveBeenCalledTimes(2);
			expect(onUpdated).toHaveBeenLastCalledWith(revision);
			await service.scan();
			expect(onUpdated).toHaveBeenCalledTimes(2);
		} finally {
			await service.close();
		}
	});
	it("归属补证挂起时有界返回配置记录，恢复后读取自动接回", async () => {
		let release = (_context: CodexConfigurationTaskSourceContext) => {};
		const pending = new Promise<CodexConfigurationTaskSourceContext>((resolve) => {
			release = resolve;
		});
		const readTaskSourceContext = vi.fn(() => pending);
		const service = createCodexConfigurationSyncService({
			listSessions: () => [],
			onUpdated: () => {},
			readTaskSourceContext,
		});
		vi.useFakeTimers();
		try {
			const first = service.getState();
			const second = service.getState();
			await vi.advanceTimersByTimeAsync(1_000);
			expect((await first).changes).toEqual([]);
			expect((await second).changes).toEqual([]);
			expect(readTaskSourceContext).toHaveBeenCalledTimes(1);
			release({ writerTasks: {}, taskLinks: {} });
			await Promise.resolve();
			await service.getState();
		} finally {
			vi.useRealTimers();
			release({ writerTasks: {}, taskLinks: {} });
			await service.close();
		}
	});
	it("历史归属缺失不阻塞扫描，证据恢复后持久补齐，删除任务后保留标题且停用链接", async () => {
		const home = join(fixture.path, ".codex");
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: await prepareManagedCodexConversationStorageHome(home),
			workspaceId: "project",
			conversationSessionId: "side",
			runtimeSessionIncarnationId: randomUUID(),
		});
		await writeFile(join(binding.configurationHomeDirectoryPath, "config.toml"), 'model="selected"\n');
		let context: CodexConfigurationTaskSourceContext = { writerTasks: {}, taskLinks: {} };
		const service = createCodexConfigurationSyncService({
			listSessions: () => [],
			onUpdated: () => {},
			readTaskSourceContext: async () => context,
		});
		let changeId: string;
		try {
			await service.scan();
			const change = requireDefinedTestFixtureValue((await service.getState()).changes[0]);
			changeId = change.changeId;
			expect(change.sourceEvidence?.detectedOwner.task).toBeUndefined();
			context = {
				writerTasks: {
					[binding.writerId]: {
						workspaceId: "project",
						projectPath: "/projects/kanban",
						taskId: "owner",
						taskTitle: "持久标题快照",
						taskIncarnationCreatedAtEpochMs: 42,
						conversationSessionId: "side",
						runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
					},
				},
				taskLinks: {},
			};
			await service.scan();
			expect(
				(await readCodexConfigurationSyncStore()).changes.find((entry) => entry.changeId === changeId)
					?.sourceTaskSnapshot?.taskTitle,
			).toBe("持久标题快照");
		} finally {
			await service.close();
		}
		const restarted = createCodexConfigurationSyncService({
			listSessions: () => [],
			onUpdated: () => {},
			readTaskSourceContext: async () => ({ writerTasks: {}, taskLinks: {} }),
		});
		try {
			const change = requireDefinedTestFixtureValue(
				(await restarted.getState()).changes.find((entry) => entry.changeId === changeId),
			);
			expect(change.sourceEvidence?.detectedOwner.task?.taskId).toBe("owner");
			expect(change.sourceEvidence?.detectedOwner.currentTaskLink).toBeUndefined();
			expect(change.sourceEvidence?.detectedOwner.unavailableReason).toContain("删除");
			expect(change.sourceEvidence?.initiator.status).toBe("unknown");
		} finally {
			await restarted.close();
		}
	});
	it("权限组保留完整修改前后值、删除与共享字段版本，跨服务重启仍能读取", async () => {
		const home = join(fixture.path, ".codex");
		await writeFile(join(home, "config.toml"), 'approval_policy="on-request"\nsandbox_mode="workspace-write"\n');
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: await prepareManagedCodexConversationStorageHome(home),
			workspaceId: "project",
			conversationSessionId: "side",
			runtimeSessionIncarnationId: randomUUID(),
		});
		const approval = JSON.stringify(["config.toml", "approval_policy"]);
		const sandbox = JSON.stringify(["config.toml", "sandbox_mode"]);
		await mutateCodexConfigurationSyncStore((store) => {
			const writer = store.writers[binding.writerId];
			writer.sourceTaskSnapshot = {
				workspaceId: "project",
				projectPath: "/projects/source",
				taskId: "owner",
				taskTitle: "权限设置来源",
				taskIncarnationCreatedAtEpochMs: 42,
				conversationSessionId: "side",
				runtimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
			};
			mergeObservedCodexConfigurationWriter(store, writer, { [approval]: { value: "never" } });
		});
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		const change = requireDefinedTestFixtureValue((await service.getState()).changes[0]);
		const details = await service.getChangeDetails({ changeId: change.changeId, expectedVersion: change.version });
		expect(details.rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					fieldKey: approval,
					previous: { state: "present", text: '"on-request"' },
					detected: { state: "present", text: '"never"' },
				}),
				expect.objectContaining({
					fieldKey: sandbox,
					changeKind: "deleted",
					previous: { state: "present", text: '"workspace-write"' },
					detected: { state: "absent", text: "未设置（不存在）" },
				}),
			]),
		);
		await service.close();
		const restarted = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			expect(
				await restarted.getChangeDetails({ changeId: change.changeId, expectedVersion: change.version }),
			).toEqual(details);
			expect(details.sourceEvidence.detectedOwner.task?.taskTitle).toBe("权限设置来源");
			expect((await readCodexConfigurationSyncStore()).changes[0]?.sharedFieldVersionsAtObservation).toBeDefined();
		} finally {
			await restarted.close();
		}
	});
	it("完整值统一脱敏，目标冲突展示独立决定且不能读取不属于此条目的 writer", async () => {
		const home = join(fixture.path, ".codex");
		const storage = await prepareManagedCodexConversationStorageHome(home);
		const target = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: storage,
			workspaceId: "project",
			conversationSessionId: "target",
			runtimeSessionIncarnationId: randomUUID(),
		});
		const fieldKey = JSON.stringify(["config.toml", "custom_options"]);
		await mutateCodexConfigurationSyncStore((store) => {
			store.writers[target.writerId].lastObservedFields[fieldKey] = {
				value: { visible: "target-choice", password: "target-secret" },
			};
			store.changes.push({
				changeId: "redaction",
				version: ++store.revision,
				sourceWriterId: "unknown",
				sourceIdentity: target.sourceIdentity,
				fieldKey,
				value: {
					value: {
						visible: "source-choice",
						nested: [{ token: "nested-secret" }],
						command:
							"run --api-key=command-secret --password spaced-command-secret https://name:url-secret@example.test",
						environment:
							"export AWS_SECRET_ACCESS_KEY=aws-secret-value; export SSH_PRIVATE_KEY='private-secret-value'",
						header: "Bearer bearer-secret",
					},
				},
				observedAt: 1,
				mergeStatus: "shared_default_updated",
				approvalStatus: "approved",
				recordKind: "historical_record",
				acknowledgedAt: 1,
				targets: [
					{
						writerId: target.writerId,
						conversationSessionId: "target",
						workspaceId: "project",
						status: "conflict",
						reason: "双方有独立决定",
						attemptCount: 0,
						acceptedAt: 1,
						diskSavedAt: null,
						ownerReloadedAt: null,
						recoveryCondition: null,
					},
				],
			});
		});
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			const change = requireDefinedTestFixtureValue((await service.getState()).changes[0]);
			const details = await service.getChangeDetails({
				changeId: change.changeId,
				expectedVersion: change.version,
				targetWriterId: target.writerId,
			});
			const serialized = JSON.stringify(details);
			for (const secret of [
				"nested-secret",
				"command-secret",
				"spaced-command-secret",
				"aws-secret-value",
				"private-secret-value",
				"url-secret",
				"bearer-secret",
				"target-secret",
			]) {
				expect(JSON.stringify(change)).not.toContain(secret);
				expect(serialized).not.toContain(secret);
			}
			expect(serialized).toContain("[已脱敏]");
			expect(serialized).toContain("source-choice");
			expect(serialized).toContain("target-choice");
			await expect(
				service.getChangeDetails({
					changeId: change.changeId,
					expectedVersion: change.version,
					targetWriterId: "unrelated-writer",
				}),
			).rejects.toThrow("不属于");
			expect(JSON.stringify(change.targetComparisons)).toContain("target-choice");
		} finally {
			await service.close();
		}
	});
	it("共享值并发变化拒绝旧选择，刷新后可以选择当前值，旧请求仍执行原冲突门禁", async () => {
		const home = join(fixture.path, ".codex");
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: await prepareManagedCodexConversationStorageHome(home),
			workspaceId: "project",
			conversationSessionId: "source",
			runtimeSessionIncarnationId: randomUUID(),
		});
		const fieldKey = JSON.stringify(["config.toml", "model"]);
		await mutateCodexConfigurationSyncStore((store) => {
			store.sources[binding.sourceIdentity].fields[fieldKey] = { value: "shared-current" };
			store.changes.push({
				changeId: "race",
				version: ++store.revision,
				sourceWriterId: `user-source:${binding.sourceIdentity}`,
				sourceIdentity: binding.sourceIdentity,
				fieldKey,
				previous: { value: "previous" },
				value: { value: "initial" },
				sharedValueAtConflict: { value: "shared-conflict-snapshot" },
				observedAt: 1,
				mergeStatus: "conflict",
				approvalStatus: "pending",
				recordKind: "settings_proposal",
				acknowledgedAt: null,
				targets: [],
			});
		});
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			const change = requireDefinedTestFixtureValue((await service.getState()).changes[0]);
			const input = {
				changeId: change.changeId,
				expectedVersion: change.version,
				idempotencyKey: randomUUID(),
				resolution: "keep_shared_value" as const,
			};
			await expect(service.resolveConflict(input)).rejects.toThrow("共享值已有更新");
			const digest = requireDefinedTestFixtureValue(change.comparison).expectedSharedValueDigest;
			await mutateCodexConfigurationSyncStore((store) => {
				store.sources[binding.sourceIdentity].fields[fieldKey] = { value: "newer-concurrent-choice" };
			});
			await expect(service.resolveConflict({ ...input, expectedSharedValueDigest: digest })).rejects.toThrow(
				"共享值已有更新",
			);
			const latest = requireDefinedTestFixtureValue(
				(await service.getState()).changes.find((entry) => entry.changeId === "race"),
			);
			const result = await service.resolveConflict({
				...input,
				expectedSharedValueDigest: requireDefinedTestFixtureValue(latest.comparison).expectedSharedValueDigest,
			});
			expect(result.changes.find((entry) => entry.changeId === "race")?.mergeStatus).toBe("kept_shared_value");
			const stored = await readCodexConfigurationSyncStore();
			expect(stored.sources[binding.sourceIdentity].fields[fieldKey].value).toBe("newer-concurrent-choice");
			expect(stored.changes.find((entry) => entry.changeId === "race")?.sharedValueAtConflict?.value).toBe(
				"shared-conflict-snapshot",
			);
			expect(await readFile(join(home, "config.toml"), "utf8")).toBe('model="initial"\n');
		} finally {
			await service.close();
		}
	});
	it("共享来源由对应的已接受字段版本恢复，不按相同值归因", async () => {
		const home = join(fixture.path, ".codex");
		const binding = await prepareCodexConfigurationWriterBinding({
			purpose: "native_session",
			storageHome: await prepareManagedCodexConversationStorageHome(home),
			workspaceId: "project",
			conversationSessionId: "source",
			runtimeSessionIncarnationId: randomUUID(),
		});
		const fieldKey = JSON.stringify(["config.toml", "model"]);
		await mutateCodexConfigurationSyncStore((store) => {
			updateCodexConfigurationProfileFields(
				store,
				requireDefinedTestFixtureValue(store.writers[binding.writerId].codexConfigurationProfileId),
				{ [fieldKey]: { value: "accepted" } },
				{ sourceWriterId: binding.writerId },
			);
			const accepted = requireDefinedTestFixtureValue(store.changes.at(-1));
			store.changes.push({
				...accepted,
				changeId: "conflicting",
				version: ++store.revision,
				approvalStatus: "pending",
				recordKind: "settings_proposal",
				mergeStatus: "conflict",
				value: { value: "new-choice" },
				sharedValueAtConflict: { value: "accepted" },
			});
		});
		const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
		try {
			const change = requireDefinedTestFixtureValue((await service.getState()).changes[0]);
			expect(change.comparison?.rows[0]?.sharedOrigin).toMatchObject({
				description: "已接受的字段版本",
				changeId: expect.not.stringMatching(/^conflicting$/),
			});
			await mutateCodexConfigurationSyncStore((store) => {
				const accepted = requireDefinedTestFixtureValue(
					store.changes.find((entry) => entry.changeId !== "conflicting"),
				);
				accepted.approvalStatus = "historical";
				delete accepted.acceptedProfileFieldVersion;
			});
			expect((await service.getState()).changes[0]?.comparison?.rows[0]?.sharedOrigin?.description).toBe(
				"已接受的字段版本",
			);
			await mutateCodexConfigurationSyncStore((store) => {
				store.profiles[requireDefinedTestFixtureValue(store.writers[binding.writerId].codexConfigurationProfileId)]
					.fieldVersions[fieldKey]++;
			});
			expect((await service.getState()).changes[0]?.comparison?.rows[0]?.sharedOrigin?.description).toContain(
				"来源未知",
			);
		} finally {
			await service.close();
		}
	});
});
