import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateCodexConfigurationProfileFields } from "../../../src/codex-configuration-sync/codex-configuration-profiles";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	closeCodexConfigurationSyncDatabase,
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { codexConfigurationProfileMutationRequestSchema } from "../../../src/core/codex-configuration-sync-contract";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("../../../src/terminal/terminal-agent-model-selection", () => ({
	getTerminalAgentModelSelectionOptions: async () => ({
		agentId: "codex",
		defaultModelId: "native-model",
		options: [
			{
				modelId: "native-model",
				supportedReasoningEfforts: [{ effort: "max" }, { effort: "ultra" }],
				defaultReasoningEffort: "max",
			},
			{ modelId: "limited-model", supportedReasoningEfforts: [{ effort: "low" }] },
		],
	}),
	resolveCodexNativeDefaultReasoningEffortForModel: async () => "max",
}));
const key = (name: string) => JSON.stringify(["config.toml", ...name.split(".")]);
let fixture: ReturnType<typeof createTempDir>;
let service: ReturnType<typeof createCodexConfigurationSyncService>;
beforeEach(async () => {
	fixture = createTempDir("codex-profile-field-editing-");
	fixture.path = await realpath(fixture.path);
	const configurationHome = join(fixture.path, "isolated-codex-home");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", configurationHome);
	vi.stubEnv("CODEX_SQLITE_HOME", configurationHome);
	await mkdir(configurationHome);
	await writeFile(join(configurationHome, "config.toml"), "hide_agent_reasoning = false\n");
	await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: configurationHome,
		workspaceId: "field-edits",
		conversationSessionId: "session",
		runtimeSessionIncarnationId: randomUUID(),
	});
	service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
});
afterEach(async () => {
	await service?.close();
	await closeCodexConfigurationSyncDatabase();
	vi.unstubAllEnvs();
	fixture.cleanup();
});
const profile = async () => {
	const value = (await service.getState()).profiles?.[0];
	if (!value) throw new Error("缺少隔离配置");
	return value;
};
const edit = async (
	name: string,
	value: unknown,
	expectedFieldVersions: Record<string, number | null>,
	expectedVersion: number,
) =>
	service.mutateProfile({
		action: "update",
		profileId: (await profile()).profileId,
		expectedVersion,
		expectedFieldVersions,
		fields: [{ fieldKey: key(name), value }],
		idempotencyKey: randomUUID(),
	});

