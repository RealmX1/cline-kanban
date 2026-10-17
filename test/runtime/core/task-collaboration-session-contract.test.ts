import { describe, expect, it } from "vitest";
import {
	type RuntimeTaskSessionSummary,
	runtimeTaskConversationSessionMetadataSchema,
} from "../../../src/core/api-contract";
import {
	isTaskConversationSessionWithoutTaskLifecycleAuthority,
	resolveByTheWayMainSessionForkSelection,
} from "../../../src/core/session-activity";

describe("协作会话的角色与启动配置", () => {
	it("接受独立启动配置，并把可写协作会话与主会话的生命周期权限分开", () => {
		const metadata = runtimeTaskConversationSessionMetadataSchema.parse({
			workspaceTaskId: "owner-task",
			taskConversationSessionRole: "task_collaborator",
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: 2,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: "实现另一部分",
			taskConversationSessionLaunchSettings: {
				taskAgentPermissionMode: "bypass_all_permission_prompts",
				startInPlanMode: false,
				sessionTransport: "acp_stdio_subprocess",
			},
		});
		expect(metadata.taskConversationSessionLaunchSettings?.sessionTransport).toBe("acp_stdio_subprocess");
		expect(
			isTaskConversationSessionWithoutTaskLifecycleAuthority({ taskConversationSessionMetadata: metadata }),
		).toBe(true);
		expect(isTaskConversationSessionWithoutTaskLifecycleAuthority({})).toBe(false);
		expect(
			isTaskConversationSessionWithoutTaskLifecycleAuthority({
				taskConversationSessionMetadata: { ...metadata, taskConversationSessionRole: "main" },
			}),
		).toBe(false);
	});
});

// summary 的其他字段不参与 fork 寻址；用最小结构凸显身份与 agent 的约束。
describe("By the way 主对话身份边界", () => {
	it.each(["claude", "codex"] as const)("拒绝把另一 harness 的主对话交给 %s fork", (launchAgentId) => {
		const otherAgentId = launchAgentId === "claude" ? "codex" : "claude";
		const selection = resolveByTheWayMainSessionForkSelection({
			workspaceTaskId: "task-1",
			launchAgentId,
			mainSessionWorkingDirectoryPath: "/repo",
			mainSessionSummary: {
				agentId: otherAgentId,
				agentNativeConversationSessionIdentity: { sourceAgentId: otherAgentId, nativeSessionId: "main-native-id" },
			} as RuntimeTaskSessionSummary,
			existingTaskConversationSessionSummaries: [],
		});
		expect(selection.forkRejectionReason).toContain("agent 与当前 By the way agent 不同");
		expect(selection.mainSessionNativeConversationSessionId).toBeUndefined();
	});

	it("不采用 sourceAgentId 不匹配的主身份，也不猜测协作对话", () => {
		const selection = resolveByTheWayMainSessionForkSelection({
			workspaceTaskId: "task-1",
			launchAgentId: "codex",
			mainSessionWorkingDirectoryPath: "/repo",
			mainSessionSummary: {
				agentId: "codex",
				agentNativeConversationSessionIdentity: { sourceAgentId: "claude", nativeSessionId: "claude-main-id" },
			} as RuntimeTaskSessionSummary,
			existingTaskConversationSessionSummaries: [
				{ taskId: "collaborator", agentId: "codex", workspacePath: "/repo" } as RuntimeTaskSessionSummary,
			],
		});
		expect(selection.forkRejectionReason).toContain("主会话尚未记录可用的");
		expect(selection.mainSessionNativeConversationSessionId).toBeUndefined();
	});
});
