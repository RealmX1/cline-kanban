import { CheckCircle2, GitCommit, Plus } from "lucide-react";
import { type ReactElement, useState } from "react";

import { PostDeployVerificationChecklistItem } from "@/components/post-deploy-verification/post-deploy-verification-checklist-item";
import {
	boardColumnBadgeClassName,
	formatBoardColumnLabel,
	formatDeployTimestamp,
	shortenCommitSha,
} from "@/components/post-deploy-verification/post-deploy-verification-format";
import {
	spotlightAnchor,
	VERIFICATION_ANCHOR_ATTR,
	verificationPanelTaskAnchorKey,
} from "@/components/post-deploy-verification/verification-anchor-registry";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimePostDeployVerificationChecklistItem, RuntimePostDeployVerificationTask } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

export interface PostDeployVerificationTaskCardProps {
	task: RuntimePostDeployVerificationTask;
	taskTitle: string;
	// 当前实际所在列（getTaskColumnId）；null = 任务已不在看板（可能已删除）。
	currentColumnId: BoardColumnId | null;
	// active 组可交互；history 组只读快照。
	interactive: boolean;
	isCompleting: boolean;
	onToggleChecklistItem: (itemId: string, checked: boolean) => void;
	onAddCustomChecklistItem: (label: string) => void;
	onRemoveCustomChecklistItem: (itemId: string) => void;
	onRunVerificationItem: (itemId: string) => void;
	onRequestComplete: () => void;
	onSelectTask: () => void;
	// 「定位并核对」中 anchor.view==="board" 时导航回看板（App 提供 setSelectedTaskId(null)）。
	onNavigateToBoard: () => void;
}

// spotlight 需在导航切换视图后目标元素挂载完成才生效；视图切换是异步渲染，故延后一帧再定位。
const SPOTLIGHT_AFTER_NAVIGATION_DELAY_MS = 80;

