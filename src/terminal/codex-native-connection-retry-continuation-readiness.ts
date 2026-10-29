import { readCodexNativeAgentTurnExecution } from "../agent-session-history/codex-native-agent-turn-execution-reader";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { buildTerminalNativeConversationIdentityForAsynchronousWriteValidation } from "./terminal-native-conversation-write-target-identity";

type CodexNativeConnectionRetryContinuationReadiness =
	| { outcome: "ready_for_terminal_write"; nativeTurnId: string }
	| { outcome: "deferred_before_terminal_write" | "target_invalidated" };

export async function inspectCodexNativeConnectionRetryContinuationReadiness(input: {
	summary: RuntimeTaskSessionSummary;
	getCurrentSummary: () => RuntimeTaskSessionSummary | null;
	requiredNativeTurnId?: string;
}): Promise<CodexNativeConnectionRetryContinuationReadiness> {
	const { summary } = input;
	const targetIdentity = buildTerminalNativeConversationIdentityForAsynchronousWriteValidation(summary);
	const targetIsCurrent = () => {
		const current = input.getCurrentSummary();
		return (
			current !== null &&
			buildTerminalNativeConversationIdentityForAsynchronousWriteValidation(current) === targetIdentity
		);
	};
	const endpoint = summary.codexNativeSessionControlEndpoint;
	if (
		endpoint &&
		(endpoint.conversationSessionId !== summary.taskId ||
			endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId)
	)
		return { outcome: "target_invalidated" };
	try {
		const observation = await readCodexNativeAgentTurnExecution({
			summary,
			workspaceId: endpoint?.workspaceId ?? "",
			observedAtMs: Date.now(),
		});
		if (!targetIsCurrent()) return { outcome: "target_invalidated" };
		if (!observation?.nativeTurnId) return { outcome: "deferred_before_terminal_write" };
		if (input.requiredNativeTurnId && observation.nativeTurnId !== input.requiredNativeTurnId)
			return { outcome: "target_invalidated" };
		if (observation.executionStatus === "finished") {
			if (observation.nativeTurnStatus === "failed")
				return { outcome: "ready_for_terminal_write", nativeTurnId: observation.nativeTurnId };
			return { outcome: "target_invalidated" };
		}
		return { outcome: "deferred_before_terminal_write" };
	} catch {
		return { outcome: targetIsCurrent() ? "deferred_before_terminal_write" : "target_invalidated" };
	}
}
