import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CrossProjectRecentlyActiveTaskSwitcherHostContextProvider } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { RelationTaskCardPreviewLayout } from "@/components/detail-panels/relation-task-card-preview-layout";
import { RelationNeighborWorkUnitReference } from "@/components/detail-panels/work-unit-relation-neighborhood-panel-neighbor-reference-and-badges";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildRelationTaskCardPreviewTargetFromDisplayEntry } from "@/hooks/relation-task-card-preview-target";
import { useRelationTaskCardPreview } from "@/hooks/use-relation-task-card-preview";
import {
	buildWorkUnitRelationNeighborPresentation,
	type WorkUnitRelationNeighborPresentation,
} from "@/hooks/work-unit-relation-neighborhood-panel-presentation-model";
import { buildKanbanBoardCardDisplayEntryForTest } from "@/hooks/work-unit-relation-neighborhood-summary-response-test-fixtures";
import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "@/runtime/types";

const { readSnapshot, openTask } = vi.hoisted(() => ({ readSnapshot: vi.fn(), openTask: vi.fn() }));
vi.mock("@/runtime/directly-related-task-preview-query", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	fetchQualifiedTaskCardSnapshotForRelatedPreview: readSnapshot,
}));
vi.mock("@/runtime/cross-project-task-worktree-git-metadata-query", () => ({
	fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries: async () => ({ tasks: [] }),
}));

const entries = ["first", "second"].map((taskId) =>
	buildKanbanBoardCardDisplayEntryForTest({ workspaceId: "other", taskId, currentTitle: `任务 ${taskId}` }),
);
function neighbor(index: number): WorkUnitRelationNeighborPresentation {
	return buildWorkUnitRelationNeighborPresentation({
		neighborWorkUnit: entries[index]!.workUnit,
		neighborDisplayEntry: entries[index]!,
		currentKanbanProjectWorkspaceId: "current",
		knownKanbanProjectByWorkspaceId: new Map([
			["other", { kanbanProjectName: "另一个项目", isKanbanProjectAvailable: true }],
		]),
	});
}
function snapshot(taskId: string, createdAt = 1_000) {
	return {
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: {
			taskCard: {
				id: taskId,
				title: `完整任务 ${taskId}`,
				prompt: `完整描述 ${taskId}`,
				startInPlanMode: false,
				baseRef: "main",
				createdAt,
				updatedAt: createdAt,
			},
			boardColumnIdContainingTaskCard: "review",
			taskSessionSummaryLiveInRuntimeProcessMemory: null,
			taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
		} satisfies RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries,
	};
}
function Harness() {
	const controller = useRelationTaskCardPreview();
	return (
		<TooltipProvider>
			<CrossProjectRecentlyActiveTaskSwitcherHostContextProvider
				value={{
					projects: [
						{
							id: "other",
							name: "另一个项目",
							path: "/repos/other",
							availability: { status: "available" },
							taskCounts: { backlog: 0, in_progress: 0, review: 2, validation: 0, trash: 0 },
							inProgressTaskDetails: [],
							crossProjectTaskSwitcherEntries: [],
						},
					],
					currentProjectId: "current",
					notificationLogByWorkspaceId: {},
					isBoardScopeAllProjectsSelected: false,
					focusedTaskInProject: null,
					onOpenTaskInProject: openTask,
					onRequestPinCurrentProjectTaskToTaskPinboard: vi.fn(),
					onUnpinCurrentProjectTaskFromTaskPinboard: vi.fn(),
					onEditCurrentProjectTaskPinboardPinReason: vi.fn(),
				}}
			>
				<RelationTaskCardPreviewLayout controller={controller}>
					{[0, 1].map((index) => (
						<RelationNeighborWorkUnitReference
							key={index}
							neighbor={neighbor(index)}
							openNeighborKanbanBoardCardInItsProject={openTask}
						/>
					))}
					<button
						type="button"
						onClick={(event) =>
							controller.pinPreview(
								buildRelationTaskCardPreviewTargetFromDisplayEntry(
									undefined,
									"pending-task-creation",
									"待创建任务",
								),
								event.currentTarget,
							)
						}
					>
						预览虚拟根
					</button>
				</RelationTaskCardPreviewLayout>
			</CrossProjectRecentlyActiveTaskSwitcherHostContextProvider>
		</TooltipProvider>
	);
}
let root: Root;
let container: HTMLDivElement;
function button(label: string) {
	const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.getAttribute("aria-label") === label || item.textContent === label,
	);
	if (!element) throw new Error(`找不到按钮：${label}`);
	return element;
}
const first = () => button("预览 task first [other]");
const second = () => button("预览 task second [other]");
const click = (element: HTMLElement) => act(async () => element.click());
const fullCard = () => container.querySelector('[data-task-card-render-role="task_card_copy_in_related_task_preview"]');
beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	readSnapshot.mockReset().mockImplementation(async (task: { taskId: string }) => snapshot(task.taskId));
	openTask.mockReset();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	act(() => root.render(<Harness />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
});

