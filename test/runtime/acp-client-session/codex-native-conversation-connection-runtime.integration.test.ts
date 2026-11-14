import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpSessionNotification } from "../../../src/acp-client-session/acp-protocol-boundary";
import { CodexNativeConversationConnectionRuntime } from "../../../src/agent-conversation/codex-native-conversation-connection-runtime";

const ownedRuntimes: { runtime: CodexNativeConversationConnectionRuntime; directory: string }[] = [];
const require = createRequire(import.meta.url);
async function fixture() {
	const directory = await mkdtemp("/tmp/kanban-native-comparison-test-");
	const updates: AcpSessionNotification[] = [];
	const requests: string[] = [];
	const replayFlags: boolean[] = [];
	const runtime = new CodexNativeConversationConnectionRuntime(
		{
			onSessionUpdate: (taskId, update) => {
				updates.push(update);
				replayFlags.push(runtime.isReplayingPersistedConversationHistory(taskId));
			},
			onPermissionRequest: async () => ({ outcome: { outcome: "cancelled" } }),
			onElicitationRequest: async () => ({ action: "cancel" }),
			onConnectionClosed: vi.fn(),
		},
		{
			binary: resolve("test/integration/fixtures/codex-protocol-comparison-fake-app-server.cjs"),
			environment: { ...process.env, KANBAN_COMPARISON_TEST_WS_MODULE_PATH: require.resolve("ws") },
			onProtocolEvent: (event) => {
				if (event.direction === "request") requests.push(event.method);
			},
		},
	);
	ownedRuntimes.push({ runtime, directory });
	return { runtime, directory, updates, requests, replayFlags };
}
const launch = (cwd: string) => ({
	taskId: "comparison",
	agentId: "codex" as const,
	cwd,
	modelId: "fixture-model",
	permissionMode: "ask_for_every_tool_use" as const,
});
afterEach(async () => {
	for (const { runtime, directory } of ownedRuntimes.splice(0)) {
		await runtime.stopTaskConnectionAndConfirmExit("comparison");
		await rm(directory, { recursive: true, force: true });
	}
});
describe("原生 Codex 连接与共用服务合同", () => {
	it("原生 turn 完成经独立通知结算，完整输出保留且不重复启动", async () => {
		const { runtime, directory, updates, requests } = await fixture();
		const connection = await runtime.startTaskConnection(launch(directory));
		expect(await runtime.startTaskConnection(launch(directory))).toBe(connection);
		await expect(connection.prompt([{ type: "text", text: "原始输入" }])).resolves.toEqual({
			stopReason: "end_turn",
		});
		expect(updates).toContainEqual({
			sessionId: "native-test-thread",
			update: {
				sessionUpdate: "agent_message_chunk",
				messageId: "assistant-item",
				content: { type: "text", text: "中文完整输出" },
			},
		});
		expect(requests).toEqual(["thread/start", "turn/start"]);
		expect(await runtime.stopTaskConnectionAndConfirmExit("comparison")).toMatchObject({
			rootProcessExitConfirmed: true,
		});
	});
	it("取消只中断当前回合，恢复不会重新发送首条输入", async () => {
		const { runtime, directory, requests, replayFlags } = await fixture();
		const connection = await runtime.startTaskConnection({
			...launch(directory),
			resumePriorAgentConversationWithoutResendingPrompt: true,
			observedAgentNativeSessionId: "native-test-thread",
		});
		expect(requests).toEqual(["thread/resume", "thread/turns/list"]);
		expect(replayFlags).toEqual([true, true]);
		const turn = connection.prompt([{ type: "text", text: "wait_for_interrupt" }]);
		await connection.cancel();
		await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
		expect(runtime.getConnection("comparison")).toBe(connection);
		expect(requests.filter((method) => method === "turn/start")).toHaveLength(1);
	});
	it("没有确切原生身份时拒绝恢复，完全不创建执行实例", async () => {
		const { runtime, directory } = await fixture();
		await expect(
			runtime.startTaskConnection({
				...launch(directory),
				resumePriorAgentConversationWithoutResendingPrompt: true,
			}),
		).rejects.toThrow("确切会话 ID");
		expect(runtime.getConnection("comparison")).toBeNull();
	});
	it("损坏的 turn/start 响应明确拒绝，不留下永远挂起的回合", async () => {
		const { runtime, directory } = await fixture();
		const connection = await runtime.startTaskConnection(launch(directory));
		await expect(connection.prompt([{ type: "text", text: "invalid_turn_start_response" }])).rejects.toThrow();
		await expect(connection.prompt([{ type: "text", text: "后续正常输入" }])).resolves.toEqual({
			stopReason: "end_turn",
		});
	});
	it("旧连接的 close 和输入不会操作新执行实例", async () => {
		const { runtime, directory } = await fixture();
		const original = await runtime.startTaskConnection(launch(directory));
		await runtime.stopTaskConnectionAndConfirmExit("comparison");
		const replacement = await runtime.startTaskConnection(launch(directory));
		original.close();
		expect(runtime.getConnection("comparison")).toBe(replacement);
		await expect(original.prompt([{ type: "text", text: "旧输入" }])).rejects.toThrow("已关闭");
		await expect(replacement.prompt([{ type: "text", text: "新输入" }])).resolves.toEqual({ stopReason: "end_turn" });
	});
});
