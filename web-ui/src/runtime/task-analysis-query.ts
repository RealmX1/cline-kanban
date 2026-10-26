import type { RuntimeAppRouterInputs, RuntimeAppRouterOutputs } from "@runtime-trpc";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export type TaskAnalysisExecutorSettings = RuntimeAppRouterOutputs["support"]["getGlobalExecutorSettings"];
export type TaskProjectAssignmentAnalysis = RuntimeAppRouterOutputs["support"]["analyzeTaskProjectAssignment"];
export const readGlobalTaskAnalysisExecutorSettings = () =>
	getRuntimeTrpcClient(null).support.getGlobalExecutorSettings.query();
export const saveGlobalTaskAnalysisExecutorSettings = async (settings: TaskAnalysisExecutorSettings) => {
	const saved = await getRuntimeTrpcClient(null).support.setGlobalExecutorSettings.mutate(settings);
	window.dispatchEvent(new Event("kanban-task-analysis-settings-saved"));
	return saved;
};
export const requestTaskProjectAssignmentAnalysis = (
	workspaceId: string,
	request: RuntimeAppRouterInputs["support"]["analyzeTaskProjectAssignment"],
) => getRuntimeTrpcClient(workspaceId).support.analyzeTaskProjectAssignment.mutate(request);
