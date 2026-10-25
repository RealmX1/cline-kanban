import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveRecordedCodexConversationHome } from "../codex-conversation-storage/codex-conversation-storage-home";
import { resolveRuntimeAgentSessionTransportFromSummary } from "../core/agent-catalog";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	doesConversationSessionBelongToTask,
	resolveMainTaskConversationSessionId,
} from "../core/task-main-conversation-session-binding";
import {
	type TaskMainSessionHandoverExistingTargetBinding,
	taskMainSessionHandoverExistingPeerAgentIdSchema,
	taskMainSessionHandoverExistingTargetBindingSchema,
} from "../core/task-main-session-handover-contract";
import { TaskMainSessionHandoverExecutionProhibitedError } from "./codex-main-session-handover-native-fork";

export function getTaskMainSessionHandoverExistingPeerUnavailableReason(
	card: RuntimeBoardCard,
	target: RuntimeTaskSessionSummary,
): string | null {
	if (!doesConversationSessionBelongToTask(target, card.id)) return "会话不属于当前任务。";
	if (target.taskId === resolveMainTaskConversationSessionId(card)) return "当前主会话不能接任自身。";
	const metadata = target.taskConversationSessionMetadata;
	if (
		metadata?.taskConversationSessionRole !== "task_collaborator" ||
		metadata.taskConversationSessionRoleAtCreation === "by_the_way"
	)
		return "仅可写 peer 或前主会话可以接任。";
	if (!taskMainSessionHandoverExistingPeerAgentIdSchema.safeParse(target.agentId).success)
		return "当前 Agent 不支持既有 peer 接任。";
	if (
		target.agentNativeConversationSessionIdentity?.sourceAgentId !== target.agentId ||
		!target.agentNativeConversationSessionIdentity.nativeSessionId.trim()
	)
		return "等待可靠的原生会话身份。";
	if (!target.workspacePath) return "等待可靠的工作目录。";
	if (!metadata.taskConversationSessionLaunchSettings) return "等待该会话的独立启动设置。";
	return null;
}

export function captureTaskMainSessionHandoverExistingTargetBinding(
	workspaceId: string,
	card: RuntimeBoardCard,
	target: RuntimeTaskSessionSummary,
): TaskMainSessionHandoverExistingTargetBinding {
	const unavailableReason = getTaskMainSessionHandoverExistingPeerUnavailableReason(card, target);
	if (unavailableReason) throw new Error(unavailableReason);
	return taskMainSessionHandoverExistingTargetBindingSchema.parse({
		workspaceId,
		workspaceTaskId: card.id,
		taskConversationSessionId: target.taskId,
		agentId: target.agentId,
		nativeSessionId: target.agentNativeConversationSessionIdentity?.nativeSessionId,
		workingDirectoryPath: resolve(target.workspacePath as string),
		sessionTransport: resolveRuntimeAgentSessionTransportFromSummary(target),
		taskConversationMode: target.taskConversationMode ?? "operational",
		launchSettingsSnapshot: JSON.parse(
			JSON.stringify(target.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings ?? null),
		),
		codexConversationStorageHomeDirectoryPath:
			target.agentId === "codex"
				? resolveRecordedCodexConversationHome({
						...target,
						transcriptPath: target.agentNativeConversationSessionIdentity?.transcriptPath,
					})
				: undefined,
	});
}

export function assertTaskMainSessionHandoverExistingTargetBinding(input: {
	workspaceId: string;
	card: RuntimeBoardCard;
	binding: TaskMainSessionHandoverExistingTargetBinding;
	target: RuntimeTaskSessionSummary | null | undefined;
}): asserts input is typeof input & { target: RuntimeTaskSessionSummary } {
	const { workspaceId, card, binding, target } = input;
	if (!target) throw new Error("等待已固定 peer 的会话记录，未改选其他会话。");
	if (
		workspaceId !== binding.workspaceId ||
		card.id !== binding.workspaceTaskId ||
		target.taskId !== binding.taskConversationSessionId ||
		target.agentId !== binding.agentId ||
		!doesConversationSessionBelongToTask(target, card.id) ||
		target.taskConversationSessionMetadata?.taskConversationSessionRoleAtCreation === "by_the_way" ||
		target.agentNativeConversationSessionIdentity?.sourceAgentId !== binding.agentId ||
		target.agentNativeConversationSessionIdentity.nativeSessionId !== binding.nativeSessionId ||
		!target.workspacePath ||
		resolve(target.workspacePath) !== binding.workingDirectoryPath ||
		resolveRuntimeAgentSessionTransportFromSummary(target) !== binding.sessionTransport ||
		(binding.taskConversationMode !== undefined &&
			(target.taskConversationMode ?? "operational") !== binding.taskConversationMode) ||
		!isDeepStrictEqual(
			JSON.parse(
				JSON.stringify(target.taskConversationSessionMetadata?.taskConversationSessionLaunchSettings ?? null),
			),
			binding.launchSettingsSnapshot,
		)
	)
		throw new TaskMainSessionHandoverExecutionProhibitedError(
			"已固定 peer 的归属、原生身份、工作目录、通道、会话模式或启动设置已改变，停止交接。",
		);
}
