// dd2db 2x：ACP（omp）会话的 park 等价物。PTY 侧靠 hook 的 to_review 闸抑制「等你审查」，ACP 没有 hook，
// 所以抑制写在回合收束里；sidecar 与谓词和 PTY 是同一个。
import { describe, expect, it } from "vitest";

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
} from "../../../src/acp-client-session/acp-session-update-adapter";
import {
	describeAcpTaskSessionAwaitingDispatchedBackgroundWork,
	parkAcpTaskSessionEntryAwaitingDispatchedBackgroundWork,
	unparkAcpTaskSessionEntry,
} from "../../../src/acp-client-session/acp-task-session-park-awaiting-dispatched-background-work";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { isParkedAwaitingDispatchedBackgroundWork, resolveSessionFacets } from "../../../src/core/session-activity";

function createRunningAcpContext(): AcpSessionUpdateContext {
	const entry = createAcpTaskSessionEntry("task-1", "omp");
	updateAcpSummary(entry, deriveAcpFacetPatch("running", null, { pid: 4242, agentId: "omp" }));
	return {
		taskId: "task-1",
		agentId: "omp",
		pid: 4242,
		entry,
		isReplayingPersistedConversationHistory: false,
		emitSummary: (_summary: RuntimeTaskSessionSummary) => {},
		emitMessage: (_message: AcpTaskMessage) => {},
	};
}

function parkRunningAcpContext(context: AcpSessionUpdateContext, label = "rvf reviewers"): void {
	const parked = parkAcpTaskSessionEntryAwaitingDispatchedBackgroundWork({
		taskId: context.taskId,
		entry: context.entry,
		hasLiveAcpConnection: true,
		label,
	});
	expect(parked.ok).toBe(true);
}

describe("ACP park awaiting dispatched background work", () => {
	it("keeps the agent turn when a parked turn ends normally, instead of handing it to the user for review", () => {
		const context = createRunningAcpContext();
		parkRunningAcpContext(context);

		const summary = applyAcpPromptTurnCompletion(context, "end_turn");

		expect(resolveSessionFacets(summary)).toMatchObject({ turnOwner: "agent", liveness: "live", userTurnKind: null });
		expect(isParkedAwaitingDispatchedBackgroundWork(summary)).toBe(true);
		expect(describeAcpTaskSessionAwaitingDispatchedBackgroundWork(context.entry)).toMatchObject({
			parked: true,
			label: "rvf reviewers",
		});
	});

	it("still hands an unparked turn to the user for review", () => {
		const context = createRunningAcpContext();

		const summary = applyAcpPromptTurnCompletion(context, "end_turn");

		expect(resolveSessionFacets(summary)).toMatchObject({ turnOwner: "user", userTurnKind: "review" });
	});

	it("clears the park when a parked turn is refused, cancelled, or loses its process", () => {
		for (const ending of ["refusal", "cancelled", "connection_closed"] as const) {
			const context = createRunningAcpContext();
			parkRunningAcpContext(context);

			const summary =
				ending === "connection_closed"
					? applyAcpConnectionClosed(context, { exitCode: 1, errorMessage: null })
					: applyAcpPromptTurnCompletion(context, ending);

			expect(isParkedAwaitingDispatchedBackgroundWork(summary)).toBe(false);
			expect(resolveSessionFacets(summary).turnOwner).toBe("user");
		}
	});

	it("refuses to park without a live connection or outside an agent turn, and keeps sinceMs on a repeated park", () => {
		const context = createRunningAcpContext();
		expect(
			parkAcpTaskSessionEntryAwaitingDispatchedBackgroundWork({
				taskId: "task-1",
				entry: context.entry,
				hasLiveAcpConnection: false,
			}).ok,
		).toBe(false);

		parkRunningAcpContext(context, "first label");
		const firstSinceMs = context.entry.summary.awaitingDispatchedBackgroundWork?.sinceMs;
		parkRunningAcpContext(context, "second label");
		expect(context.entry.summary.awaitingDispatchedBackgroundWork).toEqual({
			sinceMs: firstSinceMs,
			label: "second label",
		});

		expect(unparkAcpTaskSessionEntry(context.entry)).not.toBeNull();
		expect(unparkAcpTaskSessionEntry(context.entry)).toBeNull();

		updateAcpSummary(
			context.entry,
			deriveAcpFacetPatch("awaiting_review", "completion", { pid: 4242, agentId: "omp" }),
		);
		const parkedInUserTurn = parkAcpTaskSessionEntryAwaitingDispatchedBackgroundWork({
			taskId: "task-1",
			entry: context.entry,
			hasLiveAcpConnection: true,
		});
		expect(parkedInUserTurn).toEqual({
			ok: false,
			error: 'Task "task-1" is not in an agent turn and cannot be parked.',
		});
	});
});
