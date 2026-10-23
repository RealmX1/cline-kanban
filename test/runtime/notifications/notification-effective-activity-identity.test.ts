import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { notificationSummaryProgressIdentity } from "../../../src/notifications/notification-assessment-service";

describe("通知依据回合与交棒，而不是任意活动新鲜度", () => {
	it("同一用户回合的压缩不取消已存在的交棒通知", () => {
		const previous: RuntimeTaskSessionSummary = {
			taskId: "task",
			agentId: "claude",
			state: "awaiting_review",
			workspacePath: null,
			pid: null,
			startedAt: null,
			updatedAt: 100,
			lastOutputAt: null,
			reviewReason: "hook",
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			turnOwner: "user",
			liveness: "exited",
			userTurnKind: "review",
			runtimeSessionIncarnationId: "incarnation",
			agentResponseGenerationTurnSequence: 1,
			lastConversationProgressObservation: { observedAtMs: 100, evidenceKind: "agent_lifecycle_hook_event" },
		};
		const compacted = {
			...previous,
			updatedAt: 200,
			lastConversationProgressObservation: {
				observedAtMs: 200,
				evidenceKind: "agent_lifecycle_hook_event" as const,
			},
		};
		expect(notificationSummaryProgressIdentity(compacted)).toBe(notificationSummaryProgressIdentity(previous));
		expect(notificationSummaryProgressIdentity({ ...compacted, agentResponseGenerationTurnSequence: 2 })).not.toBe(
			notificationSummaryProgressIdentity(previous),
		);
	});
});
