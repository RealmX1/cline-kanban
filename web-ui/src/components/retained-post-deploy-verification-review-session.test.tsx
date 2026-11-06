import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PostDeployVerificationReviewBeforeMoveIntoDoneDialogProps } from "@/components/post-deploy-verification/post-deploy-verification-review-before-move-into-done-dialog";
import { RetainedPostDeployVerificationReviewSession } from "@/components/retained-post-deploy-verification-review-session";
import { createInitialBoardData } from "@/data/board-data";
import type { completeTaskClosureFromBoundFloatingForm } from "@/state/complete-task-closure-from-bound-floating-form";

const mocks = vi.hoisted(() => ({
	complete: vi.fn<typeof completeTaskClosureFromBoundFloatingForm>(async () => {}),
	requestComment: vi.fn(),
}));
beforeEach(() => {
	mocks.complete.mockReset().mockResolvedValue(undefined);
	mocks.requestComment.mockReset();
});
let reviewProps: PostDeployVerificationReviewBeforeMoveIntoDoneDialogProps;
vi.mock("@/components/post-deploy-verification/post-deploy-verification-review-before-move-into-done-dialog", () => ({
	PostDeployVerificationReviewBeforeMoveIntoDoneDialog: (
		props: PostDeployVerificationReviewBeforeMoveIntoDoneDialogProps,
	) => {
		reviewProps = props;
		return null;
	},
}));
vi.mock("@/hooks/use-post-deploy-verification", () => ({ usePostDeployVerification: () => ({}) }));
vi.mock("@/state/complete-task-closure-from-bound-floating-form", () => ({
	completeTaskClosureFromBoundFloatingForm: mocks.complete,
}));
vi.mock("@/state/post-deploy-verification-task-closure-form-request", () => ({
	requestPostDeployVerificationTaskClosureForm: mocks.requestComment,
}));
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	vi.unstubAllGlobals();
});

it("核对窗的导航、补充结案和最终提交始终使用打开时的项目与任务身份", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const board = createInitialBoardData();
	board.columns
		.find((column) => column.id === "validation")!
		.cards.push({
			id: "a1b2c",
			title: "A 的任务",
			prompt: "需求",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 100,
			updatedAt: 101,
		});
	const openTask = vi.fn();
	const navigateToProjectBoard = vi.fn();
	const staleCurrentPageCallback = vi.fn();
	const comment = { taskCommentEntryId: "comment-1", commentText: "A 的结案内容" };
	mocks.requestComment.mockResolvedValue(comment);
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	await act(async () =>
		root.render(
			<RetainedPostDeployVerificationReviewSession
				workspaceId="project-a"
				taskId="a1b2c"
				board={board}
				realTaskCardRenderingInputs={null}
				isSubmittingClosure={false}
				onCancel={vi.fn()}
				onConfirmClosureRequestsBySelectedTaskId={staleCurrentPageCallback}
				onSelectTask={staleCurrentPageCallback}
				onNavigateToBoard={staleCurrentPageCallback}
				onRequestTaskCommentBeforeMovingIntoDone={staleCurrentPageCallback}
				onOpenTaskInProject={openTask}
				onNavigateToProjectBoard={navigateToProjectBoard}
			/>,
		),
	);
	await act(async () => {
		reviewProps.onSelectTask?.();
		await reviewProps.onNavigateToBoard?.();
		reviewProps.onRequestTaskCommentBeforeMovingIntoDone?.();
	});
	expect(openTask).toHaveBeenCalledWith("project-a", "a1b2c");
	expect(navigateToProjectBoard).toHaveBeenCalledWith("project-a");
	expect(mocks.requestComment).toHaveBeenCalledWith("project-a", "a1b2c", 100);
	await act(async () => reviewProps.onConfirmClosureRequestsBySelectedTaskId({}));
	expect(mocks.complete).toHaveBeenCalledWith(
		expect.objectContaining({
			workspaceId: "project-a",
			taskId: "a1b2c",
			expectedTaskIncarnationCreatedAtEpochMs: 100,
			taskCommentToAppendWhenMovingIntoDone: comment,
		}),
	);
	expect(staleCurrentPageCallback).not.toHaveBeenCalled();
});

it("PDV 面板的保留核对窗传递原部署凭据，未知移列响应后仍可复用原结案内容重试", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const board = createInitialBoardData();
	board.columns
		.find((column) => column.id === "validation")!
		.cards.push({
			id: "a1b2c",
			title: "A 的任务",
			prompt: "需求",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 100,
			updatedAt: 101,
		});
	const comment = {
		taskCommentEntryId: "comment-a",
		commentText: "原结案内容",
		closure: {
			closureRequestId: "358b30d6-811a-45fd-b8cf-8e55472a9892",
			details: { outcome: "delivery_accepted" as const, evidence: [], acceptedDeliverables: [] },
			selectedArtifactRelativePaths: [],
		},
	};
	mocks.requestComment.mockResolvedValue(comment);
	mocks.complete.mockImplementationOnce(async (input) => {
		input.receipt.moveSubmissionAttempted = true;
		throw new Error("移列响应未知");
	});
	const close = vi.fn();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	await act(async () =>
		root.render(
			<RetainedPostDeployVerificationReviewSession
				workspaceId="project-a"
				taskId="a1b2c"
				board={board}
				realTaskCardRenderingInputs={null}
				isSubmittingClosure={false}
				postDeployVerificationCompletionDeploymentId="deployment-a"
				onCancel={close}
				onConfirmClosureRequestsBySelectedTaskId={vi.fn()}
			/>,
		),
	);
	await act(async () => reviewProps.onConfirmClosureRequestsBySelectedTaskId({}));
	expect(close).not.toHaveBeenCalled();
	expect(reviewProps.continueConfirmationAfterMove).toBe(true);
	await act(async () => reviewProps.onConfirmClosureRequestsBySelectedTaskId({}));
	expect(mocks.requestComment).toHaveBeenCalledOnce();
	expect(mocks.complete).toHaveBeenLastCalledWith(
		expect.objectContaining({
			completionDeploymentId: "deployment-a",
			taskCommentToAppendWhenMovingIntoDone: comment,
		}),
	);
	expect(close).toHaveBeenCalledOnce();
});
