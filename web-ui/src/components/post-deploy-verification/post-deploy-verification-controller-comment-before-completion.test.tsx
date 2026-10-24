import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	PostDeployVerificationController,
	type PostDeployVerificationControllerProps,
} from "@/components/post-deploy-verification/post-deploy-verification-controller";
import { createPostDeployVerificationTaskReadModelTestFixture } from "@/components/post-deploy-verification/post-deploy-verification-task-read-model-test-fixtures";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createInitialBoardData } from "@/data/board-data";
import type { UsePostDeployVerificationResult } from "@/hooks/use-post-deploy-verification";
import type { BoardCard } from "@/types";

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: () => undefined,
	useTaskWorkspaceInfoValue: () => null,
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
const reactActEnvironmentGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = reactActEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT;
	reactActEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = true;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	reactActEnvironmentGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

async function renderUnhydratedWorkspacePostDeployVerificationCard(hasUncheckedChecklistItem = false) {
	const card: BoardCard = {
		id: "task-1",
		title: "未水合项目的任务",
		prompt: "原始需求",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
	const board = createInitialBoardData();
	board.columns.find((column) => column.id === "validation")!.cards.push(card);
	const task = createPostDeployVerificationTaskReadModelTestFixture({
		taskId: card.id,
		columnIdAtMatch: "validation",
		checklist: [
			{
				id: "authored:check",
				label: "检查真实行为",
				checked: !hasUncheckedChecklistItem,
				source: "authored",
				kind: "guided_manual",
				guidance: null,
				script: null,
				run: null,
				cleanup: null,
			},
		],
	});
	const verification: UsePostDeployVerificationResult = {
		activeGroup: {
			deploymentId: "deployment-1",
			deployedAtIso: "2026-10-18T00:00:00.000Z",
			foldedAtIso: null,
			workspaceId: "unhydrated-workspace",
			deployedSourceCommit: "abc123",
			previousDeployedSourceCommit: null,
			tasks: [task],
		},
		historyGroups: [],
		activeDeploymentId: "deployment-1",
		loadError: null,
		hasLoadedOnce: true,
		pendingVerificationTaskCount: 1,
		refresh: vi.fn(),
		refreshAndReadActiveGroup: vi.fn(),
		isVerificationWriteInFlight: false,
		stayInFront: true,
		setStayInFront: vi.fn(),
		collapsed: false,
		setCollapsed: vi.fn(),
		toggleChecklistItem: vi.fn(),
		addCustomChecklistItem: vi.fn(),
		removeCustomChecklistItem: vi.fn(),
		runVerificationItem: vi.fn(),
		requestComplete: vi
			.fn()
			.mockResolvedValue({ needsConfirmation: false, confirmationToken: "token-1", requiredAcknowledgements: [] }),
		confirmComplete: vi.fn().mockResolvedValue({ ok: true }),
	};
	const completePostDeployVerificationMoveToDone = vi
		.fn<PostDeployVerificationControllerProps["completePostDeployVerificationMoveToDone"]>()
		.mockResolvedValue({ ok: true });
	const rerender = () =>
		act(async () =>
			root.render(
				<TooltipProvider>
					<PostDeployVerificationController
						verification={verification}
						board={board}
						completePostDeployVerificationMoveToDone={completePostDeployVerificationMoveToDone}
						onSelectTask={vi.fn()}
						onNavigateToBoard={vi.fn()}
						realTaskCardRenderingInputsForPostDeployVerificationPanelEntries={{
							realTaskCardRenderingInputsBoardSourceKind:
								"runtime_board_snapshot_of_workspace_not_hydrated_in_browser",
							workspaceIdOwningRuntimeBoardSnapshot: "unhydrated-workspace",
							taskSessionsFromRuntimeBoardSnapshot: {},
							workspacePathOwningRuntimeBoardSnapshot: null,
							onActivateTaskCardOpeningTaskInItsProject: vi.fn(),
							defaultAgentId: null,
							defaultClineModelId: null,
						}}
					/>
				</TooltipProvider>,
			),
		);
	verification.refreshAndReadActiveGroup = vi.fn(async () => verification.activeGroup);
	await rerender();
	await act(async () =>
		document
			.querySelector<HTMLButtonElement>(
				'[data-post-deploy-verification-deployment-attribution-zone="task_commits_not_yet_deployed_or_task_unattributable"] button',
			)!
			.click(),
	);
	return { verification, completePostDeployVerificationMoveToDone, board, card, task, rerender };
}

async function selectCommentBeforeCompletion() {
	const trigger = document.querySelector<HTMLButtonElement>('.kb-board-card-shell [aria-label="Move task to done"]');
	expect(trigger).not.toBeNull();
	await act(async () => trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
	const option = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="添加评论并移入 Done…"]');
	expect(option).not.toBeNull();
	await act(async () => option!.click());
}

it("未水合 PDV 宿主的附加完成选项先打开评论弹窗，不申请完成 token 或移列", async () => {
	const { verification, completePostDeployVerificationMoveToDone } =
		await renderUnhydratedWorkspacePostDeployVerificationCard();
	await selectCommentBeforeCompletion();
	expect(document.querySelector('[aria-label="任务评论"]')).not.toBeNull();
	expect(verification.requestComplete).not.toHaveBeenCalled();
	expect(completePostDeployVerificationMoveToDone).not.toHaveBeenCalled();
});

function buttonWithText(text: string): HTMLButtonElement {
	const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(entry) => entry.textContent?.trim() === text,
	);
	expect(button).toBeDefined();
	return button!;
}

