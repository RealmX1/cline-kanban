import { describe, expect, it } from "vitest";
import type { RuntimeBoardCard } from "../../../src/core/api-contract";
import { validateExternalWorkflowRunBindingUpdate } from "../../../src/core/task-external-workflow-run-binding";

const binding = {
	owningWorkspaceId: "workspace-1",
	owningTaskId: "task-1",
	owningTaskIncarnationCreatedAtEpochMs: 1,
	workflowProviderId: "software-factory",
	workflowKind: "research",
	workItemId: "item-1",
	runId: "run-1",
	workflowDatabasePath: "/persistent/workflows.sqlite",
	artifactDirectoryPath: "/persistent/artifacts",
	lastObservedState: {
		observedAtEpochMs: 10,
		availability: "observed" as const,
		businessStage: "evidence_collection",
		executionQualification: "stage_work_required",
		waitingReason: null,
		materialFilePaths: ["/persistent/artifacts/question.md"],
	},
};
const card: RuntimeBoardCard = {
	id: "task-1",
	title: "任务",
	prompt: "需求",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: 1,
	updatedAt: 2,
};

describe("外部流程 Run 引用", () => {
	it("完整任务归属正确时接受引用与相同观察重放", () => {
		expect(() => validateExternalWorkflowRunBindingUpdate(card, binding, "workspace-1", 1)).not.toThrow();
		expect(() =>
			validateExternalWorkflowRunBindingUpdate(
				{ ...card, externalWorkflowRunBinding: binding },
				binding,
				"workspace-1",
				1,
			),
		).not.toThrow();
	});
	it("拒绝未知代次、旧代次及跨工作区写入", () => {
		for (const incarnation of [undefined, 0])
			expect(() => validateExternalWorkflowRunBindingUpdate(card, binding, "workspace-1", incarnation)).toThrow();
		expect(() => validateExternalWorkflowRunBindingUpdate(card, binding, "workspace-2", 1)).toThrow();
	});
	it("拒绝更换 Run 和倒序或同时间不同观察", () => {
		const boundCard = { ...card, externalWorkflowRunBinding: binding };
		expect(() =>
			validateExternalWorkflowRunBindingUpdate(boundCard, { ...binding, runId: "another-run" }, "workspace-1", 1),
		).toThrow();
		for (const observedAtEpochMs of [9, 10])
			expect(() =>
				validateExternalWorkflowRunBindingUpdate(
					boundCard,
					{
						...binding,
						lastObservedState: { ...binding.lastObservedState, observedAtEpochMs, availability: "unavailable" },
					},
					"workspace-1",
					1,
				),
			).toThrow();
		expect(() =>
			validateExternalWorkflowRunBindingUpdate(
				boundCard,
				{
					...binding,
					lastObservedState: { ...binding.lastObservedState, observedAtEpochMs: 11, availability: "unavailable" },
				},
				"workspace-1",
				1,
			),
		).not.toThrow();
	});
});
