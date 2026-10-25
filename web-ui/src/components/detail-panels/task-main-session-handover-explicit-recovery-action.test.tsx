import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskMainSessionHandoverAction } from "@/components/detail-panels/task-main-session-handover-action";
import type { RuntimeTaskSessionSummary, TaskMainSessionHandoverStatusResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";

const queries = vi.hoisted(() => ({
	getTaskMainSessionHandoverStatus: vi.fn(),
	recoverTaskMainSessionHandoverWithNewCodexSession: vi.fn(),
	retryTaskMainSessionHandover: vi.fn(),
	cancelTaskMainSessionHandover: vi.fn(),
	prepareTaskMainSessionHandover: vi.fn(),
	requestTaskMainSessionHandover: vi.fn(),
}));
vi.mock("@/runtime/task-main-session-handover-query", () => queries);

const record = {
	handoverId: "11111111-1111-4111-8111-111111111111",
	sourceTaskConversationSessionId: "task-1",
	targetTaskConversationSessionId: "codex-original",
	destination: { kind: "new_codex_session" as const },
	status: "failed" as const,
	createdAt: 1,
	updatedAt: 2,
	userContextNotes: "继续原任务",
	additionalPlanReferencePaths: [],
	materialDirectoryPath: "/persistent/handover-material",
	errorMessage: "无法确认交接汇报是否已提交。",
	reportDeliveryStartedAt: 1,
	reportDeliveryAttempt: 0,
};
const taskCard: BoardCard = {
	id: "task-1",
	title: "恢复交接",
	prompt: "继续任务",
	createdAt: 1,
	updatedAt: 1,
	startInPlanMode: true,
	baseRef: "main",
	mainTaskConversationSessionId: "codex-original",
	taskMainSessionHandover: record,
};
const summary: RuntimeTaskSessionSummary = {
	taskId: "codex-original",
	agentId: "codex",
	state: "awaiting_review",
	workspacePath: "/work",
	pid: null,
	startedAt: 1,
	updatedAt: 2,
	lastOutputAt: null,
	reviewReason: "error",
	exitCode: 1,
	lastHookAt: null,
	latestHookActivity: null,
	turnOwner: "user",
	liveness: "exited",
	userTurnKind: "error",
};

describe("交接失败的显式恢复入口", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
	function setRecoverableHandoverRecord(failedRecord = record) {
		queries.getTaskMainSessionHandoverStatus.mockResolvedValue({
			record: failedRecord,
			recoveryAvailability: {
				canRetryUndeliveredReport: false,
				canRecreateCodexSession: true,
				terminalDeliveryFailureReason: "submit_confirmation_budget_exhausted",
				blockReason: null,
			},
		} satisfies TaskMainSessionHandoverStatusResponse);
	}
	beforeEach(() => {
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		vi.resetAllMocks();
		setRecoverableHandoverRecord();
		queries.recoverTaskMainSessionHandoverWithNewCodexSession.mockResolvedValue({ record: null });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});
	async function render(card = taskCard) {
		await act(async () =>
			root.render(
				<TaskMainSessionHandoverAction workspaceId="isolated" taskCard={card} mainSessionSummary={summary} />,
			),
		);
	}
	async function click(label: string) {
		const button = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
		if (!button) throw new Error(`未找到按钮：${label}`);
		await act(async () => button.click());
	}

	it("不确定回执没有普通重试，明确确认后才新建接任会话", async () => {
		await render();
		expect(container.textContent).not.toContain("重试交接");
		await click("新建 Codex 并重新交接");
		expect(document.body.textContent).toContain("可能重复汇报");
		expect(document.body.textContent).toContain("原会话、旧 Codex、交接材料和失败记录都会保留");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession).not.toHaveBeenCalled();
		await click("取消恢复");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession).not.toHaveBeenCalled();
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession).toHaveBeenCalledExactlyOnceWith("isolated", {
			taskId: "task-1",
			expectedHandoverId: record.handoverId,
			expectedReportDeliveryAttempt: 0,
			requestId: expect.any(String),
			acknowledgePossibleDuplicateReport: true,
		});
	});

	it("同一投递轮次在网络结果不明后重试，仍复用原恢复请求", async () => {
		queries.recoverTaskMainSessionHandoverWithNewCodexSession.mockRejectedValueOnce(new Error("网络连接中断"));
		await render();
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		expect(document.body.textContent).toContain("网络连接中断");
		const originalRequest = queries.recoverTaskMainSessionHandoverWithNewCodexSession.mock.calls[0]?.[1];
		await click("取消恢复");
		const updatedRecord = { ...record, updatedAt: 3 };
		setRecoverableHandoverRecord(updatedRecord);
		await render({ ...taskCard, taskMainSessionHandover: updatedRecord });
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession.mock.calls[1]?.[1]).toEqual(originalRequest);
	});

	it.each([
		{ description: "投递轮次推进", nextRecord: { ...record, reportDeliveryAttempt: 1 } },
		{ description: "交接记录更换", nextRecord: { ...record, handoverId: "22222222-2222-4222-8222-222222222222" } },
	])("同任务$description后的下一次恢复使用新请求", async ({ nextRecord }) => {
		await render();
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		const originalRequestId = queries.recoverTaskMainSessionHandoverWithNewCodexSession.mock.calls[0]?.[1].requestId;
		setRecoverableHandoverRecord(nextRecord);
		await render({ ...taskCard, taskMainSessionHandover: nextRecord });
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession.mock.calls[1]?.[1]).toMatchObject({
			taskId: taskCard.id,
			expectedHandoverId: nextRecord.handoverId,
			expectedReportDeliveryAttempt: nextRecord.reportDeliveryAttempt,
			requestId: expect.any(String),
		});
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession.mock.calls[1]?.[1].requestId).not.toBe(
			originalRequestId,
		);
	});

	it.each(["成功", "失败"])("同任务旧投递轮次的迟到%s响应不覆盖新轮次恢复状态", async (outcome) => {
		let completeOriginalRequest: ((value: TaskMainSessionHandoverStatusResponse) => void) | undefined;
		let rejectOriginalRequest: ((cause: Error) => void) | undefined;
		queries.recoverTaskMainSessionHandoverWithNewCodexSession.mockImplementationOnce(
			() =>
				new Promise<TaskMainSessionHandoverStatusResponse>((resolve, reject) => {
					completeOriginalRequest = resolve;
					rejectOriginalRequest = reject;
				}),
		);
		await render();
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		const nextRecord = { ...record, reportDeliveryAttempt: 1 };
		setRecoverableHandoverRecord(nextRecord);
		await render({ ...taskCard, taskMainSessionHandover: nextRecord });
		await act(async () => {
			if (outcome === "成功") completeOriginalRequest?.({ record: null });
			else rejectOriginalRequest?.(new Error("旧轮次恢复请求失败"));
		});
		expect(container.textContent).toContain("新建 Codex 并重新交接");
		expect(document.body.textContent).not.toContain("旧轮次恢复请求失败");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("同任务新轮次可独立恢复，旧轮次返回不会解除新请求的忙碌状态", async () => {
		let completeOriginalRequest: ((value: TaskMainSessionHandoverStatusResponse) => void) | undefined;
		let completeCurrentRequest: ((value: TaskMainSessionHandoverStatusResponse) => void) | undefined;
		queries.recoverTaskMainSessionHandoverWithNewCodexSession
			.mockImplementationOnce(
				() =>
					new Promise<TaskMainSessionHandoverStatusResponse>((resolve) => {
						completeOriginalRequest = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<TaskMainSessionHandoverStatusResponse>((resolve) => {
						completeCurrentRequest = resolve;
					}),
			);
		await render();
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		const nextRecord = { ...record, reportDeliveryAttempt: 1 };
		setRecoverableHandoverRecord(nextRecord);
		await render({ ...taskCard, taskMainSessionHandover: nextRecord });
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession).toHaveBeenCalledTimes(2);
		await act(async () => completeOriginalRequest?.({ record: null }));
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		const confirmButton = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "确认新建并重新交接",
		);
		expect(confirmButton?.disabled).toBe(true);
		await click("确认新建并重新交接");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession).toHaveBeenCalledTimes(2);
		await act(async () => completeCurrentRequest?.({ record: null }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("确定未投递时允许普通重试", async () => {
		queries.getTaskMainSessionHandoverStatus.mockResolvedValueOnce({
			record,
			recoveryAvailability: {
				canRetryUndeliveredReport: true,
				canRecreateCodexSession: true,
				terminalDeliveryFailureReason: "terminal_prompt_readiness_timeout",
				blockReason: null,
			},
		});
		await render();
		await click("重试交接");
		expect(queries.retryTaskMainSessionHandover).toHaveBeenCalledExactlyOnceWith("isolated", "task-1");
	});

	it("旧任务恢复仍在等待时，新任务可独立恢复，迟到响应不覆盖当前界面", async () => {
		let completeOriginalRequest: ((value: TaskMainSessionHandoverStatusResponse) => void) | undefined;
		queries.recoverTaskMainSessionHandoverWithNewCodexSession.mockImplementationOnce(
			() =>
				new Promise<TaskMainSessionHandoverStatusResponse>((resolve) => {
					completeOriginalRequest = resolve;
				}),
		);
		await render();
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		const nextRecord = { ...record, handoverId: "22222222-2222-4222-8222-222222222222" };
		queries.getTaskMainSessionHandoverStatus.mockResolvedValueOnce({
			record: nextRecord,
			recoveryAvailability: {
				canRetryUndeliveredReport: false,
				canRecreateCodexSession: true,
				terminalDeliveryFailureReason: "submit_confirmation_budget_exhausted",
				blockReason: null,
			},
		});
		await render({ ...taskCard, id: "task-2", taskMainSessionHandover: nextRecord });
		await click("新建 Codex 并重新交接");
		await click("确认新建并重新交接");
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession).toHaveBeenCalledTimes(2);
		expect(queries.recoverTaskMainSessionHandoverWithNewCodexSession.mock.calls.at(1)?.[1]).toMatchObject({
			taskId: "task-2",
		});
		await act(async () => completeOriginalRequest?.({ record: null }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("旧会话仍生成时显示原因，不提供重建按钮", async () => {
		queries.getTaskMainSessionHandoverStatus.mockResolvedValueOnce({
			record,
			recoveryAvailability: {
				canRetryUndeliveredReport: false,
				canRecreateCodexSession: false,
				terminalDeliveryFailureReason: null,
				blockReason: "原 Codex 会话仍在生成，请等它停下后重试。",
			},
		});
		await render();
		expect(container.textContent).toContain("原 Codex 会话仍在生成");
		expect(container.textContent).not.toContain("新建 Codex 并重新交接");
	});
});
