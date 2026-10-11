import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { AlertTriangle, Check, ClipboardCheck, Eye, Radio } from "lucide-react";
import { type ReactElement, type ReactNode, useMemo, useState } from "react";

import {
	applyClosureReasonToAllUncheckedChecklistItemsInDialogDraft,
	buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId,
	createInitialPostDeployVerificationDoneEntryClosureDialogDraft,
	EMPTY_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_DRAFT,
	isClosureReasonCodeDeferringChecklistItemToNaturalUsageObservation,
	isUncheckedChecklistItemClosureReasonDraftComplete,
	listTaskEntriesSelectedForClosure,
	POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODE_PRESENTATION,
	POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODES_IN_DIALOG_ORDER,
	type PostDeployVerificationDoneEntryClosureDialogDraft,
	type PostDeployVerificationDoneEntryClosureDialogTaskEntry,
	readClosureReasonDraftOfChecklistItem,
	toggleTaskEntrySelectedForClosureInDialogDraft,
	type UncheckedChecklistItemClosureReasonDraft,
	updateClosureReasonDraftOfChecklistItem,
	validatePostDeployVerificationDoneEntryClosureDialogDraft,
} from "@/components/post-deploy-verification/post-deploy-verification-done-entry-closure-dialog-draft-and-closure-request-resolution";
import {
	boardColumnBadgeClassName,
	formatBoardColumnLabel,
} from "@/components/post-deploy-verification/post-deploy-verification-format";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import type {
	RuntimePostDeployVerificationDoneEntryClosureRequest,
	RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode,
} from "@/runtime/types";

// 「带原因移入 Done」对话框：PDV 面板（单任务完成 / 分区批量结案）与看板入口（按钮、拖拽、服务端拒绝兜底）共用。
// 吸收了原先的两层确认框（跳过 Validation + in_progress 会话可能仍在跑）：它们现在是本对话框的条件段落，
// 不再先后弹两个框。判定逻辑全在 ...-draft-and-closure-request-resolution.ts，这里只渲染。

export type PostDeployVerificationDoneEntryClosureDialogTaskEntrySelectionMode =
	| "single_task_entry_always_included"
	| "multiple_task_entries_selectable_for_batch_closure";

export interface PostDeployVerificationUncheckedItemsClosureReasonDialogProps {
	dialogTitle: string;
	taskEntries: PostDeployVerificationDoneEntryClosureDialogTaskEntry[];
	taskEntrySelectionMode: PostDeployVerificationDoneEntryClosureDialogTaskEntrySelectionMode;
	isSubmittingClosure: boolean;
	onCancel: () => void;
	onConfirmClosureRequestsBySelectedTaskId: (
		closureRequestsBySelectedTaskId: Record<string, RuntimePostDeployVerificationDoneEntryClosureRequest>,
	) => void;
}

const CLOSURE_REASON_CODE_SELECT_PLACEHOLDER_VALUE = "";

function ClosureDialogCheckbox({
	checked,
	onCheckedChange,
	ariaLabel,
	disabled,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	ariaLabel: string;
	disabled?: boolean;
}): ReactElement {
	return (
		<RadixCheckbox.Root
			checked={checked}
			disabled={disabled}
			onCheckedChange={(next) => onCheckedChange(next === true)}
			aria-label={ariaLabel}
			className="mt-px flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-default disabled:opacity-50"
		>
			<RadixCheckbox.Indicator>
				<Check size={11} className="text-white" />
			</RadixCheckbox.Indicator>
		</RadixCheckbox.Root>
	);
}

