import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configurationDigest } from "../../../src/codex-configuration-sync/codex-configuration-field-projection";
import { createCodexConfigurationSyncService } from "../../../src/codex-configuration-sync/codex-configuration-sync-service";
import {
	mutateCodexConfigurationSyncStore,
	readCodexConfigurationSyncStore,
} from "../../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { prepareManagedCodexConversationStorageHome } from "../../../src/codex-conversation-storage/codex-conversation-storage-home";
import { createTempDir } from "../../utilities/temp-dir";

let fixture: ReturnType<typeof createTempDir>;
let storageHome: string;
const modelFieldKey = JSON.stringify(["config.toml", "model"]);

beforeEach(async () => {
	fixture = createTempDir("codex-target-conflict-current-source-");
	fixture.path = await realpath(fixture.path);
	const sourceHome = join(fixture.path, ".codex");
	vi.stubEnv("HOME", fixture.path);
	vi.stubEnv("CODEX_HOME", sourceHome);
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.path, "isolated-sqlite"));
	await mkdir(sourceHome);
	await writeFile(join(sourceHome, "config.toml"), stringify({ model: "initial-model" }));
	storageHome = await prepareManagedCodexConversationStorageHome(sourceHome);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fixture.cleanup();
});

const createWriter = (conversationSessionId: string) =>
	prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome,
		workspaceId: "current-source-observation-workspace",
		conversationSessionId,
		runtimeSessionIncarnationId: randomUUID(),
	});

describe("目标冲突处理核验当前来源观测", () => {
	it.each(["use_source_change", "keep_target_value"] as const)(
		"来源出现新待审批值后，%s 保留审批边界与目标决定",
		async (resolution) => {
			const sourceWriter = await createWriter("source-writer");
			const targetWriter = await createWriter("target-writer");
			const sourceFilePath = join(sourceWriter.configurationHomeDirectoryPath, "config.toml");
			const targetFilePath = join(targetWriter.configurationHomeDirectoryPath, "config.toml");
			const service = createCodexConfigurationSyncService({ listSessions: () => [], onUpdated: () => {} });
			try {
				const sourceConfiguration = parse(await readFile(sourceFilePath, "utf8"));
				sourceConfiguration.model = "approved-source-model";
				await writeFile(sourceFilePath, stringify(sourceConfiguration));
				const proposal = (await service.getState()).changes[0];
				const approved = await service.batchAction({
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
				const approvedChange = approved.state.changes.find((change) => change.changeId === proposal.changeId);
				if (!approvedChange) throw new Error("缺少已审批来源决定");
				const targetConfiguration = parse(await readFile(targetFilePath, "utf8"));
				targetConfiguration.model = "target-local-model";
				await writeFile(targetFilePath, stringify(targetConfiguration));
				await service.scan();
				const targetValueDigest = configurationDigest({ value: "target-local-model" });
				// 恢复已有目标冲突的持久记录，包含此前已确认的保存事实。
				await mutateCodexConfigurationSyncStore((store) => {
					const change = store.changes.find((entry) => entry.changeId === approvedChange.changeId);
					if (!change) throw new Error("缺少来源决定");
					change.targets.push({
						writerId: targetWriter.writerId,
						conversationSessionId: "target-writer",
						workspaceId: "current-source-observation-workspace",
						status: "conflict",
						reason: "目标已作出另一决定",
						attemptCount: 1,
						acceptedAt: 10,
						diskSavedAt: 20,
						ownerReloadedAt: null,
						recoveryCondition: null,
						conflictingTargetValueDigest: targetValueDigest,
						conflictHistory: [{ observedAt: 30, value: { value: "target-local-model" } }],
					});
				});
				sourceConfiguration.model = "new-pending-source-model";
				await writeFile(sourceFilePath, stringify(sourceConfiguration));
				await service.scan();
				const before = await readCodexConfigurationSyncStore();
				const request = {
					changeId: approvedChange.changeId,
					expectedVersion: approvedChange.version,
					idempotencyKey: randomUUID(),
					targetWriterId: targetWriter.writerId,
					expectedTargetValueDigest: targetValueDigest,
					resolution,
				};
				if (resolution === "use_source_change") {
					await expect(service.resolveTargetConflict(request)).rejects.toThrow("新设置或来源定义");
					const after = await readCodexConfigurationSyncStore();
					expect(after.writers[targetWriter.writerId].mergeBaselineFields).toEqual(
						before.writers[targetWriter.writerId].mergeBaselineFields,
					);
					expect(after.changes).toEqual(before.changes);
					expect(after.mutationReceipts[request.idempotencyKey]).toBeUndefined();
				} else {
					await service.resolveTargetConflict(request);
					await service.resolveTargetConflict(request);
					const after = await readCodexConfigurationSyncStore();
					expect(
						after.changes.find((entry) => entry.changeId === approvedChange.changeId)?.targets[0],
					).toMatchObject({ status: "not_applicable", diskSavedAt: 20, ownerReloadedAt: null });
					expect(after.changes.find((entry) => entry.sourceWriterId === targetWriter.writerId)?.mergeStatus).toBe(
						"target_conflict_target_value_kept",
					);
				}
				const after = await readCodexConfigurationSyncStore();
				expect(after.sources[sourceWriter.sourceIdentity].fields[modelFieldKey]).toEqual({
					value: "approved-source-model",
				});
				expect(after.changes.find((entry) => entry.value?.value === "new-pending-source-model")).toMatchObject({
					approvalStatus: "pending",
					mergeStatus: "pending_approval",
				});
				expect(parse(await readFile(targetFilePath, "utf8")).model).toBe("target-local-model");
			} finally {
				await service.close();
			}
		},
	);
});
