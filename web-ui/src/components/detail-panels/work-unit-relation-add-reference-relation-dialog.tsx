// dd2db 2.1「添加关系」对话框（T12 ②）：用户以面板所在的卡为主语，直接断言一条参照关系。
// 对端从跨全部项目的任务里挑；kind 从注册表列（选项文案 = webUiAddRelationOptionLabel）；专有输入按 kind 显示。
// 提交按钮的 onClick 事件原样交给传输层（runtime 据此拒绝脚本合成的点击）；runtime 拒绝时把它那句话原样显示在对话框里，
// 对话框不关，用户改了再提交。表单状态在 use-work-unit-relation-add-reference-relation-dialog-form 里，这里只渲染。

import {
	ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS,
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
	type AssertedInterWorkUnitReferenceRelationKind,
	REFERENCE_CONCERN_NATURES,
	type ReferenceConcernNature,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import type { InterWorkUnitRelationAssertionWriteResponse } from "@runtime-work-unit-relation-assertion-write-api-contract";
import { Link2, TriangleAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useId } from "react";
import { WorkUnitRelationCounterpartKanbanBoardCardPicker } from "@/components/detail-panels/work-unit-relation-counterpart-kanban-board-card-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useWorkUnitRelationAddReferenceRelationDialogForm } from "@/hooks/use-work-unit-relation-add-reference-relation-dialog-form";
import {
	type AddReferenceRelationDialogDraft,
	isKindSpecificAttributeKeyPartOfAnyRequiredAlternative,
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
					placeholder="Which behavior or state of the other task this one is about"
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
					<option value="">Not specified</option>
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
					placeholder="One claim per line"
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
					placeholder="What is reused (evidence, docs, commits — not its obligations)"
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
					placeholder="One pointer per line (path, commit, URL)"
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
					placeholder="Which part of this task's requirements came from the other task"
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
					placeholder="Pointer to the shared contract (API schema, protocol doc, …)"
					value={draft.sharedCrossRepositoryContractPointerText}
					onChange={(event) => updateDraft({ sharedCrossRepositoryContractPointerText: event.target.value })}
				/>
			);
		default:
			return null;
	}
}

const KIND_SPECIFIC_ATTRIBUTE_HINT_BY_ATTRIBUTE_KEY: Partial<Record<string, string>> = {
	claimsUnderVerification: "Each claim starts as pending; the verifying task records the verdict later.",
};

