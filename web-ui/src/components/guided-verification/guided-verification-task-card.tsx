import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { Check, CheckCircle2, GitCommit, Plus, X } from "lucide-react";
import { type ReactElement, useState } from "react";

import {
	boardColumnBadgeClassName,
	formatBoardColumnLabel,
	formatDeployTimestamp,
	shortenCommitSha,
} from "@/components/guided-verification/guided-verification-format";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeGuidedVerificationTask } from "@/runtime/types";
import type { BoardColumnId } from "@/types";

export interface GuidedVerificationTaskCardProps {
	task: RuntimeGuidedVerificationTask;
	taskTitle: string;
	// 当前实际所在列（getTaskColumnId）；null = 任务已不在看板（可能已删除）。
	currentColumnId: BoardColumnId | null;
	// active 组可交互；history 组只读快照。
	interactive: boolean;
	isCompleting: boolean;
	onToggleChecklistItem: (itemId: string, checked: boolean) => void;
	onAddCustomChecklistItem: (label: string) => void;
	onRemoveCustomChecklistItem: (itemId: string) => void;
	onRequestComplete: () => void;
	onSelectTask: () => void;
}

export function GuidedVerificationTaskCard({
	task,
	taskTitle,
	currentColumnId,
	interactive,
	isCompleting,
	onToggleChecklistItem,
	onAddCustomChecklistItem,
	onRemoveCustomChecklistItem,
	onRequestComplete,
	onSelectTask,
}: GuidedVerificationTaskCardProps): ReactElement {
	const [customDraft, setCustomDraft] = useState("");
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
		<div className="rounded-md border border-border bg-surface-1 p-2">
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

			{/* checklist */}
			<div className="mt-2 space-y-1">
				{task.checklist.map((item) => (
					<div key={item.id} className="group/item flex items-center gap-2">
						<RadixCheckbox.Root
							checked={item.checked}
							disabled={!checklistInteractive || isCompleting}
							onCheckedChange={(next) => onToggleChecklistItem(item.id, next === true)}
							className="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-default disabled:opacity-50"
						>
							<RadixCheckbox.Indicator>
								<Check size={11} className="text-white" />
							</RadixCheckbox.Indicator>
						</RadixCheckbox.Root>
						<span
							className={`flex-1 text-[12px] ${item.checked ? "text-text-tertiary line-through" : "text-text-secondary"}`}
						>
							{item.label}
						</span>
						{checklistInteractive && item.source === "custom" ? (
							<Tooltip content="移除自定义核对项">
								<button
									type="button"
									aria-label="移除自定义核对项"
									onClick={() => onRemoveCustomChecklistItem(item.id)}
									className="shrink-0 cursor-pointer text-text-tertiary opacity-0 transition-opacity hover:text-status-red group-hover/item:opacity-100"
								>
									<X size={12} />
								</button>
							</Tooltip>
						) : null}
					</div>
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
