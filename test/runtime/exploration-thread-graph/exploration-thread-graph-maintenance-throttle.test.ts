import type {
	CompletedTurnSequenceSnapshot,
	ExplorationThreadGraphCollection,
} from "agent-conversation-exploration-thread-graph/core";
import { createEmptyExplorationThreadGraphCollection } from "agent-conversation-exploration-thread-graph/core";
import { describe, expect, it } from "vitest";
import {
	countUnplacedCompletedTurns,
	DEFAULT_MINIMUM_TURNS_BETWEEN_MAINTENANCE_RUNS,
	decideExplorationThreadGraphMaintenanceThrottle,
} from "../../../src/exploration-thread-graph/exploration-thread-graph-maintenance-throttle";

// 这道闸是宿主侧唯一的成本闸：放宽一格，每个 turn 就多烧一次 fork（重型会话实测 ≈ $4.5/次）。

function makeSnapshot(conversationSessionId: string, turnNumbers: readonly number[]): CompletedTurnSequenceSnapshot {
	return {
		conversationSessionId,
		sourceKind: "claude_code_transcript",
		turns: turnNumbers.map((turnNumber) => ({
			turnNumber,
			userPromptExcerpt: `prompt ${turnNumber}`,
			assistantResponseExcerpt: `response ${turnNumber}`,
			startedAt: new Date(turnNumber * 1_000).toISOString(),
			endedAt: new Date(turnNumber * 1_000 + 500).toISOString(),
			userMessageOrigin: "human_typed",
			toolCallCount: 0,
		})),
		sourceSignature: `signature-${turnNumbers.length}`,
		projectionConfidence: "transcript_reconstructed",
		inProgressTurnNumber: null,
	};
}

function makeCollection(overrides: Partial<ExplorationThreadGraphCollection> = {}): ExplorationThreadGraphCollection {
	return { ...createEmptyExplorationThreadGraphCollection("exploration-1", 1_000), ...overrides };
}

function makeSnapshots(
	entries: readonly (readonly [string, readonly number[]])[],
): Map<string, CompletedTurnSequenceSnapshot> {
	return new Map(entries.map(([sessionId, turnNumbers]) => [sessionId, makeSnapshot(sessionId, turnNumbers)]));
}

describe("countUnplacedCompletedTurns", () => {
	it("只数超过该会话 lastPlacedTurnNumber 的已完成 turn，逐会话各算各的", () => {
		const collection = makeCollection({ lastPlacedTurnNumberBySession: { "session-a": 3, "session-b": 0 } });
		const turnSnapshotsBySession = makeSnapshots([
			["session-a", [1, 2, 3, 4, 5]],
			["session-b", [1, 2]],
		]);

		expect(countUnplacedCompletedTurns(collection, turnSnapshotsBySession)).toBe(4);
	});

	it("collection 里没有记录过的会话按「一个都没归位」计", () => {
		const collection = makeCollection();
		expect(countUnplacedCompletedTurns(collection, makeSnapshots([["session-new", [1, 2, 3]]]))).toBe(3);
	});
});

describe("decideExplorationThreadGraphMaintenanceThrottle", () => {
	it("从未维护过且有已完成 turn ⇒ 立刻 backfill，不受间隔约束", () => {
		const decision = decideExplorationThreadGraphMaintenanceThrottle({
			collection: makeCollection({ lastMaintenanceJobCompletedAt: null }),
			turnSnapshotsBySession: makeSnapshots([["session-a", [1]]]),
		});

		expect(decision).toEqual({ shouldRun: true, mode: "initial_backfill", unplacedCompletedTurnCount: 1 });
	});

	it("一个已完成 turn 都没有 ⇒ 不跑（即便从未维护过）", () => {
		const decision = decideExplorationThreadGraphMaintenanceThrottle({
			collection: makeCollection({ lastMaintenanceJobCompletedAt: null }),
			turnSnapshotsBySession: makeSnapshots([["session-a", []]]),
		});

		expect(decision).toEqual({ shouldRun: false, reason: "no_completed_turns", unplacedCompletedTurnCount: 0 });
	});

	it("维护过之后，未归位数不足阈值就不跑——这正是成本闸生效的那一刻", () => {
		const decision = decideExplorationThreadGraphMaintenanceThrottle({
			collection: makeCollection({
				lastMaintenanceJobCompletedAt: 5_000,
				lastPlacedTurnNumberBySession: { "session-a": 3 },
			}),
			turnSnapshotsBySession: makeSnapshots([["session-a", [1, 2, 3, 4, 5, 6]]]),
			minimumTurnsBetweenMaintenanceRuns: 5,
		});

		expect(decision).toEqual({
			shouldRun: false,
			reason: "not_enough_newly_completed_turns",
			unplacedCompletedTurnCount: 3,
		});
	});

	it("攒够阈值 ⇒ 增量跑", () => {
		const decision = decideExplorationThreadGraphMaintenanceThrottle({
			collection: makeCollection({
				lastMaintenanceJobCompletedAt: 5_000,
				lastPlacedTurnNumberBySession: { "session-a": 3 },
			}),
			turnSnapshotsBySession: makeSnapshots([["session-a", [1, 2, 3, 4, 5, 6, 7, 8]]]),
			minimumTurnsBetweenMaintenanceRuns: 5,
		});

		expect(decision).toEqual({ shouldRun: true, mode: "incremental", unplacedCompletedTurnCount: 5 });
	});

	it("跨会话累加后达标即可——by-the-way 会话的新 turn 同样算数", () => {
		const decision = decideExplorationThreadGraphMaintenanceThrottle({
			collection: makeCollection({
				lastMaintenanceJobCompletedAt: 5_000,
				lastPlacedTurnNumberBySession: { "session-a": 2, "session-b": 0 },
			}),
			turnSnapshotsBySession: makeSnapshots([
				["session-a", [1, 2, 3, 4]],
				["session-b", [1, 2, 3]],
			]),
			minimumTurnsBetweenMaintenanceRuns: 5,
		});

		expect(decision).toEqual({ shouldRun: true, mode: "incremental", unplacedCompletedTurnCount: 5 });
	});

	it("默认阈值为 5：给到 4 个新 turn 时不跑，第 5 个到位才跑", () => {
		const collection = makeCollection({
			lastMaintenanceJobCompletedAt: 5_000,
			lastPlacedTurnNumberBySession: { "session-a": 0 },
		});
		expect(DEFAULT_MINIMUM_TURNS_BETWEEN_MAINTENANCE_RUNS).toBe(5);
		expect(
			decideExplorationThreadGraphMaintenanceThrottle({
				collection,
				turnSnapshotsBySession: makeSnapshots([["session-a", [1, 2, 3, 4]]]),
			}).shouldRun,
		).toBe(false);
		expect(
			decideExplorationThreadGraphMaintenanceThrottle({
				collection,
				turnSnapshotsBySession: makeSnapshots([["session-a", [1, 2, 3, 4, 5]]]),
			}).shouldRun,
		).toBe(true);
	});
});
