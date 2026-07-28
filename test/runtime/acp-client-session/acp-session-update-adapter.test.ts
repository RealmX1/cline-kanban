// SessionUpdate → facet / 聊天消息 的映射全表。用合成 payload 驱动，因此不依赖真实 agent
// 与 LLM 凭据——tool_call / plan / stopReason 这些在真机上要花钱才走得到的分支都覆盖得到。
import { describe, expect, it } from "vitest";
import type { AcpSessionNotification } from "../../../src/acp-client-session/acp-protocol-boundary";
import {
	type AcpTaskMessage,
	createAcpTaskSessionEntry,
	deriveAcpFacetPatch,
	updateAcpSummary,
} from "../../../src/acp-client-session/acp-session-state";
import {
	type AcpSessionUpdateContext,
	applyAcpConnectionClosed,
	applyAcpPromptTurnCompletion,
	applyAcpSessionUpdate,
} from "../../../src/acp-client-session/acp-session-update-adapter";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { resolveSessionFacets } from "../../../src/core/session-activity";

const SESSION_ID = "session-1";

function createContext(pid: number | null = 4242): {
	context: AcpSessionUpdateContext;
	emittedSummaries: RuntimeTaskSessionSummary[];
	emittedMessages: AcpTaskMessage[];
} {
	const entry = createAcpTaskSessionEntry("task-1", "omp");
	const emittedSummaries: RuntimeTaskSessionSummary[] = [];
	const emittedMessages: AcpTaskMessage[] = [];
	return {
		emittedSummaries,
		emittedMessages,
		context: {
			taskId: "task-1",
			agentId: "omp",
			pid,
			entry,
			emitSummary: (summary) => emittedSummaries.push(summary),
			emitMessage: (message) => emittedMessages.push(message),
		},
	};
}

function notify(update: AcpSessionNotification["update"]): AcpSessionNotification {
	return { sessionId: SESSION_ID, update };
}

describe("applyAcpSessionUpdate", () => {
	it("groups agent message chunks by ACP messageId and starts a new message when it changes", () => {
		const { context, emittedMessages } = createContext();

		applyAcpSessionUpdate(
			context,
			notify({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello" } }),
		);
		applyAcpSessionUpdate(
			context,
			notify({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: " world" } }),
		);
		applyAcpSessionUpdate(
			context,
			notify({ sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "Second" } }),
		);

		expect(context.entry.messages).toHaveLength(2);
		expect(context.entry.messages[0].content).toBe("Hello world");
		expect(context.entry.messages[1].content).toBe("Second");
		expect(emittedMessages.at(-1)?.content).toBe("Second");
	});

	it("routes thought chunks to the reasoning role", () => {
		const { context } = createContext();
		applyAcpSessionUpdate(
			context,
			notify({ sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text: "thinking" } }),
		);
		expect(context.entry.messages[0].role).toBe("reasoning");
		expect(context.entry.messages[0].meta?.streamType).toBe("reasoning");
	});

	it("keeps one tool message per toolCallId and replaces its content on update", () => {
		const { context } = createContext();

		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "$ ls",
				kind: "execute",
				status: "pending",
			}),
		);
		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "alpha.ts" } }],
			}),
		);

		expect(context.entry.messages).toHaveLength(1);
		expect(context.entry.messages[0].role).toBe("tool");
		expect(context.entry.messages[0].meta?.toolCallStatus).toBe("completed");
		expect(context.entry.messages[0].content).toContain("alpha.ts");
	});

	it("renders a tool call diff into markdown so the existing renderer can display it", () => {
		const { context } = createContext();
		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "tool_call",
				toolCallId: "call-diff",
				title: "edit",
				kind: "edit",
				content: [{ type: "diff", path: "/repo/a.ts", oldText: "const a = 1;", newText: "const a = 2;" }],
			}),
		);
		const content = context.entry.messages[0].content;
		expect(content).toContain("```diff");
		expect(content).toContain("-const a = 1;");
		expect(content).toContain("+const a = 2;");
	});

	it("keeps a single plan message and replaces it wholesale on every plan update", () => {
		const { context } = createContext();
		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "plan",
				entries: [{ content: "Step one", priority: "medium", status: "pending" }],
			}),
		);
		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "plan",
				entries: [
					{ content: "Step one", priority: "medium", status: "completed" },
					{ content: "Step two", priority: "medium", status: "in_progress" },
				],
			}),
		);

		const planMessages = context.entry.messages.filter((message) => message.meta?.messageKind === "plan");
		expect(planMessages).toHaveLength(1);
		expect(planMessages[0].content).toContain("[x] Step one");
		expect(planMessages[0].content).toContain("[~] Step two");
	});

	it("ignores session metadata updates instead of polluting the chat stream", () => {
		const { context, emittedMessages } = createContext();
		applyAcpSessionUpdate(context, notify({ sessionUpdate: "usage_update", used: 1, size: 2 } as never));
		applyAcpSessionUpdate(context, notify({ sessionUpdate: "available_commands_update", availableCommands: [] }));
		expect(emittedMessages).toHaveLength(0);
	});
});

