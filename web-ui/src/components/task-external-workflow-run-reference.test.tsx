import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { TaskExternalWorkflowRunReference } from "@/components/task-external-workflow-run-reference";
import type { BoardCard } from "@/types";

const card: BoardCard = {
	id: "task-1",
	title: "任务",
	prompt: "需求",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: 1,
	updatedAt: 2,
	externalWorkflowRunBinding: {
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
			availability: "observed",
			businessStage: "evidence_collection",
			executionQualification: "stage_work_required",
			waitingReason: "等待原始材料",
			materialFilePaths: ["/persistent/artifacts/question.md"],
		},
	},
};

describe("外部工作流引用展示", () => {
	it("显示只读观察与材料；不可达及归属不符保留 unknown", async () => {
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () => root.render(<TaskExternalWorkflowRunReference card={card} workspaceId="workspace-1" />));
			expect(container.textContent).toContain("最近阶段：evidence_collection");
			expect(container.textContent).toContain("等待原始材料");
			expect(container.textContent).toContain("question.md");
			const unavailable = structuredClone(card);
			if (unavailable.externalWorkflowRunBinding?.lastObservedState)
				unavailable.externalWorkflowRunBinding.lastObservedState.availability = "unavailable";
			await act(async () =>
				root.render(<TaskExternalWorkflowRunReference card={unavailable} workspaceId="workspace-1" />),
			);
			expect(container.textContent).toContain("状态 unknown");
			expect(container.textContent).not.toContain("evidence_collection");
			await act(async () =>
				root.render(<TaskExternalWorkflowRunReference card={card} workspaceId="another-workspace" />),
			);
			expect(container.textContent).toContain("状态 unknown");
			expect(container.textContent).toContain("引用属于其他工作区或任务代次");
		} finally {
			await act(async () => root.unmount());
		}
	});
});
