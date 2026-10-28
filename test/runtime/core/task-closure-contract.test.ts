import { describe, expect, it } from "vitest";
import {
	resolveTaskClosureOutcomeForBoardColumn,
	taskClosureDetailsSchema,
} from "../../../src/core/task-closure-contract";

describe("任务结案结果", () => {
	it("历史未标注不能推断为交付接受，打开中的任务没有结案结果", () => {
		expect(resolveTaskClosureOutcomeForBoardColumn("trash")).toBe("closure_outcome_unspecified");
		expect(resolveTaskClosureOutcomeForBoardColumn("review")).toBeNull();
	});
	it("非交付结果要求原因，取消要求授权，并入要求完整承接身份", () => {
		for (const outcome of [
			"plan_retired",
			"implementation_unnecessary",
			"merged_into_successor_task",
			"cancelled_by_user",
		]) {
			expect(taskClosureDetailsSchema.safeParse({ outcome }).success).toBe(false);
		}
		expect(taskClosureDetailsSchema.safeParse({ outcome: "delivery_accepted" }).success).toBe(true);
		expect(taskClosureDetailsSchema.safeParse({ outcome: "closure_outcome_unspecified" }).success).toBe(true);
		expect(
			taskClosureDetailsSchema.safeParse({
				outcome: "cancelled_by_user",
				reason: "停止方向",
				authorizationSource: "用户当前消息",
			}).success,
		).toBe(true);
		expect(
			taskClosureDetailsSchema.safeParse({
				outcome: "merged_into_successor_task",
				reason: "整合",
				successorTask: { workspaceId: "other", taskId: "12345", taskIncarnationCreatedAtEpochMs: 1 },
			}).success,
		).toBe(true);
	});
	it("保留退役主结果和已接受成果，不推导验收通过", () => {
		const result = taskClosureDetailsSchema.parse({
			outcome: "plan_retired",
			reason: "采用新方案",
			acceptedDeliverables: [{ description: "调查报告", evidence: ["docs/report.md"] }],
		});
		expect(result.outcome).toBe("plan_retired");
		expect(result.acceptedDeliverables).toHaveLength(1);
	});
});
