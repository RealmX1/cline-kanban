import * as RadixCheckbox from "@radix-ui/react-checkbox";
import {
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	ClipboardList,
	GitBranchPlus,
	GitCommit,
	Plus,
} from "lucide-react";
import { type ReactElement, useEffect, useId, useState } from "react";

import {
	isPostDeployVerificationTaskAwaitingVerification,
	readCarriedForwardIntoDeploymentIdOrNull,
} from "@/components/post-deploy-verification/post-deploy-verification-active-deployment-group-tasks-grouped-by-deployment-attribution-zone";
import { PostDeployVerificationChecklistItem } from "@/components/post-deploy-verification/post-deploy-verification-checklist-item";
import { POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODE_PRESENTATION } from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-draft-and-closure-request-resolution";
import {
	boardColumnBadgeClassName,
	formatBoardColumnLabel,
	formatDeployTimestamp,
} from "@/components/post-deploy-verification/post-deploy-verification-format";
import {
	describePostDeployVerificationTaskDeploymentAttributionForPanelEntry,
	type PostDeployVerificationTaskDeploymentAttributionBadgeTone,
} from "@/components/post-deploy-verification/post-deploy-verification-task-deployment-attribution-badge-description";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type {
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationDeploymentGroup,
	RuntimePostDeployVerificationTask,
} from "@/runtime/types";
import type { BoardColumnId } from "@/types";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";

// PDV 面板任务条目的下半部分（wrapper 专有，任务本身的信息在上半部分的真实卡体里）：部署归属徽标、可折叠的
// 核对清单、自定义项录入、完成区 / 结案记录。

export interface PostDeployVerificationTaskEntryChecklistAndClosureSectionProps {
	postDeployVerificationTask: RuntimePostDeployVerificationTask;
	// 当前实际所在列；null = 卡已不在看板（被删）。
	currentBoardColumnIdOfTaskCard: BoardColumnId | null;
	retainedDeploymentGroupsByDeploymentId: ReadonlyMap<string, RuntimePostDeployVerificationDeploymentGroup>;
	// 活跃组可交互；历史组只读。
	interactive: boolean;
	// 第一区默认展开，其余区与历史组默认收起。
	checklistInitiallyExpanded: boolean;
	isCompleting: boolean;
	onToggleChecklistItem: (itemId: string, checked: boolean) => void;
	onAddCustomChecklistItem: (label: string) => void;
	onRemoveCustomChecklistItem: (itemId: string) => void;
	onRunVerificationItem: (itemId: string) => void;
	onRequestComplete: () => void;
	completionActionRendering?: "post_deploy_verification_panel" | "review_before_move_into_done";
	onRequestGuidedManualVerification?: (
		item: RuntimePostDeployVerificationChecklistItem,
		locate: () => void | Promise<void>,
	) => void;
	onLocateChecklistItem: (item: RuntimePostDeployVerificationChecklistItem) => void | Promise<void>;
	onCreateFollowUpTaskFromSelectedChecklistItems?: (selectedChecklistItemIds: string[]) => void;
}

const DEPLOYMENT_ATTRIBUTION_BADGE_TONE_CLASS_NAME: Record<
	PostDeployVerificationTaskDeploymentAttributionBadgeTone,
	string
> = {
	deployed_in_this_deployment: "border-status-green/30 bg-status-green/10 text-status-green",
	deployed_in_earlier_deployment: "border-status-orange/30 bg-status-orange/10 text-status-orange",
	not_yet_deployed_or_unattributable: "border-border bg-surface-3 text-text-tertiary",
	attribution_not_yet_computed: "border-border bg-surface-3 text-text-tertiary italic",
};

