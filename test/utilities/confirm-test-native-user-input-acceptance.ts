import type { TerminalSessionManager } from "../../src/terminal/session-manager";

// 测试显式提供原生接受消息，替代旧用例中用PTY重绘冒充成功。投递回执仍须在fixture提供写前消息游标。
export function confirmTestNativeUserInputAcceptance(input: {
	manager: TerminalSessionManager;
	taskId: string;
	promptText?: string;
	observedAtMs?: number;
	eventId?: string;
}): void {
	const summary = input.manager.getSummary(input.taskId);
	if (!summary?.runtimeSessionIncarnationId || (summary.agentId !== "claude" && summary.agentId !== "codex")) {
		throw new Error("接受证据fixture需要明确的活体及Claude/Codex原生身份");
	}
	const nativeSessionId =
		summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? `test-native-${input.taskId}`;
	if (!summary.agentNativeConversationSessionIdentity)
		input.manager.applyAgentNativeConversationSessionIdentity(input.taskId, {
			sourceAgentId: summary.agentId,
			nativeSessionId,
			transcriptPath: null,
			observedAt: Date.now(),
		});
	input.manager.confirmAcceptedAgentConversationInput(input.taskId, {
		runtimeSessionIncarnationId: summary.runtimeSessionIncarnationId,
		nativeSessionId,
		observedAtMs: input.observedAtMs ?? Date.now(),
		eventId: input.eventId ?? `${nativeSessionId}:new-user-message`,
		submittedPromptText: input.promptText,
	});
}
