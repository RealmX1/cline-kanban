import { notifyError } from "@/components/app-toaster";
import {
	requestTaskProjectAssignmentAnalysis,
	type TaskProjectAssignmentAnalysis,
} from "@/runtime/task-analysis-query";
import { fetchWorkspaceState } from "@/runtime/workspace-state-query";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

export interface TaskProjectAssignmentDecisionRequest {
	requestId: string;
	title: string;
	analysis: TaskProjectAssignmentAnalysis | null;
	failureMessage: string | null;
	resolve: (choice: "keep" | "adopt" | "cancel") => void;
}
const listeners = new Set<() => void>();
let pendingDecisions: readonly TaskProjectAssignmentDecisionRequest[] = [];
const analysisRunsByInput = new Map<string, Promise<{ workspaceId: string; baseRef: string } | null>>();
const acceptedAnalysisByTask = new Map<string, string>();
export const subscribeToTaskProjectAssignmentDecisions = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
export const getPendingTaskProjectAssignmentDecisions = () => pendingDecisions;
const publish = () => {
	for (const listener of listeners) listener();
};
const taskInputKey = (workspaceId: string, title: string, prompt: string) =>
	JSON.stringify([workspaceId, title, prompt]);
export function rememberTaskProjectAssignmentAnalysisAccepted(
	workspaceId: string,
	taskId: string,
	title: string,
	prompt: string,
) {
	acceptedAnalysisByTask.set(`${workspaceId}:${taskId}`, taskInputKey(workspaceId, title, prompt));
}
export function hasAcceptedTaskProjectAssignmentAnalysis(
	workspaceId: string,
	taskId: string,
	title: string,
	prompt: string,
) {
	return acceptedAnalysisByTask.get(`${workspaceId}:${taskId}`) === taskInputKey(workspaceId, title, prompt);
}
export function invalidateAcceptedTaskProjectAssignmentAnalyses() {
	acceptedAnalysisByTask.clear();
}
if (typeof window !== "undefined")
	window.addEventListener("kanban-task-analysis-settings-saved", invalidateAcceptedTaskProjectAssignmentAnalyses);

function requestDecision(request: Omit<TaskProjectAssignmentDecisionRequest, "resolve">) {
	return new Promise<"keep" | "adopt" | "cancel">((resolve) => {
		pendingDecisions = [
			...pendingDecisions,
			{
				...request,
				resolve: (choice) => {
					pendingDecisions = pendingDecisions.filter((entry) => entry.requestId !== request.requestId);
					publish();
					resolve(choice);
				},
			},
		];
		publish();
	});
}

export function runTaskProjectAssignmentPreflight(input: {
	workspaceId: string;
	title: string;
	prompt: string;
	baseRef: string;
	isStillCurrent?: () => boolean;
}) {
	const key = JSON.stringify([input.workspaceId, input.title, input.prompt, input.baseRef]);
	const previous = analysisRunsByInput.get(key);
	if (previous) return previous;
	const run = (async () => {
		const operationId = createRandomUuidV4WithInsecureContextFallback();
		let analysis: TaskProjectAssignmentAnalysis | null = null;
		let failureMessage: string | null = null;
		try {
			analysis = await requestTaskProjectAssignmentAnalysis(input.workspaceId, {
				operationId,
				title: input.title,
				prompt: input.prompt,
			});
		} catch (error) {
			failureMessage = `项目归属分析失败：${error instanceof Error ? error.message : String(error)}`;
			notifyError(failureMessage);
		}
		if (input.isStillCurrent && !input.isStillCurrent()) return null;
		if (!failureMessage && !analysis?.suggestedWorkspaceId)
			return { workspaceId: input.workspaceId, baseRef: input.baseRef };
		const choice = await requestDecision({ requestId: operationId, title: input.title, analysis, failureMessage });
		if (choice === "cancel" || (input.isStillCurrent && !input.isStillCurrent())) return null;
		if (choice === "keep" || !analysis?.suggestedWorkspaceId)
			return { workspaceId: input.workspaceId, baseRef: input.baseRef };
		const target = await fetchWorkspaceState(analysis.suggestedWorkspaceId);
		const baseRef = target.git.branches.some((branch) => branch.name === input.baseRef)
			? input.baseRef
			: target.git.defaultBranch;
		if (!baseRef) throw new Error("建议项目没有可用基础分支，请手动选择。");
		return { workspaceId: analysis.suggestedWorkspaceId, baseRef };
	})();
	analysisRunsByInput.set(key, run);
	void run
		.finally(() => {
			if (analysisRunsByInput.get(key) === run) analysisRunsByInput.delete(key);
		})
		.catch(() => undefined);
	return run;
}
