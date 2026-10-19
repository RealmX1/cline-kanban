import { describe, expect, it } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import { isTaskConversationSessionWithoutTaskLifecycleAuthority } from "../../../src/core/session-activity";
import {
	projectTaskConversationSessionsForMainSessionBinding,
	resolveMainTaskConversationSessionId,
	resolveMainTaskConversationSessionSummary,
} from "../../../src/core/task-main-conversation-session-binding";

function summary(taskId: string, collaborator = false) {
	return runtimeTaskSessionSummarySchema.parse({
		taskId,
		state: "idle",
		agentId: collaborator ? "codex" : "claude",
		workspacePath: "/repo/task",
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...(collaborator
			? {
					taskConversationSessionMetadata: {
						workspaceTaskId: "task-1",
						taskConversationSessionRole: "task_collaborator",
						taskConversationSessionContextSource: "started_from_scratch",
						parentTaskConversationSessionId: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: "协作",
					},
				}
			: {}),
	});
}

describe("任务主会话的稳定绑定", () => {
	it("旧卡兼容 Task ID，显式绑定只改变寻址、不交换会话身份", () => {
		const sessions = { "task-1": summary("task-1"), "codex-peer": summary("codex-peer", true) };
		expect(resolveMainTaskConversationSessionId({ id: "task-1" })).toBe("task-1");
		const card = { id: "task-1", mainTaskConversationSessionId: "codex-peer" };
		expect(resolveMainTaskConversationSessionSummary(card, sessions)?.taskId).toBe("codex-peer");
		expect(sessions["task-1"].agentId).toBe("claude");
	});
	it("按绑定派生唯一生命周期权限，保留前主与接收方的创建角色", () => {
		const sessions = { "task-1": summary("task-1"), "codex-peer": summary("codex-peer", true) };
		const projected = projectTaskConversationSessionsForMainSessionBinding(
			{ columns: [{ cards: [{ id: "task-1", mainTaskConversationSessionId: "codex-peer" }] }] },
			sessions,
		);
		expect(isTaskConversationSessionWithoutTaskLifecycleAuthority(projected["task-1"])).toBe(true);
		expect(isTaskConversationSessionWithoutTaskLifecycleAuthority(projected["codex-peer"])).toBe(false);
		expect(projected["task-1"].taskConversationSessionMetadata?.taskConversationSessionRoleAtCreation).toBe("main");
		expect(projected["codex-peer"].taskConversationSessionMetadata?.taskConversationSessionRoleAtCreation).toBe(
			"task_collaborator",
		);
		expect(projected["codex-peer"].taskConversationSessionMetadata?.taskConversationSessionContextSource).toBe(
			"started_from_scratch",
		);
		expect(
			projectTaskConversationSessionsForMainSessionBinding(
				{ columns: [{ cards: [{ id: "task-1", mainTaskConversationSessionId: "codex-peer" }] }] },
				projected,
			),
		).toBe(projected);
	});
	it("缺失或跨任务的显式目标不回退到原 Claude", () => {
		const card = { id: "task-1", mainTaskConversationSessionId: "missing-codex" };
		expect(resolveMainTaskConversationSessionSummary(card, { "task-1": summary("task-1") })).toBeNull();
		expect(
			resolveMainTaskConversationSessionSummary(
				{ ...card, mainTaskConversationSessionId: "other-task" },
				{ "other-task": summary("other-task") },
			),
		).toBeNull();
	});
});
