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

	it("卡头在提问时间旁显示了结时刻与等待时长，前缀词随结局变化", async () => {
		// 取当地正午，确保 +5 分钟不跨日（同日只显示钟点）。
		const askedAtLocalNoon = new Date(2026, 9, 2, 12, 0, 0).getTime();
		const resolvedFiveMinutesLater = askedAtLocalNoon + 5 * 60 * 1000;
		listUserDecisionHistoryQueryMock.mockResolvedValue({
			historyEntries: [
				{
					...answeredInAgentTerminalEntry,
					askedAt: askedAtLocalNoon,
					resolvedAt: resolvedFiveMinutesLater,
				},
				{
					...answeredInAgentTerminalEntry,
					historyEntryId: "ledger:task-1:toolu_superseded",
					askedAt: askedAtLocalNoon - 1,
					resolvedAt: askedAtLocalNoon + 1,
					resolution: "superseded_by_later_question_without_answer",
					questionAnswers: [],
				},
			],
		});
		const host = await renderHistoryPanel();
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问答记录"]')?.click();
		});
		expect(host.textContent).toContain(
			`作答于 ${new Date(resolvedFiveMinutesLater).toLocaleTimeString()}（等了 5m）`,
		);
		expect(host.textContent).toContain("被取代于");
		expect(host.textContent).toContain("（等了 <1m）");
	});

	it("跨日了结时显示完整日期时间", async () => {
		const askedAtLocalNoon = new Date(2026, 9, 2, 12, 0, 0).getTime();
		const resolvedNextDay = new Date(2026, 9, 3, 9, 0, 0).getTime();
		listUserDecisionHistoryQueryMock.mockResolvedValue({
			historyEntries: [{ ...answeredInAgentTerminalEntry, askedAt: askedAtLocalNoon, resolvedAt: resolvedNextDay }],
		});
		const host = await renderHistoryPanel();
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问答记录"]')?.click();
		});
		expect(host.textContent).toContain(`作答于 ${new Date(resolvedNextDay).toLocaleString()}（等了 21h）`);
	});

	it("没有了结时刻（转录截断）时不显示作答时间与等待时长，也不回退到其它字段", async () => {
		listUserDecisionHistoryQueryMock.mockResolvedValue({
			historyEntries: [{ ...answeredInAgentTerminalEntry, resolvedAt: null }],
		});
		const host = await renderHistoryPanel();
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问答记录"]')?.click();
		});
		expect(host.textContent).toContain("提问于");
		expect(host.textContent).not.toContain("作答于");
		expect(host.textContent).not.toContain("等了");
	});
});
