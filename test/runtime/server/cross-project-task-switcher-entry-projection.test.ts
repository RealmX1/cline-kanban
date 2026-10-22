import { describe, expect, it } from "vitest";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import { collectCrossProjectTaskSwitcherEntriesFromBoard } from "../../../src/server/cross-project-task-switcher-entry-projection";
import {
	collectInProgressTaskDetailsFromBoardUsingTaskSessionFacts,
	type TaskSessionFactsForCrossProjectTaskViews,
} from "../../../src/server/in-progress-task-detail-projection";

// 跨项目切换面板条目的取景（哪些卡进 projects_updated 广播）。不变量：
//   - 置顶的卡不论哪一列都进（含 Done）；
//   - 其余只取非 Done 列，且 agent 正持有回合、或「最后被碰」/ 停止生成时刻在时间窗内；
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
	it("完整 Backlog 不受活动时间窗限制，其他旧卡仍排除", () => {
		const entries = collect(
			makeBoard({
				backlog: [makeCard("old-backlog", { taskDescriptionLastUpdatedAt: NOW_MS - 60 * DAY_MS })],
				review: [makeCard("old-review")],
			}),
		);
		expect(entries.map((entry) => entry.taskId)).toEqual(["old-backlog"]);
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

	it("置顶的卡即使在 Done 列、很久没碰也进；未置顶的 Done 卡即使刚碰过也不进", () => {
		const entries = collect(
			makeBoard({
				trash: [
					makeCard("pinned-done", { pinnedToTaskPinboardAt: 1, taskPinboardPinReason: "watch" }),
					makeCard("recent-done", { taskDescriptionLastUpdatedAt: NOW_MS }),
				],
			}),
		);
		expect(entries.map((entry) => [entry.taskId, entry.pinnedToTaskPinboardAt, entry.taskPinboardPinReason])).toEqual(
			[["pinned-done", 1, "watch"]],
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
