import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { inspectCodexNativeConnectionRetryContinuationReadiness } from "../../../src/terminal/codex-native-connection-retry-continuation-readiness";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: async (
		operation: (port: { request: typeof request }) => Promise<unknown>,
	) => operation({ request }),
}));

function makeSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "conversation",
		agentId: "codex",
		pid: 123,
		workspacePath: "/isolated/task",
		state: "running",
		turnOwner: "agent",
		liveness: "retrying",
		userTurnKind: null,
		startedAt: 10,
		updatedAt: 20,
		lastOutputAt: 20,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath: "/isolated/native.jsonl",
			observedAt: 10,
		},
		codexNativeSessionControlEndpoint: {
			workspaceId: "workspace",
			conversationSessionId: "conversation",
			runtimeSessionIncarnationId: "incarnation",
			socketPath: "/isolated/control",
		},
	};
}

describe("Codex 自动重连续跑的原生写前核验", () => {
	beforeEach(() => {
		request.mockReset();
	});
	it.each([
		["inProgress", "deferred_before_terminal_write"],
		["completed", "target_invalidated"],
		["interrupted", "target_invalidated"],
		["unknown-status", "deferred_before_terminal_write"],
		["failed", "ready_for_terminal_write"],
	] as const)("原生回合 %s 时返回 %s", async (status, outcome) => {
		const summary = makeSummary();
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"], nextCursor: null }
				: { data: [{ id: "turn", status, items: [] }], nextCursor: null },
		);
		expect(
			await inspectCodexNativeConnectionRetryContinuationReadiness({ summary, getCurrentSummary: () => summary }),
		).toMatchObject({ outcome });
		expect(request.mock.calls.every(([method]) => ["thread/loaded/list", "thread/turns/list"].includes(method))).toBe(
			true,
		);
	});
	it("缺少控制面或读取失败时保持未知，不把 TUI 输入框当成故障证据", async () => {
		const summary = makeSummary();
		summary.codexNativeSessionControlEndpoint = undefined;
		expect(
			await inspectCodexNativeConnectionRetryContinuationReadiness({ summary, getCurrentSummary: () => summary }),
		).toMatchObject({ outcome: "deferred_before_terminal_write" });
		expect(request).not.toHaveBeenCalled();
		const restored = makeSummary();
		request.mockRejectedValue(new Error("控制面不可读"));
		expect(
			await inspectCodexNativeConnectionRetryContinuationReadiness({
				summary: restored,
				getCurrentSummary: () => restored,
			}),
		).toMatchObject({ outcome: "deferred_before_terminal_write" });
	});
	it("查询期间原地切换 incarnation 必须作废旧目标", async () => {
		const summary = makeSummary();
		request.mockImplementation(async () => {
			summary.runtimeSessionIncarnationId = "replacement";
			return { data: ["native"], nextCursor: null };
		});
		expect(
			await inspectCodexNativeConnectionRetryContinuationReadiness({ summary, getCurrentSummary: () => summary }),
		).toMatchObject({ outcome: "target_invalidated" });
	});

	it("已加载列表分页后核对同一回合，新的失败回合不能继承旧回合的写入资格", async () => {
		const summary = makeSummary();
		request.mockImplementation(async (method, parameters) =>
			method === "thread/loaded/list"
				? parameters.cursor === null
					? { data: ["other"], nextCursor: "second-page" }
					: { data: ["native"], nextCursor: null }
				: { data: [{ id: "new-failed-turn", status: "failed" }] },
		);
		expect(
			await inspectCodexNativeConnectionRetryContinuationReadiness({
				summary,
				getCurrentSummary: () => summary,
				requiredNativeTurnId: "original-failed-turn",
			}),
		).toMatchObject({ outcome: "target_invalidated" });
		expect(request).toHaveBeenCalledWith("thread/loaded/list", { cursor: "second-page", limit: 100 });
	});

	it("原生列表分页游标循环时保持未知，不能继续查询或写入", async () => {
		const summary = makeSummary();
		request.mockResolvedValue({ data: ["other"], nextCursor: "repeated-cursor" });
		expect(
			await inspectCodexNativeConnectionRetryContinuationReadiness({ summary, getCurrentSummary: () => summary }),
		).toMatchObject({ outcome: "deferred_before_terminal_write" });
		expect(request).toHaveBeenCalledTimes(2);
	});
});
