import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NonModalFloatingFormWindowHost } from "@/components/non-modal-floating-form-window-host-provider";
import { useCrossProjectTaskOpenInProject } from "@/hooks/use-cross-project-task-open-in-project";
import type { BoardCard, BoardColumnId, BoardData } from "@/types";

// 「在某个项目里打开某个任务」的唯一入口：All projects 首页、Spotlight、跨项目切换面板、通知点击共用。

const showAppToastMock = vi.hoisted(() => vi.fn());
const readTaskCardMock = vi.hoisted(() => vi.fn());
const ensureTerminalMock = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/task-card-action-query", () => ({ readTaskCardWithBoardColumnInWorkspace: readTaskCardMock }));
vi.mock("@/terminal/persistent-terminal-manager", () => ({ ensurePersistentTerminal: ensureTerminalMock }));

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

function taskReadResponse(taskId: string, columnId: BoardColumnId = "review", createdAt = 0) {
	return {
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: {
			taskCard: { ...makeCard(taskId), createdAt },
			boardColumnIdContainingTaskCard: columnId,
		},
	};
}

interface HarnessProps {
	board: BoardData;
	currentProjectId: string | null;
	projectIdOwningHydratedBoard: string | null;
	selectedTaskId: string | null;
	isDetailViewOpen: boolean;
	isCurrentProjectBoardSettled: boolean;
	floatingFormWindowHost?: NonModalFloatingFormWindowHost | null;
}

let latest: ReturnType<typeof useCrossProjectTaskOpenInProject> | null = null;
// 绕过本 hook 改导航意图（顶栏项目切换器 / popstate）——与 App 里 use-project-navigation 的 setRequestedProjectId 同义。
let requestProjectNavigationBypassingCrossProjectTaskOpen: ((projectId: string) => void) | null = null;
const setSelectedTaskId = vi.fn<(taskId: string | null) => void>();
const handleSelectProject = vi.fn<(projectId: string) => void>();
const openBacklogTaskEditor = vi.fn<(workspaceId: string, card: BoardCard) => void>();

