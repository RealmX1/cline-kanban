import { hostNonModalFloatingForm } from "@/components/host-non-modal-floating-form";
import { NonModalFormDialog as Dialog } from "@/components/ui/non-modal-form-dialog";
// dd2db 2.1「添加关系」对话框（T12 ②）：用户以面板所在的卡为主语，直接断言一条参照关系。
// 对端从跨全部项目的任务里挑；kind 从注册表列（选项文案 = webUiAddRelationOptionLabel）；专有输入按 kind 显示。
// 提交按钮或表单快捷键的原始事件交给传输层（runtime 据此拒绝脚本合成事件）；runtime 拒绝时把它那句话原样显示在对话框里，
// 对话框不关，用户改了再提交。表单状态在 use-work-unit-relation-add-reference-relation-dialog-form 里，这里只渲染。

import {
	REFERENCE_CONCERN_NATURES,
	type ReferenceConcernNature,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import type { InterWorkUnitRelationAssertionWriteResponse } from "@runtime-work-unit-relation-assertion-write-api-contract";
import { Link2, TriangleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useId } from "react";
import { ReferenceRelationStatement } from "@/components/detail-panels/reference-relation-statement";
import { WorkUnitRelationCounterpartKanbanBoardCardPicker } from "@/components/detail-panels/work-unit-relation-counterpart-kanban-board-card-picker";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import {
	FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS,
	useFormPrimaryActionSubmitKeyboardShortcut,
} from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";
import { useWorkUnitRelationAddReferenceRelationDialogForm } from "@/hooks/use-work-unit-relation-add-reference-relation-dialog-form";
import {
	type AddReferenceRelationDialogDraft,
	getCrossProjectCounterpartSelectionProblem,
	listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs,
	REFERENCE_RELATION_KIND_SPECIFIC_ATTRIBUTE_FORM_FIELD_LABEL_BY_ATTRIBUTE_KEY,
} from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";

const FORM_TEXT_INPUT_CLASS_NAME =
	"w-full rounded-md border border-border-bright bg-surface-2 px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none";

function AddReferenceRelationFormField({
	fieldLabel,
	fieldInputElementId,
	fieldHint,
	isFieldRequired,
	children,
}: {
	fieldLabel: string;
	fieldInputElementId: string;
	fieldHint?: ReactNode;
	isFieldRequired: boolean;
	children: ReactNode;
}): ReactElement {
	return (
		<div className="flex flex-col gap-1">
			<label htmlFor={fieldInputElementId} className="text-[11px] font-medium text-text-secondary">
				{fieldLabel}
				{isFieldRequired ? <span className="text-status-orange"> *</span> : null}
			</label>
			{children}
			{fieldHint ? <div className="text-[11px] text-text-tertiary">{fieldHint}</div> : null}
		</div>
	);
}

// 每个专有属性的输入控件：单行 / 多行（一行一个）/ 下拉。
export function KindSpecificAttributeInput({
	attributeKey,
	attributeInputElementId,
	draft,
	updateDraft,
}: {
	attributeKey: ReturnType<typeof listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs>[number];
	attributeInputElementId: string;
	draft: AddReferenceRelationDialogDraft;
	updateDraft: (draftPatch: Partial<AddReferenceRelationDialogDraft>) => void;
}): ReactElement | null {
	switch (attributeKey) {
		case "concernedAspectSummary":
			return (
				<input
					id={attributeInputElementId}
					type="text"
					className={FORM_TEXT_INPUT_CLASS_NAME}
					placeholder="对方的哪些行为或状态与本 Task 有关"
					value={draft.concernedAspectSummaryText}
					onChange={(event) => updateDraft({ concernedAspectSummaryText: event.target.value })}
				/>
			);
		case "concernNature":
			return (
				<NativeSelect
					id={attributeInputElementId}
					size="sm"
					fill
					value={draft.selectedConcernNature}
					onChange={(event) =>
						updateDraft({ selectedConcernNature: event.target.value as ReferenceConcernNature | "" })
					}
				>
					<option value="">未指定</option>
					{REFERENCE_CONCERN_NATURES.map((concernNature) => (
						<option key={concernNature} value={concernNature}>
							{concernNature.replaceAll("_", " ")}
						</option>
					))}
				</NativeSelect>
			);
		case "claimsUnderVerification":
			return (
				<textarea
					id={attributeInputElementId}
					rows={3}
					className={FORM_TEXT_INPUT_CLASS_NAME}
					placeholder="每行一条主张"
					value={draft.claimsUnderVerificationOnePerLineText}
					onChange={(event) => updateDraft({ claimsUnderVerificationOnePerLineText: event.target.value })}
				/>
			);
		case "reusedOutputSummary":
			return (
				<input
					id={attributeInputElementId}
					type="text"
					className={FORM_TEXT_INPUT_CLASS_NAME}
					placeholder="复用的证据、文档或 commit"
					value={draft.reusedOutputSummaryText}
					onChange={(event) => updateDraft({ reusedOutputSummaryText: event.target.value })}
				/>
			);
		case "reusedOutputPointers":
			return (
				<textarea
					id={attributeInputElementId}
					rows={2}
					className={FORM_TEXT_INPUT_CLASS_NAME}
					placeholder="每行一个位置（路径、commit、URL）"
					value={draft.reusedOutputPointersOnePerLineText}
					onChange={(event) => updateDraft({ reusedOutputPointersOnePerLineText: event.target.value })}
				/>
			);
		case "originatedRequirementPortionSummary":
			return (
				<input
					id={attributeInputElementId}
					type="text"
					className={FORM_TEXT_INPUT_CLASS_NAME}
					placeholder="来自对方的需求部分"
					value={draft.originatedRequirementPortionSummaryText}
					onChange={(event) => updateDraft({ originatedRequirementPortionSummaryText: event.target.value })}
				/>
			);
		case "sharedCrossRepositoryContractPointer":
			return (
				<input
					id={attributeInputElementId}
					type="text"
					className={FORM_TEXT_INPUT_CLASS_NAME}
					placeholder="共享契约位置（API schema、协议文档等）"
					value={draft.sharedCrossRepositoryContractPointerText}
					onChange={(event) => updateDraft({ sharedCrossRepositoryContractPointerText: event.target.value })}
				/>
			);
		default:
			return null;
	}
}

const KIND_SPECIFIC_ATTRIBUTE_HINT_BY_ATTRIBUTE_KEY: Partial<Record<string, string>> = {
	claimsUnderVerification: "新主张从 pending 开始，核验任务之后记录结论。",
};

function AddReferenceRelationDialogContent({
	subjectKanbanBoardCardWorkspaceId,
	subjectKanbanBoardCardTaskId,
	subjectTaskTitle,
	subjectTaskIncarnationCreatedAtEpochMs,
	onCancel,
	onReferenceRelationAssertionWriteSucceeded,
}: {
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
	subjectTaskTitle?: string;
	subjectTaskIncarnationCreatedAtEpochMs?: number;
	onCancel: () => void;
	onReferenceRelationAssertionWriteSucceeded: (writeResponse: InterWorkUnitRelationAssertionWriteResponse) => void;
}): ReactElement {
	const fieldElementIdPrefix = useId();
	const form = useWorkUnitRelationAddReferenceRelationDialogForm({
		subjectKanbanBoardCardWorkspaceId,
		subjectKanbanBoardCardTaskId,
		subjectTaskIncarnationCreatedAtEpochMs,
		onReferenceRelationAssertionWriteSucceeded,
	});
	const draft = form.addReferenceRelationDialogDraft;
	const handlePrimaryActionKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: form.submitReferenceRelationFromExplicitUserGesture,
		disabled: form.isReferenceRelationAssertionSubmissionInFlight,
	});
	const selectedReferenceRelationKind = draft.selectedReferenceRelationKind || "reference_is_generally_related_with";
	const shownKindSpecificAttributeKeys = selectedReferenceRelationKind
		? listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs(selectedReferenceRelationKind)
		: [];
	const counterpart = draft.selectedCounterpartKanbanBoardCard;
	const projectProblem = getCrossProjectCounterpartSelectionProblem(
		selectedReferenceRelationKind,
		subjectKanbanBoardCardWorkspaceId,
		counterpart?.counterpartKanbanBoardCardWorkspaceId,
	);

	return (
		<div className="contents" onKeyDown={handlePrimaryActionKeyDown}>
			<DialogBody className="@container flex flex-col gap-3">
				<AddReferenceRelationFormField
					fieldLabel="已有 Task"
					fieldInputElementId={`${fieldElementIdPrefix}-counterpart`}
					isFieldRequired
				>
					<WorkUnitRelationCounterpartKanbanBoardCardPicker
						subjectKanbanBoardCardWorkspaceId={subjectKanbanBoardCardWorkspaceId}
						subjectKanbanBoardCardTaskId={subjectKanbanBoardCardTaskId}
						selectedCounterpartKanbanBoardCard={counterpart}
						onSelectedCounterpartKanbanBoardCardChange={(selectedCounterpartKanbanBoardCard) =>
							form.updateAddReferenceRelationDialogDraft({ selectedCounterpartKanbanBoardCard })
						}
						searchInputElementId={`${fieldElementIdPrefix}-counterpart`}
					/>
				</AddReferenceRelationFormField>

				<ReferenceRelationStatement
					relationKind={selectedReferenceRelationKind}
					currentTaskIsStatementSubject={draft.currentTaskIsStatementSubject}
					rootTitle={subjectTaskTitle ?? subjectKanbanBoardCardTaskId}
					counterpartLabel={
						counterpart
							? `${counterpart.counterpartKanbanProjectDisplayName} / ${counterpart.counterpartKanbanBoardCardTaskId} / ${counterpart.counterpartKanbanBoardCardTitle}`
							: "尚未选择"
					}
					currentTaskTargetWorkspaceId={subjectKanbanBoardCardWorkspaceId}
					counterpartCurrentWorkspaceId={counterpart?.counterpartKanbanBoardCardWorkspaceId}
					onReferenceRelationKindAndDirectionChange={(
						selectedReferenceRelationKind,
						currentTaskIsStatementSubject,
					) =>
						form.updateAddReferenceRelationDialogDraft({
							selectedReferenceRelationKind,
							currentTaskIsStatementSubject,
						})
					}
				/>
				{projectProblem ? (
					<p role="alert" className="text-xs text-status-orange">
						{projectProblem}
					</p>
				) : null}

				<details className="space-y-3">
					<summary className="cursor-pointer text-xs text-text-secondary">可选详情</summary>
					{shownKindSpecificAttributeKeys.map((attributeKey) => (
						<AddReferenceRelationFormField
							key={attributeKey}
							fieldLabel={
								REFERENCE_RELATION_KIND_SPECIFIC_ATTRIBUTE_FORM_FIELD_LABEL_BY_ATTRIBUTE_KEY[attributeKey]
							}
							fieldInputElementId={`${fieldElementIdPrefix}-${attributeKey}`}
							isFieldRequired={false}
							fieldHint={KIND_SPECIFIC_ATTRIBUTE_HINT_BY_ATTRIBUTE_KEY[attributeKey]}
						>
							<KindSpecificAttributeInput
								attributeKey={attributeKey}
								attributeInputElementId={`${fieldElementIdPrefix}-${attributeKey}`}
								draft={draft}
								updateDraft={form.updateAddReferenceRelationDialogDraft}
							/>
						</AddReferenceRelationFormField>
					))}

					<AddReferenceRelationFormField
						fieldLabel="关系理由（可选）"
						fieldInputElementId={`${fieldElementIdPrefix}-rationale`}
						isFieldRequired={false}
					>
						<input
							id={`${fieldElementIdPrefix}-rationale`}
							type="text"
							maxLength={600}
							className={FORM_TEXT_INPUT_CLASS_NAME}
							placeholder="两项任务的关系理由"
							value={draft.relationAssertionRationaleOneSentenceText}
							onChange={(event) =>
								form.updateAddReferenceRelationDialogDraft({
									relationAssertionRationaleOneSentenceText: event.target.value,
								})
							}
						/>
					</AddReferenceRelationFormField>

					<AddReferenceRelationFormField
						fieldLabel="证据位置（可选）"
						fieldInputElementId={`${fieldElementIdPrefix}-evidence-pointers`}
						isFieldRequired={false}
						fieldHint="每行一个：文件路径、commit 或 URL。"
					>
						<textarea
							id={`${fieldElementIdPrefix}-evidence-pointers`}
							rows={2}
							className={FORM_TEXT_INPUT_CLASS_NAME}
							value={draft.relationAssertionEvidencePointersOnePerLineText}
							onChange={(event) =>
								form.updateAddReferenceRelationDialogDraft({
									relationAssertionEvidencePointersOnePerLineText: event.target.value,
								})
							}
						/>
					</AddReferenceRelationFormField>
				</details>
				{form.draftValidationProblemMessagesShownAfterSubmitAttempt.length > 0 ? (
					<ul role="alert" aria-label="添加关系表单问题" className="list-disc pl-5 text-[11px] text-status-orange">
						{form.draftValidationProblemMessagesShownAfterSubmitAttempt.map((problemMessage) => (
							<li key={problemMessage}>{problemMessage}</li>
						))}
					</ul>
				) : null}
				{form.referenceRelationAssertionWriteFailureMessage ? (
					<div
						role="alert"
						aria-label="添加关系失败"
						className="flex items-start gap-1.5 rounded-md border border-status-red/30 bg-status-red/10 px-2 py-1.5 text-[11px] break-words text-status-red"
					>
						<TriangleAlert size={12} className="mt-0.5 shrink-0" />
						<span>{form.referenceRelationAssertionWriteFailureMessage}</span>
					</div>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={onCancel}>
					取消
				</Button>
				<Button
					variant="primary"
					size="sm"
					icon={form.isReferenceRelationAssertionSubmissionInFlight ? <Spinner size={12} /> : undefined}
					disabled={form.isReferenceRelationAssertionSubmissionInFlight || Boolean(projectProblem)}
					{...FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS}
					onClick={form.submitReferenceRelationFromExplicitUserGesture}
				>
					添加关系
				</Button>
			</DialogFooter>
		</div>
	);
}

function WorkUnitRelationAddReferenceRelationDialogForm({
	isAddReferenceRelationDialogOpen,
	onAddReferenceRelationDialogOpenChange,
	subjectKanbanBoardCardWorkspaceId,
	subjectKanbanBoardCardTaskId,
	subjectTaskTitle,
	subjectTaskIncarnationCreatedAtEpochMs,
	onReferenceRelationAssertionWriteSucceeded,
}: {
	isAddReferenceRelationDialogOpen: boolean;
	openingRequestSequence?: number;
	onAddReferenceRelationDialogOpenChange: (isAddReferenceRelationDialogOpen: boolean) => void;
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
	subjectTaskTitle?: string;
	subjectTaskIncarnationCreatedAtEpochMs?: number;
	onReferenceRelationAssertionWriteSucceeded: (writeResponse: InterWorkUnitRelationAssertionWriteResponse) => void;
}): ReactElement {
	return (
		<Dialog
			open={isAddReferenceRelationDialogOpen}
			onOpenChange={onAddReferenceRelationDialogOpenChange}
			contentClassName="max-w-4xl"
		>
			{/* 内容只在打开时挂载：关掉再开就是一张空表单，不残留上次的草稿与报错。 */}
			<DialogHeader title="添加关系" icon={<Link2 size={14} />} />
			<AddReferenceRelationDialogContent
				subjectKanbanBoardCardWorkspaceId={subjectKanbanBoardCardWorkspaceId}
				subjectKanbanBoardCardTaskId={subjectKanbanBoardCardTaskId}
				subjectTaskTitle={subjectTaskTitle}
				subjectTaskIncarnationCreatedAtEpochMs={subjectTaskIncarnationCreatedAtEpochMs}
				onCancel={() => onAddReferenceRelationDialogOpenChange(false)}
				onReferenceRelationAssertionWriteSucceeded={onReferenceRelationAssertionWriteSucceeded}
			/>
		</Dialog>
	);
}

export const WorkUnitRelationAddReferenceRelationDialog = hostNonModalFloatingForm(
	WorkUnitRelationAddReferenceRelationDialogForm,
	{
		formKind: "WorkUnitRelationAddReferenceRelationDialog",
		openingRequestIdentity: (props) => props.openingRequestSequence,
		isOpen: (props) => props.isAddReferenceRelationDialogOpen,
		instanceIdentity: (props) =>
			JSON.stringify([
				props.subjectKanbanBoardCardWorkspaceId,
				props.subjectKanbanBoardCardTaskId,
				props.subjectTaskIncarnationCreatedAtEpochMs,
			]),
		ownership: (props) => ({
			workspaceId: props.subjectKanbanBoardCardWorkspaceId,
			taskId: props.subjectKanbanBoardCardTaskId,
			taskIncarnationCreatedAtEpochMs: props.subjectTaskIncarnationCreatedAtEpochMs,
		}),
		withClose: (props, close) => ({
			...props,
			isAddReferenceRelationDialogOpen: true,
			onAddReferenceRelationDialogOpenChange: (open) => {
				if (!open) close();
			},
			onReferenceRelationAssertionWriteSucceeded: (result) => {
				props.onReferenceRelationAssertionWriteSucceeded(result);
				close();
			},
		}),
		onClosed: (props) => props.onAddReferenceRelationDialogOpenChange(false),
	},
);