async function enterTaskComment(commentText: string) {
	const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="任务评论"]');
	expect(textarea).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, commentText);
		textarea!.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

it("取消未水合宿主的评论弹窗不申请 token、不写评论、不移列", async () => {
	const { verification, completePostDeployVerificationMoveToDone } =
		await renderUnhydratedWorkspacePostDeployVerificationCard();
	await selectCommentBeforeCompletion();
	await enterTaskComment("尚未提交的草稿");
	await act(async () => buttonWithText("取消").click());
	expect(document.querySelector('[aria-label="任务评论"]')).toBeNull();
	expect(verification.requestComplete).not.toHaveBeenCalled();
	expect(verification.confirmComplete).not.toHaveBeenCalled();
	expect(completePostDeployVerificationMoveToDone).not.toHaveBeenCalled();
});

it("Validation 清单已核对：确认评论后经过原 token 完成流，并将评论交给原移列命令", async () => {
	const { verification, completePostDeployVerificationMoveToDone } =
		await renderUnhydratedWorkspacePostDeployVerificationCard();
	await selectCommentBeforeCompletion();
	await enterTaskComment("  已完成实际验证  ");
	await act(async () => buttonWithText("提交评论并移入 Done").click());
	expect(verification.requestComplete).toHaveBeenCalledWith({ deploymentId: "deployment-1", taskId: "task-1" });
	expect(completePostDeployVerificationMoveToDone).toHaveBeenCalledWith("task-1", "validation", undefined, {
		taskCommentEntryId: expect.any(String),
		commentText: "已完成实际验证",
	});
	expect(verification.confirmComplete).toHaveBeenCalledWith({
		deploymentId: "deployment-1",
		taskId: "task-1",
		token: "token-1",
		acks: [],
	});
	expect(document.querySelector('[aria-label="任务评论"]')).toBeNull();
});

