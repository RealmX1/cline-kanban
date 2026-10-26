import { describe, expect, it } from "vitest";
import { resolveLastEffectiveAgentConversationActivityObservation } from "../../../src/core/agent-conversation-activity-observation";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import { estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn } from "../../../src/core/cross-project-recently-active-task-switcher-section-assignment";
import { collectCrossProjectTaskSwitcherEntriesFromBoard } from "../../../src/server/cross-project-task-switcher-entry-projection";
import {
	collectInProgressTaskDetailsFromBoardUsingTaskSessionFacts,
	type TaskSessionFactsForCrossProjectTaskViews,
} from "../../../src/server/in-progress-task-detail-projection";

// 跨项目切换面板条目的取景（哪些卡进 projects_updated 广播）。不变量：
//   - 置顶的卡不论哪一列都进（含 Done）；
//   - 其余所有阶段，且 agent 正持有回合、或最近触达时刻在时间窗内；
//   - 条目是 in_progress 明细（inProgressTaskDetails）的超集，由同一个 per-card 构造函数产出。

const NOW_MS = 10_000_000_000;
const DAY_MS = 24 * 60 * 60_000;
const HORIZON_MS = 7 * DAY_MS;

function makeCard(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: "p",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
		taskDescriptionLastUpdatedAt: 0,
		...overrides,
	};
}

function makeBoard(cardsByColumn: Partial<Record<RuntimeBoardColumnId, RuntimeBoardCard[]>>): RuntimeBoardData {
	const columnIds: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return { columns: columnIds.map((id) => ({ id, title: id, cards: cardsByColumn[id] ?? [] })) };
}

function makeFacts(
	overrides: Partial<TaskSessionFactsForCrossProjectTaskViews> = {},
): TaskSessionFactsForCrossProjectTaskViews {
	return {
		agentId: "claude",
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		agentResponseGenerationStopped: null,
		lastConversationProgressObservation: null,
		agentResponseGenerationTurnStarted: null,
		lastMainAgentConversationModelRequestDispatchObservation: null,
		agentProcessStartedAt: null,
		turnOwner: null,
		liveness: "none",
		userTurnKind: null,
		isParkedAwaitingDispatchedBackgroundWork: false,
		...overrides,
	};
}

function collect(
	board: RuntimeBoardData,
	sessionFactsByTaskId = new Map<string, TaskSessionFactsForCrossProjectTaskViews>(),
	lastOpenedByUserAtByTaskId = new Map<string, number>(),
) {
	return collectCrossProjectTaskSwitcherEntriesFromBoard({
		board,
		sessionFactsByTaskId,
		lastOpenedByUserAtByTaskId,
		nowMs: NOW_MS,
		activityHorizonMs: HORIZON_MS,
	});
}

