import { describe, expect, it, vi } from "vitest";

const migration = vi.hoisted(() => vi.fn());
vi.mock("../../../src/codex-conversation-storage/codex-conversation-storage-migration", () => ({
	migrateStoppedCodexConversationStorage: migration,
	rollbackStoppedCodexConversationStorage: migration,
}));

import { operateCodexConversationStorage } from "../../../src/codex-conversation-storage/codex-conversation-storage-runtime-operation";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

function summary(liveness: "live" | "exited"): RuntimeTaskSessionSummary {
	return {
		taskId: "task-session",
		agentId: "codex",
		workspacePath: "/workspace",
		turnOwner: "user",
		liveness,
		userTurnKind: "review",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "01a15120-4476-78b0-8c56-5a7321338e0b",
			transcriptPath: "/original-codex-home/sessions/rollout.jsonl",
			observedAt: 1,
		},
	} as RuntimeTaskSessionSummary;
}

describe("迁移活跃会话的门禁", () => {
	it("即使本轮已结束且正在等审查，也延后活体，零迁移调用", async () => {
		migration.mockClear();
		const result = await operateCodexConversationStorage(
			{ operation: "migrate_stopped" },
			{ listKnownSummaries: async () => [summary("live")] },
		);
		expect(result.entries[0]?.status).toBe("active_deferred");
		expect(migration).not.toHaveBeenCalled();
	});
	it("状态查询可列出已退出会话，但不会启动迁移或重启会话", async () => {
		migration.mockClear();
		const result = await operateCodexConversationStorage(
			{ operation: "status" },
			{ listKnownSummaries: async () => [summary("exited")] },
		);
		expect(result.entries[0]).toMatchObject({ status: "eligible", homeDirectoryPath: "/original-codex-home" });
		expect(migration).not.toHaveBeenCalled();
	});
	it("主会话已退出但同 Task 的侧会话活着时，整张卡都延后", async () => {
		migration.mockClear();
		const main = summary("exited");
		const side = { ...summary("live"), taskId: "side-session" };
		for (const session of [main, side])
			session.taskConversationSessionMetadata = {
				workspaceTaskId: "same-task",
			} as RuntimeTaskSessionSummary["taskConversationSessionMetadata"];
		const result = await operateCodexConversationStorage(
			{ operation: "migrate_stopped", conversationSessionId: main.taskId },
			{ listKnownSummaries: async () => [main, side] },
		);
		expect(result.entries[0]?.status).toBe("active_deferred");
		expect(migration).not.toHaveBeenCalled();
	});
	it("显式复用的来源对话被归属校验拒绝，不调用迁移", async () => {
		migration.mockClear();
		const result = await operateCodexConversationStorage(
			{ operation: "migrate_stopped" },
			{
				listKnownSummaries: async () => [summary("exited")],
				resolveMigrationOwnership: async () => ({ rejectionReason: "显式复用的来源对话保持原目录" }),
			},
		);
		expect(result.entries[0]).toMatchObject({ status: "refused", message: "显式复用的来源对话保持原目录" });
		expect(migration).not.toHaveBeenCalled();
	});
});
