import type { ReactElement } from "react";

import { PostDeployVerificationTaskCard } from "@/components/post-deploy-verification/post-deploy-verification-task-card";
import type { RuntimePostDeployVerificationDeploymentGroup, RuntimePostDeployVerificationTask } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardColumnId, BoardData } from "@/types";
import { truncateTaskPromptLabel } from "@/utils/task-prompt";

export interface PostDeployVerificationDeploymentGroupProps {
	group: RuntimePostDeployVerificationDeploymentGroup;
	board: BoardData;
	// active 组可交互；history 组为只读快照。
	interactive: boolean;
	completingTaskId: string | null;
	onToggleChecklistItem: (deploymentId: string, taskId: string, itemId: string, checked: boolean) => void;
	onAddCustomChecklistItem: (deploymentId: string, taskId: string, label: string) => void;
	onRemoveCustomChecklistItem: (deploymentId: string, taskId: string, itemId: string) => void;
	onRunVerificationItem: (deploymentId: string, taskId: string, itemId: string) => void;
	onRequestComplete: (deploymentId: string, taskId: string) => void;
	onSelectTask: (taskId: string) => void;
	onNavigateToBoard: () => void;
}

// 任务归入待核对 / 已核对 / 已移除三桶（plan 面板三区）。
function partitionTasks(tasks: RuntimePostDeployVerificationTask[]): {
	pending: RuntimePostDeployVerificationTask[];
	done: RuntimePostDeployVerificationTask[];
	dropped: RuntimePostDeployVerificationTask[];
} {
	const pending: RuntimePostDeployVerificationTask[] = [];
	const done: RuntimePostDeployVerificationTask[] = [];
	const dropped: RuntimePostDeployVerificationTask[] = [];
	for (const task of tasks) {
		if (task.droppedReason !== null) {
			dropped.push(task);
		} else if (task.verifiedAt !== null) {
			done.push(task);
		} else {
			pending.push(task);
		}
	}
	return { pending, done, dropped };
}

export function PostDeployVerificationDeploymentGroup({
	group,
	board,
	interactive,
	completingTaskId,
	onToggleChecklistItem,
	onAddCustomChecklistItem,
	onRemoveCustomChecklistItem,
	onRunVerificationItem,
	onRequestComplete,
	onSelectTask,
	onNavigateToBoard,
}: PostDeployVerificationDeploymentGroupProps): ReactElement {
	const { pending, done, dropped } = partitionTasks(group.tasks);
	// 「没有 commit 关联任务」：本组零 commit_correlation 任务时明示（validation 列任务不受影响仍列出）。
	const hasCommitCorrelatedTask = group.tasks.some((task) => task.inclusionReason === "commit_correlation");

	const renderTaskCard = (task: RuntimePostDeployVerificationTask): ReactElement => {
		const selection = findCardSelection(board, task.taskId);
		const taskTitle =
			selection?.card.title || truncateTaskPromptLabel(selection?.card.prompt ?? "") || `任务 ${task.taskId}`;
		const currentColumnId: BoardColumnId | null = selection?.column.id ?? null;
		return (
			<PostDeployVerificationTaskCard
				key={task.taskId}
				task={task}
				taskTitle={taskTitle}
				currentColumnId={currentColumnId}
				interactive={interactive}
				isCompleting={completingTaskId === task.taskId}
				onToggleChecklistItem={(itemId, checked) =>
					onToggleChecklistItem(group.deploymentId, task.taskId, itemId, checked)
				}
				onAddCustomChecklistItem={(label) => onAddCustomChecklistItem(group.deploymentId, task.taskId, label)}
				onRemoveCustomChecklistItem={(itemId) =>
					onRemoveCustomChecklistItem(group.deploymentId, task.taskId, itemId)
				}
				onRunVerificationItem={(itemId) => onRunVerificationItem(group.deploymentId, task.taskId, itemId)}
				onRequestComplete={() => onRequestComplete(group.deploymentId, task.taskId)}
				onSelectTask={() => onSelectTask(task.taskId)}
				onNavigateToBoard={onNavigateToBoard}
			/>
		);
	};

	return (
		<div className="space-y-2">
			{!hasCommitCorrelatedTask ? (
				<p className="m-0 rounded-md border border-dashed border-border bg-surface-1 px-2 py-1.5 text-[12px] text-text-tertiary">
					没有 commit 关联任务
				</p>
			) : null}

			<section>
				<h4 className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
					待核对（{pending.length}）
				</h4>
				{pending.length > 0 ? (
					<div className="space-y-1.5">{pending.map(renderTaskCard)}</div>
				) : (
					<p className="m-0 text-[12px] italic text-text-tertiary">无待核对任务</p>
				)}
			</section>

			{done.length > 0 ? (
				<section>
					<h4 className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-status-green">
						已核对 / Done（{done.length}）
					</h4>
					<div className="space-y-1.5">{done.map(renderTaskCard)}</div>
				</section>
			) : null}

			{dropped.length > 0 ? (
				<section>
					<h4 className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
						已移除（{dropped.length}）
					</h4>
					<div className="space-y-1.5">{dropped.map(renderTaskCard)}</div>
				</section>
			) : null}
		</div>
	);
}
