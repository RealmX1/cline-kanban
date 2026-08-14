import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRaisedPendingUserDecisionPanel } from "@/components/detail-panels/agent-raised-pending-user-decision-panel";
import {
	type PendingUserDecisionQuestionAnswerDraft,
	useAgentRaisedPendingUserDecision,
} from "@/hooks/use-agent-raised-pending-user-decision";
import type { RuntimeAgentRaisedPendingUserDecision, RuntimeTaskHookActivity } from "@/runtime/types";

const listPendingUserDecisionsQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			listAgentRaisedPendingUserDecisions: { query: listPendingUserDecisionsQueryMock },
			answerAgentRaisedPendingUserDecision: { mutate: vi.fn() },
			dismissAgentRaisedPendingUserDecision: { mutate: vi.fn() },
		},
	}),
}));

const decision: RuntimeAgentRaisedPendingUserDecision = {
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
			options: [
				{ optionId: "option-a", label: "只恢复", description: "等待用户" },
				{ optionId: "option-b", label: "恢复并继续", description: "开始生成" },
			],
			allowsFreeformAnswer: true,
		},
		{
			decisionQuestionId: "question-1",
			headerMarkdown: "通知",
			questionMarkdown: "是否保留后台通知？",
			selectionMode: "multiple",
			options: [{ optionId: "option-c", label: "保留" }],
			allowsFreeformAnswer: false,
		},
	],
	askedAt: 1,
	reclaimedAt: null,
	answerDeliveryState: "not_answered",
	lastAnswerDeliveryFailureReason: null,
};

function createDecisionForTask(taskId: string): RuntimeAgentRaisedPendingUserDecision {
	return {
		...decision,
		decisionId: `${taskId}:question-1`,
		taskId,
	};
}

