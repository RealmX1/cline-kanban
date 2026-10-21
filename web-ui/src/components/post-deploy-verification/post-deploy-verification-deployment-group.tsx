import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ClipboardList } from "lucide-react";
import type { ReactElement } from "react";

import {
	countPostDeployVerificationTasksAwaitingVerification,
	groupActiveDeploymentGroupTasksByDeploymentAttributionZone,
	isPostDeployVerificationTaskAwaitingVerification,
	POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_ATTRIBUTION_ZONE_SECTION_TITLE,
	POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_ATTRIBUTION_ZONES_IN_PANEL_ORDER,
	readTaskDeploymentAttributionOrNullWhenNotYetComputed,
} from "@/components/post-deploy-verification/post-deploy-verification-active-deployment-group-tasks-grouped-by-deployment-attribution-zone";
import { resolveTaskTitleForPostDeployVerificationPanel } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-task-entries-from-read-model-and-board";
import { shortenCommitSha } from "@/components/post-deploy-verification/post-deploy-verification-format";
import {
	PostDeployVerificationTaskEntryWrappingRealTaskCard,
	type RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries,
} from "@/components/post-deploy-verification/post-deploy-verification-task-entry-wrapping-real-task-card";
import { Button } from "@/components/ui/button";
import type {
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationTask,
	RuntimePostDeployVerificationTaskDeploymentAttributionZone,
} from "@/runtime/types";
import { getTaskColumnId } from "@/state/board-state";
import type { BoardData } from "@/types";
import type { TaskCardMoveIntoDoneRequestHandler } from "@/types/task-card-move-into-done-request";

export interface PostDeployVerificationDeploymentGroupTaskEntryActions {
	completingTaskId: string | null;
	onToggleChecklistItem: (deploymentId: string, taskId: string, itemId: string, checked: boolean) => void;
	onAddCustomChecklistItem: (deploymentId: string, taskId: string, label: string) => void;
	onRemoveCustomChecklistItem: (deploymentId: string, taskId: string, itemId: string) => void;
	onRunVerificationItem: (deploymentId: string, taskId: string, itemId: string) => void;
	onRequestComplete: (
		deploymentId: string,
		taskId: string,
		options?: Parameters<TaskCardMoveIntoDoneRequestHandler>[1],
	) => void;
	onSelectTask: (taskId: string) => void;
	onNavigateToBoard: () => void;
	onCreateFollowUpTaskFromChecklistItems?: (
		deploymentId: string,
		taskId: string,
		selectedChecklistItemIds: string[],
	) => void;
}

interface PostDeployVerificationDeploymentGroupSharedProps {
	group: RuntimePostDeployVerificationDeploymentGroup;
	board: BoardData;
	realTaskCardRenderingInputs: RealTaskCardRenderingInputsForPostDeployVerificationPanelEntries | null;
	retainedDeploymentGroupsByDeploymentId: ReadonlyMap<string, RuntimePostDeployVerificationDeploymentGroup>;
	taskEntryActions: PostDeployVerificationDeploymentGroupTaskEntryActions;
}

