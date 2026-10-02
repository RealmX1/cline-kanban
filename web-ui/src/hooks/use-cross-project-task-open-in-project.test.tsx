import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCrossProjectTaskOpenInProject } from "@/hooks/use-cross-project-task-open-in-project";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// 「在某个项目里打开某个任务」的唯一入口：Board Overview、Spotlight、跨项目切换面板、通知点击共用。

const showAppToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/app-toaster", () => ({ showAppToast: showAppToastMock }));

function makeCard(id: string): BoardCard {
	return { id, title: id, prompt: id, startInPlanMode: false, baseRef: "main", createdAt: 0, updatedAt: 0 };
}

function makeBoard(cardsByColumn: Partial<Record<BoardColumnId, string[]>>): BoardData {
	const columnIds: BoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return {
		columns: columnIds.map((id) => ({ id, title: id, cards: (cardsByColumn[id] ?? []).map(makeCard) })),
	};
}

interface HarnessProps {
	board: BoardData;
	currentProjectId: string | null;
	isDetailViewOpen: boolean;
	isCurrentProjectBoardSettled: boolean;
}

let latest: ReturnType<typeof useCrossProjectTaskOpenInProject> | null = null;
// 绕过本 hook 改导航意图（顶栏项目切换器 / popstate）——与 App 里 use-project-navigation 的 setRequestedProjectId 同义。
let requestProjectNavigationBypassingCrossProjectTaskOpen: ((projectId: string) => void) | null = null;
const setSelectedTaskId = vi.fn<(taskId: string | null) => void>();
const handleSelectProject = vi.fn<(projectId: string) => void>();
const openBacklogTaskEditor = vi.fn<(card: BoardCard) => void>();

function Harness(props: HarnessProps): null {
	// 仿 App：handleSelectProject 同步 setRequestedProjectId，与 setPendingCrossProjectTaskOpen 同批渲染；
	// 导航意图 ≠ 运行时已激活项目期间 isProjectSwitching 为真，board 不算落定。
	const [requestedProjectId, setRequestedProjectId] = useState<string | null>(null);
	requestProjectNavigationBypassingCrossProjectTaskOpen = setRequestedProjectId;
	const isProjectSwitching = requestedProjectId !== null && requestedProjectId !== props.currentProjectId;
	latest = useCrossProjectTaskOpenInProject({
		...props,
		isCurrentProjectBoardSettled: props.isCurrentProjectBoardSettled && !isProjectSwitching,
		setSelectedTaskId,
		handleSelectProject: (projectId) => {
			handleSelectProject(projectId);
			setRequestedProjectId(projectId);
		},
		openBacklogTaskEditor,
	});
	return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	setSelectedTaskId.mockReset();
	handleSelectProject.mockReset();
	openBacklogTaskEditor.mockReset();
	showAppToastMock.mockReset();
	latest = null;
	requestProjectNavigationBypassingCrossProjectTaskOpen = null;
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
});

function render(props: Partial<HarnessProps> = {}): void {
	act(() =>
		root.render(
			createElement(Harness, {
				board: makeBoard({ review: ["a-review"], backlog: ["a-backlog"] }),
				currentProjectId: "project-a",
				isDetailViewOpen: true,
				isCurrentProjectBoardSettled: true,
				...props,
			}),
		),
	);
}

