import { describe, expect, it, vi } from "vitest";
import { createDefaultAcpSummary } from "../../../src/acp-client-session/acp-session-state";
import { advanceAgentWorkProgress } from "../../../src/core/agent-work-progress";
import * as workspaceState from "../../../src/state/workspace-state";
import {
	collectTaskIndexingMaterials,
	readClaudeAwaySummaryFromExistingTranscriptLine,
} from "../../../src/task-indexing-support/collect-task-indexing-materials";

vi.mock("../../../src/state/workspace-state", () => ({
	listWorkspaceIndexEntries: vi.fn(),
	loadWorkspaceBoardById: vi.fn(),
	loadPersistedWorkspaceSessionsById: vi.fn(),
}));

describe("复用 Claude 已有 away summary", () => {
	it("读取原生 system/away_summary 的 content，忽略侧链与正文提到的同名词", () => {
		expect(
			readClaudeAwaySummaryFromExistingTranscriptLine(
				JSON.stringify({
					type: "system",
					subtype: "away_summary",
					content: "已经实现核心，仍待验收。",
					isSidechain: false,
				}),
			),
		).toBe("已经实现核心，仍待验收。");
		expect(
			readClaudeAwaySummaryFromExistingTranscriptLine(
				JSON.stringify({ type: "system", subtype: "away_summary", content: "分身的结论", isSidechain: true }),
			),
		).toBeNull();
		expect(
			readClaudeAwaySummaryFromExistingTranscriptLine(
				JSON.stringify({ type: "assistant", message: { content: "代码含有 away_summary 字样" } }),
			),
		).toBeNull();
	});
});

describe("持久会话读取失败的项目隔离", () => {
	it("Session Intent 只读取显式选择且 incarnation 一致的主会话", async () => {
		vi.mocked(workspaceState.listWorkspaceIndexEntries).mockResolvedValue([
			{ workspaceId: "project-a", repoPath: "/project" },
		]);
		vi.mocked(workspaceState.loadWorkspaceBoardById).mockResolvedValue({
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: ["abc12", "def34"].map((id) => ({
						id,
						title: id,
						prompt: "不能自动读取的全文",
						baseRef: "main",
						startInPlanMode: false,
						createdAt: 1,
						updatedAt: 1,
					})),
				},
			],
		});
		vi.mocked(workspaceState.loadPersistedWorkspaceSessionsById).mockResolvedValue({
			abc12: createDefaultAcpSummary("abc12", "codex"),
		});
		const readSessionIntentMaterial = vi.fn(async () => ({
			sessionIntent: { taskConversationSessionId: "abc12", nativeSessionId: "native", messages: [] },
			missingContextParts: ["session_intent_messages_unavailable"],
		}));
		const result = await collectTaskIndexingMaterials({
			workspaceId: "project-a",
			listLiveSessionSummaries: () => [],
			includeRecapSources: false,
			readSessionIntentMaterial,
			sessionIntentTaskReferences: [
				{
					workUnitType: "kanban_board_card",
					workspaceId: "project-a",
					taskId: "abc12",
					taskIncarnationCreatedAtEpochMs: 1,
				},
				{
					workUnitType: "kanban_board_card",
					workspaceId: "project-a",
					taskId: "def34",
					taskIncarnationCreatedAtEpochMs: 999,
				},
			],
		});
		expect(readSessionIntentMaterial).toHaveBeenCalledOnce();
		expect(readSessionIntentMaterial).toHaveBeenCalledWith(
			expect.objectContaining({ card: expect.objectContaining({ id: "abc12", createdAt: 1 }) }),
		);
		expect(result.materials[0]?.sessionIntent?.taskConversationSessionId).toBe("abc12");
		expect(result.materials[0]?.missingContextParts).toContain("session_intent_messages_unavailable");
		expect(result.materials[1]?.sessionIntent).toBeUndefined();
	});
	it.each(["project-a", "project-b"])(
		"%s 会话损坏时仍保留任务和未知缺口，恢复后自动补齐",
		async (brokenWorkspaceId) => {
			vi.mocked(workspaceState.listWorkspaceIndexEntries).mockResolvedValue(
				["project-a", "project-b"].map((workspaceId) => ({
					workspaceId,
					repoPath: `/projects/${workspaceId}`,
					createdAt: 1,
					updatedAt: 1,
				})),
			);
			vi.mocked(workspaceState.loadWorkspaceBoardById).mockImplementation(async () => ({
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{
								id: "abc12",
								title: "可读任务",
								prompt: "任务要求",
								baseRef: "main",
								startInPlanMode: false,
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			}));
			const summary = createDefaultAcpSummary("abc12", "omp");
			summary.agentWorkProgressEntries = advanceAgentWorkProgress(
				summary,
				{ progressEntryId: "implemented", progressText: "核心实现已完成", progressEntryOutcome: "completed" },
				"implemented",
				100,
			);
			vi.mocked(workspaceState.loadPersistedWorkspaceSessionsById).mockImplementation(async (workspaceId) => {
				if (workspaceId === brokenWorkspaceId) throw new Error("sessions.json 校验失败");
				return { abc12: summary };
			});
			const input = { workspaceId: "project-a", includeRecapSources: false, listLiveSessionSummaries: () => [] };
			const result = await collectTaskIndexingMaterials(input);
			expect(result.materials).toHaveLength(2);
			expect(result.missingContextParts).toEqual([`${brokenWorkspaceId}:sessions_unreadable`]);
			const brokenMaterial = result.materials.find((entry) => entry.taskReference.workspaceId === brokenWorkspaceId);
			expect(brokenMaterial?.latestTaskProgressSummaryText).toBeNull();
			expect(brokenMaterial?.missingContextParts).toContain("persisted_sessions_unreadable");
			expect(
				result.materials.find((entry) => entry.taskReference.workspaceId !== brokenWorkspaceId)
					?.latestTaskProgressSummaryText,
			).toContain("核心实现已完成");
			vi.mocked(workspaceState.loadPersistedWorkspaceSessionsById).mockResolvedValue({ abc12: summary });
			const recovered = await collectTaskIndexingMaterials(input);
			expect(recovered.missingContextParts).toEqual([]);
			expect(
				recovered.materials.every((entry) => entry.latestTaskProgressSummaryText?.includes("核心实现已完成")),
			).toBe(true);
		},
	);
});
