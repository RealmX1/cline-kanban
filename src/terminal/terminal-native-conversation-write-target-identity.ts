import type { RuntimeTaskSessionSummary } from "../core/api-contract";

// 异步核验后仍须是同一个进程、原生会话和控制端点，不能只认同一个 PTY 对象。
export function buildTerminalNativeConversationIdentityForAsynchronousWriteValidation(
	summary: RuntimeTaskSessionSummary,
): string {
	const identity = summary.agentNativeConversationSessionIdentity;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	return JSON.stringify([
		summary.taskId,
		summary.agentId,
		summary.workspacePath,
		summary.startedAt,
		summary.runtimeSessionIncarnationId,
		identity?.sourceAgentId,
		identity?.nativeSessionId,
		identity?.transcriptPath,
		endpoint?.socketPath,
		endpoint?.workspaceId,
		endpoint?.conversationSessionId,
		endpoint?.runtimeSessionIncarnationId,
	]);
}
