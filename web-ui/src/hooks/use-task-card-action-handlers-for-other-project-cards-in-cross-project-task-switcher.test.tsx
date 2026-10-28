import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createPostDeployVerificationTaskReadModelTestFixture } from "@/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";
import type { TaskCardActionHandlerBundle } from "@/components/task-card-business-props";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createInitialBoardData } from "@/data/board-data";
import { useCrossProjectTaskOpenInProject } from "@/hooks/use-cross-project-task-open-in-project";
import { useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher } from "@/hooks/use-task-card-action-handlers-for-other-project-cards-in-cross-project-task-switcher";
import type { RuntimePostDeployVerificationDeploymentGroup } from "@/runtime/types";
import type { BoardCard, BoardColumnId } from "@/types";

const mocks = vi.hoisted(() => ({
	move: vi.fn(),
	verificationMutation: vi.fn(),
	read: vi.fn(),
	workspaceRead: vi.fn(),
	verificationState: vi.fn<
		() => Promise<{
			deploymentGroups: RuntimePostDeployVerificationDeploymentGroup[];
			activeDeploymentId: string | null;
		}>
	>(async () => ({ deploymentGroups: [], activeDeploymentId: null })),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		deployment: {
			getPostDeployVerificationState: { query: mocks.verificationState },
			updateVerificationChecklist: { mutate: mocks.verificationMutation },
		},
	}),
}));
vi.mock("@/runtime/workspace-state-query", () => ({
	fetchWorkspaceState: mocks.workspaceRead,
	fetchTaskWorkspaceInfoForWorkspace: vi.fn(),
}));
vi.mock("@/terminal/persistent-terminal-manager", () => ({ ensurePersistentTerminal: vi.fn() }));
vi.mock("@/runtime/task-card-action-query", () => ({ readTaskCardWithBoardColumnInWorkspace: mocks.read }));
vi.mock("@/state/task-card-action-commands-for-any-workspace", () => ({
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime: mocks.move,
	moveTaskCardBetweenNonTrashColumnsThroughRuntime: vi.fn(),
	moveTaskCardIntoReviewByHandingTurnToUserThroughRuntime: vi.fn(),
	permanentlyDeleteTaskCardsWithFullResourceCleanupThroughRuntime: vi.fn(),
	restoreTaskCardFromDoneIntoReviewResumingAgentSessionThroughRuntime: vi.fn(),
	startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime: vi.fn(),
	updateTaskCardFieldValuesThroughRuntime: vi.fn(),
}));
vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn(), showAppToast: vi.fn() }));

const card: BoardCard = {
	id: "shared-task-id",
	title: "其他项目的任务",
	prompt: "原文",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: 1,
	updatedAt: 1,
};
const noop = () => {};

function buttonWithText(text: string): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
	if (!button) throw new Error(`找不到按钮：${text}`);
	return button;
}