export function PostDeployVerificationTaskCard({
	task,
	taskTitle,
	currentColumnId,
	interactive,
	isCompleting,
	onToggleChecklistItem,
	onAddCustomChecklistItem,
	onRemoveCustomChecklistItem,
	onRunVerificationItem,
	onRequestComplete,
	onSelectTask,
	onNavigateToBoard,
}: PostDeployVerificationTaskCardProps): ReactElement {
	const [customDraft, setCustomDraft] = useState("");

	// 「定位并核对」：按 anchor.view 导航（task_detail=本任务详情 / board=看板），随后 spotlight 目标元素。
	// 降级：无 anchor 时把面板内本任务卡滚入视野并高亮（至少让用户知道核对哪个任务）。
	const handleLocate = (item: RuntimePostDeployVerificationChecklistItem): void => {
		const anchor = item.guidance?.anchor ?? null;
		if (anchor?.view === "task_detail") {
			onSelectTask();
		} else if (anchor?.view === "board") {
			onNavigateToBoard();
		}
		const anchorKey = anchor?.anchorKey ?? verificationPanelTaskAnchorKey(task.taskId);
		window.setTimeout(() => spotlightAnchor(anchorKey), SPOTLIGHT_AFTER_NAVIGATION_DELAY_MS);
	};
	const isVerified = task.verifiedAt !== null;
	const isDropped = task.droppedReason !== null;
	const allChecked = task.checklist.length > 0 && task.checklist.every((item) => item.checked);
	// 完成按钮：仅 active 组、未核对、未移除、仍在看板、全勾时可见。
	const canComplete = interactive && !isVerified && !isDropped && allChecked && currentColumnId !== null;
	// 交互态：active 组未核对未移除时可勾选；history / 已核对 / 已移除 一律只读。
	const checklistInteractive = interactive && !isVerified && !isDropped;

	const handleAddCustom = (): void => {
		const trimmed = customDraft.trim();
		if (!trimmed) {
			return;
		}
		onAddCustomChecklistItem(trimmed);
		setCustomDraft("");
	};

	return (
		<div
			className="rounded-md border border-border bg-surface-1 p-2"
			{...{ [VERIFICATION_ANCHOR_ATTR]: verificationPanelTaskAnchorKey(task.taskId) }}
		>
			<div className="flex items-start justify-between gap-2">
				<button
					type="button"
					onClick={onSelectTask}
					className="min-w-0 flex-1 cursor-pointer truncate text-left text-[13px] font-medium text-text-primary hover:text-accent-hover"
					title={taskTitle}
				>
					{taskTitle}
				</button>
				{isDropped ? (
					<span className="shrink-0 rounded-sm border border-status-red/30 bg-status-red/10 px-1.5 py-0.5 text-[11px] text-status-red">
						已移除
					</span>
				) : currentColumnId ? (
					<span
						className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[11px] ${boardColumnBadgeClassName(currentColumnId)}`}
					>
						{formatBoardColumnLabel(currentColumnId)}
					</span>
				) : null}
			</div>

			{/* 关联提示：validation 列免 commit 关联；review / in_progress 展示 matched commits */}
			<div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-text-tertiary">
				{task.inclusionReason === "validation_column" ? (
					<span>纳入原因：Validation 列</span>
				) : (
					<>
						<GitCommit size={11} />
						{task.matchedCommits.length > 0 ? (
							task.matchedCommits.map((sha) => (
								<span key={sha} className="font-mono">
									{shortenCommitSha(sha)}
								</span>
							))
						) : (
							<span>无关联提交</span>
						)}
					</>
				)}
			</div>

			{isDropped ? (
				<p className="m-0 mt-1.5 text-[11px] italic text-text-tertiary">
					{task.droppedReason === "task_deleted" ? "任务已从看板删除" : "任务已被手动移出核对"}
				</p>
			) : null}

			{/* checklist：automated_script 项渲染运行按钮 + 状态徽标，其余渲染 checkbox（组件内分发） */}
			<div className="mt-2 space-y-1">
				{task.checklist.map((item) => (
					<PostDeployVerificationChecklistItem
						key={item.id}
						item={item}
						interactive={checklistInteractive}
						isCompleting={isCompleting}
						taskVerified={isVerified}
						onToggle={(checked) => onToggleChecklistItem(item.id, checked)}
						onRun={() => onRunVerificationItem(item.id)}
						onRemoveCustom={() => onRemoveCustomChecklistItem(item.id)}
						onLocate={() => handleLocate(item)}
					/>
				))}
				{task.checklist.length === 0 ? <p className="m-0 text-[12px] italic text-text-tertiary">无核对项</p> : null}
			</div>

			{/* 自定义核对项录入（仅可交互态） */}
			{checklistInteractive ? (
				<div className="mt-2 flex items-center gap-1.5">
					<input
						type="text"
						value={customDraft}
						onChange={(event) => setCustomDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								handleAddCustom();
							}
						}}
						placeholder="添加自定义核对项"
						className="h-6 flex-1 rounded-sm border border-border bg-surface-2 px-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<Button
						size="xs"
						variant="ghost"
						icon={<Plus size={12} />}
						disabled={customDraft.trim().length === 0}
						onClick={handleAddCustom}
						aria-label="添加自定义核对项"
					/>
				</div>
			) : null}

			{/* 已核对：Done 子区展示 */}
			{isVerified ? (
				<div className="mt-2 flex items-center gap-1.5 text-[11px] text-status-green">
					<CheckCircle2 size={12} />
					<span>已核对 · {formatDeployTimestamp(task.verifiedAt ?? "")}</span>
					{task.boardMovedToDoneAt === null ? (
						<span className="text-status-orange">（未移入看板 Done）</span>
					) : null}
				</div>
			) : null}

			{/* 完成核对 → 移入 Done */}
			{canComplete ? (
				<div className="mt-2">
					<Button
						size="sm"
						variant="danger"
						fill
						disabled={isCompleting}
						icon={isCompleting ? <Spinner size={14} /> : <CheckCircle2 size={14} />}
						onClick={onRequestComplete}
					>
						完成核对并移入 Done
					</Button>
					<p className="m-0 mt-1 text-center text-[11px] text-text-tertiary">完成后将停止会话并清理 worktree</p>
				</div>
			) : null}
		</div>
	);
}
