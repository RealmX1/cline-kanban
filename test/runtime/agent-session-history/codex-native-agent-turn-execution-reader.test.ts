import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCodexNativeAgentTurnExecution } from "../../../src/agent-session-history/codex-native-agent-turn-execution-reader";
import { readNativeAgentConversationActivity } from "../../../src/agent-session-history/native-agent-conversation-activity-reader";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: async (
		operation: (port: { request: typeof request }) => Promise<unknown>,
	) => operation({ request }),
}));
const NOW = 1_790_000_000_000;
function summary(nativeSessionId = "native"): RuntimeTaskSessionSummary {
	return {
		taskId: "background-wait",
		agentId: "codex",
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		workspacePath: "/isolated",
		pid: 12,
		startedAt: NOW - 600_000,
		updatedAt: NOW,
		lastOutputAt: NOW,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId,
			transcriptPath: "/isolated/no-transcript.jsonl",
			observedAt: NOW,
		},
		codexNativeSessionControlEndpoint: {
			workspaceId: "isolated",
			conversationSessionId: "background-wait",
			runtimeSessionIncarnationId: "incarnation",
			socketPath: "/isolated/control.sock",
		},
	};
}
function mockResponses(threadStatus = "active", turnStatus = "inProgress", activeFlags: string[] = []) {
	request.mockImplementation(async (method, parameters) => {
		if (method === "thread/loaded/list") return { data: ["native"] };
		if (method === "thread/read")
			return { thread: { id: "native", status: { type: threadStatus, activeFlags }, canAcceptDirectInput: true } };
		if (method === "thread/turns/list")
			return {
				data: [
					{
						id: "current",
						status: turnStatus,
						startedAt: (NOW - 600_000) / 1_000,
						items: parameters.itemsView === "summary" ? [] : [{ id: "old", type: "userMessage" }],
					},
				],
			};
		throw new Error(`意外的查询 ${method}`);
	});
}
beforeEach(() => {
	request.mockReset();
	mockResponses();
});
afterEach(() => vi.restoreAllMocks());