async function submitExplicitClosureForm() {
	const select = document.querySelector<HTMLSelectElement>('select[aria-label="结案结果"]');
	if (!select) return;
	await act(async () => {
		select.value = "delivery_accepted";
		select.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await act(async () => {
		buttonWithText("归档并结案").click();
	});
}

it.each(["成功", "失败"])("结案提交中保持任务身份，旧请求%s后才允许打开另一任务", async (outcome) => {
	let finish!: (value: unknown) => void;
	mocks.move.mockReset().mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	mocks.read.mockReset().mockResolvedValue({
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: { taskCard: card, boardColumnIdContainingTaskCard: "validation" },
	});
	mocks.verificationState.mockResolvedValue({ activeDeploymentId: null, deploymentGroups: [] });
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let requestDone: ((taskCard: BoardCard) => void) | undefined;
	function Harness() {
		const controller = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
			onRequestPinTaskCardInOtherProjectToTaskPinboard: noop,
			onUnpinTaskCardInOtherProjectFromTaskPinboard: noop,
		});
		requestDone = (taskCard) =>
			controller
				.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
					workspaceId: "other-project-2",
					taskCard,
					boardColumnIdContainingTaskCard: "validation",
					taskCardActionCommandKindInFlight: null,
				})
				.onMoveToTrashTask?.(taskCard.id);
		return <TooltipProvider>{controller.otherProjectTaskCardActionConfirmationDialogs}</TooltipProvider>;
	}
	try {
		await act(async () => root.render(<Harness />));
		await act(async () => requestDone?.(card));
		await submitExplicitClosureForm();
		expect(mocks.move).toHaveBeenCalledOnce();
		const nextCard = { ...card, id: "next-task", title: "下一任务" };
		await act(async () => requestDone?.(nextCard));
		expect(document.body.textContent).not.toContain("下一任务");
		await act(async () =>
			finish(
				outcome === "成功"
					? {
							taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
							response: { taskWorktreeDeletionResult: null },
						}
					: { taskCardActionCommandExecutionOutcome: "command_failed", commandFailureMessage: "网络失败" },
			),
		);
		if (outcome === "失败") await act(async () => buttonWithText("取消").click());
		await act(async () => requestDone?.(nextCard));
		expect(document.body.textContent).toContain("下一任务");
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

describe("其他项目卡片的评论后完成", () => {
	it.each(["原 ID 同文已保存", "缺少本次评论", "同文但不同 ID", "同 ID 但不同正文", "重试时改写正文"])(
		"响应丢失后重新读取 Done：%s 时仅结算已保存的同一条评论",
		async (savedCommentState) => {
			mocks.move.mockReset();
			mocks.read.mockReset();
			const persistedCard: BoardCard = { ...card, taskCommentEntries: [] };
			mocks.read.mockResolvedValue({
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: { taskCard: persistedCard, boardColumnIdContainingTaskCard: "validation" },
			});
			mocks.move.mockImplementationOnce(async (input) => {
				if (savedCommentState !== "缺少本次评论")
					persistedCard.taskCommentEntries = [
						{
							...input.taskCommentToAppendWhenMovingIntoDone,
							...(savedCommentState === "同文但不同 ID" ? { taskCommentEntryId: "另一条评论" } : {}),
							...(savedCommentState === "同 ID 但不同正文" ? { commentText: "另一段正文" } : {}),
							createdAt: 2,
							updatedAt: 2,
						},
					];
				// 模拟运行时已处理请求但响应丢失，命令包装层将网络异常转为失败结果。
				return {
					taskCardActionCommandExecutionOutcome: "command_failed",
					commandFailureMessage: "保存后的网络响应丢失",
				};
			});
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			let actions: TaskCardActionHandlerBundle | null = null;
			function Harness() {
				const result = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
					onRequestPinTaskCardInOtherProjectToTaskPinboard: noop,
					onUnpinTaskCardInOtherProjectFromTaskPinboard: noop,
				});
				const bundle = result.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
					workspaceId: "other-project-2",
					taskCard: card,
					boardColumnIdContainingTaskCard: "validation",
					taskCardActionCommandKindInFlight: null,
				});
				useEffect(() => {
					actions = bundle;
				});
				return result.otherProjectTaskCardActionConfirmationDialogs;
			}
			async function enterComment(text: string) {
				await act(async () => {
					const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')!;
					Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
					textarea.dispatchEvent(new Event("input", { bubbles: true }));
				});
			}
			try {
				await act(async () => root.render(<Harness />));
				await act(async () => {
					if (!actions?.onMoveToTrashTask) throw new Error("没有其他项目 Done 动作");
					actions.onMoveToTrashTask(card.id, { requestTaskCommentBeforeMovingIntoDone: true });
				});
				await enterComment("项目二已提交的完成评论");
				await submitExplicitClosureForm();
				expect(document.querySelector('[role="alert"]')?.textContent).toBe("保存后的网络响应丢失");
				mocks.read.mockResolvedValue({
					taskCardLookupOutcome: "task_card_found_on_workspace_board",
					taskCardSnapshot: { taskCard: persistedCard, boardColumnIdContainingTaskCard: "trash" },
				});
				if (savedCommentState === "重试时改写正文") await enterComment("改写后的完成评论");
				await submitExplicitClosureForm();
				if (savedCommentState === "原 ID 同文已保存") {
					expect(document.querySelector('[role="dialog"]')).toBeNull();
					expect(persistedCard.taskCommentEntries).toHaveLength(1);
				} else {
					expect(document.querySelector('[role="alert"]')?.textContent).toContain("未提交评论");
					expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')?.value).toBe(
						savedCommentState === "重试时改写正文" ? "改写后的完成评论" : "项目二已提交的完成评论",
					);
				}
				expect(mocks.move).toHaveBeenCalledOnce();
			} finally {
				await act(async () => root.unmount());
				host.remove();
			}
		},
	);

	for (const columnId of ["review", "validation"] as const)
		it(`${columnId} 保留项目身份、取消草稿和失败重试`, async () => {
			mocks.move.mockReset();
			mocks.read.mockReset();
			mocks.read.mockResolvedValue({
				taskCardLookupOutcome: "task_card_found_on_workspace_board",
				taskCardSnapshot: { taskCard: card, boardColumnIdContainingTaskCard: columnId },
			});
			mocks.move.mockResolvedValue({
				taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
				response: { taskWorktreeDeletionResult: null },
			});
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			let actions: TaskCardActionHandlerBundle | null = null;
			function Harness({ stage }: { stage: BoardColumnId }) {
				const result = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
					onRequestPinTaskCardInOtherProjectToTaskPinboard: noop,
					onUnpinTaskCardInOtherProjectFromTaskPinboard: noop,
				});
				const bundle = result.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
					workspaceId: "other-project-2",
					taskCard: card,
					boardColumnIdContainingTaskCard: stage,
					taskCardActionCommandKindInFlight: null,
				});
				useEffect(() => {
					actions = bundle;
				});
				return result.otherProjectTaskCardActionConfirmationDialogs;
			}
			const requestComment = () => {
				if (!actions?.onMoveToTrashTask) throw new Error("没有其他项目 Done 动作");
				actions.onMoveToTrashTask(card.id, { requestTaskCommentBeforeMovingIntoDone: true });
			};
			try {
				await act(async () => root.render(<Harness stage={columnId} />));
				await act(async () => requestComment());
				const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')!;
				await act(async () => {
					Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
						textarea,
						"项目二的评论",
					);
					textarea.dispatchEvent(new Event("input", { bubbles: true }));
				});
				if (columnId === "validation")
					mocks.move.mockResolvedValueOnce({
						taskCardActionCommandExecutionOutcome: "command_failed",
						commandFailureMessage: "网络暂时失败",
					});
				await submitExplicitClosureForm();
				if (columnId === "review") {
					expect(mocks.move).not.toHaveBeenCalled();
					await act(async () => buttonWithText("Cancel").click());
					expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')?.value).toBe(
						"项目二的评论",
					);
					await submitExplicitClosureForm();
					await act(async () => buttonWithText("结案任务").click());
				} else {
					expect(document.querySelector('[role="alert"]')?.textContent).toBe("网络暂时失败");
					await submitExplicitClosureForm();
					expect(mocks.move.mock.calls[0]?.[0].taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId).toBe(
						mocks.move.mock.calls[1]?.[0].taskCommentToAppendWhenMovingIntoDone.taskCommentEntryId,
					);
				}
				expect(mocks.move).toHaveBeenLastCalledWith(
					expect.objectContaining({
						workspaceId: "other-project-2",
						taskId: card.id,
						taskCommentToAppendWhenMovingIntoDone: expect.objectContaining({ commentText: "项目二的评论" }),
					}),
				);
				expect(document.querySelector('[role="dialog"]')).toBeNull();
			} finally {
				await act(async () => root.unmount());
				host.remove();
			}
		});
});