describe("applyAcpPromptTurnCompletion", () => {
	it("hands the turn back to the user with a completion reason on end_turn", () => {
		const { context } = createContext();
		const summary = applyAcpPromptTurnCompletion(context, "end_turn");
		const facets = resolveSessionFacets(summary);
		expect(facets.turnOwner).toBe("user");
		// 进程还活着（pid 非空）→ awaiting 必须是 live 而不是 exited。
		expect(facets.liveness).toBe("live");
		expect(summary.reviewReason).toBe("completion");
	});

	it("treats a cancelled stop reason as interrupted rather than an error", () => {
		const { context } = createContext();
		const summary = applyAcpPromptTurnCompletion(context, "cancelled");
		expect(resolveSessionFacets(summary).liveness).toBe("interrupted");
		expect(summary.reviewReason).toBeNull();
	});

	it("marks a refusal as an error turn", () => {
		const { context } = createContext();
		const summary = applyAcpPromptTurnCompletion(context, "refusal");
		expect(summary.reviewReason).toBe("error");
		expect(resolveSessionFacets(summary).userTurnKind).toBe("error");
	});

	it("does not advance the substantive output timestamp when a turn is cancelled", () => {
		const { context } = createContext();
		applyAcpSessionUpdate(
			context,
			notify({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hi" } }),
		);
		const substantiveAfterOutput = context.entry.summary.lastSubstantiveOutputAt;
		expect(substantiveAfterOutput).not.toBeNull();

		const summary = applyAcpPromptTurnCompletion(context, "cancelled");
		expect(summary.lastSubstantiveOutputAt).toBe(substantiveAfterOutput);
	});
});

describe("applyAcpConnectionClosed", () => {
	it("clears the pid so a dead agent process reads as exited rather than live", () => {
		const { context } = createContext();
		const summary = applyAcpConnectionClosed(context, { exitCode: 0, errorMessage: null });
		expect(summary.pid).toBeNull();
		expect(resolveSessionFacets(summary).liveness).toBe("exited");
	});

	it("surfaces the agent's own diagnostics as a system message on a non-zero exit", () => {
		const { context, emittedMessages } = createContext();
		applyAcpConnectionClosed(context, { exitCode: 1, errorMessage: "boom: missing credentials" });
		expect(emittedMessages.at(-1)?.content).toContain("boom: missing credentials");
		expect(context.entry.summary.exitCode).toBe(1);
		expect(context.entry.summary.reviewReason).toBe("error");
	});

	it("keeps the substantive output timestamp when the connection closes", () => {
		const { context } = createContext();
		applyAcpSessionUpdate(
			context,
			notify({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hi" } }),
		);
		const substantiveAfterOutput = context.entry.summary.lastSubstantiveOutputAt;
		const summary = applyAcpConnectionClosed(context, { exitCode: 0, errorMessage: null });
		expect(summary.lastSubstantiveOutputAt).toBe(substantiveAfterOutput);
	});
});

// 回归：流式更新只推进存活度，绝不能夺回「等人拍板」的回合。
// 两个真实场景：(a) broker 刚因 session/request_permission 置成 awaiting_review + permission，
// 紧随其后的 tool_call_update / plan 会把卡片刷回 running，用户看不出有待决策；
// (b) 回合结束后迟到的 tool_call_update 会把 awaiting_review 永久改回 running，而 ACP 侧
// 没有终端侧 scanForStalls 那样的自愈路径。
describe("applyAcpSessionUpdate keeps the user turn", () => {
	// 与 acp-task-session-service 的 broker 逐字同构：reviewReason 走 "hook"，
	// 具体的等人类型由 deriveAcpFacetPatch 的第四个参数覆盖。
	function markAwaitingUserDecision(context: AcpSessionUpdateContext): void {
		updateAcpSummary(context.entry, {
			...deriveAcpFacetPatch(
				"awaiting_review",
				"hook",
				{ pid: context.pid, agentId: context.agentId },
				"permission",
			),
			reviewReason: "hook",
		});
	}

	it("does not steal the turn back while a user decision is pending", () => {
		const { context, emittedSummaries } = createContext();
		markAwaitingUserDecision(context);

		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "tool_call_update",
				toolCallId: "tc-1",
				status: "in_progress",
			} as AcpSessionNotification["update"]),
		);
		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "plan",
				entries: [{ content: "Step one", priority: "medium", status: "pending" }],
			}),
		);

		const facets = resolveSessionFacets(context.entry.summary);
		expect(facets.turnOwner).toBe("user");
		expect(facets.userTurnKind).toBe("permission");
		expect(emittedSummaries.at(-1)?.reviewReason).toBe("hook");
	});

	it("does not revert a completed turn when a late tool_call_update arrives", () => {
		const { context } = createContext();
		applyAcpPromptTurnCompletion(context, "end_turn");
		expect(resolveSessionFacets(context.entry.summary).turnOwner).toBe("user");

		applyAcpSessionUpdate(
			context,
			notify({
				sessionUpdate: "tool_call_update",
				toolCallId: "tc-late",
				status: "completed",
			} as AcpSessionNotification["update"]),
		);

		expect(resolveSessionFacets(context.entry.summary).turnOwner).toBe("user");
	});

	it("still advances liveness for a normal agent turn", () => {
		const { context } = createContext();

		applyAcpSessionUpdate(
			context,
			notify({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "hi" } }),
		);

		expect(resolveSessionFacets(context.entry.summary).turnOwner).toBe("agent");
	});
});
