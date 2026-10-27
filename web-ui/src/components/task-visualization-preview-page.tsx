import { useEffect } from "react";
import { TaskVisualizationArtifactsPanel } from "@/components/detail-panels/task-visualization-artifacts-panel";
import { useTaskVisualizationArtifacts } from "@/hooks/use-task-visualization-artifacts";

export function TaskVisualizationPreviewPage() {
	const query = new URLSearchParams(window.location.search);
	const workspaceId = query.get("workspaceId");
	const taskId = query.get("taskId") ?? "";
	const artifactId = query.get("visualizationArtifactId");
	const requestedRevisionId = query.get("revisionId");
	const controller = useTaskVisualizationArtifacts({ workspaceId, taskId, observeBrowser: false });
	const taskTitle = controller.taskAttribution?.taskTitle;
	useEffect(() => {
		const previousTitle = document.title;
		document.title = `任务 ${taskId}${taskTitle ? ` · ${taskTitle}` : ""} · 可视化`;
		return () => {
			document.title = previousTitle;
		};
	}, [taskId, taskTitle]);
	if (!workspaceId || !taskId)
		return (
			<p role="alert" className="p-4">
				可视化链接缺少任务归属。
			</p>
		);
	return (
		<main className="flex h-dvh min-h-0 flex-col">
			<header className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-3 text-sm">
				<a href="/" className="text-accent hover:underline">
					返回看板
				</a>
				<span>任务可视化</span>
			</header>
			<TaskVisualizationArtifactsPanel
				workspaceId={workspaceId}
				taskId={taskId}
				controller={controller}
				initialSelection={
					artifactId === null
						? undefined
						: { visualizationArtifactId: artifactId, revisionId: requestedRevisionId ?? undefined }
				}
			/>
		</main>
	);
}