describe("其他项目的 PDV 核对阶段", () => {
	it.each<BoardColumnId>(["review", "validation", "in_progress"])(
		"%s 卡片先核对所属项目的验证项，不提前移列",
		async (columnId) => {
			const board = createInitialBoardData();
			board.columns.find((entry) => entry.id === columnId)!.cards.push(card);
			const task = createPostDeployVerificationTaskReadModelTestFixture({
				taskId: card.id,
				checklist: [
					{
						id: "other-project-item",
						label: "其他项目的实际验证",
						checked: false,
						source: "authored",
						kind: "guided_manual",
						guidance: null,
						script: null,
						run: null,
						cleanup: null,
					},
				],
			});
			const state = {
				activeDeploymentId: "other-deployment",
				deploymentGroups: [
					{
						deploymentId: "other-deployment",
						workspaceId: "other-project-2",
						deployedSourceCommit: "abc",
						previousDeployedSourceCommit: null,
						deployedAtIso: "2026-10-23T10:00:00Z",
						foldedAtIso: null,
						tasks: [task],
					},
				],
			};
			mocks.verificationState.mockResolvedValue(state);
			mocks.workspaceRead.mockResolvedValue({ board, sessions: {}, repoPath: "/fixture/other-project-2" });
			mocks.move.mockClear();
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			let actions: TaskCardActionHandlerBundle | null = null;
			let returnToComment: (() => void) | undefined;
			function Harness() {
				const result = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
					onRequestPinTaskCardInOtherProjectToTaskPinboard: noop,
					onUnpinTaskCardInOtherProjectFromTaskPinboard: noop,
				});
				actions = result.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
					workspaceId: "other-project-2",
					taskCard: card,
					boardColumnIdContainingTaskCard: columnId,
					taskCardActionCommandKindInFlight: null,
				});
				returnToComment =
					result.otherProjectTaskCardActionConfirmationDialogs.props.children[1]?.props
						.onRequestTaskCommentBeforeMovingIntoDone;
				return <TooltipProvider>{result.otherProjectTaskCardActionConfirmationDialogs}</TooltipProvider>;
			}
			try {
				await act(async () => root.render(<Harness />));
				await act(async () => {
					actions?.onMoveToTrashTask?.(
						card.id,
						columnId === "validation" ? { requestTaskCommentBeforeMovingIntoDone: true } : undefined,
					);
				});
				if (columnId !== "validation") {
					mocks.read.mockResolvedValue({
						taskCardLookupOutcome: "task_card_found_on_workspace_board",
						taskCardSnapshot: { taskCard: card, boardColumnIdContainingTaskCard: columnId },
					});
					await submitExplicitClosureForm();
				}
				if (columnId === "validation") {
					mocks.read.mockResolvedValue({
						taskCardLookupOutcome: "task_card_found_on_workspace_board",
						taskCardSnapshot: { taskCard: card, boardColumnIdContainingTaskCard: columnId },
					});
					await act(async () => {
						const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')!;
						Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
							textarea,
							"核对前的原评论",
						);
						textarea.dispatchEvent(new Event("input", { bubbles: true }));
					});
					await submitExplicitClosureForm();
				}
				expect(document.body.textContent).toContain("结案前核对");
				expect(document.body.textContent).toContain("其他项目的实际验证");
				expect(document.querySelector("select")).toBeNull();
				expect(mocks.move).not.toHaveBeenCalled();
				expect(mocks.workspaceRead).toHaveBeenCalledWith("other-project-2");
				if (columnId === "validation") {
					await act(async () => returnToComment?.());
					expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="任务评论"]')?.value).toBe(
						"核对前的原评论",
					);
					expect(buttonWithText("归档并结案").disabled).toBe(false);
					await submitExplicitClosureForm();
					expect(document.body.textContent).toContain("结案前核对");
					expect(mocks.move).not.toHaveBeenCalled();
				}
			} finally {
				act(() => root.unmount());
				host.remove();
				mocks.verificationState.mockResolvedValue({ deploymentGroups: [], activeDeploymentId: null });
			}
		},
	);
});

