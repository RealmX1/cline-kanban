import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mutateCodexConfigurationSyncStore } from "../../src/codex-configuration-sync/codex-configuration-sync-store";
import { prepareCodexConfigurationWriterBinding } from "../../src/codex-configuration-sync/codex-configuration-writer-binding";
import { type RuntimeTaskSessionSummary, runtimeTaskSessionSummarySchema } from "../../src/core/api-contract";

export async function prepareCodexConfigurationRecoveryScaleFixture(
	workspaceLocations: Array<{ workspaceId: string; workspacePath: string }>,
	sourceHome: string,
) {
	if (!workspaceLocations.length) throw new Error("真实规模配置恢复夹具至少需要一个工作区");
	const sessionCount = 1041;
	const targetCount = 3878;
	await mkdir(sourceHome, { recursive: true });
	await writeFile(join(sourceHome, "config.toml"), 'model = "synthetic-model"\n');
	const binding = await prepareCodexConfigurationWriterBinding({
		purpose: "native_session",
		storageHome: sourceHome,
		workspaceId: workspaceLocations[0].workspaceId,
		conversationSessionId: "historical-session-0",
		runtimeSessionIncarnationId: "00000000-0000-0000-0000-000000000000",
	});
	const sessionIdentities = Array.from({ length: sessionCount }, (_, index) => ({
		workspaceId: workspaceLocations[index % workspaceLocations.length].workspaceId,
		conversationSessionId: `historical-session-${Math.floor(index / workspaceLocations.length)}`,
	}));
	const sessionsByWorkspace: Record<string, Record<string, RuntimeTaskSessionSummary>> = {};
	for (const { workspaceId, workspacePath } of workspaceLocations)
		sessionsByWorkspace[workspaceId] = Object.fromEntries(
			sessionIdentities
				.filter((identity) => identity.workspaceId === workspaceId)
				.map(({ conversationSessionId }) => [
					conversationSessionId,
					runtimeTaskSessionSummarySchema.parse({
						taskId: conversationSessionId,
						agentId: "codex",
						state: "awaiting_review",
						turnOwner: "user",
						liveness: "exited",
						userTurnKind: "review",
						workspacePath,
						pid: null,
						startedAt: 1,
						updatedAt: 1,
						lastOutputAt: 1,
						reviewReason: null,
						exitCode: 0,
					}),
				]),
		);
	await mutateCodexConfigurationSyncStore((store) => {
		if (!store.defaultCodexConfigurationProfileId) throw new Error("真实规模夹具缺少默认 profile");
		store.writers[binding.writerId].retiredAt = 1;
		store.changes.push({
			changeId: "synthetic-pending-start-change",
			version: 1,
			sourceWriterId: binding.writerId,
			sourceIdentity: binding.sourceIdentity,
			codexConfigurationProfileId: store.defaultCodexConfigurationProfileId,
			fieldKey: JSON.stringify(["config.toml", "model"]),
			value: { value: "synthetic-model" },
			observedAt: 1,
			recordKind: "settings_proposal",
			approvalStatus: "approved",
			mergeStatus: "shared_default_updated",
			acknowledgedAt: null,
			targets: Array.from({ length: targetCount }, (_, index) => ({
				writerId: `synthetic-retired-writer-${index}`,
				...sessionIdentities[index % sessionCount],
				status: "pending_next_start" as const,
				reason: "合成历史目标，保留后续启动恢复职责",
				recoveryCondition: "同一来源的会话下次启动",
				acceptedAt: 1,
				diskSavedAt: null,
				ownerReloadedAt: null,
				attemptCount: 0,
			})),
		});
	});
	return { sessionCount, targetCount, sessionsByWorkspace };
}