// 原因码下拉 + 原因文本：逐项与「应用到全部」共用。
function UncheckedChecklistItemClosureReasonPicker({
	closureReasonDraft,
	onClosureReasonDraftChange,
	ariaLabelPrefix,
	disabled,
}: {
	closureReasonDraft: UncheckedChecklistItemClosureReasonDraft;
	onClosureReasonDraftChange: (patch: Partial<UncheckedChecklistItemClosureReasonDraft>) => void;
	ariaLabelPrefix: string;
	disabled: boolean;
}): ReactElement {
	const selectedCode = closureReasonDraft.closureReasonCode;
	const isCustomReason = selectedCode === "custom_reason_described_in_reason_text";
	const isCustomReasonMissingText = isCustomReason && closureReasonDraft.closureReasonText.trim().length === 0;
	return (
		<div className="space-y-1">
			<div className="flex flex-wrap items-center gap-1.5">
				<NativeSelect
					size="sm"
					aria-label={`${ariaLabelPrefix}：原因`}
					disabled={disabled}
					value={selectedCode ?? CLOSURE_REASON_CODE_SELECT_PLACEHOLDER_VALUE}
					onChange={(event) =>
						onClosureReasonDraftChange({
							closureReasonCode:
								event.target.value === CLOSURE_REASON_CODE_SELECT_PLACEHOLDER_VALUE
									? null
									: (event.target
											.value as RuntimePostDeployVerificationUncheckedChecklistItemClosureReasonCode),
						})
					}
					containerClassName="min-w-0 max-w-full"
					className="max-w-full"
				>
					<option value={CLOSURE_REASON_CODE_SELECT_PLACEHOLDER_VALUE}>选择原因…</option>
					{POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODES_IN_DIALOG_ORDER.map((code) => (
						<option key={code} value={code}>
							{
								POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODE_PRESENTATION[code]
									.closureReasonOptionLabel
							}
						</option>
					))}
				</NativeSelect>
				<input
					type="text"
					aria-label={`${ariaLabelPrefix}：原因文本`}
					disabled={disabled}
					value={closureReasonDraft.closureReasonText}
					onChange={(event) => onClosureReasonDraftChange({ closureReasonText: event.target.value })}
					placeholder={isCustomReason ? "必须填写原因" : "可选：补充说明"}
					className={cn(
						"h-7 min-w-0 flex-1 rounded-md border bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none",
						isCustomReasonMissingText ? "border-status-red/60" : "border-border-bright",
					)}
				/>
			</div>
			{selectedCode ? (
				<p
					className={cn(
						"m-0 text-[11px]",
						isClosureReasonCodeDeferringChecklistItemToNaturalUsageObservation(selectedCode)
							? "text-accent"
							: "text-text-tertiary",
					)}
				>
					{isClosureReasonCodeDeferringChecklistItemToNaturalUsageObservation(selectedCode) ? (
						<Eye size={11} className="mr-1 inline-block align-[-1px]" />
					) : null}
					{
						POST_DEPLOY_VERIFICATION_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_CODE_PRESENTATION[selectedCode]
							.closureReasonOptionExplanation
					}
				</p>
			) : null}
		</div>
	);
}

