import { randomUUID } from "node:crypto";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import { getNotificationLifecycleArchive } from "./notification-lifecycle-archive";

// 保留证据正文，但不保存认证字段。不能把整个环境变量对象交给此入口。
export function redactNotificationEvidence(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactNotificationEvidence);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/api.?key|authorization|password|access.?token|refresh.?token|secret|signature/iu.test(key)
					? "[redacted]"
					: redactNotificationEvidence(item),
			]),
		);
	if (typeof value === "string" && /^[\s]*[[{]/u.test(value)) {
		try {
			return JSON.stringify(redactNotificationEvidence(JSON.parse(value)));
		} catch {
			/* 非 JSON 正文继续按文本脱敏。 */
		}
	}
	if (typeof value === "string")
		return value
			.replace(/(Bearer\s+)\S+/giu, "$1[redacted]")
			.replace(/((?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]");
	return value;
}
export function reportNotificationArchiveFailure(): void {
	logAgentSessionRetentionWarning(
		"notification-archive-incomplete: 通知留档失败；保留基础提醒，暂停本次 AI 静默筛选。",
	);
}
export async function captureNotificationSignal(input: {
	workspaceId: string;
	taskId: string;
	sourceKind: string;
	rawPayload: unknown;
	candidateId?: string;
	userTurnKind?: string;
	triggeredAt?: number;
}): Promise<string | null> {
	try {
		const candidateId = input.candidateId ?? randomUUID();
		const archive = getNotificationLifecycleArchive();
		const existing = await archive.get(candidateId);
		if (
			existing &&
			(existing.candidate.workspaceId !== input.workspaceId || existing.candidate.taskId !== input.taskId)
		)
			throw new Error("Notification identity mismatch");
		await archive.capture({
			...input,
			candidateId,
			triggeredAt: input.triggeredAt ?? Date.now(),
			userTurnKind: input.userTurnKind ?? "review",
			rawPayload: redactNotificationEvidence(input.rawPayload),
		});
		return candidateId;
	} catch {
		reportNotificationArchiveFailure();
		return null;
	}
}
export async function recordNotificationSignalDecision(
	candidateId: string | null | undefined,
	eventType: string,
	details: unknown,
	excluded = false,
): Promise<void> {
	if (!candidateId) return;
	try {
		const archive = getNotificationLifecycleArchive();
		const current = excluded ? await archive.get(candidateId) : null;
		const mayExclude = excluded && current?.candidate.notificationProcessingStatus === "captured";
		await archive.update(
			candidateId,
			mayExclude ? { notificationProcessingStatus: "excluded", notificationPanelVisibility: "excluded" } : {},
			eventType,
			redactNotificationEvidence(details),
		);
	} catch {
		reportNotificationArchiveFailure();
	}
}
