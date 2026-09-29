import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRaisedUserDecisionHistoryPanel } from "@/components/detail-panels/agent-raised-user-decision-history-panel";
import type { RuntimeAgentRaisedUserDecisionHistoryEntry } from "@/runtime/types";

const listUserDecisionHistoryQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			listAgentRaisedUserDecisionHistoryForTask: { query: listUserDecisionHistoryQueryMock },
		},
	}),
}));

const answeredInAgentTerminalEntry: RuntimeAgentRaisedUserDecisionHistoryEntry = {
	historyEntryId: "ledger:task-1:toolu_1",
	taskId: "task-1",
	recordSource: "kanban_decision_ledger",
	decisionKind: "ordinary_user_question",
	askedAt: 1_000,
	resolvedAt: 2_000,
	resolution: "answered_in_agent_terminal",
	orderedQuestions: [
		{
			decisionQuestionId: "question-0",
			headerMarkdown: "交付终态",
			questionMarkdown: "这个任务交付到哪一步？",
			selectionMode: "single",
			options: [{ optionId: "question-0-option-0", label: "实测 + 修确凿缺陷" }],
			allowsFreeformAnswer: true,
		},
	],
	questionAnswers: [
		{
			decisionQuestionId: "question-0",
			selectedOptionLabels: ["实测 + 修确凿缺陷"],
			freeformAnswerText: null,
			notesText: "先测，**不进行修复**",
		},
	],
	answerDeliveryState: null,
};

const answeredInKanbanPanelButUndeliveredEntry: RuntimeAgentRaisedUserDecisionHistoryEntry = {
	...answeredInAgentTerminalEntry,
	historyEntryId: "ledger:task-1:toolu_2",
	askedAt: 500,
	resolution: "answered_in_kanban_panel",
	questionAnswers: [
		{
			decisionQuestionId: "question-0",
			selectedOptionLabels: [],
			freeformAnswerText: "我手写的回答",
			notesText: null,
		},
	],
	answerDeliveryState: "delivery_failed",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = null;
	container = null;
	listUserDecisionHistoryQueryMock.mockReset();
});

async function renderHistoryPanel() {
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<AgentRaisedUserDecisionHistoryPanel
				workspaceId="workspace-1"
				taskId="task-1"
				pendingUserDecisionIdentityForRefresh={null}
			/>,
		);
	});
	return container;
}

describe("AgentRaisedUserDecisionHistoryPanel", () => {
	it("折叠时不读取（服务端会扫描转录），展开后才拉取", async () => {
		listUserDecisionHistoryQueryMock.mockResolvedValue({ historyEntries: [] });
		const host = await renderHistoryPanel();
		expect(listUserDecisionHistoryQueryMock).not.toHaveBeenCalled();
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问答记录"]')?.click();
		});
		expect(listUserDecisionHistoryQueryMock).toHaveBeenCalledWith({ taskId: "task-1" });
		expect(host.textContent).toContain("这个任务里还没有已了结的 agent 提问");
	});

	it("结构化呈现每条问答：在哪答的、选了什么、手写回答、终端备注（markdown）与送达状态", async () => {
		listUserDecisionHistoryQueryMock.mockResolvedValue({
			historyEntries: [answeredInAgentTerminalEntry, answeredInKanbanPanelButUndeliveredEntry],
		});
		const host = await renderHistoryPanel();
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问答记录"]')?.click();
		});
		expect(host.textContent).toContain("问答记录（2）");
		expect(host.textContent).toContain("在终端作答");
		expect(host.textContent).toContain("这个任务交付到哪一步？");
		expect(host.textContent).toContain("选择实测 + 修确凿缺陷");
		expect(host.textContent).toContain("备注");
		expect(host.querySelector("strong")?.textContent).toBe("不进行修复");
		expect(host.textContent).toContain("在面板作答");
		expect(host.textContent).toContain("回答我手写的回答");
		expect(host.textContent).toContain("未送达 agent");
	});

	it("切换 agent 通道时被自动取消的问题不冒充成「在面板取消」", async () => {
		listUserDecisionHistoryQueryMock.mockResolvedValue({
			historyEntries: [
				{
					...answeredInAgentTerminalEntry,
					historyEntryId: "ledger:task-1:toolu_transport_switch",
					resolution: "cancelled_by_agent_session_transport_switch",
					questionAnswers: [],
				},
			],
		});
		const host = await renderHistoryPanel();
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问答记录"]')?.click();
		});
		expect(host.textContent).toContain("切换 agent 通道时自动取消");
		expect(host.textContent).not.toContain("在面板取消");
	});
});
