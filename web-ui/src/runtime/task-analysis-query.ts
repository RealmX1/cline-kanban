import type { RuntimeAppRouterInputs, RuntimeAppRouterOutputs } from "@runtime-trpc";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export type TaskAssistanceModelProviderRoutingSettings =
	RuntimeAppRouterOutputs["support"]["getTaskAssistanceModelProviderRoutingSettings"];
export type TaskProjectAssignmentAnalysis = RuntimeAppRouterOutputs["support"]["analyzeTaskProjectAssignment"];
export const readGlobalTaskAssistanceModelProviderRoutingSettings = () =>
	getRuntimeTrpcClient(null).support.getTaskAssistanceModelProviderRoutingSettings.query();
export const saveGlobalTaskAssistanceModelProviderRoutingSettings = async (
	settings: TaskAssistanceModelProviderRoutingSettings,
) => {
	const saved =
		await getRuntimeTrpcClient(null).support.setTaskAssistanceModelProviderRoutingSettings.mutate(settings);
	window.dispatchEvent(new Event("kanban-task-analysis-settings-saved"));
	return saved;
};
export const requestTaskProjectAssignmentAnalysis = (
	workspaceId: string,
	request: RuntimeAppRouterInputs["support"]["analyzeTaskProjectAssignment"],
	abortSignal?: AbortSignal,
) => getRuntimeTrpcClient(workspaceId).support.analyzeTaskProjectAssignment.mutate(request, { signal: abortSignal });
