import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	CodexConfigurationBatchActionRequest,
	CodexConfigurationChangeDetailsRequest,
	CodexConfigurationMutationReceiptRequest,
	CodexConfigurationProfileMutationRequest,
	CodexConfigurationResolveConflictRequest,
	CodexConfigurationResolveTargetConflictRequest,
	CodexConfigurationSynchronizeRequest,
} from "@/runtime/types";

export const mutateCodexConfigurationProfile = (
	workspaceId: string | null,
	input: CodexConfigurationProfileMutationRequest,
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.mutateCodexConfigurationProfile.mutate(
		{
			...input,
			stateResponseScope: "overview",
		},
		{ signal },
	);

export const batchCodexConfigurationAction = (
	workspaceId: string | null,
	input: CodexConfigurationBatchActionRequest,
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.batchCodexConfigurationAction.mutate(
		{ ...input, stateResponseScope: "overview" },
		{
			signal,
			context: {
				sendAsIndependentHttpRequest:
					(input.action === "confirm_source" || input.action === "defer") &&
					input.items.every((item) => item.entryKind === "source_observation"),
			},
		},
	);

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
	getRuntimeTrpcClient(workspaceId).runtime.getCodexConfigurationSyncOverview.query(undefined, {
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
) =>
	getRuntimeTrpcClient(workspaceId).runtime.synchronizeCodexConfigurationChange.mutate({
		...input,
		stateResponseScope: "overview",
	});
export const resolveCodexConfigurationConflict = (
	workspaceId: string | null,
	input: CodexConfigurationResolveConflictRequest,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.resolveCodexConfigurationConflict.mutate({
		...input,
		stateResponseScope: "overview",
	});
export const acknowledgeCodexConfigurationChange = (
	workspaceId: string | null,
	input: { changeId: string; expectedVersion: number; idempotencyKey: string },
) =>
	getRuntimeTrpcClient(workspaceId).runtime.acknowledgeCodexConfigurationChange.mutate({
		...input,
		stateResponseScope: "overview",
	});
export const resolveCodexConfigurationTargetConflict = (
	workspaceId: string | null,
	input: CodexConfigurationResolveTargetConflictRequest,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.resolveCodexConfigurationTargetConflict.mutate({
		...input,
		stateResponseScope: "overview",
	});

export const fetchCodexConfigurationSyncHistory = (
	workspaceId: string | null,
	input: { category?: "all" | "settings" | "sources"; search?: string; limit?: number; cursor?: string },
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.listCodexConfigurationSyncHistory.query(input, {
		signal,
		context: { sendAsIndependentHttpRequest: true },
	});
export const fetchCodexConfigurationSourceObservation = (
	workspaceId: string | null,
	observationId: string,
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.getCodexConfigurationSourceObservation.query(
		{ observationId },
		{ signal, context: { sendAsIndependentHttpRequest: true } },
	);
export const fetchCodexConfigurationMutationReceipt = (
	workspaceId: string | null,
	input: CodexConfigurationMutationReceiptRequest,
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.getCodexConfigurationMutationReceipt.query(input, {
		signal,
		context: { sendAsIndependentHttpRequest: true },
	});

export const fetchCodexConfigurationSessionAdoptionProgress = (
	workspaceId: string | null,
	input: { profileId?: string; workspaceId?: string; conversationSessionId?: string; limit?: number; cursor?: string },
	signal?: AbortSignal,
) =>
	getRuntimeTrpcClient(workspaceId).runtime.listCodexConfigurationSessionAdoptionProgress.query(input, {
		signal,
		context: { sendAsIndependentHttpRequest: true },
	});
