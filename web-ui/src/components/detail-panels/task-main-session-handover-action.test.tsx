import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary, TaskMainSessionHandoverPrepareResponse } from "@/runtime/types";
import type { BoardCard } from "@/types";
import { TaskMainSessionHandoverAction } from "./task-main-session-handover-action";

const requests = vi.hoisted(() => ({ prepare: vi.fn(), request: vi.fn(), cancel: vi.fn(), retry: vi.fn() }));
vi.mock("@/runtime/task-main-session-handover-query", () => ({
	prepareTaskMainSessionHandover: requests.prepare,
	requestTaskMainSessionHandover: requests.request,
	cancelTaskMainSessionHandover: requests.cancel,
	retryTaskMainSessionHandover: requests.retry,
}));
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const card: BoardCard = {
	id: "task-1",
	title: "交接",
	prompt: "核对实现",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
};
const source: RuntimeTaskSessionSummary = {
	taskId: "task-1",
	state: "awaiting_review",
	agentId: "claude",
	workspacePath: "/project",
	pid: null,
	startedAt: 1,
	updatedAt: 1,
	lastOutputAt: null,
	reviewReason: "hook",
	exitCode: null,
	lastHookAt: null,
	latestHookActivity: null,
	turnOwner: "user",
	liveness: "live",
	userTurnKind: "review",
};
const preview: TaskMainSessionHandoverPrepareResponse = {
	mainTaskConversationSessionId: "task-1",
	codexPeerTaskConversationSessionIds: ["codex-peer"],
	busyTaskConversationSessionIds: [],
	material: {
		taskTitle: "交接",
		taskPrompt: "核对实现",
		sourceTaskConversationSessionId: "task-1",
		sourceAgentId: "claude",
		sourceNativeConversationSessionId: null,
		workspacePath: "/project",
		currentWorkPhaseGoal: null,
		planReferences: [],
		transcriptReferences: [],
		lastAgentMessage: null,
		workspaceGitStatus: null,
		workspaceHeadCommit: null,
		missingMaterialDescriptions: ["缺少精确 transcript"],
		userContextNotes: "",
	},
};

