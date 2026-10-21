import { describe, expect, it, vi } from "vitest";
import type { QueuedTaskPromptDeliveryEntry, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import {
	assertIndependentUserTurnImmediatelyBeforeTerminalWrite,
	NativeIndependentUserTurnMessageAlreadyAccepted,
	readCurrentTuiNativeConversationTurns,
} from "../../../src/rvf-automatic-closeout/native-independent-user-turn-delivery-gate";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../../src/rvf-automatic-closeout/codex-app-server-request-connection", () => ({
	withRunningCodexAppServerControlSocketConnection: async (
		operation: (port: { request: typeof request }) => Promise<unknown>,
	) => operation({ request }),
}));

const predecessor = { id: "implementation", status: "completed", items: [] };
function targetSummary() {
	return {
		taskId: "conversation",
		agentId: "codex",
		startedAt: 1,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: { nativeSessionId: "native", transcriptPath: "/isolated/transcript" },
		codexNativeSessionControlEndpoint: {
			socketPath: "/isolated/socket",
			workspaceId: "workspace",
			conversationSessionId: "conversation",
			runtimeSessionIncarnationId: "incarnation",
		},
	} as RuntimeTaskSessionSummary;
}
function targetEntry() {
	return {
		taskId: "conversation",
		requiredNativeIndependentUserTurnSessionId: "native",
		requiredNativeIndependentUserTurnSessionIncarnationId: "incarnation",
	} as QueuedTaskPromptDeliveryEntry;
}

describe("当前 TUI 独立原生回合门", () => {
	it("只查询当前 TUI 已加载会话，不 resume 磁盘历史", async () => {
		request.mockImplementation(async (method) =>
			method === "thread/loaded/list"
				? { data: ["native"], nextCursor: null }
				: { data: [predecessor], nextCursor: null },
		);
		const summary = targetSummary();
		expect(
			await readCurrentTuiNativeConversationTurns({
				workspaceId: "workspace",
				entry: targetEntry(),
				getSummary: () => summary,
			}),
		).toEqual([predecessor]);
		expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/loaded/list", "thread/turns/list"]);
		request.mockClear();
	});
	it.each(["missing_endpoint", "incarnation_changed", "different_native_session", "not_loaded"])(
		"%s 时不降级",
		async (kind) => {
			const summary = targetSummary();
			if (kind === "missing_endpoint") summary.codexNativeSessionControlEndpoint = undefined;
			if (kind === "incarnation_changed") summary.runtimeSessionIncarnationId = "replacement";
			if (kind === "different_native_session" && summary.agentNativeConversationSessionIdentity)
				summary.agentNativeConversationSessionIdentity.nativeSessionId = "replacement";
			request.mockResolvedValue({ data: [], nextCursor: null });
			await expect(
				readCurrentTuiNativeConversationTurns({
					workspaceId: "workspace",
					entry: targetEntry(),
					getSummary: () => summary,
				}),
			).rejects.toMatchObject({
				reason:
					kind === "incarnation_changed" || kind === "different_native_session"
						? "native_independent_user_turn_session_replaced"
						: "native_independent_user_turn_capability_unavailable",
			});
			request.mockClear();
		},
	);
	it("查询跨 await 后再次核对身份", async () => {
		const summary = targetSummary();
		request.mockImplementation(async (method) => {
			if (method === "thread/loaded/list") return { data: ["native"], nextCursor: null };
			summary.runtimeSessionIncarnationId = "changed";
			return { data: [predecessor], nextCursor: null };
		});
		await expect(
			readCurrentTuiNativeConversationTurns({
				workspaceId: "workspace",
				entry: targetEntry(),
				getSummary: () => summary,
			}),
		).rejects.toMatchObject({ reason: "native_independent_user_turn_session_replaced" });
		request.mockClear();
	});
	it("同一 completed 前置回合允许实际写入；本条唯一后继消息已摄入时停止补发", () => {
		expect(() =>
			assertIndependentUserTurnImmediatelyBeforeTerminalWrite({
				turns: [predecessor],
				predecessorTurnId: predecessor.id,
				text: "边界",
			}),
		).not.toThrow();
		expect(() =>
			assertIndependentUserTurnImmediatelyBeforeTerminalWrite({
				turns: [
					predecessor,
					{
						id: "next",
						status: "inProgress",
						items: [{ id: "message", type: "userMessage", content: [{ type: "input_text", text: "边界" }] }],
					},
				],
				predecessorTurnId: predecessor.id,
				text: "边界",
			}),
		).toThrow(NativeIndependentUserTurnMessageAlreadyAccepted);
	});
	it.each(["same_turn", "other_message", "rewound"])("%s 不会误确认本条已摄入", (kind) => {
		const message = {
			id: "message",
			type: "userMessage",
			content: [{ type: "input_text", text: kind === "other_message" ? "其它正文" : "边界" }],
		};
		const turns =
			kind === "rewound"
				? []
				: kind === "same_turn"
					? [{ ...predecessor, status: "inProgress", items: [message] }]
					: [predecessor, { id: "next", status: "inProgress", items: [message] }];
		expect(() =>
			assertIndependentUserTurnImmediatelyBeforeTerminalWrite({
				turns,
				predecessorTurnId: predecessor.id,
				text: "边界",
			}),
		).toThrow("未继续写入");
	});
});