function PostDeployVerificationTaskEntryClosureRecord({
	postDeployVerificationTask: task,
}: {
	postDeployVerificationTask: RuntimePostDeployVerificationTask;
}): ReactElement | null {
	const closure = task.postDeployVerificationClosure ?? null;
	if (
		task.verifiedAt !== null &&
		(closure === null || closure.postDeployVerificationClosureOutcome === "all_checklist_items_checked")
	) {
		return (
			<div className="flex flex-wrap items-center gap-1.5 text-[11px] text-status-green">
				<CheckCircle2 size={12} />
				<span>已核对通过 · {formatDeployTimestamp(task.verifiedAt)}</span>
				{task.boardMovedToDoneAt === null ? <span className="text-status-orange">（未移入看板 Done）</span> : null}
			</div>
		);
	}
	if (closure === null) {
		return null;
	}
	const checklistItemLabelById = new Map(task.checklist.map((item) => [item.id, item.label]));
	return (
		<div
			data-post-deploy-verification-closure-outcome={closure.postDeployVerificationClosureOutcome}
			className="space-y-1"
		>
			<div className="flex items-center gap-1.5 text-[11px] text-status-orange">
				<ClipboardList size={12} />
				<span>带原因结案 · {formatDeployTimestamp(closure.closedAtIso)}</span>
			</div>
			<ul className="m-0 list-none space-y-1 p-0">
				{closure.uncheckedChecklistItemClosureReasons.map((closureReason) => (
					<li
						key={closureReason.checklistItemId}
						className="rounded-sm border border-border bg-surface-2 px-1.5 py-1"
					>
						<p className="m-0 min-w-0 break-words text-[11px] text-text-tertiary line-through">
							{checklistItemLabelById.get(closureReason.checklistItemId) ?? closureReason.checklistItemId}
						</p>
						<p className="m-0 min-w-0 break-words text-[11px] text-text-secondary">
							{
								POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODE_PRESENTATION[
									closureReason.uncheckedChecklistItemClosureReasonCode
								].closureReasonOptionLabel
							}
							{closureReason.uncheckedChecklistItemClosureReasonText
								? `：${closureReason.uncheckedChecklistItemClosureReasonText}`
								: null}
						</p>
					</li>
				))}
			</ul>
		</div>
	);
}

