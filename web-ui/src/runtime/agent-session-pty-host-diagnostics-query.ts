import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

const diagnosticsInvalidationListeners = new Set<() => void>();
export const fetchAgentSessionPtyHostDiagnostics = (workspaceId: string | null) =>
	getRuntimeTrpcClient(workspaceId).runtime.getAgentSessionPtyHostDiagnostics.query();

export function notifyAgentSessionPtyHostDiagnosticsUpdated(): void {
	for (const listener of diagnosticsInvalidationListeners) listener();
}

export function subscribeToAgentSessionPtyHostDiagnosticsUpdates(listener: () => void): () => void {
	diagnosticsInvalidationListeners.add(listener);
	return () => {
		diagnosticsInvalidationListeners.delete(listener);
	};
}
