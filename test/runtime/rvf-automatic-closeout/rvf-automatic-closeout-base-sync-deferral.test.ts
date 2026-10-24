import { describe, expect, it } from "vitest";
import { rvfAutomaticCloseoutExecutionResultReportRequestSchema } from "../../../src/core/rvf-automatic-closeout-contract";

const deferredBaseSyncReport = {
	taskId: "task",
	decisionToken: "0123456789abcdef",
	runId: "run",
	handoffSha256: "a".repeat(64),
	stage: "base_branch_sync",
	outcome: "blocked",
	blockedReasonKind: "agent_assessed_not_ready_for_base_sync",
	reason: "当前候选依赖尚未闭合的协议变更",
	baseBranchSyncReassessmentCondition: "依赖闭合并通过验证后重新评估",
};

describe("Agent 暂缓 base sync 的执行报告", () => {
	it("保留明确理由和恢复条件，兼容已有完成报告", () => {
		expect(rvfAutomaticCloseoutExecutionResultReportRequestSchema.parse(deferredBaseSyncReport)).toEqual(
			deferredBaseSyncReport,
		);
		expect(
			rvfAutomaticCloseoutExecutionResultReportRequestSchema.safeParse({
				taskId: "task",
				decisionToken: "0123456789abcdef",
				runId: "run",
				handoffSha256: "a".repeat(64),
				stage: "base_branch_sync",
				outcome: "completed",
				commitSha: "b".repeat(40),
				baseRef: "main",
			}).success,
		).toBe(true);
	});
	it.each([
		{ stage: "land" },
		{ outcome: "completed", commitSha: "b".repeat(40), baseRef: "main" },
		{ baseBranchSyncReassessmentCondition: undefined },
		{ reason: " " },
	])("拒绝把暂缓混为其他阶段、完成或无理由的结果：%j", (change) => {
		expect(
			rvfAutomaticCloseoutExecutionResultReportRequestSchema.safeParse({ ...deferredBaseSyncReport, ...change })
				.success,
		).toBe(false);
	});
});
