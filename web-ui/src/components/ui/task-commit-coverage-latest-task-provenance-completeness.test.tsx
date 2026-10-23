import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeTaskCommitCoverageInCurrentDeployment } from "@/runtime/types";
import { TaskCommitCoverageInCurrentDeploymentIndicator } from "./task-commit-coverage-in-current-deployment-indicator";

describe("最新提交归属不完整时的部署指标", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it.each([0, 1])("旧分母为 %i 时，最新归属不完整仍显示未知及原因", async (previousCommitCount) => {
		const previousCoverage: RuntimeTaskCommitCoverageInCurrentDeployment = {
			coverageStatus:
				previousCommitCount === 0 ? "no_known_task_commits" : "all_known_task_commits_in_current_deployment",
			knownTaskCommitCount: previousCommitCount,
			matchedTaskCommitCountInCurrentDeployment: previousCommitCount,
			currentDeploymentId: "current-deployment",
			currentDeployedSourceCommit: "a".repeat(40),
			currentDeploymentRecordedAtIso: "2026-10-23T09:00:00.000Z",
			unavailableReason: null,
			coverageVersion: "previous-complete",
		};
		act(() => root.render(<TaskCommitCoverageInCurrentDeploymentIndicator coverage={previousCoverage} />));
		if (previousCommitCount === 0) expect(container.querySelector("button")).toBeNull();
		else expect(container.querySelector("button")?.textContent).toBe("部署 1/1");
		act(() =>
			root.render(
				<TaskCommitCoverageInCurrentDeploymentIndicator
					coverage={{
						...previousCoverage,
						coverageStatus: "unknown",
						knownTaskCommitCount: null,
						matchedTaskCommitCountInCurrentDeployment: null,
						unavailableReason: "task_commit_ownership_history_incomplete",
						coverageVersion: "latest-incomplete",
					}}
				/>,
			),
		);
		const button = container.querySelector("button");
		expect(button?.textContent).toBe("部署 ?");
		expect(button?.getAttribute("aria-label")).toBe("部署覆盖：无法判断");
		await act(async () => button?.click());
		const details = document.querySelector('[role="dialog"][aria-label="当前部署的提交覆盖"]');
		expect(details?.textContent).toContain("任务的最新提交归属记录不完整，无法确定当前覆盖范围。");
	});
});
