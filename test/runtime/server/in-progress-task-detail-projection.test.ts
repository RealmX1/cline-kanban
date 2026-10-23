import { describe, expect, it } from "vitest";
import {
	resolveLastAgentConversationPromptCacheReferenceObservation,
	resolveLastEffectiveAgentConversationActivityObservation,
} from "../../../src/core/agent-conversation-activity-observation";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	buildTaskActivityDetailFromBoardCardAndTaskSessionFacts,
	collectInProgressTaskDetailsFromBoard,
	extractTaskSessionFactsForCrossProjectTaskViews,
} from "../../../src/server/in-progress-task-detail-projection";

// in_progress 明细投影（顶栏项目切换器的 live 计数读它）。核心不变量：按「列归属」取 in_progress 列全部卡，
// awaiting_review 的卡不被挪走；无 session 的卡回退 null/none。
// 纯函数测试，不启动 SDK host（见 AGENTS.md Node22 CI 挂起告警）。

function makeCard(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: "p",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function makeBoard(columnToTaskIds: Partial<Record<RuntimeBoardColumnId, string[]>>): RuntimeBoardData {
	const allColumns: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: allColumns.map((id) => ({
			id,
			title: id,
			cards: (columnToTaskIds[id] ?? []).map((taskId) => makeCard(taskId)),
		})),
	};
}

function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 1_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function sessionsOf(...summaries: RuntimeTaskSessionSummary[]): Record<string, RuntimeTaskSessionSummary> {
	return Object.fromEntries(summaries.map((summary) => [summary.taskId, summary]));
}

