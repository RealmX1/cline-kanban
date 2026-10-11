import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskGitAction } from "@/git-actions/build-task-git-action-prompt";
import { useReviewAutoActions } from "@/hooks/use-review-auto-actions";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { BoardColumnId, BoardData, ReviewTaskWorkspaceSnapshot, TaskAutoReviewMode } from "@/types";

function createBoard(autoReviewEnabled: boolean, autoReviewMode: TaskAutoReviewMode = "commit"): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Test task",
						prompt: "Test task",
						startInPlanMode: false,
						autoReviewEnabled,
						autoReviewMode,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
	};
}

const workspaceSnapshots: Record<string, ReviewTaskWorkspaceSnapshot> = {
	"task-1": {
		taskId: "task-1",
		path: "/tmp/task-1",
		branch: "task-1",
		isDetached: false,
		headCommit: "abc123",
		baseCommit: null,
		commitsAheadOfBaseRef: null,
		commitsBehindBaseRef: null,
		changedFiles: 3,
		additions: 10,
		deletions: 2,
	},
};

function HookHarness({
	board,
	runAutoReviewGitAction,
	requestMoveTaskToTrash,
}: {
	board: BoardData;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestMoveTaskToTrash: (taskId: string, fromColumnId: BoardColumnId) => Promise<void>;
}): null {
	setTaskWorkspaceSnapshot(workspaceSnapshots["task-1"] ?? null);
	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction,
		requestMoveTaskToTrash,
	});
	return null;
}

// auto-review 完成 → 自动移入 Done 的整条链路：有改动时先触发 commit/PR，改动清零后视为完成并移列。
function AutoReviewCompletionHarness({
	board,
	changedFiles,
	runAutoReviewGitAction,
	requestMoveTaskToTrash,
}: {
	board: BoardData;
	changedFiles: number;
	runAutoReviewGitAction: (taskId: string, action: TaskGitAction) => Promise<boolean>;
	requestMoveTaskToTrash: (taskId: string, fromColumnId: BoardColumnId, options?: object) => Promise<void>;
}): null {
	const snapshot = workspaceSnapshots["task-1"];
	setTaskWorkspaceSnapshot(snapshot ? { ...snapshot, changedFiles } : null);
	useReviewAutoActions({
		board,
		taskGitActionLoadingByTaskId: {},
		runAutoReviewGitAction,
		requestMoveTaskToTrash,
	});
	return null;
}

describe("useReviewAutoActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("cancels a scheduled auto review action when autoReviewEnabled is turned off", async () => {
		const runAutoReviewGitAction = vi.fn(async () => true);
		const requestMoveTaskToTrash = vi.fn(async () => {});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(true)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			root.render(
				<HookHarness
					board={createBoard(false)}
					runAutoReviewGitAction={runAutoReviewGitAction}
					requestMoveTaskToTrash={requestMoveTaskToTrash}
				/>,
			);
		});

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});

		expect(runAutoReviewGitAction).not.toHaveBeenCalled();
		expect(requestMoveTaskToTrash).not.toHaveBeenCalled();
	});

	// dd2db Y-EVENT-8：auto-review 完成后的自动移入 Done 按模式区分发起方（PR 模式不结案依赖要求两者分开）。
	it.each([
		["commit", "web_ui_client_automation_auto_review_commit_mode_completion"],
		["pr", "web_ui_client_automation_auto_review_pull_request_mode_completion"],
	] as const)(
		"moves a completed %s-mode auto review into Done tagged with its mode-specific initiator",
		async (autoReviewMode, expectedBoardMutationInitiator) => {
			const runAutoReviewGitAction = vi.fn(async () => true);
			const requestMoveTaskToTrash = vi.fn(async () => {});
			const board = createBoard(true, autoReviewMode);

			await act(async () => {
				root.render(
					<AutoReviewCompletionHarness
						board={board}
						changedFiles={3}
						runAutoReviewGitAction={runAutoReviewGitAction}
						requestMoveTaskToTrash={requestMoveTaskToTrash}
					/>,
				);
			});
			await act(async () => {
				vi.advanceTimersByTime(600);
			});
			expect(runAutoReviewGitAction).toHaveBeenCalledWith("task-1", autoReviewMode);

			await act(async () => {
				root.render(
					<AutoReviewCompletionHarness
						board={board}
						changedFiles={0}
						runAutoReviewGitAction={runAutoReviewGitAction}
						requestMoveTaskToTrash={requestMoveTaskToTrash}
					/>,
				);
			});
			await act(async () => {
				vi.advanceTimersByTime(600);
			});

			expect(requestMoveTaskToTrash).toHaveBeenCalledWith("task-1", "review", {
				skipWorkingChangeWarning: true,
				boardMutationInitiator: expectedBoardMutationInitiator,
			});
		},
	);
});