function PendingUserDecisionHookHarness(props: {
	workspaceId: string;
	taskId: string;
	runtimeSessionLatestHookActivity: RuntimeTaskHookActivity | null;
}) {
	const result = useAgentRaisedPendingUserDecision(props);
	return <div data-testid="pending-decision-id">{result.decision?.decisionId ?? "none"}</div>;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function renderPanel(props: {
	agentResponseGenerationTurnSequence: number;
	onAnswer?: (answers: PendingUserDecisionQuestionAnswerDraft[]) => Promise<boolean>;
	onDismiss?: () => Promise<boolean>;
}) {
	container ??= document.body.appendChild(document.createElement("div"));
	root ??= createRoot(container);
	act(() => {
		root?.render(
			<AgentRaisedPendingUserDecisionPanel
				decision={decision}
				isSubmitting={false}
				onAnswer={props.onAnswer ?? vi.fn(async () => true)}
				onDismiss={props.onDismiss ?? vi.fn(async () => true)}
				agentResponseGenerationTurnSequence={props.agentResponseGenerationTurnSequence}
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
	listPendingUserDecisionsQueryMock.mockReset();
});

describe("AgentRaisedPendingUserDecisionPanel", () => {
	it("完整渲染多问与所有选项", () => {
		const host = renderPanel({ agentResponseGenerationTurnSequence: 3 });
		expect(host.textContent).toContain("恢复旧会话后怎么处理？");
		expect(host.textContent).toContain("只恢复");
		expect(host.textContent).toContain("恢复并继续");
		expect(host.textContent).toContain("是否保留后台通知？");
		expect(host.textContent).toContain("保留");
	});

	it("提交结构化答案时保留每道问题的归属", async () => {
		const onAnswer = vi.fn(async () => true);
		const host = renderPanel({ agentResponseGenerationTurnSequence: 3, onAnswer });
		const radio = host.querySelector<HTMLInputElement>('input[value="option-b"]');
		const checkbox = host.querySelector<HTMLButtonElement>('[role="checkbox"]');
		await act(async () => {
			radio?.click();
			checkbox?.click();
		});
		const submit = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "提交回答");
		await act(async () => {
			submit?.click();
		});
		expect(onAnswer).toHaveBeenCalledWith([
			expect.objectContaining({ decisionQuestionId: "question-0", selectedOptionIds: ["option-b"] }),
			expect.objectContaining({ decisionQuestionId: "question-1", selectedOptionIds: ["option-c"] }),
		]);
	});

	it("直接终端 prompt 推进 turnSequence 后自动折叠但不取消问题", () => {
		const host = renderPanel({ agentResponseGenerationTurnSequence: 3 });
		expect(host.textContent).toContain("恢复旧会话后怎么处理？");
		renderPanel({ agentResponseGenerationTurnSequence: 4 });
		expect(host.textContent).toContain("Agent 有一个尚未回答的问题");
		expect(host.textContent).not.toContain("恢复旧会话后怎么处理？");
	});

	it("显式取消调用 durable dismiss，不触发回答或 agent 生成", async () => {
		const onAnswer = vi.fn(async () => true);
		const onDismiss = vi.fn(async () => true);
		const host = renderPanel({ agentResponseGenerationTurnSequence: 3, onAnswer, onDismiss });
		const dismiss = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "取消问题");
		await act(async () => {
			dismiss?.click();
		});
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(onAnswer).not.toHaveBeenCalled();
	});
});

describe("useAgentRaisedPendingUserDecision 实时会话绑定", () => {
	it("当前会话收到 AskUserQuestion hook activity 后立即重查 durable decision", async () => {
		listPendingUserDecisionsQueryMock
			.mockResolvedValueOnce({ decisions: [] })
			.mockResolvedValueOnce({ decisions: [createDecisionForTask("task-1")] });
		container = document.body.appendChild(document.createElement("div"));
		root = createRoot(container);

		await act(async () => {
			root?.render(
				<PendingUserDecisionHookHarness
					workspaceId="workspace-1"
					taskId="task-1"
					runtimeSessionLatestHookActivity={null}
				/>,
			);
		});
		expect(container.textContent).toBe("none");

		await act(async () => {
			root?.render(
				<PendingUserDecisionHookHarness
					workspaceId="workspace-1"
					taskId="task-1"
					runtimeSessionLatestHookActivity={{
						activityText: "Waiting for your answer",
						toolName: "AskUserQuestion",
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "PreToolUse",
						notificationType: null,
						source: "claude",
					}}
				/>,
			);
		});

		expect(listPendingUserDecisionsQueryMock).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("task-1:question-1");
	});

	it("切到 By-the-way 子会话后只接纳子 taskId 的响应，迟到的主会话响应不能串台", async () => {
		let resolveMainQuery: ((value: { decisions: RuntimeAgentRaisedPendingUserDecision[] }) => void) | null = null;
		listPendingUserDecisionsQueryMock.mockImplementation(({ taskId }: { taskId: string }) => {
			if (taskId === "task-1") {
				return new Promise<{ decisions: RuntimeAgentRaisedPendingUserDecision[] }>((resolve) => {
					resolveMainQuery = resolve;
				});
			}
			return Promise.resolve({ decisions: [createDecisionForTask(taskId)] });
		});
		container = document.body.appendChild(document.createElement("div"));
		root = createRoot(container);

		await act(async () => {
			root?.render(
				<PendingUserDecisionHookHarness
					workspaceId="workspace-1"
					taskId="task-1"
					runtimeSessionLatestHookActivity={null}
				/>,
			);
		});
		await act(async () => {
			root?.render(
				<PendingUserDecisionHookHarness
					workspaceId="workspace-1"
					taskId="task-conversation-session-child"
					runtimeSessionLatestHookActivity={null}
				/>,
			);
		});
		expect(container.textContent).toBe("task-conversation-session-child:question-1");

		await act(async () => {
			resolveMainQuery?.({ decisions: [createDecisionForTask("task-1")] });
		});
		expect(container.textContent).toBe("task-conversation-session-child:question-1");
	});
});
