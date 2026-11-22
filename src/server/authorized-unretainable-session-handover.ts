import type {
	AuthorizedUnretainableHandoverSession,
	AuthorizedUnretainableSessionHandover,
} from "../core/api-contract";

export function normalizeHandoverProcessStartTimeText(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

export function interruptedSessionIdentityKey(session: AuthorizedUnretainableHandoverSession): string {
	return JSON.stringify([
		session.sessionKind,
		session.workspaceId,
		session.conversationSessionId,
		session.processId,
		session.nativeConversationSessionId,
		session.runtimeSessionIncarnationId,
	]);
}

export type AuthorizedUnretainableSessionHandoverDecision = "allow" | "refuse" | "unbound";

/**
 * 没有绑定时保持旧布尔语义。带上预检绑定时，只允许仍是那一代 runtime，
 * 且当前会被退出打断的会话都已经在预检清单里。新出现的会话必须拒绝，已自然退出的会话不必仍在。
 */
export function decideAuthorizedUnretainableSessionHandover(input: {
	allowInterruption: boolean;
	binding: AuthorizedUnretainableSessionHandover | undefined;
	currentProcessId: number;
	currentProcessStartTimeText: string | null;
	currentSessions: readonly AuthorizedUnretainableHandoverSession[];
}): AuthorizedUnretainableSessionHandoverDecision {
	if (!input.allowInterruption || !input.binding) return "unbound";
	if (input.binding.runtimeProcessId !== input.currentProcessId) return "refuse";
	if (!input.currentProcessStartTimeText) return "refuse";
	if (
		normalizeHandoverProcessStartTimeText(input.currentProcessStartTimeText) !==
		normalizeHandoverProcessStartTimeText(input.binding.runtimeProcessStartTimeText)
	)
		return "refuse";
	const authorized = new Set(input.binding.interruptedSessions.map(interruptedSessionIdentityKey));
	return input.currentSessions.every((session) => authorized.has(interruptedSessionIdentityKey(session)))
		? "allow"
		: "refuse";
}

/**
 * 在线诊断只有明确给出 true，才表示该 runtime 会执行预检绑定。
 * 缺省是旧服务：它按冻结契约忽略未知字段，仍只看布尔值。
 */
export function liveRuntimeEnforcesAuthorizedUnretainableSessionHandoverBinding(diagnostic: {
	enforcesAuthorizedUnretainableSessionHandoverBinding?: unknown;
}): boolean {
	return diagnostic.enforcesAuthorizedUnretainableSessionHandoverBinding === true;
}

/**
 * 已验收基线会固定报告绑定字段，但没有专用 procedure。
 * 只有正在应答的本 build 才把这项标成 true。
 */
export function liveRuntimeAcceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions(diagnostic: {
	acceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions?: unknown;
	enforcesAuthorizedUnretainableSessionHandoverBinding?: unknown;
}): boolean {
	return diagnostic.acceptsPlannedHandoverRestartWithAuthorizedUnretainableSessions === true;
}

export function plannedRedeploymentHandoverDispatch(input: {
	allowInterruption: boolean;
	receiverAcceptsDedicatedProcedure: boolean;
	blockingSessionCount: number;
}): "wait_for_unretainable_sessions" | "send_dedicated_binding" | "send_default_protected_handover" {
	if (input.allowInterruption && input.receiverAcceptsDedicatedProcedure) return "send_dedicated_binding";
	if (input.allowInterruption && input.blockingSessionCount > 0) return "wait_for_unretainable_sessions";
	return "send_default_protected_handover";
}

export function plannedHandoverInterruptionDecision(input: {
	allowInterruption: boolean;
	binding: AuthorizedUnretainableSessionHandover | undefined;
	currentProcessId: number;
	currentProcessStartTimeText: string | null;
	currentSessions: readonly AuthorizedUnretainableHandoverSession[];
	countedSessionsThatWouldEnd: number;
}): { outcome: "start" } | { outcome: "start_bound"; runtimeProcessStartTimeText: string } | { outcome: "refuse" } {
	if (!input.binding) {
		return !input.allowInterruption && input.countedSessionsThatWouldEnd > 0
			? { outcome: "refuse" }
			: { outcome: "start" };
	}
	// 计数提示有会话没列出来时，没有完整的身份清单可供授权核对。
	if (input.currentSessions.length < input.countedSessionsThatWouldEnd) return { outcome: "refuse" };
	const decision = decideAuthorizedUnretainableSessionHandover({
		allowInterruption: true,
		binding: input.binding,
		currentProcessId: input.currentProcessId,
		currentProcessStartTimeText: input.currentProcessStartTimeText,
		currentSessions: input.currentSessions,
	});
	if (decision !== "allow" || !input.currentProcessStartTimeText) return { outcome: "refuse" };
	return { outcome: "start_bound", runtimeProcessStartTimeText: input.currentProcessStartTimeText };
}
