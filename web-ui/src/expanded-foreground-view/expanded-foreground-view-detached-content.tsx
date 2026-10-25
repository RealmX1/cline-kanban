import { useCallback } from "react";
import { TaskVisualizationArtifactsPanel } from "@/components/detail-panels/task-visualization-artifacts-panel";
import { WorkUnitRelationNeighborhoodPanel } from "@/components/detail-panels/work-unit-relation-neighborhood-panel";
import { ExplorationThreadGraphPanel } from "@/components/exploration-thread-graph/exploration-thread-graph-panel";
import { Button } from "@/components/ui/button";
import type { ExpandedForegroundViewTarget } from "@/expanded-foreground-view/expanded-foreground-view-navigation";
import { ExpandedForegroundViewSurface } from "@/expanded-foreground-view/expanded-foreground-view-surface";
import { useExpandedForegroundViewSurface } from "@/expanded-foreground-view/use-expanded-foreground-view-surface";
import { useRecoverableForegroundRead } from "@/expanded-foreground-view/use-recoverable-foreground-read";
import { useTaskVisualizationArtifacts } from "@/hooks/use-task-visualization-artifacts";
import { fetchExplorationThreadGraph } from "@/runtime/exploration-thread-graph-query";
import { fetchWorkspaceState } from "@/runtime/workspace-state-query";

function DetachedVisualization({
	target,
}: {
	target: ExpandedForegroundViewTarget & { viewKind: "task_visualization" };
}) {
	const controller = useTaskVisualizationArtifacts({
		workspaceId: target.workspaceId,
		taskId: target.taskId,
		observeBrowser: false,
	});
	return (
		<TaskVisualizationArtifactsPanel
			workspaceId={target.workspaceId}
			taskId={target.taskId}
			taskIncarnationCreatedAtEpochMs={target.taskIncarnationCreatedAtEpochMs}
			controller={controller}
			detachedForeground
		/>
	);
}

function DetachedExplorationMap({
	target,
	executionDisabled,
}: {
	target: ExpandedForegroundViewTarget;
	executionDisabled: boolean;
}) {
	const read = useCallback(
		(signal: AbortSignal) => fetchExplorationThreadGraph(target.workspaceId, target.taskId, signal),
		[target.workspaceId, target.taskId],
	);
	const result = useRecoverableForegroundRead({ identity: JSON.stringify(target), read, refreshIntervalMs: 10_000 });
	return (
		<ExplorationThreadGraphPanel
			workspaceId={target.workspaceId}
			explorationId={target.taskId}
			taskIncarnationCreatedAtEpochMs={target.taskIncarnationCreatedAtEpochMs}
			detachedForeground
			initiallyExpanded
			isTaskAgentExecutionDisabled={executionDisabled}
			onRefresh={result.refresh}
			readError={result.error}
			data={{
				queryPhase: result.loading ? "loading" : result.error ? "error" : "ready",
				view: result.value?.view ?? null,
				turnSourceUnavailableSessionIds: result.value?.turnSourceUnavailableSessionIds ?? [],
			}}
		/>
	);
}

export function ExpandedForegroundViewDetachedContent({ target }: { target: ExpandedForegroundViewTarget }) {
	const surface = useExpandedForegroundViewSurface(target, true);
	const read = useCallback(
		async (signal: AbortSignal) => {
			if (target.viewKind === "task_relations") return null;
			const workspace = await fetchWorkspaceState(target.workspaceId, signal);
			const column = workspace.board.columns.find((entry) =>
				entry.cards.some(
					(card) => card.id === target.taskId && card.createdAt === target.taskIncarnationCreatedAtEpochMs,
				),
			);
			if (!column)
				throw Object.assign(new Error("未找到这一世任务，原任务可能已删除或同 ID 已被重新使用。"), {
					data: { code: "NOT_FOUND" },
				});
			return { executionDisabled: column.id === "trash" };
		},
		[target.viewKind, target.workspaceId, target.taskId, target.taskIncarnationCreatedAtEpochMs],
	);
	const identity = useRecoverableForegroundRead({
		identity: JSON.stringify([target.workspaceId, target.taskId, target.taskIncarnationCreatedAtEpochMs]),
		read,
	});
	if (target.viewKind === "task_relations")
		return (
			<WorkUnitRelationNeighborhoodPanel
				workspaceId={target.workspaceId}
				kanbanBoardCardTaskId={target.taskId}
				taskIncarnationCreatedAtEpochMs={target.taskIncarnationCreatedAtEpochMs}
				initiallyExpanded
				detachedForeground
			/>
		);
	if (!identity.value)
		return (
			<ExpandedForegroundViewSurface controller={surface} title="任务前台视图" className="flex min-h-0 flex-col">
				<div className="p-4 text-sm" role={identity.error ? "alert" : "status"}>
					<p>{identity.error ?? "正在读取任务…"}</p>
					{identity.error ? (
						<Button className="mt-3" size="sm" onClick={identity.refresh}>
							重试读取
						</Button>
					) : null}
				</div>
			</ExpandedForegroundViewSurface>
		);
	return target.viewKind === "task_visualization" ? (
		<DetachedVisualization target={target} />
	) : (
		<DetachedExplorationMap target={target} executionDisabled={identity.value.executionDisabled} />
	);
}
