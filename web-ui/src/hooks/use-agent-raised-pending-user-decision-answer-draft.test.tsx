import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	discardBrowserAnswerDraftsForTaskExceptPendingDecision,
	useAgentRaisedPendingUserDecisionAnswerDraft,
} from "@/hooks/use-agent-raised-pending-user-decision-answer-draft";
import type {
	RuntimeAgentRaisedPendingUserDecision,
	RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequest,
	RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse,
} from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const saveDraftMock = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/agent-raised-pending-user-decision-answer-draft-query", () => ({
	saveAgentRaisedPendingUserDecisionAnswerDraftToRuntime: saveDraftMock,
}));

const pendingDecision: RuntimeAgentRaisedPendingUserDecision = {
	decisionId: "decision-a",
	taskId: "task-a",
	agentId: "claude",
	decisionKind: "ordinary_user_question",
	questionMarkdown: "选择方案",
	options: [],
	allowsFreeformAnswer: true,
	askedAt: 1,
	reclaimedAt: null,
	answerDeliveryState: "not_answered",
	lastAnswerDeliveryFailureReason: null,
	originRuntimeSessionIncarnationId: null,
	recordedAnswerQuestionAnswers: null,
	orderedQuestions: [
		{
			decisionQuestionId: "question-a",
			questionMarkdown: "选哪种？",
			headerMarkdown: null,
			selectionMode: "single",
			options: [{ optionId: "option-a", label: "方案 A" }],
			allowsFreeformAnswer: true,
		},
		{
			decisionQuestionId: "question-b",
			questionMarkdown: "再选？",
			headerMarkdown: null,
			selectionMode: "multiple",
			options: [{ optionId: "option-b", label: "方案 B" }],
			allowsFreeformAnswer: true,
		},
	],
};
let hookResult: ReturnType<typeof useAgentRaisedPendingUserDecisionAnswerDraft>;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function DraftHarness({
	workspaceId,
	decision,
	onDecisionNoLongerPending,
}: {
	workspaceId: string;
	decision: RuntimeAgentRaisedPendingUserDecision;
	onDecisionNoLongerPending?: () => void;
}) {
	hookResult = useAgentRaisedPendingUserDecisionAnswerDraft({ workspaceId, decision, onDecisionNoLongerPending });
	return <div>{hookResult.draftSaveStatusText}</div>;
}

async function renderDraft(
	workspaceId = "workspace-a",
	decision = pendingDecision,
	onDecisionNoLongerPending?: () => void,
) {
	container ??= document.body.appendChild(document.createElement("div"));
	root ??= createRoot(container);
	await act(async () =>
		root?.render(
			<DraftHarness
				key={JSON.stringify([workspaceId, decision.taskId, decision.decisionId])}
				workspaceId={workspaceId}
				decision={decision}
				onDecisionNoLongerPending={onDecisionNoLongerPending}
			/>,
		),
	);
}

async function advanceSaveTimer() {
	await act(async () => vi.advanceTimersByTimeAsync(400));
}

function successfulSaveResponse(): RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse {
	return { ok: true, pendingAnswerDraft: null, decisionIsNoLongerPending: false };
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	saveDraftMock.mockReset().mockResolvedValue(successfulSaveResponse());
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	vi.useRealTimers();
	vi.restoreAllMocks();
	localStorage.clear();
});

