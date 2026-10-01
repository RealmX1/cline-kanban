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
const answerPendingUserDecisionMutateMock = vi.hoisted(() => vi.fn());
const dismissPendingUserDecisionMutateMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			listAgentRaisedPendingUserDecisions: { query: listPendingUserDecisionsQueryMock },
			answerAgentRaisedPendingUserDecision: { mutate: answerPendingUserDecisionMutateMock },
			dismissAgentRaisedPendingUserDecision: { mutate: dismissPendingUserDecisionMutateMock },
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
	originRuntimeSessionIncarnationId: "incarnation-1",
	recordedAnswerQuestionAnswers: null,
};

function createDecisionForTask(taskId: string): RuntimeAgentRaisedPendingUserDecision {
	return {
		...decision,
		decisionId: `${taskId}:question-1`,
		taskId,
	};
}

let latestPendingUserDecisionHookResult: ReturnType<typeof useAgentRaisedPendingUserDecision> | null = null;

function PendingUserDecisionHookHarness(props: {
	workspaceId: string;
	taskId: string;
	runtimeSessionLatestHookActivity: RuntimeTaskHookActivity | null;
}) {
	const result = useAgentRaisedPendingUserDecision(props);
	latestPendingUserDecisionHookResult = result;
	return <div data-testid="pending-decision-id">{result.decision?.decisionId ?? "none"}</div>;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function renderPanel(props: {
	agentResponseGenerationTurnSequence: number;
	onAnswer?: (answers: PendingUserDecisionQuestionAnswerDraft[]) => Promise<boolean>;
	onDismiss?: () => Promise<boolean>;
	decision?: RuntimeAgentRaisedPendingUserDecision;
	isAgentStoppedOnThisQuestionSelectorInLiveTerminal?: boolean;
	isQuestionRaisedByEarlierAgentSessionIncarnation?: boolean;
}) {
	container ??= document.body.appendChild(document.createElement("div"));
	root ??= createRoot(container);
	act(() => {
		root?.render(
			<AgentRaisedPendingUserDecisionPanel
				decision={props.decision ?? decision}
				isSubmitting={false}
				onAnswer={props.onAnswer ?? vi.fn(async () => true)}
				onDismiss={props.onDismiss ?? vi.fn(async () => true)}
				agentResponseGenerationTurnSequence={props.agentResponseGenerationTurnSequence}
				isAgentStoppedOnThisQuestionSelectorInLiveTerminal={
					props.isAgentStoppedOnThisQuestionSelectorInLiveTerminal ?? false
				}
				isQuestionRaisedByEarlierAgentSessionIncarnation={
					props.isQuestionRaisedByEarlierAgentSessionIncarnation ?? false
				}
			/>,
		);
	});
	return container;
}

function findButtonByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
	return Array.from(host.querySelectorAll("button")).find((button) => button.textContent === text);
}

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = null;
	container = null;
	listPendingUserDecisionsQueryMock.mockReset();
	answerPendingUserDecisionMutateMock.mockReset();
	dismissPendingUserDecisionMutateMock.mockReset();
	latestPendingUserDecisionHookResult = null;
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

	it("题干与选项说明按 markdown 渲染：换行、列表、加粗不再被压成一行", () => {
		const markdownDecision: RuntimeAgentRaisedPendingUserDecision = {
			...decision,
			orderedQuestions: [
				{
					decisionQuestionId: "question-0",
					headerMarkdown: "修复边界",
					questionMarkdown: "RVF 的 **fix_allowlist** 划到哪一层？\n\n第二段背景说明",
					selectionMode: "single",
					options: [
						{
							optionId: "option-a",
							label: "含该 skill 测试",
							description: "主审范围不变：\n- fixer 可补回归测试\n- install.sh 只读\n⚖️ 维度立场：完整性=高",
						},
					],
					allowsFreeformAnswer: true,
				},
			],
		};
		const host = renderPanel({ agentResponseGenerationTurnSequence: 3, decision: markdownDecision });
		expect(host.querySelector("strong")?.textContent).toBe("fix_allowlist");
		expect(host.querySelectorAll("p").length).toBeGreaterThanOrEqual(2);
		const optionBulletItems = Array.from(host.querySelectorAll("li")).map((item) => item.textContent);
		expect(optionBulletItems).toEqual(["fixer 可补回归测试", "install.sh 只读\n⚖️ 维度立场：完整性=高"]);
	});

	it("选中带 preview 的选项后以等宽块原样显示 preview（保留对齐空白）", async () => {
		const previewText = "方案        深度  成本\n▸ 发起 RVF   高    中";
		const previewDecision: RuntimeAgentRaisedPendingUserDecision = {
			...decision,
			orderedQuestions: [
				{
					decisionQuestionId: "question-0",
					headerMarkdown: null,
					questionMarkdown: "要不要发起 RVF？",
					selectionMode: "single",
					options: [
						{ optionId: "option-a", label: "发起 RVF", previewText },
						{ optionId: "option-b", label: "不发起" },
					],
					allowsFreeformAnswer: true,
				},
			],
		};
		const host = renderPanel({ agentResponseGenerationTurnSequence: 3, decision: previewDecision });
		expect(host.querySelector('figure[aria-label="选项预览"] pre')).toBeNull();
		await act(async () => {
			host.querySelector<HTMLInputElement>('input[value="option-a"]')?.click();
		});
		expect(host.querySelector('figure[aria-label="选项预览"] pre')?.textContent).toBe(previewText);
	});

	it("agent 正停在终端选择器上：默认折叠并提示可在终端作答，手动展开仍可在此作答", async () => {
		const onAnswer = vi.fn(async () => true);
		const host = renderPanel({
			agentResponseGenerationTurnSequence: 3,
			onAnswer,
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: true,
		});
		expect(host.textContent).toContain("Agent 正在终端里等你回答一个问题");
		expect(host.textContent).toContain("可直接在终端作答，或展开在此作答");
		expect(host.textContent).not.toContain("恢复旧会话后怎么处理？");
		await act(async () => {
			host.querySelector<HTMLButtonElement>('button[aria-label="展开问题"]')?.click();
		});
		expect(host.textContent).toContain("恢复旧会话后怎么处理？");
		expect(host.textContent).toContain("提交后会先在终端里按 Esc 关闭提问选择器");
		await act(async () => {
			findButtonByText(host, "提交回答")?.click();
		});
		expect(onAnswer).toHaveBeenCalledTimes(1);
	});

	it("Kanban / 系统重启后会话被 resume（提问活体已不是当前活体）而问题仍未回答时自动弹出", () => {
		const host = renderPanel({
			agentResponseGenerationTurnSequence: 3,
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: true,
		});
		expect(host.textContent).not.toContain("恢复旧会话后怎么处理？");
		renderPanel({
			agentResponseGenerationTurnSequence: 3,
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: false,
			isQuestionRaisedByEarlierAgentSessionIncarnation: true,
		});
		expect(host.textContent).toContain("Agent 有一个尚未回答的问题");
		expect(host.textContent).toContain("恢复旧会话后怎么处理？");
	});

	// 实测：Claude 在终端里按 Esc 拒答不触发任何 hook。用户拒答后在同一会话里继续输入，人轴离开
	// question——这不是「回来处理问题」的时刻，绝不能弹出面板打断人。
	it("同一会话里选择器消失（终端拒答后继续工作）不弹出面板", () => {
		const host = renderPanel({
			agentResponseGenerationTurnSequence: 3,
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: true,
		});
		renderPanel({
			agentResponseGenerationTurnSequence: 4,
			isAgentStoppedOnThisQuestionSelectorInLiveTerminal: false,
			isQuestionRaisedByEarlierAgentSessionIncarnation: false,
		});
		expect(host.textContent).toContain("Agent 有一个尚未回答的问题");
		expect(host.textContent).not.toContain("恢复旧会话后怎么处理？");
	});

	it("答案已保存但未送达：只读回显答案与失败原因，重试投递沿用已记下的答案，不再提供取消", async () => {
		const onAnswer = vi.fn(async () => true);
		const recordedAnswerQuestionAnswers = [
			{ decisionQuestionId: "question-0", selectedOptionIds: ["option-b"], freeformText: "先测再修" },
			{ decisionQuestionId: "question-1", selectedOptionIds: [], freeformText: null },
		];
		const host = renderPanel({
			agentResponseGenerationTurnSequence: 3,
			onAnswer,
			decision: {
				...decision,
				answerDeliveryState: "delivery_failed",
				lastAnswerDeliveryFailureReason: "无法恢复该任务的 agent 会话运行时",
				recordedAnswerQuestionAnswers,
			},
		});
		expect(host.textContent).toContain("答案已保存，尚未送达 agent");
		expect(host.textContent).toContain("你的选择：恢复并继续");
		expect(host.textContent).toContain("补充说明：先测再修");
		expect(host.textContent).toContain("未送达原因：无法恢复该任务的 agent 会话运行时");
		expect(findButtonByText(host, "取消问题")).toBeUndefined();
		await act(async () => {
			findButtonByText(host, "重试投递")?.click();
		});
		expect(onAnswer).toHaveBeenCalledWith(recordedAnswerQuestionAnswers);
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

	it("取消失败（面板手里的记录已不是最新）后重新拉取账本，面板改为呈现最新状态而不是卡在旧记录上", async () => {
		const staleDecision = createDecisionForTask("task-1");
		const latestDecision = { ...createDecisionForTask("task-1"), decisionId: "task-1:ask-user-question:同一问题" };
		listPendingUserDecisionsQueryMock
			.mockResolvedValueOnce({ decisions: [staleDecision] })
			.mockResolvedValueOnce({ decisions: [latestDecision] });
		dismissPendingUserDecisionMutateMock.mockResolvedValueOnce({ ok: false, error: "cannot be dismissed" });
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
		expect(container.textContent).toBe("task-1:question-1");
		await act(async () => {
			await latestPendingUserDecisionHookResult?.dismiss();
		});
		expect(listPendingUserDecisionsQueryMock).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("task-1:ask-user-question:同一问题");
	});

	it("回答被拒（记录已在终端里了结）后重新拉取，已了结的问题从面板消失", async () => {
		listPendingUserDecisionsQueryMock
			.mockResolvedValueOnce({ decisions: [createDecisionForTask("task-1")] })
			.mockResolvedValueOnce({ decisions: [] });
		answerPendingUserDecisionMutateMock.mockResolvedValueOnce({ ok: false, delivered: false, error: "is answered" });
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
		let answered: boolean | undefined;
		await act(async () => {
			answered = await latestPendingUserDecisionHookResult?.answer([
				{ decisionQuestionId: "question-0", selectedOptionIds: ["option-a"], freeformText: null },
			]);
		});
		expect(answered).toBe(false);
		expect(container.textContent).toBe("none");
	});
});
