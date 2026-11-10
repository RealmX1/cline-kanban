import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

let declareSubscription: ((subscribed: boolean) => void) | null = null;
export function attachPtyHostDiagnosticsSubscriptionSender(sender: (subscribed: boolean) => void): () => void {
	declareSubscription = sender;
	sender(diagnosticsInvalidationListeners.size > 0);
	return () => {
		if (declareSubscription === sender) declareSubscription = null;
	};
}

const diagnosticsInvalidationListeners = new Set<() => void>();
export const fetchAgentSessionPtyHostDiagnostics = (workspaceId: string | null) =>
	getRuntimeTrpcClient(workspaceId).runtime.getAgentSessionPtyHostDiagnostics.query();

export function notifyAgentSessionPtyHostDiagnosticsUpdated(): void {
	for (const listener of diagnosticsInvalidationListeners) listener();
}

export function subscribeToAgentSessionPtyHostDiagnosticsUpdates(listener: () => void): () => void {
	diagnosticsInvalidationListeners.add(listener);
	if (diagnosticsInvalidationListeners.size === 1) declareSubscription?.(true);
	return () => {
		diagnosticsInvalidationListeners.delete(listener);
		if (diagnosticsInvalidationListeners.size === 0) declareSubscription?.(false);
	};
}