describe("问答面板未提交草稿的持久化", () => {
	it("恢复服务端草稿而不回写初值；选项和 Notes 原样保存，包括主动清空", async () => {
		const serverDecision = {
			...pendingDecision,
			pendingAnswerDraft: {
				savedAt: 1,
				orderedQuestionAnswers: [
					{ decisionQuestionId: "question-a", selectedOptionIds: ["option-a"], freeformText: "  Notes\n原样  " },
				],
			},
		};
		await renderDraft("workspace-a", serverDecision);
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("  Notes\n原样  ");
		await advanceSaveTimer();
		expect(saveDraftMock).not.toHaveBeenCalled();
		act(() =>
			hookResult.updateQuestionAnswerDraft("question-b", {
				selectedOptionIds: ["option-b"],
				freeformText: "第二问",
			}),
		);
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { selectedOptionIds: [], freeformText: "" }));
		await advanceSaveTimer();
		expect(saveDraftMock).toHaveBeenCalledWith(
			"workspace-a",
			expect.objectContaining({
				orderedQuestionAnswers: [
					{ decisionQuestionId: "question-a", selectedOptionIds: [], freeformText: "" },
					{ decisionQuestionId: "question-b", selectedOptionIds: ["option-b"], freeformText: "第二问" },
				],
			}),
		);
		expect(hookResult.draftSaveStatusText).toBe("已保存");
	});

	it("断线时立刻保留浏览器备份，重挂载恢复并在连接恢复后上传", async () => {
		saveDraftMock.mockRejectedValue(new Error("offline"));
		await renderDraft();
		act(() =>
			hookResult.updateQuestionAnswerDraft("question-a", {
				selectedOptionIds: ["option-a"],
				freeformText: "  Notes\n未提交  ",
			}),
		);
		expect(localStorage.getItem(LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts)).toContain("未提交");
		await advanceSaveTimer();
		expect(hookResult.draftSaveStatusText).toBe("保存失败，已保留本地草稿");
		await act(async () => root?.unmount());
		root = null;
		await renderDraft();
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("  Notes\n未提交  ");
		saveDraftMock.mockResolvedValue(successfulSaveResponse());
		await act(async () => window.dispatchEvent(new Event("online")));
		expect(hookResult.draftSaveStatusText).toBe("已保存");
	});

	it("旧保存回执和查询刷新不能覆盖新编辑，新版本按顺序抵达服务端", async () => {
		let completeFirstSave: (response: RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse) => void =
			() => {};
		saveDraftMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					completeFirstSave = resolve;
				}),
		);
		await renderDraft();
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "旧草稿" }));
		await advanceSaveTimer();
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "新草稿" }));
		await advanceSaveTimer();
		expect(saveDraftMock).toHaveBeenCalledTimes(1);
		await renderDraft("workspace-a", {
			...pendingDecision,
			pendingAnswerDraft: {
				savedAt: 2,
				orderedQuestionAnswers: [
					{ decisionQuestionId: "question-a", selectedOptionIds: [], freeformText: "迟到的查询" },
				],
			},
		});
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("新草稿");
		await act(async () => completeFirstSave(successfulSaveResponse()));
		expect(saveDraftMock).toHaveBeenCalledTimes(2);
		expect(saveDraftMock.mock.calls[1]?.[1].orderedQuestionAnswers[0]?.freeformText).toBe("新草稿");
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("新草稿");
	});

	it("新编辑的本地写入失败时，旧回执不清理备份，重挂载不会回传旧草稿", async () => {
		let completeFirstSave: (response: RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse) => void =
			() => {};
		let completeSecondSave: (response: RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse) => void =
			() => {};
		saveDraftMock
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						completeFirstSave = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						completeSecondSave = resolve;
					}),
			);
		await renderDraft();
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "旧草稿" }));
		await advanceSaveTimer();
		const originalSetItem = Storage.prototype.setItem;
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
			if (value.includes("新草稿")) throw new Error("quota exceeded");
			originalSetItem.call(this, key, value);
		});
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "新草稿" }));
		await advanceSaveTimer();
		await act(async () => completeFirstSave(successfulSaveResponse()));
		expect(localStorage.getItem(LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts)).toContain("旧草稿");
		expect(hookResult.draftSaveStatusText).toBe("保存中");
		await act(async () => root?.unmount());
		root = null;
		await renderDraft("workspace-a", {
			...pendingDecision,
			pendingAnswerDraft: { savedAt: 1, ...saveDraftMock.mock.calls[0]?.[1] },
		});
		// 本地写入失败且新请求尚未确认时只能恢复服务端旧值，不能把它当新编辑再上传。
		expect(hookResult.draftSaveStatusText).toBe("已保存");
		await advanceSaveTimer();
		expect(saveDraftMock).toHaveBeenCalledTimes(2);
		await act(async () => completeSecondSave(successfulSaveResponse()));
		await renderDraft("workspace-a", {
			...pendingDecision,
			pendingAnswerDraft: { savedAt: 2, ...saveDraftMock.mock.calls[1]?.[1] },
		});
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("新草稿");
		expect(hookResult.draftSaveStatusText).toBe("已保存");
	});

	it("本地写入和备份清理都失败时，已确认的新服务端草稿不会被旧备份回滚", async () => {
		localStorage.setItem(
			LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts,
			JSON.stringify({
				[JSON.stringify(["workspace-a", pendingDecision.taskId, pendingDecision.decisionId])]: [
					{ decisionQuestionId: "question-a", selectedOptionIds: [], freeformText: "旧草稿" },
				],
			}),
		);
		await renderDraft();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("storage unavailable");
		});
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "已确认的新草稿" }));
		await advanceSaveTimer();
		expect(hookResult.draftSaveStatusText).toBe("已保存");
		expect(localStorage.getItem(LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts)).toContain("旧草稿");
		await act(async () => root?.unmount());
		root = null;
		await renderDraft("workspace-a", {
			...pendingDecision,
			pendingAnswerDraft: { savedAt: 2, ...saveDraftMock.mock.calls[0]?.[1] },
		});
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("已确认的新草稿");
		await advanceSaveTimer();
		expect(saveDraftMock).toHaveBeenCalledTimes(1);
	});

	it("本地时钟落后时从服务端版本继续编辑，回执保留更晚内容时只回显实际已保存草稿", async () => {
		const serverAnswerDraftEditVersion = Date.now() + 86_400_000;
		await renderDraft("workspace-a", {
			...pendingDecision,
			pendingAnswerDraft: {
				savedAt: 1,
				answerDraftEditVersion: serverAnswerDraftEditVersion,
				orderedQuestionAnswers: [
					{ decisionQuestionId: "question-a", selectedOptionIds: [], freeformText: "服务端初值" },
				],
			},
		});
		saveDraftMock.mockImplementation(
			async (_workspaceId: string, input: RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftRequest) => ({
				ok: true,
				decisionIsNoLongerPending: false,
				pendingAnswerDraft: {
					savedAt: 2,
					answerDraftEditVersion: (input.answerDraftEditVersion ?? 0) + 1,
					orderedQuestionAnswers: [
						{ decisionQuestionId: "question-a", selectedOptionIds: [], freeformText: "实际已确认的更晚草稿" },
					],
				},
			}),
		);
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "未获确认的本次请求" }));
		await advanceSaveTimer();
		expect(saveDraftMock.mock.calls[0]?.[1].answerDraftEditVersion).toBeGreaterThan(serverAnswerDraftEditVersion);
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("实际已确认的更晚草稿");
		expect(hookResult.draftSaveStatusText).toBe("已保存");
	});

	it("同号任务跨项目与新问题隔离，清理了结问题只触及本项目", async () => {
		saveDraftMock.mockRejectedValue(new Error("offline"));
		await renderDraft();
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "项目 A" }));
		await renderDraft("workspace-b");
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("");
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "项目 B" }));
		await renderDraft("workspace-a", { ...pendingDecision, decisionId: "new-decision" });
		expect(hookResult.questionAnswerDrafts[0]?.freeformText).toBe("");
		discardBrowserAnswerDraftsForTaskExceptPendingDecision("workspace-a", "task-a", "new-decision");
		expect(localStorage.getItem(LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts)).not.toContain("项目 A");
		expect(localStorage.getItem(LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts)).toContain("项目 B");
	});

	it("问题了结后迟到的保存回执不能留下幽灵草稿", async () => {
		let completePendingSave: (response: RuntimeSaveAgentRaisedPendingUserDecisionAnswerDraftResponse) => void =
			() => {};
		saveDraftMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					completePendingSave = resolve;
				}),
		);
		await renderDraft();
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "要保留" }));
		await advanceSaveTimer();
		act(() => hookResult.discardAnswerDraft());
		await act(async () => completePendingSave(successfulSaveResponse()));
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "问题已了结" }));
		await advanceSaveTimer();
		expect(saveDraftMock).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts)).not.toContain("要保留");
	});

	it("服务端告知问题已了结时清除备份并刷新，不能继续重试保存", async () => {
		const refreshClosedDecision = vi.fn();
		saveDraftMock.mockResolvedValue({ ok: false, pendingAnswerDraft: null, decisionIsNoLongerPending: true });
		await renderDraft("workspace-a", pendingDecision, refreshClosedDecision);
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "已过期的编辑" }));
		await advanceSaveTimer();
		expect(refreshClosedDecision).toHaveBeenCalledTimes(1);
		expect(localStorage.getItem(LocalStorageKey.AgentRaisedPendingUserDecisionAnswerDrafts)).not.toContain(
			"已过期的编辑",
		);
		await act(async () => window.dispatchEvent(new Event("online")));
		expect(saveDraftMock).toHaveBeenCalledTimes(1);
	});

	it("服务端和本地备份都失败时明确告知，不能显示已保存", async () => {
		await renderDraft();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});
		saveDraftMock.mockRejectedValue(new Error("offline"));
		act(() => hookResult.updateQuestionAnswerDraft("question-a", { freeformText: "尚未保存" }));
		await advanceSaveTimer();
		expect(hookResult.draftSaveStatusText).toBe("保存失败，本地备份也未成功");
	});
});
