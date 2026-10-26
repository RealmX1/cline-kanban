import { describe, expect, it, vi } from "vitest";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";
import type { TaskMainSessionHandoverReportAcceptanceProbe } from "../../../src/core/task-main-session-handover-contract";
import {
	queryCodexMainSessionHandoverReportAcceptanceWithPort,
	queryTaskMainSessionHandoverReportAcceptance,
} from "../../../src/server/task-main-session-handover-report-acceptance";

const probe: TaskMainSessionHandoverReportAcceptanceProbe = {
	nativeSessionId: "target-native",
	workingDirectoryPath: "/task",
	transcriptPath: null,
	codexConversationStorageHomeDirectoryPath: "/bound-codex-home",
	nativeHistoryCursor: null,
	transcriptHistoryCursor: null,
	seenNativeHistoryCursors: [],
	historicalAcceptanceEvidence: null,
};
describe("交接报告原生接受只读补证", () => {
	it.each(["pending", "other-accepted-turn", "report-accepted"])(
		"ACP 只接受与本次投递绑定的协议证明：%s",
		async (scenario) => {
			const expectedReportDeliveryKey = "handover:report:0";
			const summary = runtimeTaskSessionSummarySchema.parse({
				taskId: "task",
				agentId: "omp",
				sessionTransport: "acp_stdio_subprocess",
				workspacePath: "/task",
				runtimeSessionIncarnationId: "incarnation",
				pid: null,
				startedAt: 1,
				updatedAt: 1,
				lastOutputAt: null,
				reviewReason: null,
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				turnOwner: null,
				liveness: "none",
				userTurnKind: null,
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "omp",
					nativeSessionId: "target-native",
					transcriptPath: null,
					observedAt: 1,
				},
				agentConversationPromptSubmissionAcceptance: {
					status: scenario === "pending" ? "pending" : "accepted",
					eventId: scenario === "other-accepted-turn" ? "other-turn" : expectedReportDeliveryKey,
					attemptedAtMs: 1,
					confirmedAtMs: 2,
					nativeSessionId: "target-native",
					runtimeSessionIncarnationId: "incarnation",
				},
			});
			const result = await queryTaskMainSessionHandoverReportAcceptance({
				summary,
				probe: { ...probe, targetAgentId: "omp" },
				workspaceId: "project",
				card: {
					id: "task",
					title: "交接任务",
					prompt: "需求",
					baseRef: "main",
					startInPlanMode: false,
					createdAt: 1,
					updatedAt: 1,
				},
				prompt: "完整交接报告",
				expectedReportDeliveryKey,
			});
			expect(result.historicalAcceptanceEvidence !== null).toBe(scenario === "report-accepted");
		},
	);
	it("分页进度可持久保存，重入沿原生身份查找斜杠命令处理后的完整正文", async () => {
		const text = "/plan KANBAN_MAIN_SESSION_HANDOVER_REPORT:handover:report:0\n只读汇报";
		const request = vi.fn(async (method: string, parameters: Record<string, unknown>) => {
			if (method === "thread/read") return { thread: { id: "target-native", cwd: "/task" } };
			return parameters.cursor === null
				? { data: [], nextCursor: "older-page" }
				: {
						data: [
							{
								id: "report-turn",
								status: "completed",
								items: [
									{
										id: "report-user-message",
										type: "userMessage",
										content: [{ type: "text", text: text.slice(6) }],
									},
								],
							},
						],
						nextCursor: null,
					};
		});
		const first = await queryCodexMainSessionHandoverReportAcceptanceWithPort({ request }, probe, text);
		expect(first.nativeHistoryCursor).toBe("older-page");
		expect(first.historicalAcceptanceEvidence).toBeNull();
		const restored = JSON.parse(JSON.stringify(first)) as TaskMainSessionHandoverReportAcceptanceProbe;
		const second = await queryCodexMainSessionHandoverReportAcceptanceWithPort({ request }, restored, text);
		expect(second.historicalAcceptanceEvidence?.sourceReference).toContain("report-user-message");
		expect(request.mock.calls.every(([method]) => ["thread/read", "thread/turns/list"].includes(method))).toBe(true);
	});
	it("只出现报告标记、正文被截断或工作目录不符均不能证明接受", async () => {
		const request = vi.fn(async (method: string) =>
			method === "thread/read"
				? { thread: { id: "target-native", cwd: "/task" } }
				: {
						data: [
							{
								id: "turn",
								status: "completed",
								items: [
									{
										id: "message",
										type: "userMessage",
										content: [{ type: "text", text: "KANBAN_MAIN_SESSION_HANDOVER_REPORT:handover" }],
									},
								],
							},
						],
						nextCursor: null,
					},
		);
		expect(
			(await queryCodexMainSessionHandoverReportAcceptanceWithPort({ request }, probe, "/plan 完整正文"))
				.historicalAcceptanceEvidence,
		).toBeNull();
		await expect(
			queryCodexMainSessionHandoverReportAcceptanceWithPort(
				{ request },
				{ ...probe, workingDirectoryPath: "/other" },
				"/plan 完整正文",
			),
		).rejects.toThrow("归属");
	});
});