function ClosureDialogTaskEntrySection({
	taskEntry,
	draft,
	isSelectable,
	isSelected,
	disabled,
	onDraftChange,
}: {
	taskEntry: PostDeployVerificationDoneEntryClosureDialogTaskEntry;
	draft: PostDeployVerificationDoneEntryClosureDialogDraft;
	isSelectable: boolean;
	isSelected: boolean;
	disabled: boolean;
	onDraftChange: (
		updateDraft: (
			previous: PostDeployVerificationDoneEntryClosureDialogDraft,
		) => PostDeployVerificationDoneEntryClosureDialogDraft,
	) => void;
}): ReactElement {
	const uncheckedItemCount = taskEntry.uncheckedChecklistItemsRequiringClosureReason.length;
	return (
		<section
			data-post-deploy-verification-closure-dialog-task-entry={taskEntry.taskId}
			className={cn(
				"rounded-md border p-2",
				isSelected ? "border-border-bright bg-surface-2" : "border-border bg-surface-1",
			)}
		>
			<div className="flex items-start gap-2">
				{isSelectable ? (
					<ClosureDialogCheckbox
						checked={isSelected}
						disabled={disabled}
						ariaLabel={`纳入本次结案：${taskEntry.taskTitle}`}
						onCheckedChange={(selected) =>
							onDraftChange((previous) =>
								toggleTaskEntrySelectedForClosureInDialogDraft(previous, taskEntry.taskId, selected),
							)
						}
					/>
				) : null}
				<span className="min-w-0 flex-1 break-words text-[13px] font-medium text-text-primary">
					{taskEntry.taskTitle}
				</span>
				<span
					className={cn(
						"shrink-0 rounded-sm border px-1.5 py-0.5 text-[11px]",
						boardColumnBadgeClassName(taskEntry.boardColumnIdOfTaskCardBeforeMoveIntoDone),
					)}
				>
					{formatBoardColumnLabel(taskEntry.boardColumnIdOfTaskCardBeforeMoveIntoDone)}
				</span>
				<span className="shrink-0 text-[11px] text-text-tertiary">
					{uncheckedItemCount > 0 ? `${uncheckedItemCount} 个未勾项` : "已全勾"}
				</span>
			</div>
			{isSelected ? (
				<div className="mt-2 space-y-2">
					{taskEntry.runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel ? (
						<p className="m-0 rounded-sm border border-status-orange/30 bg-status-orange/10 px-2 py-1 text-[11px] text-status-orange">
							服务端报告该任务仍有未勾项，但本地数据还没刷新到：请用上方「应用到全部未勾项」给出原因。
						</p>
					) : null}
					{uncheckedItemCount === 0 &&
					!taskEntry.runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel ? (
						<p className="m-0 text-[11px] text-status-green">全部核对项已勾选，将按「通过」结案。</p>
					) : null}
					{taskEntry.uncheckedChecklistItemsRequiringClosureReason.map((item) => (
						<div
							key={item.checklistItemId}
							data-post-deploy-verification-closure-dialog-unchecked-item={item.checklistItemId}
							className="space-y-1 border-t border-border pt-2 first:border-t-0 first:pt-0"
						>
							<p className="m-0 min-w-0 break-words text-[12px] text-text-secondary">
								{item.checklistItemLabel}
							</p>
							<UncheckedChecklistItemClosureReasonPicker
								ariaLabelPrefix={item.checklistItemLabel}
								disabled={disabled}
								closureReasonDraft={readClosureReasonDraftOfChecklistItem(
									draft,
									taskEntry.taskId,
									item.checklistItemId,
								)}
								onClosureReasonDraftChange={(patch) =>
									onDraftChange((previous) =>
										updateClosureReasonDraftOfChecklistItem(
											previous,
											taskEntry.taskId,
											item.checklistItemId,
											patch,
										),
									)
								}
							/>
						</div>
					))}
				</div>
			) : null}
		</section>
	);
}

function ClosureDialogNoticeBox({
	icon,
	toneClassName,
	children,
}: {
	icon: ReactNode;
	toneClassName: string;
	children: ReactNode;
}): ReactElement {
	return (
		<div className={cn("flex items-start gap-2 rounded-md border p-2 text-[12px]", toneClassName)}>
			<span className="mt-px shrink-0">{icon}</span>
			<div className="min-w-0 flex-1 space-y-1.5">{children}</div>
		</div>
	);
}