function AddReferenceRelationDialogContent({
	subjectKanbanBoardCardWorkspaceId,
	subjectKanbanBoardCardTaskId,
	onCancel,
	onReferenceRelationAssertionWriteSucceeded,
}: {
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
	onCancel: () => void;
	onReferenceRelationAssertionWriteSucceeded: (writeResponse: InterWorkUnitRelationAssertionWriteResponse) => void;
}): ReactElement {
	const fieldElementIdPrefix = useId();
	const form = useWorkUnitRelationAddReferenceRelationDialogForm({
		subjectKanbanBoardCardWorkspaceId,
		subjectKanbanBoardCardTaskId,
		onReferenceRelationAssertionWriteSucceeded,
	});
	const draft = form.addReferenceRelationDialogDraft;
	const selectedReferenceRelationKind = draft.selectedReferenceRelationKind;
	const selectedRelationKindRegistryEntry = selectedReferenceRelationKind
		? ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[selectedReferenceRelationKind]
		: null;
	const shownKindSpecificAttributeKeys = selectedReferenceRelationKind
		? listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs(selectedReferenceRelationKind)
		: [];
	const selectedRelationKindHasAlternativeRequiredAttributes =
		(selectedRelationKindRegistryEntry?.requiredKindSpecificAttributeKeyAlternatives.length ?? 0) > 1;
	const counterpart = draft.selectedCounterpartKanbanBoardCard;
	// 只提示、不拦：同项目跨仓配对以 runtime 的拒绝为准（界面原样转述那句话）。
	const isSameProjectCounterpartForCrossRepositoryKind =
		selectedRelationKindRegistryEntry?.rejectsEndpointsInSameKanbanWorkspace === true &&
		counterpart?.counterpartKanbanBoardCardWorkspaceId === subjectKanbanBoardCardWorkspaceId;

	return (
		<>
			<DialogHeader title="Add relation" icon={<Link2 size={14} />} />
			<DialogBody className="flex flex-col gap-3">
				<AddReferenceRelationFormField
					fieldLabel="Other task"
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

				<AddReferenceRelationFormField
					fieldLabel="Relation"
					fieldInputElementId={`${fieldElementIdPrefix}-relation-kind`}
					isFieldRequired
					fieldHint={
						selectedRelationKindRegistryEntry ? (
							<span data-relation-statement-preview="">
								Reads as: This task {selectedRelationKindRegistryEntry.forwardReadingPhraseFromSubject}{" "}
								{counterpart ? counterpart.counterpartKanbanBoardCardTitle : "the other task"}.
							</span>
						) : undefined
					}
				>
					<NativeSelect
						id={`${fieldElementIdPrefix}-relation-kind`}
						size="sm"
						fill
						value={selectedReferenceRelationKind}
						onChange={(event) =>
							form.updateAddReferenceRelationDialogDraft({
								selectedReferenceRelationKind: event.target.value as
									| AssertedInterWorkUnitReferenceRelationKind
									| "",
							})
						}
					>
						<option value="">Choose how this task relates to the other task…</option>
						{ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS.filter((relationKind) =>
							ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind].allowedSubjectWorkUnitTypes.includes(
								"kanban_board_card",
							),
						).map((relationKind) => (
							<option key={relationKind} value={relationKind}>
								{ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[relationKind].webUiAddRelationOptionLabel}
							</option>
						))}
					</NativeSelect>
				</AddReferenceRelationFormField>

				{selectedReferenceRelationKind && selectedRelationKindHasAlternativeRequiredAttributes ? (
					<div className="text-[11px] text-text-tertiary">Fill in at least one of the fields marked *.</div>
				) : null}
				{shownKindSpecificAttributeKeys.map((attributeKey) => (
					<AddReferenceRelationFormField
						key={attributeKey}
						fieldLabel={
							REFERENCE_RELATION_KIND_SPECIFIC_ATTRIBUTE_FORM_FIELD_LABEL_BY_ATTRIBUTE_KEY[attributeKey]
						}
						fieldInputElementId={`${fieldElementIdPrefix}-${attributeKey}`}
						isFieldRequired={
							selectedReferenceRelationKind !== "" &&
							isKindSpecificAttributeKeyPartOfAnyRequiredAlternative(selectedReferenceRelationKind, attributeKey)
						}
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
				{isSameProjectCounterpartForCrossRepositoryKind ? (
					<div className="flex items-start gap-1 text-[11px] text-status-orange">
						<TriangleAlert size={12} className="mt-0.5 shrink-0" />
						Both tasks are in the same project; Kanban only accepts this kind between different repositories.
					</div>
				) : null}

				<AddReferenceRelationFormField
					fieldLabel="Rationale (one sentence)"
					fieldInputElementId={`${fieldElementIdPrefix}-rationale`}
					isFieldRequired
				>
					<input
						id={`${fieldElementIdPrefix}-rationale`}
						type="text"
						maxLength={600}
						className={FORM_TEXT_INPUT_CLASS_NAME}
						placeholder="Why these two tasks are related"
						value={draft.relationAssertionRationaleOneSentenceText}
						onChange={(event) =>
							form.updateAddReferenceRelationDialogDraft({
								relationAssertionRationaleOneSentenceText: event.target.value,
							})
						}
					/>
				</AddReferenceRelationFormField>

				<AddReferenceRelationFormField
					fieldLabel="Evidence pointers (optional)"
					fieldInputElementId={`${fieldElementIdPrefix}-evidence-pointers`}
					isFieldRequired={false}
					fieldHint="One per line: file paths, commits, URLs."
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

				{form.draftValidationProblemMessagesShownAfterSubmitAttempt.length > 0 ? (
					<ul
						role="alert"
						aria-label="Add relation form problems"
						className="list-disc pl-5 text-[11px] text-status-orange"
					>
						{form.draftValidationProblemMessagesShownAfterSubmitAttempt.map((problemMessage) => (
							<li key={problemMessage}>{problemMessage}</li>
						))}
					</ul>
				) : null}
				{form.referenceRelationAssertionWriteFailureMessage ? (
					<div
						role="alert"
						aria-label="Add relation failure"
						className="flex items-start gap-1.5 rounded-md border border-status-red/30 bg-status-red/10 px-2 py-1.5 text-[11px] break-words text-status-red"
					>
						<TriangleAlert size={12} className="mt-0.5 shrink-0" />
						<span>{form.referenceRelationAssertionWriteFailureMessage}</span>
					</div>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					variant="primary"
					size="sm"
					icon={form.isReferenceRelationAssertionSubmissionInFlight ? <Spinner size={12} /> : undefined}
					disabled={form.isReferenceRelationAssertionSubmissionInFlight}
					onClick={form.referenceRelationAssertionSubmitButtonClickHandler}
				>
					Add relation
				</Button>
			</DialogFooter>
		</>
	);
}

export function WorkUnitRelationAddReferenceRelationDialog({
	isAddReferenceRelationDialogOpen,
	onAddReferenceRelationDialogOpenChange,
	subjectKanbanBoardCardWorkspaceId,
	subjectKanbanBoardCardTaskId,
	onReferenceRelationAssertionWriteSucceeded,
}: {
	isAddReferenceRelationDialogOpen: boolean;
	onAddReferenceRelationDialogOpenChange: (isAddReferenceRelationDialogOpen: boolean) => void;
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
	onReferenceRelationAssertionWriteSucceeded: (writeResponse: InterWorkUnitRelationAssertionWriteResponse) => void;
}): ReactElement {
	return (
		<Dialog
			open={isAddReferenceRelationDialogOpen}
			onOpenChange={onAddReferenceRelationDialogOpenChange}
			contentClassName="max-w-xl"
		>
			{/* 内容只在打开时挂载：关掉再开就是一张空表单，不残留上次的草稿与报错。 */}
			<AddReferenceRelationDialogContent
				subjectKanbanBoardCardWorkspaceId={subjectKanbanBoardCardWorkspaceId}
				subjectKanbanBoardCardTaskId={subjectKanbanBoardCardTaskId}
				onCancel={() => onAddReferenceRelationDialogOpenChange(false)}
				onReferenceRelationAssertionWriteSucceeded={onReferenceRelationAssertionWriteSucceeded}
			/>
		</Dialog>
	);
}