function Harness(props: HarnessProps): null {
	// 仿 App：handleSelectProject 同步 setRequestedProjectId，与 setPendingCrossProjectTaskOpen 同批渲染；
	// 导航意图 ≠ 运行时已激活项目期间 isProjectSwitching 为真，board 不算落定。
	const [requestedProjectId, setRequestedProjectId] = useState<string | null>(null);
	requestProjectNavigationBypassingCrossProjectTaskOpen = setRequestedProjectId;
	const isProjectSwitching = requestedProjectId !== null && requestedProjectId !== props.currentProjectId;
	latest = useCrossProjectTaskOpenInProject({
		...props,
		navigationCurrentProjectId: requestedProjectId ?? props.currentProjectId,
		isCurrentProjectBoardSettled: props.isCurrentProjectBoardSettled && !isProjectSwitching,
		setSelectedTaskId,
		handleSelectProject: (projectId) => {
			handleSelectProject(projectId);
			setRequestedProjectId(projectId);
		},
		openBacklogTaskEditor,
		floatingFormWindowHost: props.floatingFormWindowHost,
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
	readTaskCardMock
		.mockReset()
		.mockImplementation((_workspaceId: string, taskId: string) => Promise.resolve(taskReadResponse(taskId)));
	ensureTerminalMock.mockReset();
	latest = null;
	requestProjectNavigationBypassingCrossProjectTaskOpen = null;
	container = document.createElement("div");
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
});

function render(props: Partial<HarnessProps> = {}): void {
	const currentProjectId = props.currentProjectId !== undefined ? props.currentProjectId : "project-a";
	act(() =>
		root.render(
			createElement(Harness, {
				board: makeBoard({ review: ["a-review"], backlog: ["a-backlog"] }),
				currentProjectId,
				// 未显式给出时视为 board 已属于当前项目；握手窗口（board 仍属上一个项目）的用例显式给出。
				projectIdOwningHydratedBoard: currentProjectId,
				selectedTaskId: "a-review",
				isDetailViewOpen: true,
				isCurrentProjectBoardSettled: true,
				...props,
			}),
		),
	);
}

describe("useCrossProjectTaskOpenInProject", () => {
	it("可等待的打开回报要等详情真实显示，取消与失败分别结算", async () => {
		render();
		let outcome: unknown;
		act(() => {
			void latest?.openTaskInProjectWithResult("project-a", "a-backlog", 42).then((result) => {
				outcome = result;
			});
		});
		await act(async () => {});
		expect(outcome).toMatchObject({ outcome: "unavailable" });
		render({ selectedTaskId: null, isDetailViewOpen: false });
		act(() => {
			void latest?.openTaskInProjectWithResult("project-a", "a-review", 0).then((result) => {
				outcome = result;
			});
		});
		outcome = undefined;
		await act(async () => {});
		expect(outcome).toBeUndefined();
		render({ selectedTaskId: "a-review", isDetailViewOpen: true });
		await act(async () => {});
		expect(outcome).toMatchObject({ outcome: "opened" });
		act(() => {
			void latest?.openTaskInProjectWithResult("project-b", "b-review", 0).then((result) => {
				outcome = result;
			});
		});
		act(() => latest?.dismissPendingCrossProjectTaskOpen());
		await act(async () => {});
		expect(outcome).toMatchObject({ outcome: "cancelled" });
	});
	it("迁移别名匹配到原编辑窗时复用该窗，并以原项目的显示回报结束等待", async () => {
		let revealListener:
			| ((ownership: {
					workspaceId?: string | null;
					taskId?: string | null;
					taskIncarnationCreatedAtEpochMs?: number;
			  }) => void)
			| undefined;
		const reveal = vi.fn(() => true);
		render({
			currentProjectId: "project-b",
			board: makeBoard({ backlog: ["moved"] }),
			selectedTaskId: null,
			isDetailViewOpen: false,
			floatingFormWindowHost: {
				hasOpenWindows: true,
				openWindow: () => Symbol(),
				closeWindow: () => undefined,
				collapseTaskEditorWindowsExcept: () => undefined,
				revealTaskEditorPreservingEarlierWorkspace: reveal,
				subscribeToRevealedTaskEditors: (listener) => {
					revealListener = listener;
					return () => {
						revealListener = undefined;
					};
				},
			},
		});
		let outcome: unknown;
		act(() => {
			void latest
				?.openTaskInProjectWithResult("project-b", "moved", 0, undefined, ["project-a", "project-b"])
				.then((result) => {
					outcome = result;
				});
		});
		await act(async () => undefined);
		expect(reveal).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "project-b",
				taskId: "moved",
				taskIncarnationCreatedAtEpochMs: 0,
				workspaceIdsUsedByTaskIncarnation: ["project-a", "project-b"],
			}),
		);
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		expect(outcome).toBeUndefined();
		act(() => revealListener?.({ workspaceId: "project-a", taskId: "moved", taskIncarnationCreatedAtEpochMs: 0 }));
		await act(async () => undefined);
		expect(outcome).toEqual({ outcome: "opened" });
	});

	it("普通看板的 Backlog 专用入口跨项目原地编辑，不切项目或选中详情", async () => {
		render({ selectedTaskId: null, isDetailViewOpen: false });
		readTaskCardMock.mockResolvedValue(taskReadResponse("b-backlog", "backlog", 42));
		await act(async () => latest?.handleOpenBacklogTaskEditorInProject("project-b", "b-backlog", 42));
		expect(readTaskCardMock).toHaveBeenCalledExactlyOnceWith("project-b", "b-backlog", 42);
		expect(openBacklogTaskEditor).toHaveBeenCalledExactlyOnceWith(
			"project-b",
			expect.objectContaining({ id: "b-backlog", createdAt: 42 }),
		);
		expect(handleSelectProject).not.toHaveBeenCalled();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it("Backlog 专用入口读取同项目 displayedBoard 的最新保存投影", () => {
		const board = makeBoard({ backlog: ["a-backlog"] });
		board.columns[0]!.cards[0]!.title = "刚保存的名称";
		render({ selectedTaskId: null, isDetailViewOpen: false, board });
		act(() => latest?.handleOpenBacklogTaskEditorInProject("project-a", "a-backlog"));
		expect(openBacklogTaskEditor).toHaveBeenCalledExactlyOnceWith(
			"project-a",
			expect.objectContaining({ id: "a-backlog", title: "刚保存的名称" }),
		);
		expect(readTaskCardMock).not.toHaveBeenCalled();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("普通看板读取后目标已离开 Backlog 时继续正常导航", async () => {
		render({ selectedTaskId: null, isDetailViewOpen: false });
		await act(async () => latest?.handleOpenBacklogTaskEditorInProject("project-b", "b-review"));
		expect(handleSelectProject).toHaveBeenLastCalledWith("project-b");
		render({
			currentProjectId: "project-b",
			selectedTaskId: null,
			isDetailViewOpen: false,
			board: makeBoard({ review: ["b-review"] }),
		});
		expect(setSelectedTaskId).toHaveBeenLastCalledWith("b-review");
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
	});

	it.each(["missing", "recreated", "read-failed"])(
		"普通看板的 Backlog 专用入口拒绝失效读取（%s）并提示",
		async (failure) => {
			render({ selectedTaskId: null, isDetailViewOpen: false });
			if (failure === "missing")
				readTaskCardMock.mockResolvedValue({ taskCardLookupOutcome: "task_card_not_found_on_workspace_board" });
			else if (failure === "recreated")
				readTaskCardMock.mockResolvedValue(taskReadResponse("b-backlog", "backlog", 43));
			else readTaskCardMock.mockRejectedValue(new Error("读取失败"));
			await act(async () => latest?.handleOpenBacklogTaskEditorInProject("project-b", "b-backlog", 42));
			expect(openBacklogTaskEditor).not.toHaveBeenCalled();
			expect(handleSelectProject).not.toHaveBeenCalled();
			expect(setSelectedTaskId).not.toHaveBeenCalled();
			expect(showAppToastMock).toHaveBeenCalledOnce();
		},
	);

	describe.each(["focus", "board"])("%s 的 Backlog 专用入口", (view) => {
		it.each(["back", "other-task", "project-board", "external-project", "unmount", "late-error"])(
			"读取期间发生 %s 后忽略旧响应或错误",
			async (navigation) => {
				let finishRead!: (response: unknown) => void;
				let failRead!: (error: Error) => void;
				readTaskCardMock.mockReturnValue(
					new Promise((resolve, reject) => {
						finishRead = resolve;
						failRead = reject;
					}),
				);
				render({ selectedTaskId: view === "focus" ? "a-review" : null, isDetailViewOpen: view === "focus" });
				act(() => latest?.handleOpenBacklogTaskEditorInProject("project-b", "b-backlog"));
				if (navigation === "back" || navigation === "late-error")
					act(() => latest?.dismissPendingCrossProjectTaskOpen());
				if (navigation === "other-task") act(() => latest?.handleOpenTaskInProject("project-a", "a-review"));
				if (navigation === "project-board") {
					let boardNavigation: Promise<void> | undefined;
					act(() => {
						boardNavigation = latest?.handleNavigateToProjectBoard("project-a");
					});
					void boardNavigation?.catch(() => undefined);
				}
				if (navigation === "external-project")
					act(() => requestProjectNavigationBypassingCrossProjectTaskOpen?.("project-c"));
				if (navigation === "unmount") act(() => root.render(null));
				handleSelectProject.mockClear();
				await act(async () =>
					navigation === "late-error"
						? failRead(new Error("迟到的读取失败"))
						: finishRead(taskReadResponse("b-backlog", "backlog")),
				);
				expect(openBacklogTaskEditor).not.toHaveBeenCalled();
				expect(handleSelectProject).not.toHaveBeenCalled();
				expect(showAppToastMock).not.toHaveBeenCalled();
			},
		);

		it("连续点击只打开最后一次读取的 Backlog", async () => {
			const completeReads: Array<(response: unknown) => void> = [];
			readTaskCardMock.mockImplementation(() => new Promise((resolve) => completeReads.push(resolve)));
			render({ selectedTaskId: view === "focus" ? "a-review" : null, isDetailViewOpen: view === "focus" });
			act(() => latest?.handleOpenBacklogTaskEditorInProject("project-b", "first"));
			act(() => latest?.handleOpenBacklogTaskEditorInProject("project-c", "second"));
			await act(async () => completeReads[1]?.(taskReadResponse("second", "backlog")));
			await act(async () => completeReads[0]?.(taskReadResponse("first", "backlog")));
			expect(openBacklogTaskEditor).toHaveBeenCalledExactlyOnceWith(
				"project-c",
				expect.objectContaining({ id: "second" }),
			);
			expect(handleSelectProject).not.toHaveBeenCalled();
		});
	});

	it.each(["list-then-search", "search-then-list"])("Focus 中 %s 共享读取失效身份", async (order) => {
		const completeReads: Array<(response: unknown) => void> = [];
		readTaskCardMock.mockImplementation(() => new Promise((resolve) => completeReads.push(resolve)));
		render();
		const first = order === "list-then-search" ? "handleOpenBacklogTaskEditorInProject" : "handleOpenTaskInProject";
		const second = order === "list-then-search" ? "handleOpenTaskInProject" : "handleOpenBacklogTaskEditorInProject";
		act(() => latest?.[first]("project-b", "first"));
		act(() => latest?.[second]("project-c", "second"));
		await act(async () => completeReads[1]?.(taskReadResponse("second", "backlog")));
		await act(async () => completeReads[0]?.(taskReadResponse("first", "backlog")));
		expect(openBacklogTaskEditor).toHaveBeenCalledExactlyOnceWith(
			"project-c",
			expect.objectContaining({ id: "second" }),
		);
		expect(handleSelectProject).not.toHaveBeenCalled();
	});

	it("来源 Focus 的在途外壳中再点 Backlog，落定后恢复最初来源再编辑最新目标", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
		render({ selectedTaskId: null, isDetailViewOpen: false });
		await act(async () => latest?.handleOpenBacklogTaskEditorInProject("project-c", "c-backlog", 42));
		expect(latest?.pendingCrossProjectTaskOpen?.originFocusedTaskInProject).toEqual({
			repoId: "project-a",
			taskId: "a-review",
		});
		const targetBoard = makeBoard({ backlog: ["c-backlog"] });
		targetBoard.columns[0]!.cards[0]!.createdAt = 42;
		render({ currentProjectId: "project-c", selectedTaskId: null, isDetailViewOpen: false, board: targetBoard });
		expect(handleSelectProject).toHaveBeenLastCalledWith("project-a");
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		render({ selectedTaskId: null, isDetailViewOpen: false });
		expect(setSelectedTaskId).toHaveBeenLastCalledWith("a-review");
		expect(openBacklogTaskEditor).toHaveBeenCalledExactlyOnceWith(
			"project-c",
			expect.objectContaining({ id: "c-backlog", createdAt: 42 }),
		);
	});

	it("从 Focus 跨项目打开 Backlog 只读目标卡并原地编辑，保留同号来源任务", async () => {
		render({ board: makeBoard({ review: ["shared-task"] }), selectedTaskId: "shared-task" });
		readTaskCardMock.mockResolvedValue(taskReadResponse("shared-task", "backlog", 42));
		await act(async () => latest?.handleOpenTaskInProject("project-b", "shared-task", 42));
		expect(readTaskCardMock).toHaveBeenCalledWith("project-b", "shared-task", 42);
		expect(openBacklogTaskEditor).toHaveBeenCalledWith(
			"project-b",
			expect.objectContaining({ id: "shared-task", createdAt: 42 }),
		);
		expect(handleSelectProject).not.toHaveBeenCalled();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it.each(["missing", "recreated", "read-failed"])(
		"从 Focus 预读目标失败（%s）时保留 Focus 并提示",
		async (failure) => {
			render();
			if (failure === "missing")
				readTaskCardMock.mockResolvedValue({ taskCardLookupOutcome: "task_card_not_found_on_workspace_board" });
			if (failure === "read-failed") readTaskCardMock.mockRejectedValue(new Error("读取失败"));
			else if (failure === "recreated")
				readTaskCardMock.mockResolvedValue(taskReadResponse("b-backlog", "backlog", 43));
			await act(async () => latest?.handleOpenTaskInProject("project-b", "b-backlog", 42));
			expect(openBacklogTaskEditor).not.toHaveBeenCalled();
			expect(handleSelectProject).not.toHaveBeenCalled();
			expect(setSelectedTaskId).not.toHaveBeenCalled();
			expect(showAppToastMock).toHaveBeenCalledOnce();
		},
	);

	it.each(["back", "other-task", "project-board", "external-project", "unmount"])(
		"预读期间发生 %s 后忽略迟到响应",
		async (navigation) => {
			let finishRead!: (response: unknown) => void;
			readTaskCardMock.mockReturnValue(
				new Promise((resolve) => {
					finishRead = resolve;
				}),
			);
			render();
			act(() => latest?.handleOpenTaskInProject("project-b", "b-backlog"));
			if (navigation === "back") act(() => latest?.dismissPendingCrossProjectTaskOpen());
			if (navigation === "other-task") act(() => latest?.handleOpenTaskInProject("project-a", "a-review"));
			if (navigation === "project-board") {
				let boardNavigation: Promise<void> | undefined;
				act(() => {
					boardNavigation = latest?.handleNavigateToProjectBoard("project-a");
				});
				void boardNavigation?.catch(() => undefined);
			}
			if (navigation === "external-project")
				act(() => requestProjectNavigationBypassingCrossProjectTaskOpen?.("project-c"));
			if (navigation === "unmount") act(() => root.render(null));
			handleSelectProject.mockClear();
			await act(async () => finishRead(taskReadResponse("b-backlog", "backlog")));
			expect(openBacklogTaskEditor).not.toHaveBeenCalled();
			expect(handleSelectProject).not.toHaveBeenCalled();
			expect(showAppToastMock).not.toHaveBeenCalled();
		},
	);

	it("连续点击只打开最后一次预读的 Backlog", async () => {
		const completeReads: Array<(response: unknown) => void> = [];
		readTaskCardMock.mockImplementation(() => new Promise((resolve) => completeReads.push(resolve)));
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "first"));
		act(() => latest?.handleOpenTaskInProject("project-c", "second"));
		await act(async () => completeReads[1]?.(taskReadResponse("second", "backlog")));
		await act(async () => completeReads[0]?.(taskReadResponse("first", "backlog")));
		expect(openBacklogTaskEditor).toHaveBeenCalledExactlyOnceWith(
			"project-c",
			expect.objectContaining({ id: "second" }),
		);
		expect(handleSelectProject).not.toHaveBeenCalled();
	});

	it("返回后迟到的读取失败不会提示过时错误", async () => {
		let failRead!: (error: Error) => void;
		readTaskCardMock.mockReturnValue(
			new Promise((_resolve, reject) => {
				failRead = reject;
			}),
		);
		render();
		act(() => latest?.handleOpenTaskInProject("project-b", "b-backlog"));
		act(() => latest?.dismissPendingCrossProjectTaskOpen());
		await act(async () => failRead(new Error("迟到的读取失败")));
		expect(showAppToastMock).not.toHaveBeenCalled();
		expect(handleSelectProject).not.toHaveBeenCalled();
	});

	it("跨项目搁置 Backlog 仍导航到详情，不作为普通 Backlog 编辑", async () => {
		const response = taskReadResponse("shelved-backlog", "backlog");
		const shelvedTask = {
			...response.taskCardSnapshot.taskCard,
			taskShelvingState: { isShelved: true, lastChangedAt: 10 },
		};
		readTaskCardMock.mockResolvedValue({
			...response,
			taskCardSnapshot: { ...response.taskCardSnapshot, taskCard: shelvedTask },
		});
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "shelved-backlog"));
		expect(handleSelectProject).toHaveBeenLastCalledWith("project-b");
		const board = makeBoard({ backlog: [] });
		board.columns[0]!.cards.push(shelvedTask);
		render({ currentProjectId: "project-b", selectedTaskId: null, isDetailViewOpen: false, board });
		expect(setSelectedTaskId).toHaveBeenLastCalledWith("shelved-backlog");
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
	});

	it("预读时非 Backlog、切换途中回到 Backlog：恢复来源 Focus 后编辑目标项目", async () => {
		readTaskCardMock.mockResolvedValue(taskReadResponse("b-task", "review", 42));
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-task", 42));
		const targetBoard = makeBoard({ backlog: ["b-task"] });
		targetBoard.columns[0]!.cards[0]!.createdAt = 42;
		render({ currentProjectId: "project-b", selectedTaskId: null, isDetailViewOpen: false, board: targetBoard });
		expect(handleSelectProject).toHaveBeenLastCalledWith("project-a");
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		render({ currentProjectId: "project-a", selectedTaskId: null, isDetailViewOpen: false });
		expect(setSelectedTaskId).toHaveBeenLastCalledWith("a-review");
		expect(openBacklogTaskEditor).toHaveBeenCalledExactlyOnceWith(
			"project-b",
			expect.objectContaining({ id: "b-task", createdAt: 42 }),
		);
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it("关联引用的一世与当前项目同 ID 新卡不符时不打开编辑器或详情", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-a", "a-backlog", 42));
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledWith(expect.objectContaining({ intent: "warning" }));
	});
	it("跨项目在途保留一世身份，落定后拒绝打开重建卡", async () => {
		render();
		readTaskCardMock.mockResolvedValue(taskReadResponse("a-review", "review", 42));
		await act(async () => latest?.handleOpenTaskInProject("project-b", "a-review", 42));
		expect(latest?.pendingCrossProjectTaskOpen).toMatchObject({ expectedTaskIncarnationCreatedAtEpochMs: 42 });
		render({ currentProjectId: "project-b", board: makeBoard({ review: ["a-review"] }) });
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});
	it.each(["pty_terminal", "acp_stdio_subprocess", "in_process_cline_sdk", undefined])(
		"在途仅预热已知 PTY 会话；通道=%s，跨项目同号卡仍保持身份",
		async (sessionTransport) => {
			readTaskCardMock.mockResolvedValue({
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: {
					taskCard: makeCard("a-review"),
					taskSessionSummaryLiveInRuntimeProcessMemory: { agentId: "claude", sessionTransport },
					taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
				},
			});
			render();
			await act(async () => latest?.handleOpenTaskInProject("project-b", "a-review"));
			expect(readTaskCardMock).toHaveBeenCalledWith("project-b", "a-review");
			if (sessionTransport === "pty_terminal")
				expect(ensureTerminalMock).toHaveBeenCalledWith(
					expect.objectContaining({
						workspaceId: "project-b",
						taskId: "a-review",
						deferAutomaticSessionResumeUntilVisibleMount: true,
					}),
				);
			else expect(ensureTerminalMock).not.toHaveBeenCalled();
			expect(setSelectedTaskId).not.toHaveBeenCalled();
		},
	);
	it("取消在途后，迟到的会话读取不会建立终端", async () => {
		let finishSessionRead!: (response: unknown) => void;
		readTaskCardMock.mockReturnValue(
			new Promise((resolve) => {
				finishSessionRead = resolve;
			}),
		);
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "a-review"));
		act(() => latest?.cancelPendingCrossProjectTaskOpenReturningToOriginTask());
		await act(async () =>
			finishSessionRead({
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: {
					taskCard: makeCard("a-review"),
					taskSessionSummaryLiveInRuntimeProcessMemory: { agentId: "claude", sessionTransport: "pty_terminal" },
					taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
				},
			}),
		);
		expect(ensureTerminalMock).not.toHaveBeenCalled();
	});
	it("跨项目 backlog 即使残留 PTY 会话也不预热终端", async () => {
		readTaskCardMock.mockResolvedValue({
			taskCardLookupOutcome: "task_card_found_on_workspace_board",
			taskCardSnapshot: {
				taskCard: makeCard("a-review"),
				boardColumnIdContainingTaskCard: "backlog",
				taskSessionSummaryLiveInRuntimeProcessMemory: { agentId: "claude", sessionTransport: "pty_terminal" },
				taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
			},
		});
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-backlog"));
		expect(ensureTerminalMock).not.toHaveBeenCalled();
	});

	it("搁置 Backlog 的搜索定位打开 Focus View，保留搁置状态", async () => {
		const board = makeBoard({ backlog: ["shelved-backlog"] });
		const card = board.columns.flatMap((column) => column.cards)[0];
		if (!card) throw new Error("缺少搁置 Backlog 夹具");
		card.taskShelvingState = { isShelved: true, lastChangedAt: 10 };
		render({ board });
		await act(async () => latest?.handleOpenTaskInProject("project-a", "shelved-backlog"));
		expect(setSelectedTaskId).toHaveBeenCalledWith("shelved-backlog");
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		expect(card.taskShelvingState.isShelved).toBe(true);
	});

	it("同项目：非 backlog 直接选中，backlog 打开编辑对话框", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-a", "a-review"));
		expect(setSelectedTaskId).toHaveBeenCalledWith("a-review");
		await act(async () => latest?.handleOpenTaskInProject("project-a", "a-backlog"));
		expect(openBacklogTaskEditor).toHaveBeenCalledWith("project-a", expect.objectContaining({ id: "a-backlog" }));
		// 同项目只会「选回当前项目」（不在途时是 no-op，在途时撤销切换），绝不切去别的项目。
		expect(handleSelectProject.mock.calls.every(([projectId]) => projectId === "project-a")).toBe(true);
	});

	// cf427：选中一个看板上没有的 id，Focus View 会无卡可显、静默关掉（通知点击「跳不进 Focus」的一种形态）。
	it("同项目找不到该任务：保持当前视图（不改选中），如实提示", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-a", "task-not-on-board"));
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledWith(
			expect.objectContaining({ message: "That task is no longer on its project's board." }),
		);
	});

	it("跨项目：先切项目并挂在途态（记下是否从 Focus View 发起），目标 board 加载出该任务后再选中", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
		expect(handleSelectProject).toHaveBeenCalledWith("project-b");
		expect(latest?.pendingCrossProjectTaskOpen).toEqual({
			repoId: "project-b",
			taskId: "b-review",
			originatedFromFocusView: true,
			originFocusedTaskInProject: { repoId: "project-a", taskId: "a-review" },
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

	it("从看板跨项目打开 backlog：等 board 完全落定后才打开编辑对话框", async () => {
		render({ isDetailViewOpen: false });
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-backlog"));
		render({
			currentProjectId: "project-b",
			board: makeBoard({ backlog: ["b-backlog"] }),
			isCurrentProjectBoardSettled: false,
		});
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		render({ currentProjectId: "project-b", board: makeBoard({ backlog: ["b-backlog"] }) });
		expect(openBacklogTaskEditor).toHaveBeenCalledWith("project-b", expect.objectContaining({ id: "b-backlog" }));
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("目标 board 落定后仍找不到该任务：清掉在途态并提示，不让过渡外壳一直挂着", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-deleted"));
		render({ currentProjectId: "project-b", board: makeBoard({ review: ["other"] }) });
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
		expect(showAppToastMock).toHaveBeenCalledTimes(1);
		expect(setSelectedTaskId).not.toHaveBeenCalled();
	});

	it("目标项目已激活但 board 仍是上一个项目的（未落定）：不拿旧 board 的同号卡做决策，落定后按目标 board 打开", async () => {
		// taskId 只在一个看板内唯一：A 的 shared-task-id 在 review，B 的同号卡在 backlog。
		render({ board: makeBoard({ review: ["shared-task-id"] }), isDetailViewOpen: false });
		await act(async () => latest?.handleOpenTaskInProject("project-b", "shared-task-id"));

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
		expect(openBacklogTaskEditor).toHaveBeenCalledWith(
			"project-b",
			expect.objectContaining({ id: "shared-task-id" }),
		);
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	// 握手窗口：旧服务端会让 projects_updated 抢在 snapshot 前到达（或 snapshot 到达那一帧 setBoard 还没发生），
	// currentProjectId 已是目标项目、board 仍属上一个项目。此时在过渡外壳里再点目标项目的另一个任务，不能被当成
	// 「同项目」去旧 board 里找卡——那会误报「That task is no longer on its project's board.」并把第一次的在途一起丢掉。
	it("currentProjectId 已是目标项目、board 仍属上一个项目时再点目标项目的另一个任务：改挂在途、不误报，落定后打开它", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-first"));
		render({
			currentProjectId: "project-b",
			projectIdOwningHydratedBoard: "project-a",
			isDetailViewOpen: false,
			selectedTaskId: null,
			isCurrentProjectBoardSettled: false,
		});

		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-second"));
		expect(showAppToastMock).not.toHaveBeenCalled();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(openBacklogTaskEditor).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toEqual({
			repoId: "project-b",
			taskId: "b-second",
			originatedFromFocusView: true,
			originFocusedTaskInProject: { repoId: "project-a", taskId: "a-review" },
		});

		render({
			currentProjectId: "project-b",
			projectIdOwningHydratedBoard: "project-b",
			board: makeBoard({ review: ["b-first", "b-second"] }),
			isDetailViewOpen: false,
			selectedTaskId: null,
		});
		expect(setSelectedTaskId).toHaveBeenCalledTimes(1);
		expect(setSelectedTaskId).toHaveBeenCalledWith("b-second");
		expect(showAppToastMock).not.toHaveBeenCalled();
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it("在途期间导航被别的入口改到第三个项目：该项目落定即取消在途态（过渡外壳随之消失），不选中也不提示", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
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

	it("在途期间导航切回原项目（popstate 等）：原项目重新落定即取消在途态", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
		act(() => requestProjectNavigationBypassingCrossProjectTaskOpen?.("project-a"));
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
		expect(setSelectedTaskId).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("快照未到时 Cancel：撤销在途切换、回到发起时的任务（不再落到目标项目）", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
		handleSelectProject.mockClear();
		act(() => latest?.cancelPendingCrossProjectTaskOpenReturningToOriginTask());
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
		expect(handleSelectProject).toHaveBeenLastCalledWith("project-a");
		expect(setSelectedTaskId).toHaveBeenLastCalledWith("a-review");
	});

	it("目标项目已激活后 Cancel：反向跨项目打开发起时的任务，外壳保持到原项目落定", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
		render({
			currentProjectId: "project-b",
			board: makeBoard({ review: ["shared"] }),
			isDetailViewOpen: false,
			selectedTaskId: null,
			isCurrentProjectBoardSettled: false,
		});
		act(() => latest?.cancelPendingCrossProjectTaskOpenReturningToOriginTask());
		expect(handleSelectProject).toHaveBeenLastCalledWith("project-a");
		expect(latest?.pendingCrossProjectTaskOpen).toEqual(
			expect.objectContaining({ repoId: "project-a", taskId: "a-review", originatedFromFocusView: true }),
		);
		render({ currentProjectId: "project-a", selectedTaskId: null, isDetailViewOpen: false });
		expect(setSelectedTaskId).toHaveBeenLastCalledWith("a-review");
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it("在途期间点当前项目的任务：撤销在途切换并直接选中它", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
		handleSelectProject.mockClear();
		await act(async () => latest?.handleOpenTaskInProject("project-a", "a-review"));
		expect(handleSelectProject).toHaveBeenCalledWith("project-a");
		expect(setSelectedTaskId).toHaveBeenLastCalledWith("a-review");
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
	});

	it("dismiss 只丢在途态，不动导航", async () => {
		render();
		await act(async () => latest?.handleOpenTaskInProject("project-b", "b-review"));
		handleSelectProject.mockClear();
		act(() => latest?.dismissPendingCrossProjectTaskOpen());
		expect(latest?.pendingCrossProjectTaskOpen).toBeNull();
		expect(handleSelectProject).not.toHaveBeenCalled();
	});
});