describe("useCrossProjectTaskOpenInProject", () => {
	it("同项目：非 backlog 直接选中，backlog 打开编辑对话框", () => {
		render();
		act(() => latest?.handleOpenTaskInProject("project-a", "a-review"));
		expect(setSelectedTaskId).toHaveBeenCalledWith("a-review");
		act(() => latest?.handleOpenTaskInProject("project-a", "a-backlog"));
		expect(openBacklogTaskEditor).toHaveBeenCalledWith(expect.objectContaining({ id: "a-backlog" }));
		expect(handleSelectProject).not.toHaveBeenCalled();
	});

	it("跨项目：先切项目并挂在途态（记下是否从 Focus View 发起），目标 board 加载出该任务后再选中", () => {
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "b-review"));
		expect(handleSelectProject).toHaveBeenCalledWith("project-b");
		expect(latest?.pendingCrossProjectTaskOpen).toEqual({
			repoId: "project-b",
			taskId: "b-review",
			originatedFromFocusView: true,
		});

		// 切项目途中：board 已清空、还没落定，不提示「找不到」。
		render({
			currentProjectId: "project-b",
			board: makeBoard({}),
			isDetailViewOpen: false,
			isCurrentProjectBoardSettled: false,
		});
		expect(showAppToastMock).not.toHaveBeenCalled();

		render({ currentProjectId: "project-b", board: makeBoard({ review: ["b-review"] }), isDetailViewOpen: false });
		expect(setSelectedTaskId).toHaveBeenCalledWith("b-review");
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it("跨项目 backlog：等 board 完全落定后才打开编辑对话框", () => {
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "b-backlog"));
		render({
			currentProjectId: "project-b",
			board: makeBoard({ backlog: ["b-backlog"] }),
			isCurrentProjectBoardSettled: false,
		});
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		render({ currentProjectId: "project-b", board: makeBoard({ backlog: ["b-backlog"] }) });
		expect(openBacklogTaskEditor).toHaveBeenCalledWith(expect.objectContaining({ id: "b-backlog" }));
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("目标 board 落定后仍找不到该任务：清掉在途态并提示，不让过渡外壳一直挂着", () => {
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "b-deleted"));
		render({ currentProjectId: "project-b", board: makeBoard({ review: ["other"] }) });
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
		expect(showAppToastMock).toHaveBeenCalledTimes(1);
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("目标项目已激活但 board 仍是上一个项目的（未落定）：不拿旧 board 的同号卡做决策，落定后按目标 board 打开", () => {
		// taskId 只在一个看板内唯一：A 的 shared-task-id 在 review，B 的同号卡在 backlog。
		render({ board: makeBoard({ review: ["shared-task-id"] }) });
		act(() => latest?.handleOpenTaskInProject("project-b", "shared-task-id"));

		// 快照到达那一帧：currentProjectId 已是 B，App 的 board 还是 A 的（setBoard 在其后的 effect 里才发生）。
		render({
			currentProjectId: "project-b",
			board: makeBoard({ review: ["shared-task-id"] }),
			isDetailViewOpen: false,
			isCurrentProjectBoardSettled: false,
		});
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toEqual(expect.objectContaining({ repoId: "project-b" }));

		render({
			currentProjectId: "project-b",
			board: makeBoard({ backlog: ["shared-task-id"] }),
			isDetailViewOpen: false,
		});
		expect(openBacklogTaskEditor).toHaveBeenCalledTimes(1);
		expect(openBacklogTaskEditor).toHaveBeenCalledWith(expect.objectContaining({ id: "shared-task-id" }));
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it("在途期间导航被别的入口改到第三个项目：该项目落定即取消在途态（过渡外壳随之消失），不选中也不提示", () => {
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "b-review"));
		expect(latest?.pendingCrossProjectTaskOpen?.originatedFromFocusView).toBe(true);

		// 加载中用顶栏切换器改选 C（不经过本 hook）。
		act(() => requestProjectNavigationBypassingCrossProjectTaskOpen?.("project-c"));
		render({ isDetailViewOpen: false });
		expect(latest?.pendingCrossProjectTaskOpen).not.toBeNull();

		render({ currentProjectId: "project-c", board: makeBoard({ review: ["b-review"] }), isDetailViewOpen: false });
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("在途期间导航切回原项目（popstate 等）：原项目重新落定即取消在途态", () => {
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "b-review"));
		act(() => requestProjectNavigationBypassingCrossProjectTaskOpen?.("project-a"));
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("取消在途跳转", () => {
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "b-review"));
		act(() => latest?.cancelPendingCrossProjectTaskOpen());
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});
});
