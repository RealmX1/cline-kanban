import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRaisedPendingUserDecisionPanel } from "@/components/detail-panels/agent-raised-pending-user-decision-panel";
import type { RuntimeAgentRaisedPendingUserDecision } from "@/runtime/types";

// 覆盖「面板先于会话 summary 挂载」的时序：card-detail-view 在 summary 未到时把当前活体比较成 null，
// 于是先判定为「先前活体提问」、面板以展开态挂载；summary 到达后选择器其实就在当前活体终端上。

const pendingDecisionRaisedInCurrentIncarnation: RuntimeAgentRaisedPendingUserDecision = {
	decisionId: "task-1:question-1",
	taskId: "task-1",
	agentId: "claude",
	decisionKind: "ordinary_user_question",
	questionMarkdown: "选择恢复方式",
	options: [],
	allowsFreeformAnswer: true,
	orderedQuestions: [
		{
			decisionQuestionId: "question-0",
			headerMarkdown: "恢复方式",
			questionMarkdown: "恢复旧会话后怎么处理？",
			selectionMode: "single",
			options: [{ optionId: "option-a", label: "只恢复", description: "等待用户" }],
			allowsFreeformAnswer: true,
		},
	],
	askedAt: 1,
	reclaimedAt: null,
	answerDeliveryState: "not_answered",
	lastAnswerDeliveryFailureReason: null,
	originRuntimeSessionIncarnationId: "incarnation-1",
	recordedAnswerQuestionAnswers: null,
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function renderPanelWithSelectorSignals(signals: {
	isAgentStoppedOnThisQuestionSelectorInLiveTerminal: boolean;
	isQuestionRaisedByEarlierAgentSessionIncarnation: boolean;
}) {
	container ??= document.body.appendChild(document.createElement("div"));
	root ??= createRoot(container);
	act(() => {
		root?.render(
			<AgentRaisedPendingUserDecisionPanel
				decision={pendingDecisionRaisedInCurrentIncarnation}
				isSubmitting={false}
				onAnswer={vi.fn(async () => true)}
				onDismiss={vi.fn(async () => true)}
				agentResponseGenerationTurnSequence={3}
				isAgentStoppedOnThisQuestionSelectorInLiveTerminal={
					signals.isAgentStoppedOnThisQuestionSelectorInLiveTerminal
				}
				isQuestionRaisedByEarlierAgentSessionIncarnation={signals.isQuestionRaisedByEarlierAgentSessionIncarnation}
			/>,
		);
	});
	return container;
}

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = null;
	container = null;
});

describe("AgentRaisedPendingUserDecisionPanel：会话 summary 晚到时的默认展开态", () => {
	it("summary 到达后确认选择器就在当前活体终端上：收回到默认折叠并露出终端作答引导", () => {
		const host = renderPanelWithSelectorSignals({
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: false,
			isQuestionRaisedByEarlierAgentSessionIncarnation: true,
		});
		expect(host.textContent).toContain("恢复旧会话后怎么处理？");

		renderPanelWithSelectorSignals({
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: true,
			isQuestionRaisedByEarlierAgentSessionIncarnation: false,
		});
		expect(host.textContent).toContain("Agent 正在终端里等你回答一个问题");
		expect(host.textContent).toContain("可直接在终端作答，或展开在此作答");
		expect(host.textContent).not.toContain("恢复旧会话后怎么处理？");
	});

	it("用户已手动展开过：选择器随后被确认在终端上时不替人收回", async () => {
		const host = renderPanelWithSelectorSignals({
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: false,
			isQuestionRaisedByEarlierAgentSessionIncarnation: true,
		});
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="折叠问题"]')?.click();
		});
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问题"]')?.click();
		});
		expect(host.textContent).toContain("恢复旧会话后怎么处理？");

		renderPanelWithSelectorSignals({
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: true,
			isQuestionRaisedByEarlierAgentSessionIncarnation: false,
		});
		expect(host.textContent).toContain("恢复旧会话后怎么处理？");
	});
});