it("闲置摘要不读卡片，悬停 200ms 才挂载真实完整卡，继续在预览内操作会固定", async () => {
	expect(readSnapshot).not.toHaveBeenCalled();
	await act(async () => first().dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
	await act(async () => vi.advanceTimersByTime(199));
	expect(readSnapshot).not.toHaveBeenCalled();
	await act(async () => vi.advanceTimersByTime(1));
	expect(readSnapshot).toHaveBeenCalledTimes(1);
	expect(readSnapshot.mock.calls[0]?.[0]).toEqual(entries[0]!.workUnit);
	expect(fullCard()?.textContent).toContain("完整任务 first");
	expect(fullCard()?.hasAttribute("data-task-id")).toBe(false);
	expect(fullCard()?.querySelector("[data-related-tasks-preview-trigger]")).toBeNull();
	await act(async () => fullCard()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
	expect(container.querySelector("[data-preview-pinned=true]")).not.toBeNull();
});

it("焦点立即预览，点击固定后忽略其他悬停和焦点，点击其他任务可切换，关闭后焦点返回", async () => {
	await act(async () => first().focus());
	expect(fullCard()?.textContent).toContain("完整任务 first");
	await click(first());
	await act(async () => second().focus());
	await act(async () => second().dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
	await act(async () => vi.advanceTimersByTime(250));
	expect(fullCard()?.textContent).toContain("完整任务 first");
	await click(second());
	expect(fullCard()?.textContent).toContain("完整任务 second");
	await click(button("关闭任务卡片预览"));
	expect(fullCard()).toBeNull();
	expect(document.activeElement).toBe(second());
	expect(openTask).not.toHaveBeenCalled();
});

it("快速切换时忽略旧任务迟到的快照", async () => {
	let resolveFirst: (value: ReturnType<typeof snapshot>) => void = () => {};
	readSnapshot.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveFirst = resolve;
			}),
	);
	await click(first());
	await click(second());
	expect(fullCard()?.textContent).toContain("完整任务 second");
	await act(async () => resolveFirst(snapshot("first")));
	expect(fullCard()?.textContent).toContain("完整任务 second");
	expect(fullCard()?.textContent).not.toContain("完整任务 first");
});

it("读取失败可重试且仍绑定同一世任务", async () => {
	readSnapshot.mockRejectedValueOnce(new Error("隔离网络故障"));
	await click(first());
	expect(container.textContent).toContain("隔离网络故障");
	expect(fullCard()).toBeNull();
	await click(button("重试加载卡片"));
	expect(fullCard()?.textContent).toContain("完整任务 first");
	expect(readSnapshot.mock.calls.map((call) => call[0])).toEqual([entries[0]!.workUnit, entries[0]!.workUnit]);
});

it("相同 ID 的新一世不能挂载可操作卡片", async () => {
	readSnapshot.mockResolvedValueOnce(snapshot("first", 2_000));
	await click(first());
	expect(fullCard()).toBeNull();
	expect(container.textContent).toContain("原任务已删除并重建");
});

it("虚拟根显示创建说明且不读取卡片；打开任务使用创建时间", async () => {
	await click(button("预览虚拟根"));
	expect(container.textContent).toContain("任务尚未创建");
	expect(readSnapshot).not.toHaveBeenCalled();
	await click(first());
	await click(button("打开任务"));
	expect(openTask).toHaveBeenCalledWith("other", "first", 1_000);
	expect(fullCard()).toBeNull();
});
