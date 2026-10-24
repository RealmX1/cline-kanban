import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary, RuntimeTaskSessionUserTurnKind } from "../../../src/core/api-contract";
import { canReconcileCodexNeedsInputWithNativeDirectInputReadiness } from "../../../src/core/codex-native-direct-input-readiness";

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
			expect(canReconcileCodexNeedsInputWithNativeDirectInputReadiness(before, before, observation)).toBe(true);
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
		expect(canReconcileCodexNeedsInputWithNativeDirectInputReadiness(before, before, observation)).toBe(false);
	});
	it.each([
		{ updatedAt: 201 },
		{ pid: 13 },
		{ pid: null },
		{ startedAt: 101 },
		{ runtimeSessionIncarnationId: "next" },
		{ agentId: "claude" as const },
		{ lastHookAt: 200 },
		{ agentResponseGenerationTurnSequence: 2 },
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
			canReconcileCodexNeedsInputWithNativeDirectInputReadiness(before, { ...before, ...patch }, observation),
		).toBe(false);
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
		expect(canReconcileCodexNeedsInputWithNativeDirectInputReadiness(before, current, observation)).toBe(false);
	});
	it.each([199, Number.NaN, Number.POSITIVE_INFINITY])("时间 %s 不是有效的本次观测", (observedAtMs) => {
		const before = summary();
		expect(
			canReconcileCodexNeedsInputWithNativeDirectInputReadiness(before, before, { ...observation, observedAtMs }),
		).toBe(false);
	});
});