export function PostDeployVerificationUncheckedItemsClosureReasonDialog({
	dialogTitle,
	taskEntries,
	taskEntrySelectionMode,
	isSubmittingClosure,
	onCancel,
	onConfirmClosureRequestsBySelectedTaskId,
}: PostDeployVerificationUncheckedItemsClosureReasonDialogProps): ReactElement {
	const isBatchSelection = taskEntrySelectionMode === "multiple_task_entries_selectable_for_batch_closure";
	const [draft, setDraft] = useState<PostDeployVerificationDoneEntryClosureDialogDraft>(() =>
		createInitialPostDeployVerificationDoneEntryClosureDialogDraft(taskEntries, {
			selectEveryTaskEntryInitially: !isBatchSelection,
		}),
	);
	const [closureReasonDraftToApplyToAll, setClosureReasonDraftToApplyToAll] =
		useState<UncheckedChecklistItemClosureReasonDraft>(EMPTY_UNCHECKED_CHECKLIST_ITEM_CLOSURE_REASON_DRAFT);

	const selectedTaskEntries = useMemo(
		() => listTaskEntriesSelectedForClosure(taskEntries, draft),
		[taskEntries, draft],
	);
	const validation = useMemo(
		() => validatePostDeployVerificationDoneEntryClosureDialogDraft(taskEntries, draft),
		[taskEntries, draft],
	);
	const selectedTaskEntriesSkippingValidation = selectedTaskEntries.filter(
		(entry) =>
			entry.boardColumnIdOfTaskCardBeforeMoveIntoDone === "review" ||
			entry.boardColumnIdOfTaskCardBeforeMoveIntoDone === "in_progress",
	);
	const selectedTaskEntriesLeavingInProgress = selectedTaskEntries.filter(
		(entry) => entry.boardColumnIdOfTaskCardBeforeMoveIntoDone === "in_progress",
	);
	const hasAnyUncheckedItemOrInvisibleUncheckedItem = taskEntries.some(
		(entry) =>
			entry.uncheckedChecklistItemsRequiringClosureReason.length > 0 ||
			entry.runtimeReportedUncheckedChecklistItemsInvisibleToLocalReadModel,
	);
	const areAllTaskEntriesSelected = selectedTaskEntries.length === taskEntries.length;

	const confirmClosure = (): void => {
		if (!validation.isReadyToConfirmClosure || isSubmittingClosure) {
			return;
		}
		onConfirmClosureRequestsBySelectedTaskId(
			buildPostDeployVerificationDoneEntryClosureRequestsBySelectedTaskId(taskEntries, draft),
		);
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				// 提交进行中忽略关闭，避免半途中断逐个移列。
				if (!open && !isSubmittingClosure) {
					onCancel();
				}
			}}
			contentClassName="!max-w-2xl"
		>
			<DialogHeader title={dialogTitle} icon={<ClipboardCheck size={16} />} />
			<DialogBody className="space-y-3 text-[13px] text-text-secondary">
				{hasAnyUncheckedItemOrInvisibleUncheckedItem ? (
					<p className="m-0">
						未全部勾选也可以移入 Done，但每个未勾项都要给出原因；结案记录为「带原因结案」，不算「核对通过」。
					</p>
				) : null}

				{isBatchSelection ? (
					<div className="flex items-center gap-2 text-[12px]">
						<ClosureDialogCheckbox
							checked={areAllTaskEntriesSelected && taskEntries.length > 0}
							disabled={isSubmittingClosure}
							ariaLabel="全选任务"
							onCheckedChange={(selected) =>
								setDraft((previous) => ({
									...previous,
									taskIdsSelectedForClosure: selected ? taskEntries.map((entry) => entry.taskId) : [],
								}))
							}
						/>
						<span>
							全选（已选 {selectedTaskEntries.length} / {taskEntries.length}）
						</span>
					</div>
				) : null}

				{hasAnyUncheckedItemOrInvisibleUncheckedItem ? (
					<div className="space-y-1.5 rounded-md border border-border bg-surface-2 p-2">
						<p className="m-0 text-[12px] font-medium text-text-primary">应用到全部未勾项</p>
						<UncheckedChecklistItemClosureReasonPicker
							ariaLabelPrefix="应用到全部未勾项"
							disabled={isSubmittingClosure}
							closureReasonDraft={closureReasonDraftToApplyToAll}
							onClosureReasonDraftChange={(patch) =>
								setClosureReasonDraftToApplyToAll((previous) => ({ ...previous, ...patch }))
							}
						/>
						<div className="flex justify-end">
							<Button
								size="sm"
								disabled={
									isSubmittingClosure ||
									!isUncheckedChecklistItemClosureReasonDraftComplete(closureReasonDraftToApplyToAll)
								}
								onClick={() =>
									setDraft((previous) =>
										applyClosureReasonToAllUncheckedChecklistItemsInDialogDraft(
											previous,
											taskEntries,
											closureReasonDraftToApplyToAll,
										),
									)
								}
							>
								应用到全部未勾项
							</Button>
						</div>
					</div>
				) : null}

				<div className="space-y-2">
					{taskEntries.map((taskEntry) => (
						<ClosureDialogTaskEntrySection
							key={taskEntry.taskId}
							taskEntry={taskEntry}
							draft={draft}
							isSelectable={isBatchSelection}
							isSelected={draft.taskIdsSelectedForClosure.includes(taskEntry.taskId)}
							disabled={isSubmittingClosure}
							onDraftChange={setDraft}
						/>
					))}
				</div>

				{selectedTaskEntriesSkippingValidation.length > 0 ? (
					<ClosureDialogNoticeBox
						icon={<AlertTriangle size={14} />}
						toneClassName="border-status-orange/30 bg-status-orange/10 text-text-primary"
					>
						<p className="m-0">
							{isBatchSelection
								? `其中 ${selectedTaskEntriesSkippingValidation.length} 个任务不在 Validation 列：`
								: "该任务不在 Validation 列："}
							移入 Done 将<span className="text-status-orange">跳过 Validation 列</span>，同时停止会话、清理
							worktree。
						</p>
						{selectedTaskEntriesSkippingValidation
							.filter((entry) => entry.agentResponsePreviewShownWithSkipValidationAcknowledgement !== null)
							.map((entry) => (
								<div key={entry.taskId} className="rounded-md border border-border bg-surface-2 p-2">
									<p className="m-0 mb-1 text-[12px] font-medium text-text-secondary">最近一条 agent 回复</p>
									<pre className="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-primary">
										{entry.agentResponsePreviewShownWithSkipValidationAcknowledgement}
									</pre>
								</div>
							))}
					</ClosureDialogNoticeBox>
				) : null}

				{selectedTaskEntriesLeavingInProgress.length > 0 ? (
					<ClosureDialogNoticeBox
						icon={<Radio size={14} className="text-status-red" />}
						toneClassName="border-status-red/30 bg-status-red/10 text-text-primary"
					>
						<div className="flex items-start gap-2">
							<ClosureDialogCheckbox
								checked={draft.inProgressAgentSessionMayStillBeRunningAcknowledged}
								disabled={isSubmittingClosure}
								ariaLabel="我已了解 In Progress 任务的会话可能仍在运行"
								onCheckedChange={(acknowledged) =>
									setDraft((previous) => ({
										...previous,
										inProgressAgentSessionMayStillBeRunningAcknowledged: acknowledged,
									}))
								}
							/>
							<span>
								我已了解{isBatchSelection ? `这 ${selectedTaskEntriesLeavingInProgress.length} 个` : "该"}
								任务仍在 In Progress，其 agent <span className="text-status-red">会话可能仍在运行</span>
								；移入 Done 会立即停止会话并清理 worktree，未提交的进行中改动可能丢失。
							</span>
						</div>
					</ClosureDialogNoticeBox>
				) : null}

				{validation.closureDraftProblemsForDisplay.length > 0 ? (
					<ul className="m-0 list-disc space-y-0.5 pl-4 text-[11px] text-text-tertiary">
						{validation.closureDraftProblemsForDisplay.map((problem) => (
							<li key={problem}>{problem}</li>
						))}
					</ul>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="default" disabled={isSubmittingClosure} onClick={onCancel}>
					取消
				</Button>
				<Button
					variant="danger"
					disabled={!validation.isReadyToConfirmClosure || isSubmittingClosure}
					icon={isSubmittingClosure ? <Spinner size={14} /> : undefined}
					onClick={confirmClosure}
				>
					{isBatchSelection ? `结案并移入 Done（${selectedTaskEntries.length} 个任务）` : "确认移入 Done"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
