import { describe, expect, it } from "vitest";
import { translateExplorationThreadGraphMaintenanceOutcome } from "../../../src/exploration-thread-graph/exploration-thread-graph-maintenance-outcome-translation";

// 这层翻译决定面板对用户说什么。翻错了，用户看到的就是对「为什么这次没判」的错误解释——
// 尤其不能把「按闸门有意没开跑」说成失败，那会让人去点第二次（而点一次是要花钱的）。

describe("translateExplorationThreadGraphMaintenanceOutcome", () => {
	it("accepted 带出落盘后的总数与剩余待判数", () => {
		expect(
			translateExplorationThreadGraphMaintenanceOutcome({
				kind: "completed",
				result: { outcome: "accepted", placedTurnCount: 12, remainingTurnCount: 3, usage: null },
			}),
		).toEqual({
			kind: "completed",
			jobOutcome: "accepted",
			placedTurnCount: 12,
			remainingTurnCount: 3,
			detail: null,
		});
	});

	it("rejected 原样透传漏斗的判词——它是可穷举的，比「失败了」有用得多", () => {
		expect(
			translateExplorationThreadGraphMaintenanceOutcome({
				kind: "completed",
				result: { outcome: "rejected", rejectionReason: "placement_outside_turns_under_judgement", usage: null },
			}),
		).toEqual({
			kind: "completed",
			jobOutcome: "rejected",
			placedTurnCount: null,
			remainingTurnCount: null,
			detail: "placement_outside_turns_under_judgement",
		});
	});

	it("skipped 带出跳过理由", () => {
		expect(
			translateExplorationThreadGraphMaintenanceOutcome({
				kind: "completed",
				result: { outcome: "skipped", skipReason: "no_turns_under_judgement" },
			}),
		).toEqual({
			kind: "completed",
			jobOutcome: "skipped",
			placedTurnCount: null,
			remainingTurnCount: null,
			detail: "no_turns_under_judgement",
		});
	});

	it("fork_failed 把停止原因与输出摘录拼在一起——分身失败时这两项缺一不可诊断", () => {
		expect(
			translateExplorationThreadGraphMaintenanceOutcome({
				kind: "completed",
				result: { outcome: "fork_failed", stopReason: "timeout", outputTextExcerpt: "no output" },
			}),
		).toEqual({
			kind: "completed",
			jobOutcome: "fork_failed",
			placedTurnCount: null,
			remainingTurnCount: null,
			detail: "timeout: no output",
		});
	});

	it.each([
		"not_exploratory_mode",
		"no_usable_sessions",
		"already_in_flight",
		"throttled",
		"no_completed_turns",
	] as const)("not_started(%s) 保持为 not_started，绝不翻成失败", (reason) => {
		expect(translateExplorationThreadGraphMaintenanceOutcome({ kind: "not_started", reason })).toEqual({
			kind: "not_started",
			reason,
		});
	});

	it("failed 带出原始错误文本", () => {
		expect(
			translateExplorationThreadGraphMaintenanceOutcome({ kind: "failed", message: "storeRoot 不可写" }),
		).toEqual({ kind: "failed", message: "storeRoot 不可写" });
	});
});