function renderTaskEntry(
	props: PostDeployVerificationDeploymentGroupSharedProps,
	task: RuntimePostDeployVerificationTask,
	options: { interactive: boolean; checklistInitiallyExpanded: boolean },
): ReactElement {
	const { group, taskEntryActions } = props;
	return (
		<PostDeployVerificationTaskEntryWrappingRealTaskCard
			key={`${group.deploymentId}:${task.taskId}`}
			postDeployVerificationTask={task}
			board={props.board}
			realTaskCardRenderingInputs={props.realTaskCardRenderingInputs}
			retainedDeploymentGroupsByDeploymentId={props.retainedDeploymentGroupsByDeploymentId}
			interactive={options.interactive}
			checklistInitiallyExpanded={options.checklistInitiallyExpanded}
			isCompleting={taskEntryActions.completingTaskId === task.taskId}
			onToggleChecklistItem={(itemId, checked) =>
				taskEntryActions.onToggleChecklistItem(group.deploymentId, task.taskId, itemId, checked)
			}
			onAddCustomChecklistItem={(label) =>
				taskEntryActions.onAddCustomChecklistItem(group.deploymentId, task.taskId, label)
			}
			onRemoveCustomChecklistItem={(itemId) =>
				taskEntryActions.onRemoveCustomChecklistItem(group.deploymentId, task.taskId, itemId)
			}
			onRunVerificationItem={(itemId) =>
				taskEntryActions.onRunVerificationItem(group.deploymentId, task.taskId, itemId)
			}
			onRequestComplete={(options) => taskEntryActions.onRequestComplete(group.deploymentId, task.taskId, options)}
			onSelectTask={() => taskEntryActions.onSelectTask(task.taskId)}
			onNavigateToBoard={taskEntryActions.onNavigateToBoard}
			onCreateFollowUpTaskFromSelectedChecklistItems={
				taskEntryActions.onCreateFollowUpTaskFromChecklistItems
					? (itemIds) =>
							taskEntryActions.onCreateFollowUpTaskFromChecklistItems?.(group.deploymentId, task.taskId, itemIds)
					: undefined
			}
		/>
	);
}

// 批量带原因结案的候选：仍待核对、卡还在看板上且不在 Done。
export function listTaskIdsEligibleForBatchClosureWithReasons(
	tasks: readonly RuntimePostDeployVerificationTask[],
	board: BoardData,
): string[] {
	return tasks
		.filter((task) => {
			if (!isPostDeployVerificationTaskAwaitingVerification(task)) {
				return false;
			}
			const columnId = getTaskColumnId(board, task.taskId);
			return columnId !== null && columnId !== "trash";
		})
		.map((task) => task.taskId);
}

const ZONES_OFFERING_BATCH_CLOSURE_WITH_REASONS: ReadonlySet<RuntimePostDeployVerificationTaskDeploymentAttributionZone> =
	new Set([
		"task_commits_deployed_only_in_earlier_deployments_awaiting_verification",
		"task_commits_not_yet_deployed_or_task_unattributable",
	]);

export interface PostDeployVerificationActiveDeploymentGroupZoneSectionsProps
	extends PostDeployVerificationDeploymentGroupSharedProps {
	onRequestBatchClosureWithReasonsOfZoneTasks: (deploymentId: string, taskIds: string[]) => void;
	isBatchClosureWithReasonsInFlight: boolean;
}