describe("主会话交接入口", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	beforeEach(async () => {
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		requests.prepare.mockReset().mockResolvedValue(preview);
		requests.request.mockReset().mockResolvedValue({ record: null });
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () =>
			root.render(
				<TaskMainSessionHandoverAction workspaceId="workspace" taskCard={card} mainSessionSummary={source} />,
			),
		);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});
	const button = (text: string) =>
		Array.from(document.querySelectorAll("button")).find(
			(element) => element.textContent === text,
		) as HTMLButtonElement;
	async function click(text: string) {
		await act(async () => button(text).click());
	}

	it("任意受支持来源可以选择新目标 Agent，并使用通用请求", async () => {
		requests.prepare.mockResolvedValueOnce({
			...preview,
			targetAgentCapabilities: [
				{
					agentId: "codex",
					label: "OpenAI Codex",
					installationStatus: "installed",
					completeNativeConversationForkAvailability: {
						available: false,
						unavailableReason: "跨 Agent 请使用交接材料",
					},
				},
				{
					agentId: "claude",
					label: "Claude Code",
					installationStatus: "installed",
					completeNativeConversationForkAvailability: {
						available: false,
						unavailableReason: "跨 Agent 请使用交接材料",
					},
				},
			],
		});
		await act(async () =>
			root.render(
				<TaskMainSessionHandoverAction
					workspaceId="workspace"
					taskCard={card}
					mainSessionSummary={{ ...source, agentId: "kimi" }}
				/>,
			),
		);
		await click("交接主会话");
		const select = document.querySelector('select[aria-label="目标 Agent"]') as HTMLSelectElement;
		await act(async () => {
			select.value = "claude";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await click("确认交接");
		expect(requests.request.mock.calls[0]?.[1].destination).toEqual({ kind: "new_agent_session", agentId: "claude" });
	});

	it.each(["claude", "omp"] as const)("%s 缺少转录路径时禁用复刻并保留全新上下文", async (agentId) => {
		const unavailableReason = "等待可靠的原生转录路径；全新上下文仍可使用。";
		requests.prepare.mockResolvedValueOnce({
			...preview,
			targetAgentCapabilities: [
				{
					agentId,
					label: agentId,
					installationStatus: "installed",
					completeNativeConversationForkAvailability: { available: false, unavailableReason },
				},
			],
		});
		await click("交接主会话");
		const targetAgent = document.querySelector('select[aria-label="目标 Agent"]') as HTMLSelectElement;
		await act(async () => {
			targetAgent.value = agentId;
			targetAgent.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const contextMode = document.querySelector('select[aria-label="上下文方式"]') as HTMLSelectElement;
		expect(contextMode.value).toBe("fresh_context_with_handover_material");
		expect(
			contextMode.querySelector<HTMLOptionElement>('option[value="fork_complete_native_conversation"]')?.disabled,
		).toBe(true);
		expect(document.body.textContent).toContain(unavailableReason);
		expect(button("确认交接").disabled).toBe(false);
		await click("确认交接");
		expect(requests.request.mock.calls[0]?.[1].destination).toEqual({ kind: "new_agent_session", agentId });
	});

	it("默认新建，材料缺失可见，失败保留补充内容且沿用幂等请求 ID", async () => {
		await click("交接主会话");
		expect((document.querySelector('select[aria-label="接收会话"]') as HTMLSelectElement).value).toBe(
			"new_codex_session",
		);
		expect(document.body.textContent).toContain("缺少精确 transcript");
		const notes = document.querySelector('textarea[aria-label="补充交接说明"]') as HTMLTextAreaElement;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(notes, "补充事实");
			notes.dispatchEvent(new Event("input", { bubbles: true }));
		});
		requests.request.mockRejectedValueOnce(new Error("模拟网络错误"));
		await click("确认交接");
		expect(notes.value).toBe("补充事实");
		expect(document.body.textContent).toContain("模拟网络错误");
		await click("确认交接");
		expect(requests.request.mock.calls[0]?.[1]).toMatchObject({
			destination: { kind: "new_codex_session" },
			userContextNotes: "补充事实",
		});
		expect(requests.request.mock.calls[1]?.[1].requestId).toBe(requests.request.mock.calls[0]?.[1].requestId);
	});

	it("生成中先给两种选择，暂不交接不发请求，确认等待才持久排定", async () => {
		requests.prepare.mockResolvedValueOnce({ ...preview, busyTaskConversationSessionIds: ["task-1"] });
		await click("交接主会话");
		await click("确认交接");
		expect(button("暂不交接")).toBeTruthy();
		expect(button("等待两者都停下后自动交接")).toBeTruthy();
		expect(requests.request).not.toHaveBeenCalled();
		await click("暂不交接");
		requests.prepare.mockResolvedValueOnce({ ...preview, busyTaskConversationSessionIds: ["task-1"] });
		await click("交接主会话");
		await click("确认交接");
		await click("等待两者都停下后自动交接");
		expect(requests.request).toHaveBeenCalledTimes(1);
	});

	it.each(["claude", "codex", "cursor", "kimi", "omp"] as const)(
		"选择既有 %s 使用真实 Agent 与精确 ID，隐藏新建设置",
		async (agentId) => {
			requests.prepare.mockResolvedValueOnce({
				...preview,
				existingPeerCandidates: [
					{
						agentId,
						taskConversationSessionId: "selected-peer",
						displayName: "我的工作线",
						available: true,
						unavailableReason: null,
					},
					{
						agentId,
						taskConversationSessionId: "missing-identity",
						displayName: "待确认工作线",
						available: false,
						unavailableReason: "等待可靠的原生会话身份。",
					},
				],
			});
			await click("交接主会话");
			const select = document.querySelector('select[aria-label="接收会话"]') as HTMLSelectElement;
			expect(Array.from(select.options).find((option) => option.value === "missing-identity")?.disabled).toBe(true);
			expect(select.textContent).toContain("等待可靠的原生会话身份");
			await act(async () => {
				select.value = "selected-peer";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
			expect(document.querySelector('select[aria-label="目标 Agent"]')).toBeNull();
			expect(document.querySelector('select[aria-label="上下文方式"]')).toBeNull();
			expect(document.body.textContent).toContain("保留所选会话的历史、模型、权限与通道");
			await click("确认交接");
			expect(requests.request.mock.calls[0]?.[1].destination).toEqual({
				kind: "existing_agent_session",
				agentId,
				taskConversationSessionId: "selected-peer",
			});
		},
	);

	it("选择已有 peer 时投递精确 session ID", async () => {
		await click("交接主会话");
		const select = document.querySelector('select[aria-label="接收会话"]') as HTMLSelectElement;
		await act(async () => {
			select.value = "codex-peer";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await click("确认交接");
		expect(requests.request.mock.calls[0]?.[1].destination).toEqual({
			kind: "existing_codex_session",
			taskConversationSessionId: "codex-peer",
		});
	});

	it("Codex 主会话可选择完整原生复刻，默认仍为全新上下文", async () => {
		requests.prepare.mockResolvedValueOnce({
			...preview,
			completeNativeConversationForkAvailability: { available: true, unavailableReason: null },
		});
		await act(async () =>
			root.render(
				<TaskMainSessionHandoverAction
					workspaceId="workspace"
					taskCard={card}
					mainSessionSummary={{ ...source, agentId: "codex" }}
				/>,
			),
		);
		await click("交接主会话");
		const select = document.querySelector('select[aria-label="上下文方式"]') as HTMLSelectElement;
		expect(select.value).toBe("fresh_context_with_handover_material");
		await act(async () => {
			select.value = "fork_complete_native_conversation";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await click("确认交接");
		expect(requests.request.mock.calls[0]?.[1].destination).toEqual({
			kind: "new_codex_session",
			contextInheritanceMode: "fork_complete_native_conversation",
		});
	});
});
