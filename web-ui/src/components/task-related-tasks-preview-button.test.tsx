import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { TaskRelatedTasksPreviewButton } from "@/components/task-related-tasks-preview-button";

const readPage = vi.hoisted(() => vi.fn());
const openTask = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/directly-related-task-preview-query", () => ({
	fetchDirectlyRelatedTaskPreviewPage: readPage,
	buildQualifiedTaskPreviewIdentityKey: (task: {
		workspaceId: string;
		taskId: string;
		taskIncarnationCreatedAtEpochMs: number;
	}) => JSON.stringify(task),
}));
vi.mock("@/components/related-task-preview-full-task-card", () => ({
	RelatedTaskPreviewFullTaskCard: ({ task }: { task: { taskId: string } }) => (
		<div data-full-card-preview={task.taskId}>完整卡片</div>
	),
}));

const relatedTask = {
	workUnitType: "kanban_board_card" as const,
	workspaceId: "project-b",
	taskId: "related",
	taskIncarnationCreatedAtEpochMs: 2,
};
const entry = {
	task: relatedTask,
	title: "关联任务",
	workspaceRepositoryPath: "/repo-b",
	lastKnownBoardColumnId: "review",
	permanentlyRemovedFromBoardAt: null,
	identityKnownToLedger: true,
	mutedOnly: false,
	relations: [
		{
			relationId: "created",
			relationKind: "provenance_created_by",
			relationClass: "recorded",
			directionFromPreviewSubject: "outgoing",
			mutedInPresentation: false,
			assertionActorKind: null,
			assertionDecisionSources: [],
		},
	],
};
let root: Root;
let container: HTMLDivElement;
const render = (count = 1) =>
	act(() =>
		root.render(
			<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider
				value={{
					projects: [
						{
							id: "project-b",
							name: "另一个项目",
							path: "/repo-b",
							availability: { status: "available" },
							taskCounts: { backlog: 0, in_progress: 0, review: 1, validation: 0, trash: 0 },
							inProgressTaskDetails: [],
							crossProjectTaskSwitcherEntries: [],
						},
					],
					currentProjectId: "project-a",
					notificationLogByWorkspaceId: {},
					isBoardScopeAllProjectsSelected: false,
					focusedTaskInProject: null,
					onOpenTaskInProject: openTask,
					onRequestPinCurrentProjectTaskToTaskPinboard: vi.fn(),
					onUnpinCurrentProjectTaskFromTaskPinboard: vi.fn(),
					onEditCurrentProjectTaskPinboardPinReason: vi.fn(),
				}}
			>
				{Array.from({ length: count }, (_, index) => (
					<TaskRelatedTasksPreviewButton
						key={index}
						workspaceId="project-a"
						taskId={`subject-${index}`}
						taskIncarnationCreatedAtEpochMs={1}
					/>
				))}
			</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>,
		),
	);
const click = async (selector: string) => {
	await act(async () => {
		document.querySelector<HTMLElement>(selector)?.click();
	});
};

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	readPage.mockReset().mockResolvedValue({
		subjectTask: relatedTask,
		entries: [entry],
		totalTaskCount: 1,
		mutedOnlyTaskCount: 0,
		standaloneSessionCount: 0,
		neighborhoodRevision: "revision",
		nextCursor: null,
	});
	openTask.mockReset();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("关联入口与可操作预览浮层", () => {
	it("大量闲置卡片不查询；点击只查询选中卡，列表主动作按完整身份导航", async () => {
		render(50);
		expect(readPage).not.toHaveBeenCalled();
		await click("[data-related-tasks-preview-trigger]");
		expect(readPage).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("另一个项目");
		await click('[data-related-task-open="related"]');
		expect(openTask).toHaveBeenCalledWith("project-b", "related", 2);
	});
	it("显式预览按钮与悬停使用同一个右侧卡片，移动到卡片内保持浮层", async () => {
		render();
		await click("[data-related-tasks-preview-trigger]");
		await click('[data-related-task-preview="related"]');
		expect(document.querySelectorAll("[data-full-card-preview]")).toHaveLength(1);
		expect(openTask).not.toHaveBeenCalled();
		act(() =>
			document
				.querySelector("[data-related-tasks-preview-trigger]")
				?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })),
		);
		act(() =>
			document
				.querySelector("[data-related-tasks-preview-dialog]")
				?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })),
		);
		await act(async () => vi.advanceTimersByTime(500));
		expect(document.querySelector("[data-full-card-preview]")).not.toBeNull();
	});
	it("永久删除项保留并解释不可用，不能导航", async () => {
		readPage.mockResolvedValue({
			entries: [{ ...entry, permanentlyRemovedFromBoardAt: 3 }],
			totalTaskCount: 1,
			mutedOnlyTaskCount: 0,
			standaloneSessionCount: 0,
			neighborhoodRevision: "revision",
			nextCursor: null,
		});
		render();
		await click("[data-related-tasks-preview-trigger]");
		expect(document.body.textContent).toContain("已永久删除");
		await click('[data-related-task-open="related"]');
		expect(openTask).not.toHaveBeenCalled();
	});
});