// 活跃组按部署归属分三区。只有第一区默认展开；Radix Collapsible 收起时**不挂载**内容，折叠区里的
// 真实卡体（每张都订阅推流 store）因此不占每标签页内存。第二、三区标题提供「批量带原因结案」。
export function PostDeployVerificationActiveDeploymentGroupZoneSections(
	props: PostDeployVerificationActiveDeploymentGroupZoneSectionsProps,
): ReactElement {
	const { group, board, onRequestBatchClosureWithReasonsOfZoneTasks, isBatchClosureWithReasonsInFlight } = props;
	const { tasksByDeploymentAttributionZone, tasksAlreadyInDoneColumnIncludedAsReadOnly } =
		groupActiveDeploymentGroupTasksByDeploymentAttributionZone(group.tasks);

	return (
		<div className="space-y-2">
			{POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_ATTRIBUTION_ZONES_IN_PANEL_ORDER.map((zone, zoneIndex) => {
				const zoneTasks = tasksByDeploymentAttributionZone[zone];
				const isFirstZone = zoneIndex === 0;
				const taskIdsEligibleForBatchClosure = ZONES_OFFERING_BATCH_CLOSURE_WITH_REASONS.has(zone)
					? listTaskIdsEligibleForBatchClosureWithReasons(zoneTasks, board)
					: [];
				return (
					<div key={zone}>
						<RadixCollapsible.Root
							defaultOpen={isFirstZone}
							data-post-deploy-verification-deployment-attribution-zone={zone}
							className="rounded-md border border-border bg-surface-1"
						>
							<div className="flex items-center gap-1 pr-1">
								<RadixCollapsible.Trigger asChild>
									<button
										type="button"
										className="group/zone-trigger flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left"
									>
										<ChevronDown
											size={14}
											className="shrink-0 -rotate-90 text-text-tertiary transition-transform group-data-[state=open]/zone-trigger:rotate-0"
										/>
										<span className="min-w-0 truncate text-[12px] font-semibold text-text-primary">
											{POST_DEPLOY_VERIFICATION_TASK_DEPLOYMENT_ATTRIBUTION_ZONE_SECTION_TITLE[zone]}
										</span>
										<span className="shrink-0 text-[11px] text-text-tertiary">
											待核对 {countPostDeployVerificationTasksAwaitingVerification(zoneTasks)} / 共{" "}
											{zoneTasks.length}
										</span>
									</button>
								</RadixCollapsible.Trigger>
								{taskIdsEligibleForBatchClosure.length > 0 ? (
									<Button
										size="xs"
										variant="ghost"
										icon={<ClipboardList size={12} />}
										disabled={isBatchClosureWithReasonsInFlight}
										onClick={() =>
											onRequestBatchClosureWithReasonsOfZoneTasks(
												group.deploymentId,
												taskIdsEligibleForBatchClosure,
											)
										}
										className="shrink-0"
									>
										批量带原因结案
									</Button>
								) : null}
							</div>
							<RadixCollapsible.Content className="space-y-1.5 border-t border-border p-1.5">
								{zoneTasks.length > 0 ? (
									zoneTasks.map((task) =>
										renderTaskEntry(props, task, {
											interactive: true,
											checklistInitiallyExpanded: isFirstZone,
										}),
									)
								) : (
									<p className="m-0 px-1 text-[12px] italic text-text-tertiary">
										{isFirstZone ? "本次部署没有归属到的任务" : "无任务"}
									</p>
								)}
							</RadixCollapsible.Content>
						</RadixCollapsible.Root>
						{isFirstZone && tasksAlreadyInDoneColumnIncludedAsReadOnly.length > 0 ? (
							<section className="mt-1.5 rounded-md border border-dashed border-border px-2 py-1.5">
								<h4 className="m-0 mb-1 text-[11px] font-semibold text-text-tertiary">
									本次部署还包含（已在 Done）（{tasksAlreadyInDoneColumnIncludedAsReadOnly.length}）
								</h4>
								<ul className="m-0 list-none space-y-0.5 p-0">
									{tasksAlreadyInDoneColumnIncludedAsReadOnly.map((task) => (
										<li
											key={task.taskId}
											data-post-deploy-verification-read-only-done-task={task.taskId}
											className="flex items-baseline gap-2 text-[12px]"
										>
											<span className="min-w-0 flex-1 truncate text-text-secondary">
												{resolveTaskTitleForPostDeployVerificationPanel(board, task.taskId)}
											</span>
											<span className="shrink-0 font-mono text-[11px] text-text-tertiary">
												{(
													readTaskDeploymentAttributionOrNullWhenNotYetComputed(task)
														?.matchedDeployedCommitsInThisDeploymentDelta ?? []
												)
													.map((matchedCommit) => shortenCommitSha(matchedCommit.deployedCommitSha))
													.join(" ")}
											</span>
										</li>
									))}
								</ul>
							</section>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

// 历史组：只读快照，任务照旧列出；已被延续到新组的未结案任务由条目徽标显示「已延续到下一部署」。
export function PostDeployVerificationHistoryDeploymentGroupTaskEntries(
	props: PostDeployVerificationDeploymentGroupSharedProps,
): ReactElement {
	if (props.group.tasks.length === 0) {
		return <p className="m-0 text-[12px] italic text-text-tertiary">无任务</p>;
	}
	return (
		<div className="space-y-1.5">
			{props.group.tasks.map((task) =>
				renderTaskEntry(props, task, { interactive: false, checklistInitiallyExpanded: false }),
			)}
		</div>
	);
}