describe("collectCrossProjectTaskSwitcherEntriesFromBoard", () => {
	it("跨项目条目保留显式null，使旧推进和请求值无法重启业务时钟", () => {
		const [entry] = collect(
			makeBoard({ review: [makeCard("card", { taskDescriptionLastUpdatedAt: NOW_MS })] }),
			new Map([
				[
					"card",
					makeFacts({
						turnOwner: "user",
						liveness: "live",
						userTurnKind: "review",
						lastEffectiveAgentConversationActivityObservation: null,
						lastAgentConversationPromptCacheReferenceObservation: null,
						lastAgentConversationUserHandoffObservation: null,
						agentConversationPromptSubmissionAcceptance: null,
						lastConversationProgressObservation: {
							observedAtMs: NOW_MS,
							evidenceKind: "persisted_agent_transcript",
						},
						lastMainAgentConversationModelRequestDispatchObservation: {
							observedAtMs: NOW_MS,
							evidenceKind: "post_tool_use_hook_event",
						},
					}),
				],
			]),
		);
		expect(entry).toBeDefined();
		if (!entry) throw new Error("缺少跨项目测试条目");
		for (const field of [
			"lastEffectiveAgentConversationActivityObservation",
			"lastAgentConversationPromptCacheReferenceObservation",
			"lastAgentConversationUserHandoffObservation",
			"agentConversationPromptSubmissionAcceptance",
		])
			expect(entry).toHaveProperty(field, null);
		expect(resolveLastEffectiveAgentConversationActivityObservation(entry)).toBeNull();
		expect(estimateMainAgentConversationPromptCacheWarmthForTaskOutsideAgentTurn(entry, NOW_MS)).toBeNull();
	});

	it.each([undefined, "another-card"])("跨项目与主卡一致拒绝缺归属或错误归属的新主（%s）", (workspaceTaskId) => {
		const [entry] = collect(
			makeBoard({
				review: [
					makeCard("card", { mainTaskConversationSessionId: "new-main", taskDescriptionLastUpdatedAt: NOW_MS }),
				],
			}),
			new Map([
				[
					"new-main",
					makeFacts({
						turnOwner: "agent",
						liveness: "live",
						lastEffectiveAgentConversationActivityObservation: {
							observedAtMs: NOW_MS,
							evidenceKind: "persisted_agent_transcript",
							activityKind: "agent_output",
						},
						taskConversationSessionMetadata: workspaceTaskId
							? {
									workspaceTaskId,
									taskConversationSessionRole: "main",
									taskConversationSessionContextSource: "main",
									parentTaskConversationSessionId: null,
									mainSessionOriginTurnNumber: null,
									mainSessionOriginUserMessagePreview: null,
									latestUserMessagePreview: null,
								}
							: undefined,
					}),
				],
			]),
		);
		expect(entry).toMatchObject({ turnOwner: null, liveness: "none" });
		expect(entry?.taskConversationSessionActivityObservations).toEqual([
			{
				sessionId: "new-main",
				role: "main",
				agentId: null,
				lastEffectiveAgentConversationActivityObservation: null,
			},
		]);
	});

	it("主交接后主投影只读新主，peer/By the way/前主保留独立活动与归属", () => {
		const activity = (observedAtMs: number) =>
			({ observedAtMs, evidenceKind: "persisted_agent_transcript", activityKind: "agent_output" }) as const;
		const metadata = (role: "by_the_way" | "task_collaborator" | "main") => ({
			workspaceTaskId: "card",
			taskConversationSessionRole: role,
			taskConversationSessionContextSource: "started_from_scratch" as const,
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
		});
		const entries = collect(
			makeBoard({
				review: [makeCard("card", { mainTaskConversationSessionId: "main", taskDescriptionLastUpdatedAt: NOW_MS })],
			}),
			new Map([
				["card", makeFacts({ lastEffectiveAgentConversationActivityObservation: activity(NOW_MS) })],
				[
					"main",
					makeFacts({
						taskConversationSessionMetadata: metadata("main"),
						lastEffectiveAgentConversationActivityObservation: activity(NOW_MS - 1000),
					}),
				],
				[
					"peer",
					makeFacts({
						taskConversationSessionMetadata: metadata("task_collaborator"),
						lastEffectiveAgentConversationActivityObservation: activity(NOW_MS + 1000),
					}),
				],
				[
					"side",
					makeFacts({
						taskConversationSessionMetadata: metadata("by_the_way"),
						lastEffectiveAgentConversationActivityObservation: null,
					}),
				],
				["unrelated", makeFacts({ lastEffectiveAgentConversationActivityObservation: activity(NOW_MS + 2000) })],
			]),
		);
		expect(entries[0]?.lastEffectiveAgentConversationActivityObservation?.observedAtMs).toBe(NOW_MS - 1000);
		expect(
			entries[0]?.taskConversationSessionActivityObservations?.map(({ sessionId, role }) => [sessionId, role]),
		).toEqual([
			["main", "main"],
			["card", "former_main"],
			["peer", "task_collaborator"],
			["side", "by_the_way"],
		]);
	});

	it("Backlog 与其他阶段一样排除时间窗外的旧卡", () => {
		const entries = collect(
			makeBoard({
				backlog: [makeCard("old-backlog", { taskDescriptionLastUpdatedAt: NOW_MS - 60 * DAY_MS })],
				review: [makeCard("old-review")],
			}),
		);
		expect(entries.map((entry) => entry.taskId)).toEqual([]);
	});
	it("时间窗外、无会话、未置顶的卡不进广播", () => {
		expect(collect(makeBoard({ review: [makeCard("old")] }))).toEqual([]);
	});

	it("Description 刚编辑过 / 我刚打开过 / 对话刚推进过的卡进广播，并带上列与时间戳", () => {
		const board = makeBoard({
			backlog: [makeCard("edited", { taskDescriptionLastUpdatedAt: NOW_MS - DAY_MS })],
			review: [makeCard("opened"), makeCard("progressed")],
		});
		const entries = collect(
			board,
			new Map([
				[
					"progressed",
					makeFacts({
						lastConversationProgressObservation: {
							observedAtMs: NOW_MS,
							evidenceKind: "agent_lifecycle_hook_event",
						},
					}),
				],
			]),
			new Map([["opened", NOW_MS - DAY_MS]]),
		);
		expect(entries.map((entry) => [entry.taskId, entry.columnId])).toEqual([
			["edited", "backlog"],
			["opened", "review"],
			["progressed", "review"],
		]);
		expect(entries.find((entry) => entry.taskId === "opened")?.lastOpenedByUserAt).toBe(NOW_MS - DAY_MS);
	});

	it("agent 正持有回合的卡不论多久没碰都进（Running 候选），并带上本轮回合开始事件供 Running 排序", () => {
		const entries = collect(
			makeBoard({ review: [makeCard("running")] }),
			new Map([
				[
					"running",
					makeFacts({
						turnOwner: "agent",
						liveness: "live",
						lastOutputAt: NOW_MS,
						agentResponseGenerationTurnStarted: { startedAt: NOW_MS - 1_000, turnSequence: 3 },
					}),
				],
			]),
		);
		expect(entries.map((entry) => entry.taskId)).toEqual(["running"]);
		expect(entries[0]?.agentResponseGenerationTurnStarted).toEqual({ startedAt: NOW_MS - 1_000, turnSequence: 3 });
	});

	it("带上卡片的 baseRef 与 worktreeMode（行上 git 元数据的 tooltip 与图标用）", () => {
		const entries = collect(
			makeBoard({
				review: [
					makeCard("branch-task", { taskDescriptionLastUpdatedAt: NOW_MS, baseRef: "develop" }),
					makeCard("inplace-task", { taskDescriptionLastUpdatedAt: NOW_MS, worktreeMode: "inplace" }),
				],
			}),
		);
		expect(entries.map((entry) => [entry.taskId, entry.baseRef, entry.worktreeMode])).toEqual([
			["branch-task", "develop", undefined],
			["inplace-task", "main", "inplace"],
		]);
	});

	it("Done 中的置顶卡和近期触达卡进入广播，旧卡排除", () => {
		const entries = collect(
			makeBoard({
				trash: [
					makeCard("pinned-done", { pinnedToTaskPinboardAt: 1, taskPinboardPinReason: "watch" }),
					makeCard("recent-done", { taskDescriptionLastUpdatedAt: NOW_MS }),
					makeCard("old-done"),
				],
			}),
		);
		expect(entries.map((entry) => [entry.taskId, entry.pinnedToTaskPinboardAt, entry.taskPinboardPinReason])).toEqual(
			[
				["pinned-done", 1, "watch"],
				["recent-done", null, null],
			],
		);
	});

	it("条目是 in_progress 明细的超集（同一个 per-card 构造函数）", () => {
		const board = makeBoard({ in_progress: [makeCard("a", { taskDescriptionLastUpdatedAt: NOW_MS })] });
		const sessionFactsByTaskId = new Map([
			["a", makeFacts({ turnOwner: "user", liveness: "exited", userTurnKind: "review", lastOutputAt: 5 })],
		]);
		const [entry] = collect(board, sessionFactsByTaskId);
		const [inProgressDetail] = collectInProgressTaskDetailsFromBoardUsingTaskSessionFacts(
			board,
			sessionFactsByTaskId,
		);
		expect(entry).toMatchObject(inProgressDetail ?? {});
		expect(entry?.userTurnKind).toBe("review");
	});
});

it("全量取景包含五个 Stage 的过期搁置任务", () => {
	const board = makeBoard(
		Object.fromEntries(
			["backlog", "in_progress", "review", "validation", "trash"].map((stage) => [
				stage,
				[makeCard(stage, { taskShelvingState: { isShelved: true, lastChangedAt: 1 } })],
			]),
		),
	);
	const entries = collect(board);
	expect(entries).toHaveLength(5);
	expect(entries.every((entry) => entry.taskShelvingState?.isShelved)).toBe(true);
});