describe("collectInProgressTaskDetailsFromBoard", () => {
	it("明确清空的新活动、缓存、交棒与接受字段必须保留null，不能复活旧值", () => {
		const facts = extractTaskSessionFactsForCrossProjectTaskViews(
			makeSummary({
				lastEffectiveAgentConversationActivityObservation: null,
				lastAgentConversationPromptCacheReferenceObservation: null,
				lastAgentConversationUserHandoffObservation: null,
				agentConversationPromptSubmissionAcceptance: null,
				lastConversationProgressObservation: { observedAtMs: 100, evidenceKind: "persisted_agent_transcript" },
				lastMainAgentConversationModelRequestDispatchObservation: {
					observedAtMs: 200,
					evidenceKind: "post_tool_use_hook_event",
				},
				agentResponseGenerationStopped: {
					stoppedAt: 300,
					signalConfidence: "harness_turn_complete",
					turnSequence: 1,
				},
			}),
		);
		const detail = buildTaskActivityDetailFromBoardCardAndTaskSessionFacts(makeCard("task-1"), facts);
		for (const field of [
			"lastEffectiveAgentConversationActivityObservation",
			"lastAgentConversationPromptCacheReferenceObservation",
			"lastAgentConversationUserHandoffObservation",
			"agentConversationPromptSubmissionAcceptance",
		])
			expect(detail).toHaveProperty(field, null);
		expect(resolveLastEffectiveAgentConversationActivityObservation(detail)).toBeNull();
		expect(resolveLastAgentConversationPromptCacheReferenceObservation(detail)).toBeNull();
	});

	it.each([undefined, "another-card"])("交接后主会话缺归属或归属错误（%s）时保持未知", (workspaceTaskId) => {
		const board = makeBoard({ in_progress: ["card"] });
		const card = board.columns.find((column) => column.id === "in_progress")?.cards[0];
		if (!card) throw new Error("缺少待交接的测试卡片");
		card.mainTaskConversationSessionId = "new-main";
		const metadata = workspaceTaskId
			? {
					workspaceTaskId,
					taskConversationSessionRole: "main" as const,
					taskConversationSessionContextSource: "main" as const,
					parentTaskConversationSessionId: null,
					mainSessionOriginTurnNumber: null,
					mainSessionOriginUserMessagePreview: null,
					latestUserMessagePreview: null,
				}
			: undefined;
		const [detail] = collectInProgressTaskDetailsFromBoard(
			board,
			sessionsOf(
				makeSummary({
					taskId: "new-main",
					state: "running",
					taskConversationSessionMetadata: metadata,
					lastConversationProgressObservation: { observedAtMs: 100, evidenceKind: "persisted_agent_transcript" },
				}),
			),
		);
		expect(detail).toMatchObject({ turnOwner: null, liveness: "none" });
		expect(resolveLastEffectiveAgentConversationActivityObservation(detail)).toBeNull();
	});

	it("in_progress 列无卡 → 空数组", () => {
		expect(collectInProgressTaskDetailsFromBoard(makeBoard({}), {})).toEqual([]);
	});

	it("只投影 in_progress 列，其余列忽略", () => {
		const board = makeBoard({ in_progress: ["a"], review: ["r"], backlog: ["b"], validation: ["v"], trash: ["t"] });
		const result = collectInProgressTaskDetailsFromBoard(board, {});
		expect(result.map((detail) => detail.taskId)).toEqual(["a"]);
	});

	it("无 session 的卡 → turnOwner=null / liveness=none / lastOutputAt=null", () => {
		const result = collectInProgressTaskDetailsFromBoard(makeBoard({ in_progress: ["a"] }), {});
		expect(result).toEqual([
			{
				taskId: "a",
				title: "a",
				agentId: null,
				createdAt: 0,
				lastOutputAt: null,
				lastSubstantiveOutputAt: null,
				// 两颗时长药丸的字段同样只是**透传**：无 session ⇒ 都是 null ⇒ 前端两颗都隐藏。
				agentResponseGenerationStopped: null,
				lastConversationProgressObservation: null,
				agentResponseGenerationTurnStarted: null,
				turnOwner: null,
				liveness: "none",
			},
		]);
	});

	it("running 会话 → turnOwner=agent / liveness=live，lastOutputAt 按 15 秒向下取整，透传 lastSubstantiveOutputAt / agentId", () => {
		const result = collectInProgressTaskDetailsFromBoard(
			makeBoard({ in_progress: ["a"] }),
			sessionsOf(
				makeSummary({
					taskId: "a",
					state: "running",
					pid: 1,
					agentId: "claude",
					// 落在 [0, 15 秒) 这一桶里：投影成 0，桶内的后续输出不再改变 projects_updated 的内容。
					lastOutputAt: 14_999,
					lastSubstantiveOutputAt: 4_000,
					agentResponseGenerationTurnStarted: { startedAt: 3_000, turnSequence: 2 },
				}),
			),
		);
		expect(result).toEqual([
			{
				taskId: "a",
				title: "a",
				agentId: "claude",
				createdAt: 0,
				lastOutputAt: 0,
				// 旧实质戳仅兼容透传，不能替代新的可信活动。
				lastSubstantiveOutputAt: 4_000,
				lastEffectiveAgentConversationActivityObservation: null,
				lastAgentConversationPromptCacheReferenceObservation: null,
				lastAgentConversationUserHandoffObservation: null,
				agentConversationPromptSubmissionAcceptance: null,
				// agent 回合期间没有停止事件；本用例的 summary 也没带推进观测 ⇒ 两颗都是 null。
				agentResponseGenerationStopped: null,
				lastConversationProgressObservation: null,
				// 本轮回合开始事件原样透传：切换面板 Running 区据此排序。
				agentResponseGenerationTurnStarted: { startedAt: 3_000, turnSequence: 2 },
				turnOwner: "agent",
				liveness: "live",
			},
		]);
	});

	// ADR-0001 口径：awaiting_review（agent 已交棒等审）的卡仍保留在 in_progress 明细里（前端归 Stale），
	// 不像主看板计数那样被挪进 review。
	it("awaiting_review 的卡仍保留在 in_progress 明细（不被挪走）", () => {
		const result = collectInProgressTaskDetailsFromBoard(
			makeBoard({ in_progress: ["a"] }),
			sessionsOf(makeSummary({ taskId: "a", state: "awaiting_review", reviewReason: "exit", pid: 1 })),
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ taskId: "a", turnOwner: "user" });
	});

	it("agentId 优先取 session、回退卡片声明", () => {
		const board: RuntimeBoardData = {
			columns: [{ id: "in_progress", title: "in_progress", cards: [makeCard("a", { agentId: "codex" })] }],
		};
		const result = collectInProgressTaskDetailsFromBoard(board, {});
		expect(result[0]?.agentId).toBe("codex");
	});
});
