import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { createInitialBoardData } from "@/data/board-data";
import type { UsePostDeployVerificationResult } from "@/hooks/use-post-deploy-verification";
import type { RuntimePostDeployVerificationDeploymentGroup } from "@/runtime/types";
import type { BoardColumnId } from "@/types";
import { PostDeployVerificationReviewBeforeMoveIntoDoneDialog } from "./post-deploy-verification-review-before-move-into-done-dialog";
import { createPostDeployVerificationTaskReadModelTestFixture } from "./post-deploy-verification-task-read-model-test-fixtures";

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
	useTaskWorkspaceInfoValue: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let group: RuntimePostDeployVerificationDeploymentGroup;
let verification: UsePostDeployVerificationResult;
const confirm = vi.fn();
const cancel = vi.fn();

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	confirm.mockReset();
	cancel.mockReset();
	group = {
		deploymentId: "deployment-1",
		workspaceId: "cline-kanban",
		deployedSourceCommit: "a".repeat(40),
		previousDeployedSourceCommit: null,
		deployedAtIso: "2026-10-23T10:00:00.000Z",
		foldedAtIso: null,
		tasks: [
			createPostDeployVerificationTaskReadModelTestFixture({
				checklist: [
					{
						id: "manual-1",
						label: "验证实际交互",
						checked: false,
						source: "authored",
						kind: "guided_manual",
						guidance: null,
						script: null,
						run: null,
						cleanup: null,
					},
				],
			}),
		],
	};
	verification = {
		activeGroup: group,
		historyGroups: [],
		activeDeploymentId: group.deploymentId,
		loadError: null,
		hasLoadedOnce: true,
		pendingVerificationTaskCount: 1,
		refresh: vi.fn(),
		refreshAndReadActiveGroup: vi.fn(async () => group),
		isVerificationWriteInFlight: false,
		stayInFront: false,
		setStayInFront: vi.fn(),
		collapsed: true,
		setCollapsed: vi.fn(),
		toggleChecklistItem: vi.fn(async () => {}),
		addCustomChecklistItem: vi.fn(async () => {}),
		removeCustomChecklistItem: vi.fn(async () => {}),
		runVerificationItem: vi.fn(async () => {}),
		requestComplete: vi.fn(),
		confirmComplete: vi.fn(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

function render(column: BoardColumnId = "validation") {
	const board = createInitialBoardData();
	const card = {
		id: "task-1",
		title: "等待核对的任务",
		prompt: "需求",
		baseRef: "main",
		startInPlanMode: false,
		createdAt: 1,
		updatedAt: 1,
	};
	board.columns.find((entry) => entry.id === column)?.cards.push(card);
	act(() =>
		root.render(
			<TooltipProvider>
				<PostDeployVerificationReviewBeforeMoveIntoDoneDialog
					workspaceId="cline-kanban"
					taskId="task-1"
					board={board}
					verification={verification}
					realTaskCardRenderingInputs={{
						realTaskCardRenderingInputsBoardSourceKind: "current_project_board_hydrated_in_browser",
						currentProjectTaskSessions: {},
						currentProjectTaskCardActionHandlers: {},
						currentProjectWorkspacePath: null,
						onActivateTaskCardOpeningTaskDetail: vi.fn(),
						defaultAgentId: null,
						defaultClineModelId: null,
					}}
					isSubmittingClosure={false}
					onCancel={cancel}
					onConfirmClosureRequestsBySelectedTaskId={confirm}
				/>
			</TooltipProvider>,
		),
	);
}

function button(text: string) {
	const result = [...document.body.querySelectorAll("button")].find((entry) => entry.textContent === text);
	if (!result) throw new Error(`找不到按钮：${text}`);
	return result;
}

describe("移入 Done 前核对", () => {
	it.each<BoardColumnId>(["review", "validation", "in_progress"])(
		"%s 先显示真实任务卡和可操作清单，不直接问原因",
		(column) => {
			render(column);
			expect(document.body.textContent).toContain("移入 Done 前核对");
			expect(document.body.textContent).toContain("验证实际交互");
			expect(document.querySelector(".kb-board-card-shell")).not.toBeNull();
			expect(document.querySelector("select")).toBeNull();
			expect(confirm).not.toHaveBeenCalled();
		},
	);

	it("仍有未完成项才打开原因表单，返回后恢复清单", async () => {
		render();
		await act(async () => button("继续填写未完成原因").click());
		expect(document.querySelector("select")).not.toBeNull();
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		act(() => button("返回核对").click());
		expect(document.querySelector("select")).toBeNull();
		expect(document.body.textContent).toContain("验证实际交互");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("刷新后已全勾，直接交出无原因的结案请求", async () => {
		render();
		group.tasks[0]!.checklist[0]!.checked = true;
		await act(async () => button("继续填写未完成原因").click());
		expect(confirm).toHaveBeenCalledWith({ "task-1": {} });
		expect(document.querySelector("select")).toBeNull();
	});

	it("写入和脚本未结束时不能结案", () => {
		verification.isVerificationWriteInFlight = true;
		render();
		expect(button("继续填写未完成原因").disabled).toBe(true);
	});

	it("刷新失败保留核对界面，不能当成通过", async () => {
		verification.refreshAndReadActiveGroup = vi.fn(async () => {
			throw new Error("连接已断开");
		});
		render();
		await act(async () => button("继续填写未完成原因").click());
		expect(document.body.textContent).toContain("连接已断开");
		expect(document.querySelector("select")).toBeNull();
		expect(confirm).not.toHaveBeenCalled();
	});
	it("人工勾选继续使用 PDV 的保存动作", () => {
		render();
		const checkbox = document.querySelector<HTMLButtonElement>('[role="checkbox"]');
		expect(checkbox).not.toBeNull();
		act(() => checkbox!.click());
		expect(verification.toggleChecklistItem).toHaveBeenCalledWith("deployment-1", "task-1", "manual-1", true);
	});

	it("全通过的 In Progress 任务仍需显式确认停止会话", async () => {
		group.tasks[0]!.checklist[0]!.checked = true;
		render("in_progress");
		await act(async () => button("完成核对并移入 Done").click());
		expect(confirm).not.toHaveBeenCalled();
		act(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
		await act(async () => button("完成核对并移入 Done").click());
		expect(confirm).toHaveBeenCalledWith({
			"task-1": { confirmedAcknowledgements: ["skip_validation", "in_progress_active"] },
		});
	});

	it("部署切换不沿用旧清单的完成确认", async () => {
		verification.refreshAndReadActiveGroup = vi.fn(async () => ({ ...group, deploymentId: "new-deployment" }));
		render();
		await act(async () => button("继续填写未完成原因").click());
		expect(document.body.textContent).toContain("部署已变化");
		expect(confirm).not.toHaveBeenCalled();
		expect(document.querySelector("select")).toBeNull();
	});

	it("等待刷新期间任务换列，不发送旧确认", async () => {
		let finishRefresh!: (value: RuntimePostDeployVerificationDeploymentGroup) => void;
		verification.refreshAndReadActiveGroup = vi.fn(
			() =>
				new Promise<RuntimePostDeployVerificationDeploymentGroup>((resolve) => {
					finishRefresh = resolve;
				}),
		);
		render();
		act(() => button("继续填写未完成原因").click());
		render("in_progress");
		await act(async () => finishRefresh(group));
		expect(document.body.textContent).toContain("任务所在项目或列已变化");
		expect(confirm).not.toHaveBeenCalled();
	});
	it("其他浏览器启动的脚本仍在运行时禁止结案，并允许刷新运行结果", () => {
		group.tasks[0]!.checklist[0]!.run = {
			status: "running",
			exitCode: null,
			startedAtIso: null,
			finishedAtIso: null,
			outputExcerpt: "",
		};
		render();
		expect(button("继续填写未完成原因").disabled).toBe(true);
		expect(button("刷新核对清单").disabled).toBe(false);
	});

	it("继续时发现新的远端运行状态，不打开原因表单或移列", async () => {
		render();
		group.tasks[0]!.checklist[0]!.run = {
			status: "running",
			exitCode: null,
			startedAtIso: null,
			finishedAtIso: null,
			outputExcerpt: "",
		};
		await act(async () => button("继续填写未完成原因").click());
		expect(document.body.textContent).toContain("验证脚本仍在运行");
		expect(confirm).not.toHaveBeenCalled();
		expect(document.querySelector("select")).toBeNull();
	});
});
