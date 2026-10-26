import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type { DirectlyRelatedTaskPreviewEntry } from "@runtime-work-unit-relation-read-api-contract";
import { useEffect, useRef, useState } from "react";
import { useCrossProjectRecentlyActiveTaskSwitcherHostContext } from "@/components/detail-panels/cross-project-recently-active-task-switcher-host-context";
import { TaskCardBody } from "@/components/task-card-body";
import { buildTaskCardBusinessProps } from "@/components/task-card-business-props";
import { Spinner } from "@/components/ui/spinner";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import { useQualifiedTaskCardSnapshotForRelatedPreview } from "@/hooks/use-qualified-task-card-snapshot-for-related-preview";
import { fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries } from "@/runtime/cross-project-task-worktree-git-metadata-query";
import { buildQualifiedTaskPreviewIdentityKey } from "@/runtime/directly-related-task-preview-query";
import { useTaskCardActionCommandKindInFlight } from "@/stores/task-card-action-commands-in-flight-store";
import { toTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";
import type { ReviewTaskWorkspaceSnapshot } from "@/types";

export function RelatedTaskPreviewFullTaskCard({
	task,
	workspaceRepositoryPath,
	onOpen,
	onCurrentMetadataChanged,
}: {
	task: KanbanBoardCardWorkUnitQualifiedReference;
	workspaceRepositoryPath: string | null;
	onOpen: () => void;
	onCurrentMetadataChanged?: (
		task: KanbanBoardCardWorkUnitQualifiedReference,
		metadata: Pick<DirectlyRelatedTaskPreviewEntry, "title" | "lastKnownBoardColumnId">,
	) => void;
}) {
	const host = useCrossProjectRecentlyActiveTaskSwitcherHostContext();
	const { workspaceId, taskId } = task;
	const project = host?.projects.find((candidate) => candidate.id === workspaceId);
	const broadcastEntry = project?.crossProjectTaskSwitcherEntries?.find(
		(candidate) => candidate.taskId === taskId && candidate.createdAt === task.taskIncarnationCreatedAtEpochMs,
	);
	const commandInFlight = useTaskCardActionCommandKindInFlight(workspaceId, taskId);
	const previousCommand = useRef(commandInFlight);
	const [completedCommandCount, setCompletedCommandCount] = useState(0);
	useEffect(() => {
		if (previousCommand.current && !commandInFlight) setCompletedCommandCount((count) => count + 1);
		previousCommand.current = commandInFlight;
	}, [commandInFlight]);
	const load = useQualifiedTaskCardSnapshotForRelatedPreview(
		task,
		JSON.stringify([
			broadcastEntry?.title,
			broadcastEntry?.columnId,
			broadcastEntry?.turnOwner,
			broadcastEntry?.liveness,
			broadcastEntry?.userTurnKind,
			completedCommandCount,
		]),
	);
	const isDocumentVisible = useDocumentVisibility();
	const identityKey = buildQualifiedTaskPreviewIdentityKey(task);
	const taskIncarnationCreatedAtEpochMs = task.taskIncarnationCreatedAtEpochMs;
	const currentProjectId = host?.currentProjectId ?? null;
	const canReadGitMetadata = Boolean(
		isDocumentVisible &&
			load.snapshot &&
			!load.error &&
			load.snapshot.taskCard.createdAt === taskIncarnationCreatedAtEpochMs &&
			load.snapshot.boardColumnIdContainingTaskCard !== "backlog",
	);
	const [identityBoundGitSnapshot, setIdentityBoundGitSnapshot] = useState<{
		identityKey: string;
		snapshot: ReviewTaskWorkspaceSnapshot | null;
	} | null>(null);
	useEffect(() => {
		setIdentityBoundGitSnapshot(null);
		if (!canReadGitMetadata) return;
		let obsolete = false;
		let pollInFlight = false;
		// 只给当前卡按需查询；不把缺创建时间的共享 store 当作身份绑定证据。
		const pollGitMetadata = async () => {
			if (pollInFlight) return;
			pollInFlight = true;
			try {
				const response = await fetchTaskWorktreeGitMetadataForCrossProjectTaskSwitcherEntries(currentProjectId, {
					tasks: [{ workspaceId, taskId }],
				});
				if (obsolete) return;
				const result = response.tasks.find(
					(candidate) => candidate.workspaceId === workspaceId && candidate.taskId === taskId,
				);
				setIdentityBoundGitSnapshot({
					identityKey,
					snapshot:
						result?.availability === "available" &&
						result.taskIncarnationCreatedAtEpochMs === taskIncarnationCreatedAtEpochMs &&
						result.taskWorkspaceMetadata.taskId === taskId
							? toTaskWorkspaceSnapshot(result.taskWorkspaceMetadata)
							: null,
				});
			} catch {
				if (!obsolete) setIdentityBoundGitSnapshot(null);
			} finally {
				pollInFlight = false;
			}
		};
		void pollGitMetadata();
		const pollingTimer = window.setInterval(() => void pollGitMetadata(), 5_000);
		return () => {
			obsolete = true;
			window.clearInterval(pollingTimer);
		};
	}, [canReadGitMetadata, currentProjectId, identityKey, workspaceId, taskId, taskIncarnationCreatedAtEpochMs]);
	const snapshot = load.snapshot;
	useEffect(() => {
		if (snapshot)
			onCurrentMetadataChanged?.(task, {
				title: snapshot.taskCard.title,
				lastKnownBoardColumnId: snapshot.boardColumnIdContainingTaskCard,
			});
	}, [snapshot, task, onCurrentMetadataChanged]);
	return (
		<section aria-label="完整任务卡片预览" className="min-w-0 p-3" data-related-full-task-card-preview="">
			<div className="mb-3 flex items-center justify-between gap-2 text-xs text-text-secondary">
				<span className="truncate">
					{project?.name ?? workspaceId} · {taskId}
				</span>
				{host?.onOpenRelationsVisualizationForTask ? (
					<button
						type="button"
						onClick={() => host.onOpenRelationsVisualizationForTask?.(task)}
						className="shrink-0 rounded px-2 py-1 text-accent hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
					>
						关系图
					</button>
				) : null}
				<button
					type="button"
					onClick={onOpen}
					className="shrink-0 rounded px-2 py-1 text-accent hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
				>
					打开任务
				</button>
			</div>
			{load.isLoading && !snapshot ? (
				<p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
					<Spinner size={12} />
					正在加载完整卡片…
				</p>
			) : null}
			{load.error ? (
				<div role="status" className="mb-3 text-xs text-text-secondary">
					<p className="break-words">{load.error}</p>
					<button type="button" onClick={load.retry} className="mt-1 text-accent hover:underline">
						重试加载卡片
					</button>
				</div>
			) : null}
			{snapshot ? (
				<fieldset disabled={Boolean(load.error)} className="min-w-0 border-0 p-0">
					<TaskCardBody
						{...buildTaskCardBusinessProps({
							card: snapshot.taskCard,
							columnId: snapshot.boardColumnIdContainingTaskCard,
							sessionSummary:
								snapshot.taskSessionSummaryLiveInRuntimeProcessMemory ??
								snapshot.taskSessionSummaryPersistedInWorkspaceSessionsFile ??
								undefined,
							handlers:
								host?.otherProjectTaskCardActionHandlers?.buildTaskCardActionHandlerBundleForOtherProjectTaskCard(
									{
										workspaceId,
										taskCard: snapshot.taskCard,
										boardColumnIdContainingTaskCard: snapshot.boardColumnIdContainingTaskCard,
										taskCardActionCommandKindInFlight: commandInFlight,
									},
								) ?? {},
							onActivateCard: onOpen,
							workspacePath: workspaceRepositoryPath,
							defaultAgentId: host?.defaultAgentId ?? null,
						})}
						onClick={onOpen}
						renderRole="task_card_copy_in_related_task_preview"
						taskCardOwnedByOtherProjectWorkspaceId={workspaceId}
						relatedTaskPreviewWorktreeGitMetadataSnapshot={
							canReadGitMetadata && identityBoundGitSnapshot?.identityKey === identityKey
								? identityBoundGitSnapshot.snapshot
								: null
						}
					/>
				</fieldset>
			) : null}
		</section>
	);
}
