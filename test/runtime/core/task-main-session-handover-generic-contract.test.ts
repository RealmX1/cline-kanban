import { describe, expect, it } from "vitest";
import {
	taskMainSessionHandoverDestinationSchema,
	taskMainSessionHandoverRecordSchema,
} from "../../../src/core/task-main-session-handover-contract";
import { renderTaskMainSessionHandoverReportPrompt } from "../../../src/server/task-main-session-handover-coordinator";

const maintainedAgentIds = ["claude", "codex", "cursor", "droid", "kiro", "kimi", "omp"] as const;

describe("跨 harness 主会话交接契约", () => {
	it.each(maintainedAgentIds)("允许新建 %s 接任，并保留显式目标身份", (agentId) => {
		const destination = { kind: "new_agent_session", agentId };
		expect(taskMainSessionHandoverDestinationSchema.parse(destination)).toEqual(destination);
	});

	it.each(["cline", "opencode", "gemini", "unknown"])("不启用未维护或禁用的 %s", (agentId) => {
		expect(taskMainSessionHandoverDestinationSchema.safeParse({ kind: "new_agent_session", agentId }).success).toBe(
			false,
		);
	});

	it("非 Codex 报告不携带 Codex 专用斜杠命令", () => {
		const record = taskMainSessionHandoverRecordSchema.parse({
			handoverId: "handover-1",
			sourceTaskConversationSessionId: "source",
			targetTaskConversationSessionId: "target",
			destination: { kind: "new_agent_session", agentId: "claude" },
			status: "report_delivery_pending",
			createdAt: 1,
			updatedAt: 1,
			userContextNotes: "",
			additionalPlanReferencePaths: [],
			materialDirectoryPath: "/persistent/handover",
			errorMessage: null,
			reportDeliveryStartedAt: null,
		});
		const prompt = renderTaskMainSessionHandoverReportPrompt(record);
		expect(prompt).not.toMatch(/^\/plan /u);
		expect(prompt).toContain("KANBAN_MAIN_SESSION_HANDOVER_REPORT:handover-1:report:0");
		expect(prompt).toContain("汇报之后等待用户下一条消息");
	});

	it("旧 Codex 目标继续逐字兼容", () => {
		expect(taskMainSessionHandoverDestinationSchema.parse({ kind: "new_codex_session" })).toEqual({
			kind: "new_codex_session",
		});
		expect(
			taskMainSessionHandoverDestinationSchema.parse({
				kind: "existing_codex_session",
				taskConversationSessionId: "peer",
			}),
		).toEqual({ kind: "existing_codex_session", taskConversationSessionId: "peer" });
	});
});
