import type { CrossProjectTaskSwitcherEntryInProject } from "@runtime-cross-project-recently-active-task-switcher-section-assignment";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	selectCrossProjectTaskSwitcherEntriesNeedingWorktreeGitMetadataPoll,
	useCrossProjectTaskWorktreeGitMetadataPolling,
} from "@/hooks/use-cross-project-task-worktree-git-metadata-polling";
import type { RuntimeBoardColumnId, RuntimeCrossProjectTaskSwitcherEntry } from "@/runtime/types";
import { resetCrossProjectTaskWorktreeGitMetadataStore } from "@/stores/cross-project-task-worktree-git-metadata-store";

const fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/cross-project-task-worktree-git-metadata-query", () => ({
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries,
}));

// 跨项目切换面板「其他项目」行的 git 元数据轮询：只请求其他项目、非 Backlog 的条目；页面不可见时不发请求。

function entryInProject(
	workspaceId: string,
	taskId: string,
	columnId: RuntimeBoardColumnId = "review",
): CrossProjectTaskSwitcherEntryInProject {
	return {
		workspaceId,
		projectName: workspaceId,
		entry: { taskId, columnId } as RuntimeCrossProjectTaskSwitcherEntry,
	};
}

describe("selectCrossProjectTaskSwitcherEntriesNeedingWorktreeGitMetadataPoll", () => {
	it("排除 Backlog、含当前项目（All projects 下状态流只探焦点任务），按 (workspaceId, taskId) 去重", () => {
		expect(
			selectCrossProjectTaskSwitcherEntriesNeedingWorktreeGitMetadataPoll([
				entryInProject("current", "c1"),
				entryInProject("other", "o1"),
				entryInProject("other", "o1"),
				entryInProject("other", "same-id"),
				entryInProject("third", "same-id"),
				entryInProject("other", "backlog-task", "backlog"),
				entryInProject("other", "done-task", "trash"),
			]),
		).toEqual([
			{ workspaceId: "current", taskId: "c1" },
			{ workspaceId: "other", taskId: "o1" },
			{ workspaceId: "other", taskId: "same-id" },
			{ workspaceId: "third", taskId: "same-id" },
			{ workspaceId: "other", taskId: "done-task" },
		]);
	});

	it("每次最多请求 100 个（与服务端 schema 上限一致）", () => {
		const entries = Array.from({ length: 130 }, (_, index) => entryInProject("other", `t${index}`));
		expect(selectCrossProjectTaskSwitcherEntriesNeedingWorktreeGitMetadataPoll(entries)).toHaveLength(100);
	});
});

describe("useCrossProjectTaskWorktreeGitMetadataPolling", () => {
	let container: HTMLDivElement;
	let root: Root;
	let documentVisibilityState: DocumentVisibilityState = "visible";

	function PollingHost({ entries }: { entries: CrossProjectTaskSwitcherEntryInProject[] }) {
		useCrossProjectTaskWorktreeGitMetadataPolling({ entriesInProjects: entries, currentProjectId: "current" });
		return null;
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		documentVisibilityState = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => documentVisibilityState);
		fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockReset();
		fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries.mockResolvedValue({ tasks: [] });
		resetCrossProjectTaskWorktreeGitMetadataStore();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("挂载即请求一轮、之后每 5 秒一轮；页面不可见时停", async () => {
		await act(async () => {
			root.render(<PollingHost entries={[entryInProject("other", "o1")]} />);
		});
		expect(fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries).toHaveBeenCalledTimes(1);
		expect(fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries).toHaveBeenLastCalledWith("current", {
			tasks: [{ workspaceId: "other", taskId: "o1" }],
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries).toHaveBeenCalledTimes(2);

		documentVisibilityState = "hidden";
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});
		expect(fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries).toHaveBeenCalledTimes(2);
	});

	it("只有 Backlog 条目时不发请求", async () => {
		await act(async () => {
			root.render(
				<PollingHost
					entries={[entryInProject("current", "b0", "backlog"), entryInProject("other", "b1", "backlog")]}
				/>,
			);
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries).not.toHaveBeenCalled();
	});
});
