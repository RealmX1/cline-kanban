import type {
	AcpConnectionRuntimeHandlers,
	AcpStartingTaskSessionProcessOwnership,
	AcpTaskConnection,
	AcpTaskConnectionStartInput,
} from "../acp-client-session/acp-client-connection-runtime";
import type {
	RuntimeAgentSessionTransport,
	RuntimeStructuredConversationExecutionCapabilities,
} from "../core/api-contract";

// 复用现有内容、工具及决策投影；原生实现不发送 ACP 握手或伪报协议版本。
export type StructuredAgentConversationTaskConnection = Omit<AcpTaskConnection, "initializeResponse">;

export interface StructuredAgentConversationConnectionRuntime {
	getConnection(taskId: string): StructuredAgentConversationTaskConnection | null;
	getStartingTaskSessionProcessOwnership?(taskId: string): AcpStartingTaskSessionProcessOwnership | null;
	isReplayingPersistedConversationHistory(taskId: string): boolean;
	startTaskConnection(input: AcpTaskConnectionStartInput): Promise<StructuredAgentConversationTaskConnection>;
	disposeTaskConnection(taskId: string): void;
	disposeAllTaskConnections(): void;
	stopTaskConnectionAndConfirmExit(
		taskId: string,
		options?: { gracefulTimeoutMs?: number; forcefulTimeoutMs?: number },
	): Promise<{ rootPid: number | null; rootProcessExitConfirmed: boolean; usedForcefulEscalation: boolean }>;
}

export interface StructuredAgentConversationBackendDefinition {
	sessionTransport: RuntimeAgentSessionTransport;
	capabilities: RuntimeStructuredConversationExecutionCapabilities;
	createConnectionRuntime(handlers: AcpConnectionRuntimeHandlers): StructuredAgentConversationConnectionRuntime;
}
