import { describe, expect, it } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeProjectTaskCounts,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import type { SessionFacets } from "../../../src/core/session-activity";
import { applyLiveSessionStateToProjectTaskCounts } from "../../../src/server/project-task-counts-live-session-overlay";

// 待审按 facet 叠加；中断保留原 Stage，不把会话退出误记为结案。
// 纯函数测试，不启动 SDK host。

function makeCard(id: string): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: "p",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 0,
		updatedAt: 0,
	};
}

function makeBoard(columnToTaskIds: Partial<Record<RuntimeBoardColumnId, string[]>>): RuntimeBoardData {
	const allColumns: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: allColumns.map((id) => ({
			id,
			title: id,
			cards: (columnToTaskIds[id] ?? []).map(makeCard),
		})),
	};
}

function makeCounts(overrides: Partial<RuntimeProjectTaskCounts> = {}): RuntimeProjectTaskCounts {
	return { backlog: 0, in_progress: 0, review: 0, validation: 0, trash: 0, ...overrides };
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

const USER_REVIEW_FACETS: Pick<SessionFacets, "turnOwner" | "liveness" | "userTurnKind"> = {
	turnOwner: "user",
	liveness: "live",
	userTurnKind: "review",
};

describe("applyLiveSessionStateToProjectTaskCounts", () => {
	it("无 live session 时原样返回计数", () => {
		const counts = makeCounts({ in_progress: 2, backlog: 1 });
		const result = applyLiveSessionStateToProjectTaskCounts(counts, makeBoard({ in_progress: ["a", "b"] }), {});
		expect(result).toEqual(counts);
	});

	it("不在 board 任何列的会话被忽略（columnId 缺失）", () => {
		const counts = makeCounts({ in_progress: 1 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ in_progress: ["a"] }),
			sessionsOf(makeSummary({ taskId: "ghost", state: "awaiting_review" })),
		);
		expect(result).toEqual(counts);
	});

	it("awaiting_review 且停在 in_progress → 计入 review（legacy state 派生）", () => {
		const counts = makeCounts({ in_progress: 1 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ in_progress: ["a"] }),
			sessionsOf(makeSummary({ taskId: "a", state: "awaiting_review", reviewReason: "exit" })),
		);
		expect(result).toEqual(makeCounts({ in_progress: 0, review: 1 }));
	});

	it("awaiting_review 但不在 in_progress（已在 review 列）→ 计数不变", () => {
		const counts = makeCounts({ review: 1 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ review: ["a"] }),
			sessionsOf(makeSummary({ taskId: "a", state: "awaiting_review" })),
		);
		expect(result).toEqual(counts);
	});

	it.each(["backlog", "in_progress", "review", "validation", "trash"] as const)(
		"中断会话保留 %s 的任务计数",
		(columnId) => {
			const counts = makeCounts({ [columnId]: 1 });
			const result = applyLiveSessionStateToProjectTaskCounts(
				counts,
				makeBoard({ [columnId]: ["a"] }),
				sessionsOf(makeSummary({ taskId: "a", state: "interrupted", reviewReason: "interrupted" })),
			);
			expect(result).toEqual(counts);
		},
	);

	it("interrupted 但已在 validation/trash 列 → 计数不变", () => {
		const counts = makeCounts({ validation: 1, trash: 1 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ validation: ["v"], trash: ["t"] }),
			sessionsOf(
				makeSummary({ taskId: "v", state: "interrupted", reviewReason: "interrupted" }),
				makeSummary({ taskId: "t", state: "interrupted", reviewReason: "interrupted" }),
			),
		);
		expect(result).toEqual(counts);
	});

	it("running / idle 会话不触发任何计数调整", () => {
		const counts = makeCounts({ in_progress: 2 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ in_progress: ["a", "b"] }),
			sessionsOf(
				makeSummary({ taskId: "a", state: "running", pid: 123 }),
				makeSummary({ taskId: "b", state: "idle" }),
			),
		);
		expect(result).toEqual(counts);
	});

	it("计数不会被减到负数（Math.max 兜底）", () => {
		const counts = makeCounts({ in_progress: 0 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ in_progress: ["a"] }),
			sessionsOf(makeSummary({ taskId: "a", state: "awaiting_review" })),
		);
		expect(result).toEqual(makeCounts({ in_progress: 0, review: 1 }));
	});

	it("显式 facet（user/live/review）被直接采信 → 计入 review", () => {
		const counts = makeCounts({ in_progress: 1 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ in_progress: ["a"] }),
			sessionsOf(makeSummary({ taskId: "a", state: "awaiting_review", ...USER_REVIEW_FACETS })),
		);
		expect(result).toEqual(makeCounts({ in_progress: 0, review: 1 }));
	});

	// 反向证明：exited（进程已退但仍等人审）与 live 折叠为同一 awaiting_review 计数行为——
	// 不被偷渡成 distinction ②（exited 仍记 review，不漏计、不另立分支）。
	it("exited 的待审会话仍记入 review（live↔exited 折叠，无 distinction ② 偷渡）", () => {
		const counts = makeCounts({ in_progress: 1 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ in_progress: ["a"] }),
			sessionsOf(
				makeSummary({
					taskId: "a",
					state: "awaiting_review",
					turnOwner: "user",
					liveness: "exited",
					userTurnKind: "review",
				}),
			),
		);
		expect(result).toEqual(makeCounts({ in_progress: 0, review: 1 }));
	});

	it("多会话混合：待审调整计数，中断保留原列", () => {
		const counts = makeCounts({ in_progress: 3 });
		const result = applyLiveSessionStateToProjectTaskCounts(
			counts,
			makeBoard({ in_progress: ["a", "b", "c"] }),
			sessionsOf(
				makeSummary({ taskId: "a", state: "awaiting_review" }),
				makeSummary({ taskId: "b", state: "interrupted", reviewReason: "interrupted" }),
				makeSummary({ taskId: "c", state: "running", pid: 1 }),
			),
		);
		expect(result).toEqual(makeCounts({ in_progress: 2, review: 1 }));
	});
});