export function PostDeployVerificationTaskEntryChecklistAndClosureSection({
	postDeployVerificationTask: task,
	currentBoardColumnIdOfTaskCard,
	retainedDeploymentGroupsByDeploymentId,
	interactive,
	checklistInitiallyExpanded,
	isCompleting,
	onToggleChecklistItem,
	onAddCustomChecklistItem,
	onRemoveCustomChecklistItem,
	onRunVerificationItem,
	onRequestComplete,
	completionActionRendering = "post_deploy_verification_panel",
	onRequestGuidedManualVerification,
	onLocateChecklistItem,
	onCreateFollowUpTaskFromSelectedChecklistItems,
}: PostDeployVerificationTaskEntryChecklistAndClosureSectionProps): ReactElement {
	const [isChecklistExpanded, setIsChecklistExpanded] = useState(checklistInitiallyExpanded);
	const [customChecklistItemDraft, setCustomChecklistItemDraft] = useState("");
	const followUpContextSelectionIdPrefix = useId();
	const [isCustomChecklistItemInputExpanded, setIsCustomChecklistItemInputExpanded] = useState(false);
	const [followUpSelectedChecklistItemIds, setFollowUpSelectedChecklistItemIds] = useState<string[] | null>(null);

	const attributionBadge = describePostDeployVerificationTaskDeploymentAttributionForPanelEntry({
		postDeployVerificationTask: task,
		retainedDeploymentGroupsByDeploymentId,
	});
	const carriedForwardIntoDeploymentId = readCarriedForwardIntoDeploymentIdOrNull(task);
	const isDropped = task.droppedReason !== null;
	const isAwaitingVerification = isPostDeployVerificationTaskAwaitingVerification(task);
	const checkedChecklistItemCount = task.checklist.filter((item) => item.checked).length;
	const areAllChecklistItemsChecked = checkedChecklistItemCount === task.checklist.length;
	// 交互态：活跃组里、仍待核对（未结案未移除）、没被延续到别的组时才可勾选 / 运行 / 加自定义项。
	const isChecklistInteractive = interactive && isAwaitingVerification && carriedForwardIntoDeploymentId === null;
	// 完成区：仍在看板上（含已在 Done 但未结案的滞留态，走 controller 的恢复分支）才有按钮。
	const canRequestComplete = isChecklistInteractive && currentBoardColumnIdOfTaskCard !== null;
	const canCreateFollowUpTask =
		canRequestComplete &&
		currentBoardColumnIdOfTaskCard !== "trash" &&
		!!onCreateFollowUpTaskFromSelectedChecklistItems &&
		task.checklist.some((item) => !item.checked);
	const isSelectingFollowUpContext = canCreateFollowUpTask && followUpSelectedChecklistItemIds !== null;
	const selectedChecklistItemIds = task.checklist
		.filter((item) => !item.checked && followUpSelectedChecklistItemIds?.includes(item.id))
		.map((item) => item.id);
	useEffect(() => {
		setFollowUpSelectedChecklistItemIds((previous) => {
			if (!previous || !canCreateFollowUpTask) return null;
			const remaining = previous.filter((id) => task.checklist.some((item) => item.id === id && !item.checked));
			return remaining.length === previous.length ? previous : remaining;
		});
	}, [task.checklist, canCreateFollowUpTask]);

	const addCustomChecklistItem = (): void => {
		const trimmedLabel = customChecklistItemDraft.trim();
		if (!trimmedLabel) {
			return;
		}
		onAddCustomChecklistItem(trimmedLabel);
		setCustomChecklistItemDraft("");
		setIsCustomChecklistItemInputExpanded(false);
	};

	return (
		<div className="space-y-1.5 border-t border-border px-2 pb-2 pt-1.5">
			{/* 部署归属 + 所在列 */}
			<div className="flex flex-wrap items-center gap-1 text-[11px]">
				<span
					data-post-deploy-verification-deployment-attribution-badge-tone={
						attributionBadge.deploymentAttributionBadgeTone
					}
					className={cn(
						"rounded-sm border px-1.5 py-0.5",
						DEPLOYMENT_ATTRIBUTION_BADGE_TONE_CLASS_NAME[attributionBadge.deploymentAttributionBadgeTone],
					)}
				>
					{attributionBadge.deploymentAttributionPrimaryLabel}
				</span>
				{attributionBadge.matchedDeployedCommitShortShasInThisDeployment.length > 0 ? (
					<span className="inline-flex flex-wrap items-center gap-1 text-text-tertiary">
						<GitCommit size={11} />
						{attributionBadge.matchedDeployedCommitShortShasInThisDeployment.map((shortSha) => (
							<span key={shortSha} className="font-mono">
								{shortSha}
							</span>
						))}
					</span>
				) : null}
				{attributionBadge.deploymentsElapsedWhileAwaitingVerificationLabel ? (
					<span className="text-text-tertiary">
						{attributionBadge.deploymentsElapsedWhileAwaitingVerificationLabel}
					</span>
				) : null}
				<span className="ml-auto flex shrink-0 items-center gap-1">
					{carriedForwardIntoDeploymentId !== null ? (
						<span className="rounded-sm border border-status-blue/30 bg-status-blue/10 px-1.5 py-0.5 text-status-blue">
							已延续到下一部署
						</span>
					) : null}
					{isDropped ? (
						<span className="rounded-sm border border-status-red/30 bg-status-red/10 px-1.5 py-0.5 text-status-red">
							已移除
						</span>
					) : currentBoardColumnIdOfTaskCard ? (
						<span
							className={cn(
								"rounded-sm border px-1.5 py-0.5",
								boardColumnBadgeClassName(currentBoardColumnIdOfTaskCard),
							)}
						>
							{formatBoardColumnLabel(currentBoardColumnIdOfTaskCard)}
						</span>
					) : null}
				</span>
			</div>

			{isDropped ? (
				<p className="m-0 text-[11px] italic text-text-tertiary">
					{task.droppedReason === "task_deleted" ? "任务已从看板删除" : "任务已被手动移出核对"}
				</p>
			) : null}

			{/* 可折叠的核对清单 */}
			<div className="flex items-center gap-1">
				<button
					type="button"
					aria-expanded={isChecklistExpanded}
					onClick={() => setIsChecklistExpanded((expanded) => !expanded)}
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-[11px] text-text-secondary hover:text-text-primary"
				>
					{isChecklistExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
					<span>核对清单</span>
					<span className={areAllChecklistItemsChecked ? "text-status-green" : "text-text-tertiary"}>
						{checkedChecklistItemCount}/{task.checklist.length} 已核对
					</span>
				</button>
				{isChecklistInteractive && !isSelectingFollowUpContext ? (
					<Tooltip content="添加自定义核对项">
						<Button
							size="xs"
							variant="ghost"
							icon={<Plus size={12} />}
							aria-label="添加自定义核对项"
							disabled={isCompleting}
							onClick={() => {
								setIsChecklistExpanded(true);
								setIsCustomChecklistItemInputExpanded((value) => !value);
							}}
						/>
					</Tooltip>
				) : null}
				{canCreateFollowUpTask && !isSelectingFollowUpContext ? (
					<Tooltip content="从核对项新建后续任务">
						<Button
							size="xs"
							variant="ghost"
							icon={<GitBranchPlus size={12} />}
							aria-label="从核对项新建后续任务"
							disabled={isCompleting}
							onClick={() => {
								setIsChecklistExpanded(true);
								setIsCustomChecklistItemInputExpanded(false);
								setFollowUpSelectedChecklistItemIds([]);
							}}
						/>
					</Tooltip>
				) : null}
			</div>
			{isSelectingFollowUpContext ? (
				<div className="flex flex-wrap items-center gap-1 text-[11px]">
					<span className="min-w-0 flex-1 text-text-secondary">
						选择作为新任务上下文的核对项（已选 {selectedChecklistItemIds.length}）
					</span>
					<Button size="xs" variant="ghost" onClick={() => setFollowUpSelectedChecklistItemIds(null)}>
						取消
					</Button>
					<Button
						size="xs"
						disabled={selectedChecklistItemIds.length === 0 || isCompleting}
						onClick={() => {
							onCreateFollowUpTaskFromSelectedChecklistItems?.(selectedChecklistItemIds);
							setFollowUpSelectedChecklistItemIds(null);
						}}
					>
						下一步
					</Button>
				</div>
			) : null}
			{isChecklistExpanded ? (
				<div className="space-y-1">
					{task.checklist.map((item) =>
						isSelectingFollowUpContext ? (
							<label
								key={item.id}
								htmlFor={`${followUpContextSelectionIdPrefix}:${item.id}`}
								className="flex items-start gap-2 text-[12px] text-text-secondary"
							>
								<RadixCheckbox.Root
									id={`${followUpContextSelectionIdPrefix}:${item.id}`}
									aria-label={`选择核对项：${item.label}`}
									checked={selectedChecklistItemIds.includes(item.id)}
									disabled={item.checked || isCompleting}
									onCheckedChange={(checked) =>
										setFollowUpSelectedChecklistItemIds((previous) =>
											checked === true
												? [...(previous ?? []), item.id]
												: (previous ?? []).filter((id) => id !== item.id),
										)
									}
									className="mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-border-bright data-[state=checked]:bg-accent disabled:opacity-40"
								>
									<RadixCheckbox.Indicator>
										<Check size={11} className="text-white" />
									</RadixCheckbox.Indicator>
								</RadixCheckbox.Root>
								<span className="min-w-0 flex-1 break-words">
									{item.label}
									{item.checked ? "（已核对）" : ""}
								</span>
							</label>
						) : (
							<PostDeployVerificationChecklistItem
								key={item.id}
								item={item}
								interactive={isChecklistInteractive}
								isCompleting={isCompleting}
								taskVerified={task.verifiedAt !== null}
								onToggle={(checked) => onToggleChecklistItem(item.id, checked)}
								onRun={() => onRunVerificationItem(item.id)}
								onRemoveCustom={() => onRemoveCustomChecklistItem(item.id)}
								onLocate={() => onLocateChecklistItem(item)}
								onRequestGuidedManualVerification={onRequestGuidedManualVerification}
							/>
						),
					)}
					{task.checklist.length === 0 ? (
						<p className="m-0 text-[12px] italic text-text-tertiary">无核对项</p>
					) : null}
					{isChecklistInteractive && isCustomChecklistItemInputExpanded && !isSelectingFollowUpContext ? (
						<div className="flex items-center gap-1.5 pt-0.5">
							<input
								type="text"
								value={customChecklistItemDraft}
								onChange={(event) => setCustomChecklistItemDraft(event.target.value)}
								onKeyDown={(event) => {
									// 输入法组字期间，Enter 属于输入法本身（上屏字符原文），不该被当成「添加这一条」。
									if (isKeyboardEventEmittedDuringImeComposition(event)) {
										return;
									}
									if (event.key === "Enter") {
										event.preventDefault();
										addCustomChecklistItem();
									}
									if (event.key === "Escape") {
										event.preventDefault();
										event.stopPropagation();
										setIsCustomChecklistItemInputExpanded(false);
										setCustomChecklistItemDraft("");
									}
								}}
								placeholder="添加自定义核对项"
								ref={(element) => element?.focus()}
								className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-surface-2 px-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
							<Button
								size="xs"
								variant="ghost"
								icon={<Plus size={12} />}
								disabled={customChecklistItemDraft.trim().length === 0}
								onClick={addCustomChecklistItem}
								aria-label="保存自定义核对项"
								className="shrink-0"
							/>
						</div>
					) : null}
				</div>
			) : null}

			<PostDeployVerificationTaskEntryClosureRecord postDeployVerificationTask={task} />

			{canRequestComplete && !isSelectingFollowUpContext ? (
				<div>
					<Button
						size="sm"
						variant="danger"
						fill
						disabled={isCompleting}
						icon={
							isCompleting ? (
								<Spinner size={14} />
							) : areAllChecklistItemsChecked ? (
								<CheckCircle2 size={14} />
							) : (
								<ClipboardList size={14} />
							)
						}
						onClick={onRequestComplete}
					>
						{areAllChecklistItemsChecked
							? "完成核对并移入 Done"
							: completionActionRendering === "review_before_move_into_done"
								? "继续填写未完成原因"
								: "带原因移入 Done"}
					</Button>
					<p className="m-0 mt-1 text-center text-[11px] text-text-tertiary">
						{areAllChecklistItemsChecked
							? "完成后将停止会话并清理 worktree"
							: `还有 ${task.checklist.length - checkedChecklistItemCount} 项未勾，需逐项给出原因；移入后停止会话并清理 worktree`}
					</p>
				</div>
			) : null}
		</div>
	);
}
