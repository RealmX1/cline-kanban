import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "./agent-catalog";
import type { RuntimeTaskSessionSummary } from "./api-contract";
import {
	type TaskMainSessionHandoverAgentId,
	taskMainSessionHandoverAgentIdSchema,
} from "./task-main-session-handover-contract";

export function isTaskMainSessionHandoverAgentSupported(agentId: unknown): agentId is TaskMainSessionHandoverAgentId {
	return (
		taskMainSessionHandoverAgentIdSchema.safeParse(agentId).success &&
		isRuntimeAgentLaunchSupported(agentId as TaskMainSessionHandoverAgentId)
	);
}

export function getTaskMainSessionHandoverNativeForkAvailability(
	source: RuntimeTaskSessionSummary,
	targetAgentId: TaskMainSessionHandoverAgentId,
) {
	const identity = source.agentNativeConversationSessionIdentity;
	const unavailableReason =
		source.agentId !== targetAgentId
			? "完整原生复刻需要来源与目标使用同一 Agent；跨 Agent 请使用交接材料。"
			: !["claude", "codex", "omp"].includes(targetAgentId)
				? "当前 Agent 不支持完整原生复刻，请使用交接材料。"
				: identity?.sourceAgentId !== targetAgentId || !source.workspacePath
					? "等待可靠的原生身份与工作目录；全新上下文仍可使用。"
					: (targetAgentId === "claude" || targetAgentId === "omp") && !identity.transcriptPath
						? "等待可靠的原生转录路径；全新上下文仍可使用。"
						: null;
	return { available: unavailableReason === null, unavailableReason };
}

export function listTaskMainSessionHandoverTargetCapabilities(source: RuntimeTaskSessionSummary) {
	return taskMainSessionHandoverAgentIdSchema.options
		.filter(isTaskMainSessionHandoverAgentSupported)
		.map((agentId) => ({
			agentId,
			label: getRuntimeAgentCatalogEntry(agentId)?.label ?? agentId,
			installationStatus: "unknown" as const,
			completeNativeConversationForkAvailability: getTaskMainSessionHandoverNativeForkAvailability(source, agentId),
		}));
}
