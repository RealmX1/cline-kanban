import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	countActiveTaskFilterDimensions,
	deriveTaskSessionActivityFilterCategory,
	EMPTY_TASK_FILTER_SELECTION,
	isEmptyTaskFilterSelection,
	resolveTaskFilterDimensionRenderableOptions,
	toggleTaskFilterSelectionSetMember,
} from "@/task-filtering/task-filter-selection";
import type { BoardColumnId } from "@/types";

function summary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "a3f21",
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: 0,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	} as RuntimeTaskSessionSummary;
}

describe("deriveTaskSessionActivityFilterCategory", () => {
	it("reports no live session for a missing or never-started summary", () => {
		expect(deriveTaskSessionActivityFilterCategory(null)).toBe("no_live_session");
		expect(deriveTaskSessionActivityFilterCategory(summary())).toBe("no_live_session");
	});

	it("reports a running agent turn", () => {
		expect(
			deriveTaskSessionActivityFilterCategory(summary({ turnOwner: "agent", liveness: "live", userTurnKind: null })),
		).toBe("agent_running");
	});

	it("splits the user turn into passive review and blocked-on-you", () => {
		// review = agent 自然完工、被动等人看一眼；其余全是「非你动手不可」，用户筛的时候最想先捞后者。
		expect(
			deriveTaskSessionActivityFilterCategory(
				summary({ turnOwner: "user", liveness: "live", userTurnKind: "review" }),
			),
		).toBe("awaiting_your_review");
		for (const blockedTurnKind of ["needs_input", "question", "plan_review", "permission"] as const) {
			expect(
				deriveTaskSessionActivityFilterCategory(
					summary({ turnOwner: "user", liveness: "live", userTurnKind: blockedTurnKind }),
				),
			).toBe("awaiting_your_input");
		}
	});

	it("reports errors from both a failed liveness and an error turn kind", () => {
		expect(
			deriveTaskSessionActivityFilterCategory(
				summary({ turnOwner: "user", liveness: "failed", userTurnKind: "error" }),
			),
		).toBe("errored_or_out_of_credits");
		expect(
			deriveTaskSessionActivityFilterCategory(
				summary({ turnOwner: "user", liveness: "live", userTurnKind: "error" }),
			),
		).toBe("errored_or_out_of_credits");
	});

	it("reports park ahead of the plain running turn it otherwise looks like", () => {
		// parked 的主 agent 在 facet 上就是个普通 running 三元组，只有 sidecar 能把它认出来。
		expect(
			deriveTaskSessionActivityFilterCategory(
				summary({
					turnOwner: "agent",
					liveness: "live",
					userTurnKind: null,
					awaitingDispatchedBackgroundWork: { parkedAt: 1, reason: null } as never,
				}),
			),
		).toBe("parked_awaiting_dispatched_background_work");
	});

	it("reports an out-of-credits user turn as an error", () => {
		expect(
			deriveTaskSessionActivityFilterCategory(
				summary({
					turnOwner: "user",
					liveness: "live",
					userTurnKind: "needs_input",
					latestHookActivity: { notificationType: "credit_limit" } as never,
				}),
			),
		).toBe("errored_or_out_of_credits");
	});
});

describe("task filter selection helpers", () => {
	it("treats the empty selection as inactive on every dimension", () => {
		expect(isEmptyTaskFilterSelection(EMPTY_TASK_FILTER_SELECTION)).toBe(true);
		expect(countActiveTaskFilterDimensions(EMPTY_TASK_FILTER_SELECTION)).toBe(0);
	});

	it("counts one active dimension per constrained dimension, not per selected value", () => {
		const selection = {
			...EMPTY_TASK_FILTER_SELECTION,
			selectedStageColumnIds: new Set<BoardColumnId>(["backlog", "review"]),
			lastModifiedWindow: "past_7_days" as const,
		};

		expect(countActiveTaskFilterDimensions(selection)).toBe(2);
	});

	it("still renders a selected member the current data no longer offers, so it can be clicked off", () => {
		// 可选集是从当前这批数据派生的、会常规缩小（关掉 All projects 等）。若只渲染可选集里的取值，
		// 就会出现「角标说有 1 个维度在生效、浮层里却找不到任何可点掉的 chip」。
		const renderableOptions = resolveTaskFilterDimensionRenderableOptions(
			[{ value: "proj-a", label: "Project A" }],
			new Set(["proj-a", "proj-b"]),
		);

		expect(renderableOptions.map((option) => option.value)).toEqual(["proj-a", "proj-b"]);
		expect(renderableOptions[0]?.isSelectedButNoLongerAvailable).toBe(false);
		expect(renderableOptions[1]).toEqual({
			value: "proj-b",
			// label 随数据一起消失了，只剩取值本身可用。
			label: "proj-b",
			isSelectedButNoLongerAvailable: true,
		});
	});

	it("leaves the available options untouched when nothing is selected", () => {
		const availableOptions = [
			{ value: "claude", label: "Claude Code" },
			{ value: "codex", label: "OpenAI Codex" },
		];

		expect(resolveTaskFilterDimensionRenderableOptions(availableOptions, new Set())).toEqual([
			{ value: "claude", label: "Claude Code", isSelectedButNoLongerAvailable: false },
			{ value: "codex", label: "OpenAI Codex", isSelectedButNoLongerAvailable: false },
		]);
	});

	it("toggles a set member without mutating the previous selection", () => {
		const withBacklog = toggleTaskFilterSelectionSetMember(
			EMPTY_TASK_FILTER_SELECTION,
			"selectedStageColumnIds",
			"backlog",
		);
		expect([...withBacklog.selectedStageColumnIds]).toEqual(["backlog"]);
		expect(EMPTY_TASK_FILTER_SELECTION.selectedStageColumnIds.size).toBe(0);

		const withoutBacklog = toggleTaskFilterSelectionSetMember(withBacklog, "selectedStageColumnIds", "backlog");
		expect(withoutBacklog.selectedStageColumnIds.size).toBe(0);
		expect([...withBacklog.selectedStageColumnIds]).toEqual(["backlog"]);
	});
});
