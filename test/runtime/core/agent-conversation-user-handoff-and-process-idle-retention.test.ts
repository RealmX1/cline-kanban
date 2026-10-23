import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { mergeSummaryWithFacets } from "../../../src/core/session-activity";
import { deriveAgentSessionRetentionDeadlineTransition } from "../../../src/server/agent-session-response-generation-stop-observer";

const NOW = 1_700_000_000_000;
function makeSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		workspacePath: "/repo",
		pid: 42,
		startedAt: NOW - 50_000,
		updatedAt: NOW - 10_000,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: 2,
		...overrides,
	};
}

describe("真实交棒历史与当前进程待命期限分离", () => {
	it("主动中断当前真实 Agent 回合，即使移除 incarnation 也记录真实交棒", () => {
		const interrupted = mergeSummaryWithFacets(makeSummary(), {
			turnOwner: "user",
			liveness: "interrupted",
			userTurnKind: "interrupted",
			runtimeSessionIncarnationId: null,
			updatedAt: NOW,
		});
		expect(interrupted.lastAgentConversationUserHandoffObservation).toEqual({
			observedAtMs: NOW,
			signalConfidence: "structured_user_turn",
			turnSequence: 2,
		});
	});
	it("真实 agent→user 边沿同时记录交棒和当前进程待命，不新写旧停止字段", () => {
		const stopped = mergeSummaryWithFacets(makeSummary(), {
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			reviewReason: "hook",
			updatedAt: NOW,
		});
		expect(stopped.lastAgentConversationUserHandoffObservation).toEqual({
			observedAtMs: NOW,
			signalConfidence: "harness_turn_complete",
			turnSequence: 2,
		});
		expect(stopped.currentAgentProcessUserTurnIdleRetentionStarted).toEqual({
			stoppedAt: NOW,
			signalConfidence: "harness_turn_complete",
			turnSequence: 2,
		});
		expect(stopped.agentResponseGenerationStopped).toBeUndefined();
	});

	it("恢复新进程只刷新待命起点，交棒历史保留", () => {
		const handoff = {
			observedAtMs: NOW - 10_000,
			signalConfidence: "harness_turn_complete" as const,
			turnSequence: 2,
		};
		const before = makeSummary({
			turnOwner: "user",
			liveness: "live",
			userTurnKind: "review",
			state: "awaiting_review",
			lastAgentConversationUserHandoffObservation: handoff,
		});
		const restored = mergeSummaryWithFacets(before, { runtimeSessionIncarnationId: "incarnation-2", updatedAt: NOW });
		expect(restored.lastAgentConversationUserHandoffObservation).toBe(handoff);
		expect(restored.currentAgentProcessUserTurnIdleRetentionStarted?.stoppedAt).toBe(NOW);
	});

	it("从未开工的就绪和 spawn 失败不能伪造交棒", () => {
		for (const liveness of ["live", "failed"] as const) {
			const idle = makeSummary({
				state: "idle",
				turnOwner: null,
				liveness: "none",
				agentResponseGenerationTurnSequence: 0,
			});
			const ready = mergeSummaryWithFacets(idle, {
				turnOwner: "user",
				liveness,
				userTurnKind: liveness === "live" ? "review" : "error",
				updatedAt: NOW,
			});
			expect(ready.lastAgentConversationUserHandoffObservation).toBeUndefined();
		}
	});

	it("Agent 继续和 park 保留历史交棒，当前进程待命清空", () => {
		const handoff = {
			observedAtMs: NOW - 10_000,
			signalConfidence: "structured_user_turn" as const,
			turnSequence: 1,
		};
		const before = makeSummary({
			state: "awaiting_review",
			turnOwner: "user",
			userTurnKind: "review",
			lastAgentConversationUserHandoffObservation: handoff,
			currentAgentProcessUserTurnIdleRetentionStarted: {
				stoppedAt: NOW - 10_000,
				signalConfidence: "structured_user_turn",
				turnSequence: 1,
			},
		});
		const running = mergeSummaryWithFacets(before, {
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			updatedAt: NOW,
		});
		expect(running.lastAgentConversationUserHandoffObservation).toBe(handoff);
		expect(running.currentAgentProcessUserTurnIdleRetentionStarted).toBeNull();
		const parked = mergeSummaryWithFacets(running, { awaitingDispatchedBackgroundWork: { sinceMs: NOW } });
		expect(parked.lastAgentConversationUserHandoffObservation).toBe(handoff);
	});

	it("回收读取新进程待命锚点，不能拿历史交棒或旧停止值起算", () => {
		const summary = makeSummary({
			state: "awaiting_review",
			turnOwner: "user",
			userTurnKind: "review",
			updatedAt: NOW,
			lastAgentConversationUserHandoffObservation: {
				observedAtMs: NOW - 100_000,
				signalConfidence: "harness_turn_complete",
				turnSequence: 2,
			},
			agentResponseGenerationStopped: {
				stoppedAt: NOW - 100_000,
				signalConfidence: "harness_turn_complete",
				turnSequence: 2,
			},
			currentAgentProcessUserTurnIdleRetentionStarted: {
				stoppedAt: NOW - 1_000,
				signalConfidence: "structured_user_turn",
				turnSequence: 2,
			},
		});
		const transition = deriveAgentSessionRetentionDeadlineTransition(null, summary, {
			nowMs: NOW,
			gracePeriodMs: 5_000,
		});
		expect(transition).toMatchObject({
			kind: "start_retention_deadline",
			input: { retentionAnchorAt: NOW - 1_000, reclamationEligibleAt: NOW + 4_000 },
		});
	});
});
