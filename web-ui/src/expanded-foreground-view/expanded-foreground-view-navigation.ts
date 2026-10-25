export interface ExpandedForegroundViewTaskIdentity {
	workspaceId: string;
	taskId: string;
	taskIncarnationCreatedAtEpochMs: number;
}

export type ExpandedForegroundViewTarget = ExpandedForegroundViewTaskIdentity &
	(
		| { viewKind: "task_relations" | "exploration_thread_graph" }
		| { viewKind: "task_visualization"; visualizationArtifactId?: string; revisionId?: string }
	);

const PARAMETER_NAMES = [
	"expandedView",
	"expandedWorkspaceId",
	"expandedTaskId",
	"expandedTaskIncarnationCreatedAtEpochMs",
	"expandedVisualizationArtifactId",
	"expandedVisualizationRevisionId",
] as const;

function relativeUrl(url: URL): string {
	return `${url.pathname}${url.search}${url.hash}`;
}

export function removeExpandedForegroundViewFromUrl(input: string): string {
	const url = new URL(input, "http://kanban.local");
	for (const name of PARAMETER_NAMES) url.searchParams.delete(name);
	return relativeUrl(url);
}

export function buildExpandedForegroundViewUrl(input: string, target: ExpandedForegroundViewTarget): string {
	const url = new URL(removeExpandedForegroundViewFromUrl(input), "http://kanban.local");
	url.searchParams.set("expandedView", target.viewKind);
	url.searchParams.set("expandedWorkspaceId", target.workspaceId);
	url.searchParams.set("expandedTaskId", target.taskId);
	url.searchParams.set("expandedTaskIncarnationCreatedAtEpochMs", String(target.taskIncarnationCreatedAtEpochMs));
	if (target.viewKind === "task_visualization") {
		if (target.visualizationArtifactId)
			url.searchParams.set("expandedVisualizationArtifactId", target.visualizationArtifactId);
		if (target.revisionId) url.searchParams.set("expandedVisualizationRevisionId", target.revisionId);
	}
	return relativeUrl(url);
}

export function parseExpandedForegroundViewTarget(input: string): {
	target: ExpandedForegroundViewTarget | null;
	error: string | null;
} {
	const params = new URL(input, "http://kanban.local").searchParams;
	const viewKind = params.get("expandedView");
	if (!viewKind) return { target: null, error: null };
	const workspaceId = params.get("expandedWorkspaceId") ?? "";
	const taskId = params.get("expandedTaskId")?.trim() ?? "";
	const incarnationText = params.get("expandedTaskIncarnationCreatedAtEpochMs");
	const taskIncarnationCreatedAtEpochMs = Number(incarnationText);
	if (
		PARAMETER_NAMES.some((name) => params.getAll(name).length > 1) ||
		!["task_relations", "exploration_thread_graph", "task_visualization"].includes(viewKind) ||
		!workspaceId.match(/^[a-zA-Z0-9_-]+$/u) ||
		!taskId ||
		!incarnationText ||
		!Number.isSafeInteger(taskIncarnationCreatedAtEpochMs) ||
		taskIncarnationCreatedAtEpochMs < 0
	)
		return { target: null, error: "前台视图链接缺少有效的内容类型或完整任务身份。" };
	const identity = { workspaceId, taskId, taskIncarnationCreatedAtEpochMs };
	if (viewKind === "task_relations" || viewKind === "exploration_thread_graph") {
		return { target: { ...identity, viewKind }, error: null };
	}
	const visualizationArtifactId = params.get("expandedVisualizationArtifactId") ?? undefined;
	const revisionId = params.get("expandedVisualizationRevisionId") ?? undefined;
	if (revisionId && !visualizationArtifactId) return { target: null, error: "可视化修订缺少产物归属。" };
	return { target: { ...identity, viewKind: "task_visualization", visualizationArtifactId, revisionId }, error: null };
}

export function expandedForegroundViewContentIdentity(target: ExpandedForegroundViewTarget): string {
	return JSON.stringify([target.viewKind, target.workspaceId, target.taskId, target.taskIncarnationCreatedAtEpochMs]);
}
