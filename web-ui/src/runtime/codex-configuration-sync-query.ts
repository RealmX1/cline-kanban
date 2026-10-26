import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	CodexConfigurationResolveConflictRequest,
	CodexConfigurationResolveTargetConflictRequest,
	CodexConfigurationSynchronizeRequest,
} from "@/runtime/types";

const invalidationListeners = new Set<() => void>();
export function notifyCodexConfigurationSyncUpdated() {
	for (const listener of invalidationListeners) listener();
}
export function subscribeCodexConfigurationSyncUpdated(listener: () => void) {
	invalidationListeners.add(listener);
	return () => {
		invalidationListeners.delete(listener);
	};
}
export const fetchCodexConfigurationSyncState = (workspaceId: string | null) =>
	getRuntimeTrpcClient(workspaceId).runtime.getCodexConfigurationSyncState.query();
export const synchronizeCodexConfigurationChange = (
	workspaceId: string | null,
	input: CodexConfigurationSynchronizeRequest,
) => getRuntimeTrpcClient(workspaceId).runtime.synchronizeCodexConfigurationChange.mutate(input);
export const resolveCodexConfigurationConflict = (
	workspaceId: string | null,
	input: CodexConfigurationResolveConflictRequest,
) => getRuntimeTrpcClient(workspaceId).runtime.resolveCodexConfigurationConflict.mutate(input);
export const acknowledgeCodexConfigurationChange = (
	workspaceId: string | null,
	input: { changeId: string; expectedVersion: number; idempotencyKey: string },
) => getRuntimeTrpcClient(workspaceId).runtime.acknowledgeCodexConfigurationChange.mutate(input);
export const resolveCodexConfigurationTargetConflict = (
	workspaceId: string | null,
	input: CodexConfigurationResolveTargetConflictRequest,
) => getRuntimeTrpcClient(workspaceId).runtime.resolveCodexConfigurationTargetConflict.mutate(input);