it("有未勾项时评论先经过核对再填写原因：取消保留草稿，确认后同一命令携带原因与评论", async () => {
	const { verification, completePostDeployVerificationMoveToDone } =
		await renderUnhydratedWorkspacePostDeployVerificationCard(true);
	await selectCommentBeforeCompletion();
	await enterTaskComment("保留在门禁里的评论");
	await act(async () => buttonWithText("提交评论并移入 Done").click());
	expect(document.querySelector('[aria-label="任务评论"]')).toBeNull();
	expect(document.body.textContent).toContain("移入 Done 前核对");
	expect(document.querySelector("select")).toBeNull();
	expect(completePostDeployVerificationMoveToDone).not.toHaveBeenCalled();
	await act(async () => buttonWithText("取消").click());
	expect(document.querySelector<HTMLTextAreaElement>('[aria-label="任务评论"]')?.value).toBe("保留在门禁里的评论");
	expect(completePostDeployVerificationMoveToDone).not.toHaveBeenCalled();
	await act(async () => buttonWithText("提交评论并移入 Done").click());
	await act(async () => buttonWithText("继续填写未完成原因").click());
	const reasonSelect = document.querySelector<HTMLSelectElement>('[aria-label="检查真实行为：原因"]')!;
	await act(async () => {
		reasonSelect.value = "custom_reason_described_in_reason_text";
		reasonSelect.dispatchEvent(new Event("change", { bubbles: true }));
	});
	const reasonInput = document.querySelector<HTMLInputElement>('[aria-label="检查真实行为：原因文本"]')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reasonInput, "另有实测证据");
		reasonInput.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(buttonWithText("确认移入 Done").disabled).toBe(false);
	await act(async () => buttonWithText("确认移入 Done").click());
	expect(completePostDeployVerificationMoveToDone).toHaveBeenCalledOnce();
	expect(completePostDeployVerificationMoveToDone).toHaveBeenCalledWith(
		"task-1",
		"validation",
		{
			uncheckedChecklistItemClosureReasons: [
				{
					checklistItemId: "authored:check",
					uncheckedChecklistItemClosureReasonCode: "custom_reason_described_in_reason_text",
					uncheckedChecklistItemClosureReasonText: "另有实测证据",
				},
			],
		},
		{ taskCommentEntryId: expect.any(String), commentText: "保留在门禁里的评论" },
	);
	expect(verification.confirmComplete).not.toHaveBeenCalled();
});

it("未水合宿主的直接完成保留原行为，不打开评论弹窗", async () => {
	const { verification, completePostDeployVerificationMoveToDone } =
		await renderUnhydratedWorkspacePostDeployVerificationCard();
	await act(async () =>
		document.querySelector<HTMLButtonElement>('.kb-board-card-shell [aria-label="Move task to done"]')!.click(),
	);
	expect(document.querySelector('[aria-label="任务评论"]')).toBeNull();
	expect(completePostDeployVerificationMoveToDone).toHaveBeenCalledWith("task-1", "validation", undefined, undefined);
	expect(verification.confirmComplete).toHaveBeenCalledOnce();
});

async function simulateCommentPersistedBeforeCompletionResponseLoss() {
	const harness = await renderUnhydratedWorkspacePostDeployVerificationCard();
	harness.completePostDeployVerificationMoveToDone.mockImplementationOnce(
		async (_taskId, _fromColumnId, _closure, comment) => {
			expect(comment).toBeDefined();
			harness.card.taskCommentEntries = [{ ...comment!, createdAt: 2, updatedAt: 2 }];
			return { ok: false, moveIntoDoneFailureMessage: "网络响应丢失" };
		},
	);
	await selectCommentBeforeCompletion();
	await enterTaskComment("已经写盘的评论");
	await act(async () => buttonWithText("提交评论并移入 Done").click());
	expect(document.querySelector<HTMLTextAreaElement>('[aria-label="任务评论"]')?.disabled).toBe(false);
	for (const column of harness.board.columns)
		column.cards = column.cards.filter((card) => card.id !== harness.card.id);
	harness.board.columns.find((column) => column.id === "trash")!.cards.push(harness.card);
	harness.verification.requestComplete = vi
		.fn()
		.mockResolvedValue({ needsConfirmation: false, error: "任务已结案，无需再次完成核对" });
	return harness;
}

