import { useCallback, useEffect } from "react";
import {
	fetchAgentSessionPtyHostDiagnostics,
	subscribeToAgentSessionPtyHostDiagnosticsUpdates,
} from "@/runtime/agent-session-pty-host-diagnostics-query";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export function useAgentSessionPtyHostDiagnostics(enabled: boolean, workspaceId: string | null) {
	const queryFn = useCallback(() => fetchAgentSessionPtyHostDiagnostics(workspaceId), [workspaceId]);
	const query = useTrpcQuery({ enabled, queryFn, retainDataOnError: false });
	const refetch = query.refetch;
	useEffect(() => {
		if (!enabled) return;
		return subscribeToAgentSessionPtyHostDiagnosticsUpdates(() => {
			void refetch();
		});
	}, [enabled, refetch]);
	return query;
}
