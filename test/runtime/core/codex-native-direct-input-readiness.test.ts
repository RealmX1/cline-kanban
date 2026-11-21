import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary, RuntimeTaskSessionUserTurnKind } from "../../../src/core/api-contract";
import { canReconcileCodexAwaitingInputWithNativeDirectInputReadiness } from "../../../src/core/codex-native-direct-input-readiness";

function summary(): RuntimeTaskSessionSummary {
	return {
		taskId: "ordinary-codex-conversation",
		state: "awaiting_review",
		agentId: "codex",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "needs_input",
		reviewReason: null,
		workspacePath: "/isolated",
		pid: 12,
		startedAt: 100,
		updatedAt: 200,
		lastOutputAt: 150,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		runtimeSessionIncarnationId: "incarnation",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			transcriptPath: "/isolated/native.jsonl",
			observedAt: 100,
		},
		codexNativeSessionControlEndpoint: {
			workspaceId: "workspace",
			conversationSessionId: "ordinary-codex-conversation",
			runtimeSessionIncarnationId: "incarnation",
			socketPath: "/isolated/socket",
		},
	};
}
const observation = { nativeSessionId: "native", observedAtMs: 300 };

describe("Codex 原生输入就绪后的状态校正边界", () => {
	it.each([null, "attention", "hook"] as const)(
		"普通 rewind 的成因为 %s 时均可校正，不要求 RVF 或恢复标记",
		(reviewReason) => {
			const before = { ...summary(), reviewReason };
			expect(canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, before, observation)).toBe(true);
		},
	);
	it.each([
		"question",
		"permission",
		"plan_review",
		"review",
		"error",
		"interrupted",
	] satisfies RuntimeTaskSessionUserTurnKind[])("显式 %s 不被兜底状态校正覆盖", (userTurnKind) => {
		const before = { ...summary(), userTurnKind };
		expect(canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, before, observation)).toBe(false);
	});
	it("只有确属上一代的选择题才可校正，期间收到新 hook 即作废", () => {
		const before = { ...summary(), userTurnKind: "question" as const };
		const replacedQuestionSelector = { originRuntimeSessionIncarnationId: "previous", nativeQuestionAskedAtMs: 99 };
		const proof = { ...observation, replacedQuestionSelector };
		expect(canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, before, proof)).toBe(true);
		expect(
			canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, { ...before, lastHookAt: 250 }, proof),
		).toBe(false);
		expect(
			canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, before, {
				...proof,
				replacedQuestionSelector: { ...replacedQuestionSelector, originRuntimeSessionIncarnationId: "incarnation" },
			}),
		).toBe(false);
	});
	it.each([
		{ pid: 13 },
		{ pid: null },
		{ startedAt: 101 },
		{ runtimeSessionIncarnationId: "next" },
		{ agentId: "claude" as const },
		{ lastHookAt: 200 },
		{ agentResponseGenerationTurnSequence: 2 },
		{ agentResponseGenerationTurnStarted: { startedAt: 250, turnSequence: 1 } },
		{ workspacePath: "/another-workspace" },
		{
			agentConversationPromptSubmissionAcceptance: {
				status: "pending" as const,
				attemptedAtMs: 200,
				runtimeSessionIncarnationId: "incarnation",
			},
		},
		{ turnOwner: "agent" as const, userTurnKind: null },
		{ liveness: "exited" as const },
	])("查询期间状态变化时丢弃旧观测：%j", (patch) => {
		const before = summary();
		expect(
			canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, { ...before, ...patch }, observation),
		).toBe(false);
	});
	it("连续 PTY 重绘与等值 hook 反序列化不使同一回合证明失效", () => {
		const before = summary();
		expect(
			canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(
				before,
				{ ...before, updatedAt: 900, lastOutputAt: 900 },
				observation,
			),
		).toBe(true);
	});
	it.each(["native_id", "transcript", "endpoint", "missing_endpoint"])("查询期间 %s 改变时丢弃旧观测", (change) => {
		const before = summary();
		const current = {
			...before,
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex" as const,
				nativeSessionId: change === "native_id" ? "next" : "native",
				transcriptPath: change === "transcript" ? "/new.jsonl" : "/isolated/native.jsonl",
				observedAt: 100,
			},
			codexNativeSessionControlEndpoint:
				change === "missing_endpoint"
					? null
					: {
							workspaceId: "workspace",
							conversationSessionId: before.taskId,
							runtimeSessionIncarnationId: "incarnation",
							socketPath: change === "endpoint" ? "/new/socket" : "/isolated/socket",
						},
		};
		expect(canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, current, observation)).toBe(false);
	});
	it.each([199, Number.NaN, Number.POSITIVE_INFINITY])("时间 %s 不是有效的本次观测", (observedAtMs) => {
		const before = summary();
		expect(
			canReconcileCodexAwaitingInputWithNativeDirectInputReadiness(before, before, { ...observation, observedAtMs }),
		).toBe(false);
	});
});
