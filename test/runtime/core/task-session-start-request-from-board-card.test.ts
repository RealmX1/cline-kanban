import { describe, expect, it } from "vitest";

import {
	type RuntimeBoardCard,
	type RuntimeTaskAgentSessionInitialization,
	runtimeTaskSessionStartRequestSchema,
} from "../../../src/core/api-contract";
import { buildTaskSessionStartRequestFromBoardCard } from "../../../src/core/task-session-start-request-from-board-card";

const CLAUDE_SESSION_INITIALIZATION: RuntimeTaskAgentSessionInitialization = {
	sourceAgentId: "claude",
	sourceSessionId: "11111111-2222-4333-8444-555555555555",
	sourceSessionReuseMode: "resume_existing_session",
};

function createFullyPopulatedBoardCard(): RuntimeBoardCard {
	return {
		id: "task-1",
		title: "Continue existing Claude session",
		prompt: "  Continue the implementation  ",
		startInPlanMode: true,
		taskAgentPermissionMode: "ask_for_every_tool_use",
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		images: [{ id: "image-1", data: "aGVsbG8=", mimeType: "image/png" }],
		agentId: "claude",
		taskConversationMode: "exploratory",
		clineSettings: { providerId: "anthropic", modelId: "claude-sonnet" },
		terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opus" },
		taskAgentSessionInitialization: CLAUDE_SESSION_INITIALIZATION,
		baseRef: "main",
		worktreeMode: "branch",
		prepFilePath: "/tmp/prep.md",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("buildTaskSessionStartRequestFromBoardCard", () => {
	// 迁自 task-agent-session-initialization-update.test.ts 的 buildCliTaskSessionStartRequest 段。
	it("forwards the persisted agent session initialization into the runtime launch request", () => {
		const request = buildTaskSessionStartRequestFromBoardCard({
			id: "task-1",
			title: "Continue existing Claude session",
			prompt: "Continue the implementation",
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			baseRef: "main",
			agentId: "claude",
			taskAgentSessionInitialization: CLAUDE_SESSION_INITIALIZATION,
			createdAt: 1,
			updatedAt: 1,
		});

		expect(request.taskAgentSessionInitialization).toEqual(CLAUDE_SESSION_INITIALIZATION);
	});

	it("带上 CLI 旧映射漏传的附图、会话模式与终端 agent 模型覆盖，并通过启动请求 schema 校验", () => {
		const request = buildTaskSessionStartRequestFromBoardCard(createFullyPopulatedBoardCard(), {
			agentTerminalGeometryForTaskSessionSpawn: { cols: 120, rows: 36 },
		});

		expect(request).toEqual({
			taskId: "task-1",
			prompt: "Continue the implementation",
			taskTitle: "Continue existing Claude session",
			images: [{ id: "image-1", data: "aGVsbG8=", mimeType: "image/png" }],
			startInPlanMode: true,
			taskAgentPermissionMode: "ask_for_every_tool_use",
			taskConversationMode: "exploratory",
			baseRef: "main",
			cols: 120,
			rows: 36,
			agentId: "claude",
			clineSettings: { providerId: "anthropic", modelId: "claude-sonnet" },
			terminalAgentModelOverrideSettings: { agentId: "claude", modelId: "opus" },
			taskAgentSessionInitialization: CLAUDE_SESSION_INITIALIZATION,
			worktreeMode: "branch",
			prepFilePath: "/tmp/prep.md",
		});
		expect(runtimeTaskSessionStartRequestSchema.safeParse(request).success).toBe(true);
	});

	it("从 Done 恢复：不重投 prompt / 附图、不带开局的 startInPlanMode，但权限档位照带", () => {
		const request = buildTaskSessionStartRequestFromBoardCard(createFullyPopulatedBoardCard(), {
			resumeFromTrash: true,
		});

		expect(request).toMatchObject({
			prompt: "",
			resumeFromTrash: true,
			taskAgentPermissionMode: "ask_for_every_tool_use",
			taskConversationMode: "exploratory",
		});
		expect(request.images).toBeUndefined();
		expect(request.startInPlanMode).toBeUndefined();
		expect(request).not.toHaveProperty("cols");
	});
});