it("PDV 响应丢失后同 ID 同文已读回且无 token：重试只结算评论，不重发完成或追加", async () => {
	const harness = await simulateCommentPersistedBeforeCompletionResponseLoss();
	harness.task.verifiedAt = "2026-10-18T00:01:00.000Z";
	harness.task.pendingConfirmation = null;
	await harness.rerender();
	await act(async () => buttonWithText("提交评论并移入 Done").click());
	expect(document.querySelector('[aria-label="任务评论"]')).toBeNull();
	expect(harness.card.taskCommentEntries).toHaveLength(1);
	expect(harness.completePostDeployVerificationMoveToDone).toHaveBeenCalledOnce();
	expect(harness.verification.requestComplete).not.toHaveBeenCalled();
	expect(harness.verification.confirmComplete).not.toHaveBeenCalled();
});

it("PDV 响应丢失后保留有效空 acknowledgement token：同 ID 同文结算不会锁住草稿或代替 PDV 恢复", async () => {
	const harness = await simulateCommentPersistedBeforeCompletionResponseLoss();
	const pendingConfirmation = {
		token: "token-1",
		expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
		requiredAcknowledgements: [],
		columnIdAtIssuance: "validation" as const,
	};
	harness.task.pendingConfirmation = pendingConfirmation;
	await harness.rerender();
	await act(async () => buttonWithText("提交评论并移入 Done").click());
	expect(document.querySelector('[aria-label="任务评论"]')).toBeNull();
	expect(harness.completePostDeployVerificationMoveToDone).toHaveBeenCalledOnce();
	expect(harness.verification.requestComplete).not.toHaveBeenCalled();
	expect(harness.verification.confirmComplete).not.toHaveBeenCalled();
	expect(harness.task.pendingConfirmation).toBe(pendingConfirmation);
	expect(harness.task.verifiedAt).toBeNull();
	await act(async () => buttonWithText("完成核对并移入 Done").click());
	expect(harness.verification.confirmComplete).toHaveBeenCalledWith({
		deploymentId: "deployment-1",
		taskId: "task-1",
		token: "token-1",
		acks: [],
	});
	expect(harness.completePostDeployVerificationMoveToDone).toHaveBeenCalledOnce();
	expect(harness.verification.requestComplete).not.toHaveBeenCalled();
});

it.each(["missing", "different_id", "different_saved_text", "edited_draft"] as const)(
	"PDV trash 读回不匹配（%s）：保留可取消草稿，不重跑完成或确认 token",
	async (conflictKind) => {
		const harness = await simulateCommentPersistedBeforeCompletionResponseLoss();
		if (conflictKind === "missing") harness.card.taskCommentEntries = [];
		if (conflictKind === "different_id")
			harness.card.taskCommentEntries![0]!.taskCommentEntryId = "another-comment-id";
		if (conflictKind === "different_saved_text")
			harness.card.taskCommentEntries![0]!.commentText = "另一段已保存的正文";
		if (conflictKind === "edited_draft") await enterTaskComment("用户修改后的草稿");
		harness.task.pendingConfirmation = {
			token: "token-1",
			expiresAtIso: new Date(Date.now() + 60_000).toISOString(),
			requiredAcknowledgements: [],
			columnIdAtIssuance: "validation",
		};
		await harness.rerender();
		await act(async () => buttonWithText("提交评论并移入 Done").click());
		const textarea = document.querySelector<HTMLTextAreaElement>('[aria-label="任务评论"]');
		expect(textarea?.disabled).toBe(false);
		expect(textarea?.value).toBe(conflictKind === "edited_draft" ? "用户修改后的草稿" : "已经写盘的评论");
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("评论");
		expect(harness.completePostDeployVerificationMoveToDone).toHaveBeenCalledOnce();
		expect(harness.verification.requestComplete).not.toHaveBeenCalled();
		expect(harness.verification.confirmComplete).not.toHaveBeenCalled();
		expect(buttonWithText("取消").disabled).toBe(false);
		await act(async () => buttonWithText("取消").click());
		expect(document.querySelector('[aria-label="任务评论"]')).toBeNull();
	},
);