describe("Codex 轻量原生回合执行状态", () => {
	it("active + inProgress + 可输入仍属于执行中，只读取轻量页", async () => {
		const result = await readCodexNativeAgentTurnExecution({
			workspaceId: "isolated",
			summary: summary(),
			observedAtMs: NOW,
		});
		expect(result).toMatchObject({
			executionStatus: "running",
			nativeTurnId: "current",
			nativeTurnStartedAtMs: NOW - 600_000,
			canAcceptDirectInput: true,
			observedAtMs: NOW,
		});
		expect(request).toHaveBeenCalledWith(
			"thread/turns/list",
			expect.objectContaining({ limit: 1, itemsView: "summary" }),
		);
		expect(request).not.toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ itemsView: "full" }));
	});
	it.each([
		["active", "inProgress", ["waitingOnUserInput"], "waiting_for_user"],
		["active", "inProgress", ["waitingOnApproval"], "waiting_for_user"],
		["active", "inProgress", ["futureUnknownFlag"], "unknown"],
		["idle", "completed", [], "finished"],
		["idle", "interrupted", [], "finished"],
		["idle", "failed", [], "finished"],
		["idle", "inProgress", [], "unknown"],
		["active", "completed", [], "unknown"],
	] as const)("线程 %s、回合 %s、标记 %j → %s", async (thread, turn, flags, expected) => {
		mockResponses(thread, turn, [...flags]);
		expect(
			(await readCodexNativeAgentTurnExecution({ workspaceId: "isolated", summary: summary(), observedAtMs: NOW }))
				?.executionStatus,
		).toBe(expected);
	});
	it("首次超预算建立独立接受基线且不重放历史，新增输入只消费一次并始终独立输出执行状态", async () => {
		const normal = request.getMockImplementation();
		const overBudgetUserInputItems = Array.from({ length: 600 }, (_, index) => ({
			id: String(index),
			type: "userMessage",
			content: [{ type: "text", text: "历史输入" }],
		}));
		request.mockImplementation(async (method, parameters) =>
			method === "thread/turns/list" && parameters.itemsView === "full"
				? {
						data: [
							{
								id: "current",
								status: "inProgress",
								items: overBudgetUserInputItems,
							},
						],
					}
				: normal?.(method, parameters),
		);
		const baselineObservation = await readNativeAgentConversationActivity({
			workspaceId: "isolated",
			summary: summary(),
			cursor: null,
			observedAtMs: NOW,
		});
		expect(baselineObservation?.events).toEqual([]);
		expect(baselineObservation?.cursor).toMatchObject({
			transport: "codex_control",
			activityProjectionWasOverBudget: true,
			predecessorTurnId: "current",
			lastAcceptedUserInputItemId: "599",
		});
		expect(baselineObservation?.codexNativeAgentTurnExecution).toMatchObject({
			executionStatus: "running",
			observedAtMs: NOW,
		});
		overBudgetUserInputItems.push({
			id: "appended-input",
			type: "userMessage",
			content: [{ type: "text", text: "追加输入" }],
		});
		const appendedInputObservation = await readNativeAgentConversationActivity({
			workspaceId: "isolated",
			summary: summary(),
			cursor: baselineObservation?.cursor ?? null,
			observedAtMs: NOW + 1_000,
		});
		expect(appendedInputObservation?.events).toEqual([
			expect.objectContaining({
				eventId: "codex:native:current:appended-input",
				activityKind: "accepted_user_input",
				evidenceKind: "native_user_prompt_acceptance",
				submittedPromptText: "追加输入",
			}),
		]);
		expect(appendedInputObservation?.cursor).toMatchObject({ lastAcceptedUserInputItemId: "appended-input" });
		expect(appendedInputObservation?.codexNativeAgentTurnExecution).toMatchObject({
			executionStatus: "running",
			observedAtMs: NOW + 1_000,
		});
		const unchangedObservation = await readNativeAgentConversationActivity({
			workspaceId: "isolated",
			summary: summary(),
			cursor: appendedInputObservation?.cursor ?? null,
			observedAtMs: NOW + 2_000,
		});
		expect(unchangedObservation?.events).toEqual([]);
		expect(unchangedObservation?.codexNativeAgentTurnExecution).toMatchObject({
			executionStatus: "running",
			observedAtMs: NOW + 2_000,
		});
	});
	it("消息查询失败不吞掉已经取得的原生执行证明", async () => {
		const normal = request.getMockImplementation();
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/turns/list" && parameters.itemsView === "full") throw new Error("投影暂时失败");
			return normal?.(method, parameters);
		});
		const result = await readNativeAgentConversationActivity({
			workspaceId: "isolated",
			summary: summary(),
			cursor: null,
			observedAtMs: NOW,
		});
		expect(result?.events).toEqual([]);
		expect(result?.nativeActivityProjectionReadFailure).toBe("投影暂时失败");
		expect(result?.codexNativeAgentTurnExecution?.executionStatus).toBe("running");
	});
	it("会话未加载、身份不匹配或端点跨 workspace 时保持未知", async () => {
		request.mockResolvedValue({ data: ["other"] });
		expect(
			await readCodexNativeAgentTurnExecution({ workspaceId: "isolated", summary: summary(), observedAtMs: NOW }),
		).toBeNull();
		mockResponses();
		expect(
			await readCodexNativeAgentTurnExecution({ workspaceId: "other", summary: summary(), observedAtMs: NOW }),
		).toBeNull();
		expect(
			await readCodexNativeAgentTurnExecution({
				workspaceId: "isolated",
				summary: summary("other"),
				observedAtMs: NOW,
			}),
		).toBeNull();
	});
	it("同身份的并发查询共享一条在途读取", async () => {
		const input = { workspaceId: "isolated", summary: summary(), observedAtMs: NOW };
		const first = readCodexNativeAgentTurnExecution(input);
		const second = readCodexNativeAgentTurnExecution(input);
		expect(second).toBe(first);
		await first;
		expect(request.mock.calls.filter(([method]) => method === "thread/read")).toHaveLength(1);
	});
	it("加载列表后续页找到目标后，消息路径不会再用第一页吞掉执行证明", async () => {
		const normal = request.getMockImplementation();
		request.mockImplementation(async (method, parameters) => {
			if (method === "thread/loaded/list")
				return parameters.cursor === null
					? { data: ["other"], nextCursor: "second-page" }
					: { data: ["native"], nextCursor: null };
			return normal?.(method, parameters);
		});
		const result = await readNativeAgentConversationActivity({
			workspaceId: "isolated",
			summary: summary(),
			cursor: null,
			observedAtMs: NOW,
		});
		expect(result?.codexNativeAgentTurnExecution?.executionStatus).toBe("running");
		expect(result?.events).toEqual([]);
		expect(request.mock.calls.filter(([method]) => method === "thread/loaded/list")).toHaveLength(2);
	});
});