it("结案前重读所属项目看板，列变化后重新核对并显式确认停止执行", async () => {
	const board = createInitialBoardData();
	board.columns.find((column) => column.id === "validation")!.cards.push(card);
	const runningBoard = createInitialBoardData();
	runningBoard.columns.find((column) => column.id === "in_progress")!.cards.push(card);
	const task = createPostDeployVerificationTaskReadModelTestFixture({
		taskId: card.id,
		checklist: [
			{
				id: "checked-at-completion",
				label: "实际验证",
				checked: false,
				source: "authored",
				kind: "guided_manual",
				guidance: null,
				script: null,
				run: null,
				cleanup: null,
			},
		],
	});
	const group: RuntimePostDeployVerificationDeploymentGroup = {
		workspaceId: "other-project-2",
		deploymentId: "live-deployment",
		deployedSourceCommit: "abc",
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-10-23T10:00:00Z",
		foldedAtIso: null,
		tasks: [task],
	};
	mocks.verificationState.mockResolvedValueOnce({ activeDeploymentId: group.deploymentId, deploymentGroups: [group] });
	mocks.verificationState.mockResolvedValue({
		activeDeploymentId: group.deploymentId,
		deploymentGroups: [
			{ ...group, tasks: [{ ...task, checklist: task.checklist.map((item) => ({ ...item, checked: true })) }] },
		],
	});
	mocks.workspaceRead.mockReset();
	mocks.workspaceRead.mockResolvedValueOnce({ board, sessions: {}, repoPath: "/fixture/other-project-2" });
	mocks.workspaceRead.mockResolvedValue({ board: runningBoard, sessions: {}, repoPath: "/fixture/other-project-2" });
	mocks.move.mockReset();
	mocks.move.mockResolvedValue({
		taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
		response: { taskWorktreeDeletionResult: null },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let actions: TaskCardActionHandlerBundle | null = null;
	function Harness() {
		const result = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
			onRequestPinTaskCardInOtherProjectToTaskPinboard: noop,
			onUnpinTaskCardInOtherProjectFromTaskPinboard: noop,
		});
		actions = result.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
			workspaceId: "other-project-2",
			taskCard: card,
			boardColumnIdContainingTaskCard: "validation",
			taskCardActionCommandKindInFlight: null,
		});
		return <TooltipProvider>{result.otherProjectTaskCardActionConfirmationDialogs}</TooltipProvider>;
	}
	try {
		await act(async () => root.render(<Harness />));
		await act(async () => actions?.onMoveToTrashTask?.(card.id));
		mocks.read.mockResolvedValueOnce({
			taskCardLookupOutcome: "task_card_found_on_workspace_board",
			taskCardSnapshot: { taskCard: card, boardColumnIdContainingTaskCard: "validation" },
		});
		await submitExplicitClosureForm();
		await act(async () => buttonWithText("完成核对并结案").click());
		expect(mocks.workspaceRead).toHaveBeenCalledTimes(2);
		expect(mocks.move).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("重新核对");
		const acknowledgement = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(acknowledgement?.checked).toBe(false);
		await act(async () => buttonWithText("完成核对并结案").click());
		expect(mocks.move).not.toHaveBeenCalled();
		await act(async () => acknowledgement!.click());
		await act(async () => buttonWithText("完成核对并结案").click());
		expect(mocks.move).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "other-project-2",
				taskId: card.id,
				postDeployVerificationDoneEntryClosure: {
					confirmedAcknowledgements: ["skip_validation", "in_progress_active"],
				},
			}),
		);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		mocks.verificationState.mockResolvedValue({ deploymentGroups: [], activeDeploymentId: null });
	}
});

