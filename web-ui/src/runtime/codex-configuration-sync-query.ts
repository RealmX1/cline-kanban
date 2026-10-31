import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	CodexConfigurationBatchActionRequest,
	CodexConfigurationChangeDetailsRequest,
	CodexConfigurationProfileMutationRequest,
	CodexConfigurationResolveConflictRequest,
	CodexConfigurationResolveTargetConflictRequest,
	CodexConfigurationSynchronizeRequest,
} from "@/runtime/types";

export const mutateCodexConfigurationProfile = (
	workspaceId: string | null,
	input: CodexConfigurationProfileMutationRequest,
) => getRuntimeTrpcClient(workspaceId).runtime.mutateCodexConfigurationProfile.mutate(input);

export const batchCodexConfigurationAction = (
	workspaceId: string | null,
	input: CodexConfigurationBatchActionRequest,
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.batchCodexConfigurationAction.mutate(input, {
		signal,
		context: {
			sendAsIndependentHttpRequest:
				(input.action === "confirm_source" || input.action === "defer") &&
				input.items.every((item) => item.entryKind === "source_observation"),
		},
	});

type ConfigurationSyncInvalidationReason = "state_updated" | "runtime_reconnected";
const invalidationListeners = new Set<(reason: ConfigurationSyncInvalidationReason) => void>();
export function notifyCodexConfigurationSyncUpdated(reason: ConfigurationSyncInvalidationReason = "state_updated") {
	for (const listener of invalidationListeners) listener(reason);
}
export function subscribeCodexConfigurationSyncUpdated(
	listener: (reason: ConfigurationSyncInvalidationReason) => void,
) {
	invalidationListeners.add(listener);
	return () => {
		invalidationListeners.delete(listener);
	};
}
export const fetchCodexConfigurationSyncState = (workspaceId: string | null, signal?: AbortSignal) =>
	getRuntimeTrpcClient(workspaceId).runtime.getCodexConfigurationSyncState.query(undefined, {
		signal,
		context: { sendAsIndependentHttpRequest: true },
	});
export const fetchCodexConfigurationChangeDetails = (
	workspaceId: string | null,
	input: CodexConfigurationChangeDetailsRequest,
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.getCodexConfigurationChangeDetails.query(input, {
		signal,
		context: { sendAsIndependentHttpRequest: true },
	});
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
