import { describe, expect, it, vi } from "vitest";
import { createHooksApi } from "../../../src/trpc/hooks-api";

describe("Codex 非持久化后台会话 hook 隔离", () => {
	it.each([
		"activity",
		"to_review",
		"to_in_progress",
		"agent_conversation_session_identity_observed",
		"main_agent_conversation_context_compaction_completed",
	] as const)("旧 CLI / spool 的 %s 不得接触主会话或发通知", async (event) => {
		const ensureManager = vi.fn();
		const persistIdentity = vi.fn();
		const broadcast = vi.fn();
		const checkpoint = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: () => "/isolated/project",
			ensureTerminalManagerForWorkspace: ensureManager,
			persistRuntimeAgentNativeConversationSessionIdentityByWorkspaceId: persistIdentity,
			broadcastRuntimeWorkspaceStateUpdated: broadcast,
			broadcastTaskReadyForReview: broadcast,
			captureTaskTurnCheckpoint: checkpoint,
			ingestsHookEventsReplayedFromAgentSessionPtyHostSpool: true,
		});
		const hook = {
			event,
			taskId: "isolated-main-session",
			workspaceId: "isolated-workspace",
			metadata: { source: "codex", hookEventName: "PostToolUse", toolName: "Bash" },
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "01a1592f-121b-7d31-9435-768bfffda4e8",
				transcriptPath: null,
				observedAt: 42,
			},
		};
		expect(await api.ingest(hook)).toEqual({ ok: true });
		expect(await api.ingest(hook)).toEqual({ ok: true });
		expect(ensureManager).not.toHaveBeenCalled();
		expect(persistIdentity).not.toHaveBeenCalled();
		expect(broadcast).not.toHaveBeenCalled();
		expect(checkpoint).not.toHaveBeenCalled();
	});
});