describe("配置字段版本编辑", () => {
	it("过期值重新编辑会创建新共享操作，原审批继续保留为过期历史", async () => {
		const original = await profile();
		const nativeWriter = Object.values((await readCodexConfigurationSyncStore()).writers)[0];
		if (!nativeWriter) throw new Error("缺少隔离 writer");
		await writeFile(
			join(nativeWriter.binding.configurationHomeDirectoryPath, "config.toml"),
			'hide_agent_reasoning=false\nmodel_reasoning_effort="ultra"\n',
		);
		await service.scan();
		const pending = (await service.getState()).changes.find(
			(change) => change.exceptionGroup === "reasoning_effort" && change.approvalStatus === "pending",
		);
		if (!pending) throw new Error("缺少推理反馈");
		await mutateCodexConfigurationSyncStore((store) => {
			const change = store.changes.find((entry) => entry.changeId === pending.changeId);
			if (change) change.feedbackExpiresAtMs = Date.now() - 1;
		});
		await service.scan();
		const expired = (await service.getState()).changes.find((change) => change.changeId === pending.changeId);
		if (!expired) throw new Error("缺少过期历史");
		const details = await service.getChangeDetails({ changeId: expired.changeId, expectedVersion: expired.version });
		expect(details.profileEditFields).toEqual([
			{ fieldKey: key("model_reasoning_effort"), value: "ultra", delete: false },
		]);
		await service.mutateProfile({
			action: "update",
			profileId: original.profileId,
			expectedVersion: (await profile()).version,
			expectedFieldVersions: { [key("model")]: null, [key("model_reasoning_effort")]: null },
			fields: details.profileEditFields?.map((field) => ({ ...field, value: field.value })),
			idempotencyKey: randomUUID(),
		});
		const after = await service.getState();
		expect(after.changes.find((change) => change.changeId === expired.changeId)?.approvalStatus).toBe("expired");
		expect(
			after.changes.some(
				(change) =>
					change.changeId !== expired.changeId &&
					change.approvalStatus === "approved" &&
					change.fieldKey === key("model_reasoning_effort"),
			),
		).toBe(true);
	});
	it("重启幂等归档本地状态，保留原生副本与已应用事实并取消待传播", async () => {
		const original = await profile();
		const nativeWriter = Object.values((await readCodexConfigurationSyncStore()).writers)[0];
		if (!nativeWriter) throw new Error("缺少隔离 writer");
		const nativeConfigurationPath = join(nativeWriter.binding.configurationHomeDirectoryPath, "config.toml");
		const nativeConfiguration =
			"hide_agent_reasoning = false\n[tui]\nscreen_reader_detection_done=true\n[tui.model_availability_nux]\nfuture_model=true\n";
		await writeFile(nativeConfigurationPath, nativeConfiguration);
		await mutateCodexConfigurationSyncStore((store) => {
			store.settingsIsolationProjectionVersion = 1;
			const localKey = key("tui.model_availability_nux.future-model");
			const selected = store.profiles[original.profileId];
			selected.fields[localKey] = { value: true };
			selected.fieldVersions[localKey] = ++store.revision;
			store.changes.push({
				changeId: "local-state-migration",
				version: store.revision,
				sourceWriterId: "profile:test",
				sourceIdentity: original.sourceIdentity,
				codexConfigurationProfileId: original.profileId,
				fieldKey: localKey,
				value: { value: true },
				observedAt: 1,
				recordKind: "historical_record",
				approvalStatus: "approved",
				acknowledgedAt: 1,
				mergeStatus: "shared_default_updated",
				targets: ["applied", "pending_reload"].map((status) => ({
					writerId: status,
					conversationSessionId: status,
					workspaceId: "fixture",
					status: status as "applied" | "pending_reload",
					reason: "原事实",
					attemptCount: 1,
					acceptedAt: 1,
					diskSavedAt: 1,
					ownerReloadedAt: status === "applied" ? 1 : null,
					recoveryCondition: "等待",
				})),
			});
		});
		await closeCodexConfigurationSyncDatabase();
		const migrated = await readCodexConfigurationSyncStore();
		expect(
			migrated.profiles[original.profileId].fields[key("tui.model_availability_nux.future-model")],
		).toBeUndefined();
		expect(
			migrated.changes
				.find((change) => change.changeId === "local-state-migration")
				?.targets.map((target) => target.status),
		).toEqual(["applied", "not_applicable"]);
		await closeCodexConfigurationSyncDatabase();
		expect((await readCodexConfigurationSyncStore()).revision).toBe(migrated.revision);
		await service.scan();
		expect(
			(await readCodexConfigurationSyncStore()).changes.filter(
				(change) => change.fieldKey.includes('"tui"') && change.settingsIsolationArchivedAtMs === undefined,
			),
		).toHaveLength(0);
		expect(await readFile(nativeConfigurationPath, "utf8")).toBe(nativeConfiguration);
	});
	it("旧客户端和元数据继续校验整体版本，删除请求可跨响应范围幂等重放", async () => {
		const original = await profile();
		await mutateCodexConfigurationSyncStore((store) =>
			updateCodexConfigurationProfileFields(store, original.profileId, {
				[key("other_preference")]: { value: true },
			}),
		);
		const legacy = {
			action: "update" as const,
			profileId: original.profileId,
			expectedVersion: original.version,
			fields: [{ fieldKey: key("hide_agent_reasoning"), value: true }],
			idempotencyKey: randomUUID(),
		};
		await expect(service.mutateProfile(legacy)).rejects.toThrow("已更新");
		await expect(
			service.mutateProfile({
				...legacy,
				name: "新名称",
				expectedFieldVersions: { [key("hide_agent_reasoning")]: original.fields[0]?.version ?? null },
			}),
		).rejects.toThrow("已更新");
		const current = await profile();
		const deletion = codexConfigurationProfileMutationRequestSchema.parse({
			action: "update",
			profileId: current.profileId,
			expectedVersion: current.version,
			fields: [{ fieldKey: key("hide_agent_reasoning"), delete: true }],
			expectedFieldVersions: {
				[key("hide_agent_reasoning")]: current.fieldVersions?.[key("hide_agent_reasoning")] ?? null,
			},
			idempotencyKey: randomUUID(),
			stateResponseScope: "overview",
		});
		expect((await service.mutateProfile(deletion)).stateResponseScope).toBe("overview");
		const count = (await readCodexConfigurationSyncStore()).changes.length;
		await service.mutateProfile({ ...deletion, stateResponseScope: "full" });
		expect((await readCodexConfigurationSyncStore()).changes).toHaveLength(count);
	});
	it("无关字段更新仍能合并；相同值不新增共享决定", async () => {
		const original = await profile();
		const version = original.fields.find((field) => field.fieldKey === key("hide_agent_reasoning"))?.version ?? null;
		await mutateCodexConfigurationSyncStore((store) =>
			updateCodexConfigurationProfileFields(store, original.profileId, {
				[key("other_preference")]: { value: true },
			}),
		);
		await edit("hide_agent_reasoning", true, { [key("hide_agent_reasoning")]: version }, original.version);
		const saved = await profile();
		expect(saved.fields.find((field) => field.fieldKey === key("other_preference"))?.value).toBe(true);
		const before = (await readCodexConfigurationSyncStore()).changes.length;
		await edit(
			"hide_agent_reasoning",
			true,
			{
				[key("hide_agent_reasoning")]:
					saved.fields.find((field) => field.fieldKey === key("hide_agent_reasoning"))?.version ?? null,
			},
			saved.version,
		);
		expect((await readCodexConfigurationSyncStore()).changes).toHaveLength(before);
	});
	it("允许首次显式设置模型和推理，联合拒绝不兼容组合", async () => {
		const original = await profile();
		await edit(
			"model_reasoning_effort",
			"ultra",
			{ [key("model")]: null, [key("model_reasoning_effort")]: null },
			original.version,
		);
		const saved = await profile();
		await expect(
			edit(
				"model",
				"limited-model",
				{
					[key("model")]: null,
					[key("model_reasoning_effort")]:
						saved.fields.find((field) => field.fieldKey === key("model_reasoning_effort"))?.version ?? null,
				},
				saved.version,
			),
		).rejects.toThrow("不支持");
	});
	it("同字段、新增权限组成员和已删除字段的旧版本均拒绝覆盖", async () => {
		const original = await profile();
		const ordinaryVersion = original.fields[0]?.version ?? null;
		await mutateCodexConfigurationSyncStore((store) =>
			updateCodexConfigurationProfileFields(store, original.profileId, {
				[key("hide_agent_reasoning")]: undefined,
				[key("permissions.custom_policy")]: { value: true },
			}),
		);
		await expect(
			edit("hide_agent_reasoning", true, { [key("hide_agent_reasoning")]: ordinaryVersion }, original.version),
		).rejects.toThrow("已更新");
		await expect(
			edit(
				"approval_policy",
				"never",
				Object.fromEntries(
					["approval_policy", "approvals_reviewer", "sandbox_mode", "sandbox_workspace_write", "permissions"].map(
						(name) => [key(name), null],
					),
				),
				original.version,
			),
		).rejects.toThrow("已更新");
	});
	it("未设置的权限表按叶子字段保存，便于磁盘投影与回执比较", async () => {
		const current = await profile();
		await edit(
			"sandbox_workspace_write",
			{ network_access: true },
			Object.fromEntries(
				["approval_policy", "approvals_reviewer", "sandbox_mode", "sandbox_workspace_write", "permissions"].map(
					(name) => [key(name), null],
				),
			),
			current.version,
		);
		const stored = Object.values((await readCodexConfigurationSyncStore()).profiles)[0];
		const leaf = key("sandbox_workspace_write.network_access");
		expect(stored?.fields[leaf]).toEqual({ value: true });
		expect(stored?.fields[key("sandbox_workspace_write")]).toBeUndefined();
		expect(
			(await readCodexConfigurationSyncStore()).changes.some(
				(change) => change.fieldKey === leaf && change.approvalStatus === "approved",
			),
		).toBe(true);
	});
});
