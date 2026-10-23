import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskCommitCoverageInCurrentDeployment } from "@/runtime/types";
import { areTaskWorkspaceSnapshotsEqual } from "@/stores/workspace-metadata-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";
import { TaskCommitCoverageInCurrentDeploymentIndicator } from "./task-commit-coverage-in-current-deployment-indicator";

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
function trigger(): HTMLButtonElement {
	const button = container.querySelector("button");
	if (!button) throw new Error("找不到部署覆盖指标");
	return button;
}

const partialCoverage: RuntimeTaskCommitCoverageInCurrentDeployment = {
	coverageStatus: "some_known_task_commits_in_current_deployment",
	knownTaskCommitCount: 5,
	matchedTaskCommitCountInCurrentDeployment: 2,
	currentDeploymentId: "deployment-one",
	currentDeployedSourceCommit: "abcdef1234567890",
	currentDeploymentRecordedAtIso: "2026-10-23T09:00:00.000Z",
	unavailableReason: null,
	coverageVersion: "partial-v1",
};

describe("当前部署提交覆盖指标", () => {
	it("展示提交覆盖而非任务完成；点按能查看版本且不触发卡片点击", async () => {
		const onCardClick = vi.fn();
		act(() =>
			root.render(
				<div onClick={onCardClick} role="presentation">
					<TaskCommitCoverageInCurrentDeploymentIndicator coverage={partialCoverage} />
				</div>,
			),
		);
		const button = trigger();
		expect(button.getAttribute("aria-label")).toBe("部署覆盖：2/5 个已知提交");
		expect(button.textContent).toBe("部署 2/5");
		await act(async () => button.click());
		const details = document.querySelector<HTMLElement>('[role="dialog"][aria-label="当前部署的提交覆盖"]');
		expect(details).not.toBeNull();
		expect(details?.textContent).toContain("当前部署版本包含 5 个已知自有提交中的 2 个");
		expect(details?.textContent).toContain("abcdef123456");
		expect(details?.textContent).toContain("不代表任务完成");
		expect(onCardClick).not.toHaveBeenCalled();
	});

	it("完整覆盖后新增提交仍更新分母；未知不显示为零", () => {
		act(() =>
			root.render(
				<TaskCommitCoverageInCurrentDeploymentIndicator
					coverage={{
						...partialCoverage,
						coverageStatus: "all_known_task_commits_in_current_deployment",
						matchedTaskCommitCountInCurrentDeployment: 5,
					}}
				/>,
			),
		);
		expect(trigger().textContent).toBe("部署 5/5");
		act(() =>
			root.render(
				<TaskCommitCoverageInCurrentDeploymentIndicator
					coverage={{ ...partialCoverage, knownTaskCommitCount: 6, matchedTaskCommitCountInCurrentDeployment: 5 }}
				/>,
			),
		);
		expect(trigger().textContent).toBe("部署 5/6");
		act(() => root.render(<TaskCommitCoverageInCurrentDeploymentIndicator />));
		expect(trigger().textContent).toBe("部署 ?");
	});

	it("确认没有已知提交时不展示；旧版本缺少字段可显示未知", () => {
		act(() =>
			root.render(
				<TaskCommitCoverageInCurrentDeploymentIndicator
					coverage={{
						...partialCoverage,
						coverageStatus: "no_known_task_commits",
						knownTaskCommitCount: 0,
						matchedTaskCommitCountInCurrentDeployment: 0,
					}}
				/>,
			),
		);
		expect(container.querySelector("button")).toBeNull();
		act(() => root.render(<TaskCommitCoverageInCurrentDeploymentIndicator />));
		expect(trigger().getAttribute("aria-label")).toContain("无法判断");
	});

	it("只有部署变化也使卡片快照失效，其他 Git 字段不必变化", () => {
		const snapshot: ReviewTaskWorkspaceSnapshot = {
			taskId: "same-task",
			path: "/isolated/task",
			branch: null,
			isDetached: true,
			headCommit: "unchanged",
			baseCommit: "unchanged",
			commitsAheadOfBaseRef: 0,
			commitsBehindBaseRef: 0,
			changedFiles: 0,
			additions: 0,
			deletions: 0,
			taskCommitCoverageInCurrentDeployment: partialCoverage,
		};
		expect(
			areTaskWorkspaceSnapshotsEqual(snapshot, {
				...snapshot,
				taskCommitCoverageInCurrentDeployment: { ...partialCoverage },
			}),
		).toBe(true);
		expect(
			areTaskWorkspaceSnapshotsEqual(snapshot, {
				...snapshot,
				taskCommitCoverageInCurrentDeployment: {
					...partialCoverage,
					currentDeploymentId: "new-deployment",
					coverageVersion: "new-version",
				},
			}),
		).toBe(false);
	});
});
