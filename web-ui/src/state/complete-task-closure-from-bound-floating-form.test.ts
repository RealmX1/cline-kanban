import { beforeEach, expect, it, vi } from "vitest";
import type { UsePostDeployVerificationResult } from "@/hooks/use-post-deploy-verification";
import {
	type BoundFloatingFormTaskClosureCompletionReceipt,
	completeTaskClosureFromBoundFloatingForm,
} from "./complete-task-closure-from-bound-floating-form";

const { move } = vi.hoisted(() => ({ move: vi.fn() }));
vi.mock("@/state/task-card-action-commands-for-any-workspace", () => ({
	moveTaskCardIntoDoneStoppingSessionsAndDeletingWorktreeThroughRuntime: move,
}));
beforeEach(() =>
	move
		.mockReset()
		.mockResolvedValue({ taskCardActionCommandExecutionOutcome: "command_completed_by_runtime", response: {} }),
);

function scenario() {
	const requestComplete = vi.fn(async () => ({
		confirmationToken: "bound-token",
		requiredAcknowledgements: ["skip_validation"],
	}));
	const confirmComplete = vi.fn(async () => ({ ok: true }));
	const receipt: BoundFloatingFormTaskClosureCompletionReceipt = { moveCompleted: false };
	return {
		workspaceId: "project-a",
		taskId: "a1b2c",
		expectedTaskIncarnationCreatedAtEpochMs: 100,
		completionDeploymentId: "deployment-a",
		receipt,
		postDeployVerificationDoneEntryClosure: { confirmedAcknowledgements: ["skip_validation" as const] },
		verification: { requestComplete, confirmComplete } as unknown as UsePostDeployVerificationResult,
		requestComplete,
		confirmComplete,
	};
}

it("带原因结案复用原门禁和 token，只在移列成功后确认核对", async () => {
	const input = scenario();
	await completeTaskClosureFromBoundFloatingForm(input);
	expect(move).toHaveBeenCalledWith(
		expect.objectContaining({
			workspaceId: "project-a",
			taskId: "a1b2c",
			expectedTaskIncarnationCreatedAtEpochMs: 100,
			postDeployVerificationDoneEntryClosure: input.postDeployVerificationDoneEntryClosure,
		}),
	);
	expect(input.confirmComplete).toHaveBeenCalledWith({
		deploymentId: "deployment-a",
		taskId: "a1b2c",
		token: "bound-token",
		acks: ["skip_validation"],
	});
	expect(move.mock.invocationCallOrder[0]).toBeLessThan(input.confirmComplete.mock.invocationCallOrder[0]!);
});

it("确认失败后的重试保留已执行回执，不重复移列或重新申请 token", async () => {
	const input = scenario();
	input.confirmComplete.mockRejectedValueOnce(new Error("网络暂不可达"));
	await expect(completeTaskClosureFromBoundFloatingForm(input)).rejects.toThrow("网络暂不可达");
	await completeTaskClosureFromBoundFloatingForm(input);
	expect(move).toHaveBeenCalledOnce();
	expect(input.requestComplete).toHaveBeenCalledOnce();
	expect(input.confirmComplete).toHaveBeenCalledTimes(2);
});

it("移列响应丢失后的重试复用已保存 token，不再申请核对凭据", async () => {
	const input = scenario();
	move.mockRejectedValueOnce(new Error("响应在移列完成后丢失"));
	await expect(completeTaskClosureFromBoundFloatingForm(input)).rejects.toThrow("响应在移列完成后丢失");
	expect(input.receipt.verificationConfirmation?.token).toBe("bound-token");
	expect(input.receipt.moveCompleted).toBe(false);
	await completeTaskClosureFromBoundFloatingForm({ ...input, postDeployVerificationDoneEntryClosure: undefined });
	expect(input.requestComplete).toHaveBeenCalledOnce();
	expect(move).toHaveBeenCalledTimes(2);
	expect(input.receipt.moveSubmissionAttempted).toBe(true);
	expect(move.mock.calls[1]?.[0].postDeployVerificationDoneEntryClosure).toBe(
		input.postDeployVerificationDoneEntryClosure,
	);
	expect(input.confirmComplete).toHaveBeenCalledOnce();
});

it("确认要求变强时保留未知状态并阻止移列，移列失败也不确认核对", async () => {
	const input = scenario();
	await expect(
		completeTaskClosureFromBoundFloatingForm({ ...input, postDeployVerificationDoneEntryClosure: {} }),
	).rejects.toThrow("确认要求已变化");
	expect(move).not.toHaveBeenCalled();
	move.mockResolvedValueOnce({
		taskCardActionCommandExecutionOutcome: "command_failed",
		commandFailureMessage: "原任务身份失效",
	});
	await expect(completeTaskClosureFromBoundFloatingForm(input)).rejects.toThrow("原任务身份失效");
	expect(input.confirmComplete).not.toHaveBeenCalled();
	expect(input.receipt.moveCompleted).toBe(false);
});
