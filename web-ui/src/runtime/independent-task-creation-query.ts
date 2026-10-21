import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { IndependentTaskCreationDraftEdit } from "@/runtime/types";

export const independentTaskCreationClient = (workspaceId: string) =>
	getRuntimeTrpcClient(workspaceId).independentTaskCreation;
export const saveIndependentTaskCreationDraft = (workspaceId: string, input: IndependentTaskCreationDraftEdit) =>
	independentTaskCreationClient(workspaceId).saveDraft.mutate(input);

export async function loadIndependentTaskCreationProviders() {
	return (await getRuntimeTrpcClient(null).notificationIntelligence.getSettings.query()).providers;
}