it("跨项目引导等待真实目标看板落定，局部视图卸载后仍能操作目标并确认观察", async () => {
	const board = createInitialBoardData();
	board.columns.find((column) => column.id === "validation")!.cards.push(card);
	const task = createPostDeployVerificationTaskReadModelTestFixture({
		taskId: card.id,
		checklist: [
			{
				id: "board-guidance",
				label: "所属项目看板验证",
				checked: false,
				source: "authored",
				kind: "guided_manual",
				guidance: {
					anchor: { view: "board", anchorKey: "board-column:validation" },
					steps: ["操作项目二看板"],
					expectedObservation: "看到项目二实际交互",
				},
				script: null,
				run: null,
				cleanup: null,
			},
		],
	});
	const group: RuntimePostDeployVerificationDeploymentGroup = {
		workspaceId: "other-project-2",
		deploymentId: "board-deployment",
		deployedSourceCommit: "abc",
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-10-23T10:00:00Z",
		foldedAtIso: null,
		tasks: [task],
	};
	mocks.verificationState.mockResolvedValue({ activeDeploymentId: group.deploymentId, deploymentGroups: [group] });
	mocks.workspaceRead.mockResolvedValue({ board, sessions: {}, repoPath: "/fixture/other-project-2" });
	mocks.verificationMutation.mockReset().mockResolvedValue({ ok: true });
	const selectProject = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let actions: TaskCardActionHandlerBundle | null = null;
	function Harness({
		currentProjectId,
		owner,
		settled,
	}: {
		currentProjectId: string;
		owner: string;
		settled: boolean;
	}) {
		const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
		const [showsAllProjects, setShowsAllProjects] = useState(true);
		const [observations, setObservations] = useState(0);
		const navigation = useCrossProjectTaskOpenInProject({
			board,
			currentProjectId,
			projectIdOwningHydratedBoard: owner,
			selectedTaskId,
			isDetailViewOpen: false,
			isCurrentProjectBoardSettled: settled,
			setSelectedTaskId,
			handleSelectProject: selectProject,
			openBacklogTaskEditor: noop,
		});
		const controller = useTaskCardActionHandlersForOtherProjectCardsInCrossProjectTaskSwitcher({
			onOpenTaskInProject: navigation.handleOpenTaskInProject,
			onNavigateToProjectBoard: async (workspaceId) => {
				setShowsAllProjects(false);
				await navigation.handleNavigateToProjectBoard(workspaceId);
			},
		});
		actions = controller.buildTaskCardActionHandlerBundleForOtherProjectTaskCard({
			workspaceId: "other-project-2",
			taskCard: card,
			boardColumnIdContainingTaskCard: "validation",
			taskCardActionCommandKindInFlight: null,
		});
		return (
			<TooltipProvider>
				{showsAllProjects ? <div data-testid="局部视图">All projects</div> : null}
				{currentProjectId === "other-project-2" && owner === currentProjectId && settled ? (
					<div data-verification-anchor="board-column:validation">
						<button type="button" onClick={() => setObservations((count) => count + 1)}>
							项目二实际界面操作
						</button>
						<output>{observations}</output>
					</div>
				) : null}
				{controller.otherProjectTaskCardActionConfirmationDialogs}
			</TooltipProvider>
		);
	}
	try {
		await act(async () => root.render(<Harness currentProjectId="project-a" owner="project-a" settled />));
		await act(async () => actions?.onMoveToTrashTask?.(card.id));
		mocks.read.mockResolvedValueOnce({
			taskCardLookupOutcome: "task_card_found_on_workspace_board",
			taskCardSnapshot: { taskCard: card, boardColumnIdContainingTaskCard: "validation" },
		});
		await submitExplicitClosureForm();
		await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="定位并核对"]')!.click());
		expect(selectProject).toHaveBeenCalledWith("other-project-2");
		expect(document.querySelector('[data-testid="局部视图"]')).toBeNull();
		expect(document.body.textContent).not.toContain("看到预期 ✓");
		await act(async () => root.render(<Harness currentProjectId="other-project-2" owner="project-a" settled />));
		expect(document.body.textContent).not.toContain("看到预期 ✓");
		await act(async () =>
			root.render(<Harness currentProjectId="other-project-2" owner="other-project-2" settled />),
		);
		expect(document.body.textContent).toContain("看到预期 ✓");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => buttonWithText("项目二实际界面操作").click());
		expect(document.querySelector("output")?.textContent).toBe("1");
		await act(async () => buttonWithText("看到预期 ✓").click());
		expect(mocks.verificationMutation).toHaveBeenCalledWith(
			expect.objectContaining({
				deploymentId: "board-deployment",
				taskId: card.id,
				itemId: "board-guidance",
				checked: true,
			}),
		);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		mocks.verificationState.mockResolvedValue({ deploymentGroups: [], activeDeploymentId: null });
	}
});
