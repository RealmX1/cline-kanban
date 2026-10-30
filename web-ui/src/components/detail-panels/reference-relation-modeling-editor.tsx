import type {
	AssertedInterWorkUnitRelation,
	AssertedReferenceRelationKindSpecificAttributes,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import {
	ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS,
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import type { KanbanBoardCardWorkUnitQualifiedReference } from "@runtime-inter-work-unit-relation-ledger-event-contract";
import type {
	ReferenceRelationModelingDraft,
	ReferenceRelationModelingInvalidDetailsForm,
} from "@runtime-work-unit-relation-modeling-api-contract";
import isDeepEqual from "fast-deep-equal";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
	REFERENCE_RELATION_LABELS,
	RELATION_GRAPH_LABELS,
	RELATION_PREVIEW_STATE_LABELS,
	ReferenceRelationModelingGraph,
} from "@/components/detail-panels/reference-relation-modeling-graph";
import { RelationTaskCardPreviewLayout } from "@/components/detail-panels/relation-task-card-preview-layout";
import { KindSpecificAttributeInput } from "@/components/detail-panels/work-unit-relation-add-reference-relation-dialog";
import { WorkUnitRelationCounterpartKanbanBoardCardPicker } from "@/components/detail-panels/work-unit-relation-counterpart-kanban-board-card-picker";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useExpandedForegroundViewNavigation } from "@/expanded-foreground-view/expanded-foreground-view-context";
import { buildRelationTaskCardPreviewTargetFromDisplayEntry } from "@/hooks/relation-task-card-preview-target";
import {
	FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS,
	useFormPrimaryActionSubmitKeyboardShortcut,
} from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";
import type { ReferenceRelationModelingEditorController } from "@/hooks/use-reference-relation-modeling-editor";
import { useRelationTaskCardPreview } from "@/hooks/use-relation-task-card-preview";
import type { TaskEditorClipboardTaskSelectionRequest } from "@/hooks/use-task-editor-clipboard-task-reference";
import {
	type AddReferenceRelationDialogDraft,
	EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
	listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs,
	validateAddReferenceRelationDialogDraftIntoAssertionRequest,
} from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";
import {
	collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent,
	type TriggeringExplicitUserGestureEvent,
} from "@/runtime/work-unit-relation-assertion-write-query";
import { resolveRelationModelingCounterpart } from "@/runtime/work-unit-relation-modeling-query";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

const ATTRIBUTE_LABELS: Record<string, string> = {
	concernedAspectSummary: "研究或诊断的方面",
	concernNature: "关注性质",
	claimsUnderVerification: "要核验的主张",
	reusedOutputSummary: "复用的产物",
	reusedOutputPointers: "产物位置",
	originatedRequirementPortionSummary: "来自对方的需求",
	sharedCrossRepositoryContractPointer: "共享契约位置",
	relatednessRationaleOneSentence: "相关理由",
};
const INPUT_CLASS =
	"w-full rounded-md border border-border-bright bg-surface-2 px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-border-focus focus:outline-none";

function buildRelationDetailsForm(
	relation: Pick<
		AssertedInterWorkUnitRelation,
		| "relationKind"
		| "relationAssertionRationaleOneSentence"
		| "relationAssertionEvidencePointers"
		| "assertedRelationKindSpecificAttributes"
	>,
): AddReferenceRelationDialogDraft {
	const attributes =
		relation.assertedRelationKindSpecificAttributes as AssertedReferenceRelationKindSpecificAttributes;
	return {
		...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
		selectedReferenceRelationKind:
			relation.relationKind as AddReferenceRelationDialogDraft["selectedReferenceRelationKind"],
		relationAssertionRationaleOneSentenceText: relation.relationAssertionRationaleOneSentence,
		relationAssertionEvidencePointersOnePerLineText: relation.relationAssertionEvidencePointers.join("\n"),
		concernedAspectSummaryText: attributes.concernedAspectSummary ?? "",
		selectedConcernNature: attributes.concernNature ?? "",
		claimsUnderVerificationOnePerLineText:
			attributes.claimsUnderVerification?.map((claim) => claim.claimSummary).join("\n") ?? "",
		reusedOutputSummaryText: attributes.reusedOutputSummary ?? "",
		reusedOutputPointersOnePerLineText: attributes.reusedOutputPointers?.join("\n") ?? "",
		originatedRequirementPortionSummaryText: attributes.originatedRequirementPortionSummary ?? "",
		sharedCrossRepositoryContractPointerText: attributes.sharedCrossRepositoryContractPointer ?? "",
	};
}

function buildPendingRelationDetailsForm(
	draft: ReferenceRelationModelingDraft,
	invalidDetailsForm?: ReferenceRelationModelingInvalidDetailsForm,
): AddReferenceRelationDialogDraft {
	const ref = draft.counterpartWorkUnit;
	return {
		...buildRelationDetailsForm(draft),
		...invalidDetailsForm,
		selectedCounterpartKanbanBoardCard:
			ref.workUnitType === "kanban_board_card"
				? {
						counterpartKanbanBoardCardWorkspaceId: ref.workspaceId,
						counterpartKanbanBoardCardTaskId: ref.taskId,
						counterpartKanbanBoardCardTitle: ref.taskId,
						counterpartKanbanProjectDisplayName: ref.workspaceId,
					}
				: null,
	};
}

export function ReferenceRelationModelingEditor({
	controller,
	workspaceId,
	taskId,
	rootTitle = "待创建任务",
	onDraftInteraction,
	onUnstagedFormChange,
	creationInFlight = false,
	onRelationsSaved,
	presentation = "embedded",
	readOnly = false,
	clipboardSelectionRequest,
}: {
	controller: ReferenceRelationModelingEditorController;
	workspaceId: string;
	taskId: string | null;
	rootTitle?: string;
	onDraftInteraction?: () => void;
	onUnstagedFormChange?: (hasUnstagedForm: boolean) => void;
	creationInFlight?: boolean;
	onRelationsSaved?: () => void;
	presentation?: "embedded" | "foreground" | "task_editor";
	readOnly?: boolean;
	clipboardSelectionRequest?: TaskEditorClipboardTaskSelectionRequest | null;
}) {
	const foregroundNavigation = useExpandedForegroundViewNavigation();
	const id = useId();
	const [form, setForm] = useState<AddReferenceRelationDialogDraft>(EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT);
	const [direction, setDirection] = useState(true);
	const [editingDraft, setEditingDraft] = useState<ReferenceRelationModelingDraft | null>(null);
	const [editing, setEditing] = useState<AssertedInterWorkUnitRelation | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [resolving, setResolving] = useState(false);
	const pendingCounterpartResolutionAttemptRef = useRef<symbol | null>(null);
	const previewSeededCounterpartCanonicalIdentityRef = useRef<KanbanBoardCardWorkUnitQualifiedReference | null>(null);
	const [narrowView, setNarrowView] = useState<"list" | "graph">(
		presentation === "task_editor" ? "list" : taskId ? "graph" : "list",
	);
	const [taskEditorRelationGraphOpen, setTaskEditorRelationGraphOpen] = useState(false);
	const taskCardPreview = useRelationTaskCardPreview();
	const invalidDetailsForms = controller.draft.invalidReferenceRelationDetailsFormsByDraftId ?? {};
	const hasInvalidDetailsForms = Object.keys(invalidDetailsForms).length > 0;
	const hasUnstagedCounterpartSelection =
		resolving || Boolean(formOpen && !editingDraft && (editing || form.selectedCounterpartKanbanBoardCard));
	const hasUnstagedRelationForm =
		hasUnstagedCounterpartSelection || Boolean(editingDraft && formError) || hasInvalidDetailsForms;
	const invalidDetailsProblemMessages = controller.draft.referenceRelationDrafts.flatMap((draft) => {
		const invalidDetailsForm = invalidDetailsForms[draft.draftId];
		if (!invalidDetailsForm) return [];
		const validation = validateAddReferenceRelationDialogDraftIntoAssertionRequest({
			draft: buildPendingRelationDetailsForm(draft, invalidDetailsForm),
			subjectKanbanBoardCardWorkspaceId: workspaceId,
			subjectKanbanBoardCardTaskId: taskId ?? "task-being-created",
		});
		return validation.isDraftReadyForSubmission ? [] : validation.draftValidationProblemMessages;
	});
	useEffect(() => {
		onUnstagedFormChange?.(hasUnstagedRelationForm);
		return () => onUnstagedFormChange?.(false);
	}, [hasUnstagedRelationForm, onUnstagedFormChange]);
	const preview = controller.preview;
	const labels = new Map(
		preview?.workUnits.map((entry) => [
			entry.workUnitKey,
			entry.kanbanBoardCardIdentity?.currentTitle ?? entry.workUnitDisplayLabel,
		]) ?? [],
	);
	if (preview) labels.set(preview.rootWorkUnitKey, rootTitle);
	const selected = preview?.workUnits.find(
		(entry) => entry.workUnitKey === taskCardPreview.selection?.target.workUnitKey,
	);
	const previewTargetForWorkUnit = (key: string) =>
		buildRelationTaskCardPreviewTargetFromDisplayEntry(
			preview?.workUnits.find((entry) => entry.workUnitKey === key),
			key,
			labels.get(key) ?? key,
		);
	const resetForm = useCallback(() => {
		pendingCounterpartResolutionAttemptRef.current = null;
		previewSeededCounterpartCanonicalIdentityRef.current = null;
		setResolving(false);
		setForm(EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT);
		setDirection(true);
		setEditing(null);
		setEditingDraft(null);
		setFormError(null);
		setFormOpen(false);
	}, []);
	useLayoutEffect(() => {
		resetForm();
		return () => {
			pendingCounterpartResolutionAttemptRef.current = null;
		};
	}, [workspaceId, taskId, resetForm]);
	const lastClipboardSelectionSequenceRef = useRef<number | null>(null);
	const [clipboardCandidates, setClipboardCandidates] = useState<
		TaskEditorClipboardTaskSelectionRequest["candidates"]
	>([]);
	function selectClipboardCounterpart(candidate: TaskEditorClipboardTaskSelectionRequest["candidates"][number]) {
		if (formOpen) return;
		resetForm();
		setClipboardCandidates([]);
		setFormOpen(true);
		void addFormToDraft(
			{
				...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
				selectedCounterpartKanbanBoardCard: {
					counterpartKanbanBoardCardWorkspaceId: candidate.kanbanBoardCard.workspaceId,
					counterpartKanbanBoardCardTaskId: candidate.kanbanBoardCard.taskId,
					counterpartKanbanBoardCardTitle: candidate.currentTitle ?? candidate.kanbanBoardCard.taskId,
					counterpartKanbanProjectDisplayName: candidate.kanbanBoardCard.workspaceId,
				},
			},
			null,
			true,
		);
	}
	useEffect(() => {
		if (
			!clipboardSelectionRequest ||
			lastClipboardSelectionSequenceRef.current === clipboardSelectionRequest.sequence
		)
			return;
		lastClipboardSelectionSequenceRef.current = clipboardSelectionRequest.sequence;
		// 正在编辑关系时不覆盖其对端，也不排队迟到覆盖。
		if (formOpen) return;
		setClipboardCandidates(clipboardSelectionRequest.candidates);
	}, [clipboardSelectionRequest, formOpen]);

	function editRelation(relation: AssertedInterWorkUnitRelation) {
		const rootKey = preview?.rootWorkUnitKey;
		const subjectIsRoot =
			preview?.relations.find((entry) => entry.relationId === relation.relationId)?.subjectKey === rootKey;
		const counterpart = subjectIsRoot
			? relation.relationStatementAnchorWorkUnitRef
			: relation.relationStatementSubjectWorkUnitRef;
		if (counterpart.workUnitType !== "kanban_board_card") return;
		resetForm();

		setForm({
			...buildRelationDetailsForm(relation),
			selectedCounterpartKanbanBoardCard: {
				counterpartKanbanBoardCardWorkspaceId: counterpart.workspaceId,
				counterpartKanbanBoardCardTaskId: counterpart.taskId,
				counterpartKanbanBoardCardTitle:
					preview?.workUnits.find(
						(entry) =>
							entry.workUnit.workUnitType === "kanban_board_card" &&
							entry.workUnit.workspaceId === counterpart.workspaceId &&
							entry.workUnit.taskId === counterpart.taskId,
					)?.kanbanBoardCardIdentity?.currentTitle ?? counterpart.taskId,
				counterpartKanbanProjectDisplayName: counterpart.workspaceId,
			},
		});
		setDirection(subjectIsRoot);
		setEditing(relation);
		setFormOpen(true);
		setFormError(null);
	}
	function editPendingDraft(draft: ReferenceRelationModelingDraft) {
		resetForm();
		const ref = draft.counterpartWorkUnit;
		if (ref.workUnitType !== "kanban_board_card") return;
		previewSeededCounterpartCanonicalIdentityRef.current = ref;
		const invalidDetailsForm =
			controller.readLatestDraft().invalidReferenceRelationDetailsFormsByDraftId?.[draft.draftId];
		setForm(buildPendingRelationDetailsForm(draft, invalidDetailsForm));
		setEditingDraft(draft);
		setDirection(invalidDetailsForm?.currentTaskIsStatementSubject ?? draft.currentTaskIsStatementSubject);
		setFormOpen(true);
	}

	useEffect(() => {
		if (!editingDraft) return;
		const storedDraft = controller
			.readLatestDraft()
			.referenceRelationDrafts.find((draft) => draft.draftId === editingDraft.draftId);
		if (!storedDraft) {
			resetForm();
			return;
		}
		const validation = validateAddReferenceRelationDialogDraftIntoAssertionRequest({
			draft: form,
			subjectKanbanBoardCardWorkspaceId: workspaceId,
			subjectKanbanBoardCardTaskId: taskId ?? "task-being-created",
		});
		if (!validation.isDraftReadyForSubmission) {
			setFormError(validation.draftValidationProblemMessages.join("；"));
			const { selectedCounterpartKanbanBoardCard: _counterpart, ...rawDetails } = form;
			const invalidDetailsForm = { ...rawDetails, currentTaskIsStatementSubject: direction };
			const invalidDetailsForms = controller.readLatestDraft().invalidReferenceRelationDetailsFormsByDraftId ?? {};
			if (!isDeepEqual(invalidDetailsForm, invalidDetailsForms[editingDraft.draftId]))
				controller.updateDraft({
					invalidReferenceRelationDetailsFormsByDraftId: {
						...invalidDetailsForms,
						[editingDraft.draftId]: invalidDetailsForm,
					},
				});
			return;
		}
		setFormError(null);
		const value = validation.referenceRelationAssertionRequestWithoutClientCharacteristics;
		const attributes = value.assertedRelationKindSpecificAttributes;
		if (
			value.relationKind === editingDraft.relationKind &&
			direction === editingDraft.currentTaskIsStatementSubject
		) {
			if (editingDraft.assertedRelationKindSpecificAttributes.originatingPostDeployVerificationEntry)
				attributes.originatingPostDeployVerificationEntry =
					editingDraft.assertedRelationKindSpecificAttributes.originatingPostDeployVerificationEntry;
			if (attributes.claimsUnderVerification)
				attributes.claimsUnderVerification = attributes.claimsUnderVerification.map((claim) => ({
					...claim,
					verificationVerdict:
						editingDraft.assertedRelationKindSpecificAttributes.claimsUnderVerification?.find(
							(previous) => previous.claimSummary === claim.claimSummary,
						)?.verificationVerdict ?? claim.verificationVerdict,
				}));
		}
		const nextDraft = {
			...editingDraft,
			relationKind: value.relationKind,
			currentTaskIsStatementSubject: direction,
			relationAssertionRationaleOneSentence: value.relationAssertionRationaleOneSentence,
			relationAssertionEvidencePointers: value.relationAssertionEvidencePointers,
			assertedRelationKindSpecificAttributes: attributes,
		};
		const invalidDetailsForms = controller.readLatestDraft().invalidReferenceRelationDetailsFormsByDraftId;
		if (!isDeepEqual(nextDraft, storedDraft) || invalidDetailsForms?.[editingDraft.draftId])
			controller.updateDraft({
				referenceRelationDrafts: controller
					.readLatestDraft()
					.referenceRelationDrafts.map((draft) => (draft.draftId === nextDraft.draftId ? nextDraft : draft)),
				invalidReferenceRelationDetailsFormsByDraftId: Object.fromEntries(
					Object.entries(invalidDetailsForms ?? {}).filter(([draftId]) => draftId !== editingDraft.draftId),
				),
			});
	}, [form, direction, editingDraft, workspaceId, taskId, controller, resetForm]);

	async function addFormToDraft(
		selectedForm = form,
		relationBeingEdited = editing,
		currentTaskIsStatementSubject = direction,
	) {
		setForm(selectedForm);
		setFormError(null);
		const result = validateAddReferenceRelationDialogDraftIntoAssertionRequest({
			draft: selectedForm,
			subjectKanbanBoardCardWorkspaceId: workspaceId,
			subjectKanbanBoardCardTaskId: taskId ?? "task-being-created",
		});
		if (!result.isDraftReadyForSubmission) {
			setFormError(result.draftValidationProblemMessages.join("；"));
			return;
		}
		const counterpart = selectedForm.selectedCounterpartKanbanBoardCard;
		if (!counterpart) return;
		const counterpartResolutionAttempt = Symbol();
		pendingCounterpartResolutionAttemptRef.current = counterpartResolutionAttempt;
		const isCurrentCounterpartResolutionAttempt = () =>
			pendingCounterpartResolutionAttemptRef.current === counterpartResolutionAttempt;
		setResolving(true);
		const expectedCounterpartCanonicalIdentity = previewSeededCounterpartCanonicalIdentityRef.current;
		try {
			const ref = await resolveRelationModelingCounterpart(
				counterpart.counterpartKanbanBoardCardWorkspaceId,
				counterpart.counterpartKanbanBoardCardTaskId,
			);
			if (!isCurrentCounterpartResolutionAttempt()) return;
			if (expectedCounterpartCanonicalIdentity && !isDeepEqual(ref, expectedCounterpartCanonicalIdentity)) {
				throw new Error("预览中的任务已删除并重建，请重新搜索并选择要关联的任务。");
			}
			const value = result.referenceRelationAssertionRequestWithoutClientCharacteristics;
			if (ref.workUnitType === "kanban_board_card" && ref.workspaceId === workspaceId && ref.taskId === taskId)
				throw new Error("任务不能关联自身。");
			const symmetric =
				ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[value.relationKind].relationEndpointSymmetry ===
				"symmetric_unordered_endpoint_pair";
			if (
				controller
					.readLatestDraft()
					.referenceRelationDrafts.some(
						(draft) =>
							draft.relationKind === value.relationKind &&
							isDeepEqual(draft.counterpartWorkUnit, ref) &&
							(symmetric || draft.currentTaskIsStatementSubject === currentTaskIsStatementSubject),
					)
			)
				throw new Error("相同类型与方向的关系已在待保存列表中。");
			const attributes = value.assertedRelationKindSpecificAttributes;
			const currentTaskWorkUnit = preview?.workUnits.find(
				(entry) => entry.workUnitKey === preview.rootWorkUnitKey,
			)?.workUnit;
			const statementEndpointsUnchanged =
				currentTaskWorkUnit &&
				isDeepEqual(
					relationBeingEdited?.relationStatementSubjectWorkUnitRef,
					currentTaskIsStatementSubject ? currentTaskWorkUnit : ref,
				) &&
				isDeepEqual(
					relationBeingEdited?.relationStatementAnchorWorkUnitRef,
					currentTaskIsStatementSubject ? ref : currentTaskWorkUnit,
				);
			if (
				relationBeingEdited?.relationKind === "reference_requirement_originates_from" &&
				value.relationKind === relationBeingEdited.relationKind &&
				statementEndpointsUnchanged &&
				relationBeingEdited.assertedRelationKindSpecificAttributes.originatingPostDeployVerificationEntry
			) {
				attributes.originatingPostDeployVerificationEntry = relationBeingEdited
					.assertedRelationKindSpecificAttributes
					.originatingPostDeployVerificationEntry as AssertedReferenceRelationKindSpecificAttributes["originatingPostDeployVerificationEntry"];
			}
			// 端点完整身份与陈述角色不变时，沿用同名主张的结论；换端点、反向或改写主张均重新核验。
			if (
				relationBeingEdited?.relationKind === value.relationKind &&
				statementEndpointsUnchanged &&
				attributes.claimsUnderVerification
			) {
				const previousClaims = relationBeingEdited.assertedRelationKindSpecificAttributes
					.claimsUnderVerification as AssertedReferenceRelationKindSpecificAttributes["claimsUnderVerification"];
				attributes.claimsUnderVerification = attributes.claimsUnderVerification.map((claim) => ({
					...claim,
					verificationVerdict:
						previousClaims?.find((previous) => previous.claimSummary === claim.claimSummary)
							?.verificationVerdict ?? claim.verificationVerdict,
				}));
			}
			controller.addDraft({
				draftId: createRandomUuidV4WithInsecureContextFallback(),
				replacesRelationId: relationBeingEdited?.relationId ?? null,
				expectedAssertedRelationStateVersion: relationBeingEdited?.assertedRelationStateVersion ?? null,
				counterpartWorkUnit: ref,
				relationKind: value.relationKind,
				currentTaskIsStatementSubject: currentTaskIsStatementSubject,
				relationAssertionRationaleOneSentence: value.relationAssertionRationaleOneSentence,
				relationAssertionEvidencePointers: value.relationAssertionEvidencePointers,
				assertedRelationKindSpecificAttributes: value.assertedRelationKindSpecificAttributes,
			});
			onDraftInteraction?.();
			resetForm();
		} catch (failure) {
			if (isCurrentCounterpartResolutionAttempt()) {
				setFormError(failure instanceof Error ? failure.message : String(failure));
			}
		} finally {
			if (isCurrentCounterpartResolutionAttempt()) {
				pendingCounterpartResolutionAttemptRef.current = null;
				setResolving(false);
			}
		}
	}
	const selectedKind = form.selectedReferenceRelationKind;
	const relationSaveDisabled =
		!taskId ||
		!controller.hasChanges ||
		controller.saving ||
		creationInFlight ||
		!controller.ready ||
		hasUnstagedRelationForm ||
		readOnly;
	const saveRelationsFromExplicitUserGesture = (event: TriggeringExplicitUserGestureEvent) => {
		if (!taskId || relationSaveDisabled) return;
		const characteristics = collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(event);
		return controller
			.applyToTask(taskId, characteristics)
			.then(onRelationsSaved)
			.catch(() => undefined);
	};
	const handleRelationSaveKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: saveRelationsFromExplicitUserGesture,
		disabled: relationSaveDisabled,
	});
	const relationDetailsSubmitDisabled =
		resolving ||
		controller.saving ||
		creationInFlight ||
		readOnly ||
		Boolean(editingDraft) ||
		!(editing || form.selectedCounterpartKanbanBoardCard);
	const handleRelationDetailsKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: () => addFormToDraft(),
		disabled: relationDetailsSubmitDisabled,
	});
	const relationModelingContents = (
		<section
			onKeyDown={handleRelationSaveKeyDown}
			aria-label="任务关系建模"
			className="@container flex min-w-0 flex-col gap-3 py-3 text-xs text-text-primary"
		>
			<fieldset disabled={controller.saving || creationInFlight} className="flex min-w-0 flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					{clipboardCandidates.length ? (
						<div className="space-y-2" role="group" aria-label="剪贴板任务匹配">
							<p className="text-xs text-text-secondary">剪贴板识别到任务，点击关联后加入列表：</p>
							{clipboardCandidates.map((candidate) => (
								<Button
									key={JSON.stringify(candidate.kanbanBoardCard)}
									disabled={readOnly || !controller.ready || resolving}
									size="sm"
									onClick={() => selectClipboardCounterpart(candidate)}
								>
									关联 {candidate.kanbanBoardCard.workspaceId} /{" "}
									{candidate.currentTitle ?? candidate.kanbanBoardCard.taskId}
								</Button>
							))}
						</div>
					) : null}

					<div>
						<h3 className={presentation === "task_editor" ? "sr-only" : "font-medium"}>关联任务</h3>
						<p className="mt-1 text-text-secondary">选择已有任务即可关联，类型与详情均可选。</p>
					</div>
					<div className="flex gap-1">
						<Button
							size="xs"
							onClick={() => {
								resetForm();
								setFormOpen(true);
							}}
							disabled={!controller.ready || controller.saving || readOnly || hasUnstagedCounterpartSelection}
						>
							添加关系
						</Button>
						<Button size="xs" variant="ghost" onClick={controller.refresh}>
							刷新关系
						</Button>
					</div>
				</div>
				{controller.draftPersistenceError ? (
					<p role="status" className="text-status-orange">
						{controller.draftPersistenceError}
					</p>
				) : null}
				{controller.error ? (
					<p role="alert" className="rounded-md bg-status-red/15 p-2 text-text-primary">
						{controller.error}
					</p>
				) : null}
				{hasInvalidDetailsForms && (!formOpen || !editingDraft || !invalidDetailsForms[editingDraft.draftId]) ? (
					<p role="alert" className="text-status-orange">
						请展开详情修正无效输入，或移除对应关系。{invalidDetailsProblemMessages.join("；")}
					</p>
				) : null}
				{!formOpen && formError ? (
					<p role="alert" className="text-status-orange">
						{formError}
					</p>
				) : null}
				{readOnly ? (
					<p role="status" className="text-text-secondary">
						这是已删除任务的历史关系，只读展示这一世身份。
					</p>
				) : null}
				{formOpen ? (
					<div
						onKeyDown={handleRelationDetailsKeyDown}
						className="flex flex-col gap-3 rounded-md border border-border-bright bg-surface-1 p-3"
						role="group"
						aria-label={editing ? "修改参照关系" : "新增参照关系"}
					>
						{!editingDraft ? (
							<WorkUnitRelationCounterpartKanbanBoardCardPicker
								subjectKanbanBoardCardWorkspaceId={workspaceId}
								subjectKanbanBoardCardTaskId={taskId ?? ""}
								selectedCounterpartKanbanBoardCard={form.selectedCounterpartKanbanBoardCard}
								onSelectedCounterpartKanbanBoardCardChange={(value) => {
									previewSeededCounterpartCanonicalIdentityRef.current = null;
									setForm((previous) => ({ ...previous, selectedCounterpartKanbanBoardCard: value }));
									if (value && !editing && !editingDraft)
										void addFormToDraft({ ...form, selectedCounterpartKanbanBoardCard: value });
								}}
								searchInputElementId={`${id}-search`}
							/>
						) : null}
						{editing || editingDraft || form.selectedCounterpartKanbanBoardCard ? (
							<>
								<label className="flex flex-col gap-1" htmlFor={`${id}-kind`}>
									关系类型
									<NativeSelect
										id={`${id}-kind`}
										aria-label="关系类型"
										size="sm"
										fill
										value={selectedKind}
										onChange={(event) =>
											setForm((previous) => ({
												...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
												selectedCounterpartKanbanBoardCard: previous.selectedCounterpartKanbanBoardCard,
												relationAssertionRationaleOneSentenceText:
													previous.relationAssertionRationaleOneSentenceText,
												relationAssertionEvidencePointersOnePerLineText:
													previous.relationAssertionEvidencePointersOnePerLineText,
												selectedReferenceRelationKind: event.target
													.value as AddReferenceRelationDialogDraft["selectedReferenceRelationKind"],
											}))
										}
									>
										<option value="">普通关联（默认）</option>
										{ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS.map((kind) => (
											<option key={kind} value={kind}>
												{REFERENCE_RELATION_LABELS[kind]}
											</option>
										))}
									</NativeSelect>
								</label>
								{selectedKind &&
								ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY[selectedKind].relationEndpointSymmetry !==
									"symmetric_unordered_endpoint_pair" ? (
									<label className="flex flex-col gap-1" htmlFor={`${id}-direction`}>
										陈述方向
										<NativeSelect
											id={`${id}-direction`}
											aria-label="陈述方向"
											size="sm"
											fill
											value={direction ? "current" : "other"}
											onChange={(event) => setDirection(event.target.value === "current")}
										>
											<option value="current">当前任务 → 关联任务</option>
											<option value="other">关联任务 → 当前任务</option>
										</NativeSelect>
									</label>
								) : null}
								{selectedKind && form.selectedCounterpartKanbanBoardCard ? (
									<p className="rounded-md bg-surface-2 p-2" role="note" aria-label="关系陈述预览">
										{direction
											? rootTitle
											: form.selectedCounterpartKanbanBoardCard.counterpartKanbanBoardCardTitle}{" "}
										· {REFERENCE_RELATION_LABELS[selectedKind]} ·{" "}
										{direction
											? form.selectedCounterpartKanbanBoardCard.counterpartKanbanBoardCardTitle
											: rootTitle}
									</p>
								) : null}
								<details className="space-y-3">
									<summary className="cursor-pointer text-text-secondary">可选详情</summary>
									{(selectedKind
										? listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs(selectedKind)
										: []
									)
										.filter((key) => key !== "relatednessRationaleOneSentence")
										.map((key) => (
											<label key={key} className="flex flex-col gap-1" htmlFor={`${id}-${key}`}>
												{ATTRIBUTE_LABELS[key]}
												<KindSpecificAttributeInput
													attributeKey={key}
													attributeInputElementId={`${id}-${key}`}
													draft={form}
													updateDraft={(patch) => setForm((previous) => ({ ...previous, ...patch }))}
												/>
											</label>
										))}
									<label className="flex flex-col gap-1" htmlFor={`${id}-reason`}>
										关系理由（可选）
										<input
											id={`${id}-reason`}
											className={INPUT_CLASS}
											value={form.relationAssertionRationaleOneSentenceText}
											maxLength={600}
											onChange={(event) =>
												setForm((previous) => ({
													...previous,
													relationAssertionRationaleOneSentenceText: event.target.value,
												}))
											}
										/>
									</label>
									<label className="flex flex-col gap-1" htmlFor={`${id}-evidence`}>
										证据位置（可选，每行一个）
										<textarea
											id={`${id}-evidence`}
											rows={2}
											className={INPUT_CLASS}
											value={form.relationAssertionEvidencePointersOnePerLineText}
											onChange={(event) =>
												setForm((previous) => ({
													...previous,
													relationAssertionEvidencePointersOnePerLineText: event.target.value,
												}))
											}
										/>
									</label>
								</details>
							</>
						) : null}
						{formError ? (
							<p role="alert" className="text-status-orange">
								{formError}
							</p>
						) : null}
						<div className="flex gap-2">
							{!editingDraft && (editing || form.selectedCounterpartKanbanBoardCard) ? (
								<Button
									{...FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS}
									size="xs"
									disabled={relationDetailsSubmitDisabled}
									onClick={() => void addFormToDraft()}
								>
									{resolving ? "正在核对身份…" : editing ? "保存详情到草稿" : "添加关系到草稿"}
								</Button>
							) : resolving ? (
								<span role="status">正在核对身份…</span>
							) : null}
							<Button
								size="xs"
								variant="ghost"
								onClick={() => (editingDraft ? setFormOpen(false) : resetForm())}
							>
								{editingDraft ? "收起详情" : "取消"}
							</Button>
						</div>
					</div>
				) : null}
				<ul aria-label="待保存关联任务" className="divide-y divide-border">
					{controller.draft.referenceRelationDrafts.map((draft) => (
						<li key={draft.draftId} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
							<span className="min-w-0 flex-1 break-words">
								{draft.counterpartWorkUnit.workUnitType === "kanban_board_card"
									? `${draft.counterpartWorkUnit.workspaceId} / ${preview?.workUnits.find((entry) => isDeepEqual(entry.workUnit, draft.counterpartWorkUnit))?.kanbanBoardCardIdentity?.currentTitle ?? draft.counterpartWorkUnit.taskId}`
									: draft.counterpartWorkUnit.nativeConversationSessionId}
							</span>
							{invalidDetailsForms[draft.draftId] ? <span className="text-status-orange">详情有误</span> : null}
							<NativeSelect
								aria-label="待保存关系类型"
								size="sm"
								value={draft.relationKind}
								onChange={(event) => {
									if (editingDraft?.draftId === draft.draftId) resetForm();
									controller.addDraft({
										...draft,
										relationKind: event.target.value as ReferenceRelationModelingDraft["relationKind"],
										assertedRelationKindSpecificAttributes: {},
									});
								}}
								disabled={
									readOnly ||
									Boolean(invalidDetailsForms[draft.draftId]) ||
									(formOpen && editingDraft?.draftId === draft.draftId)
								}
							>
								{ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS.map((kind) => (
									<option key={kind} value={kind}>
										{REFERENCE_RELATION_LABELS[kind]}
									</option>
								))}
							</NativeSelect>
							<Button
								size="xs"
								variant="ghost"
								disabled={readOnly || hasUnstagedCounterpartSelection}
								onClick={() =>
									editingDraft?.draftId === draft.draftId
										? setFormOpen((open) => !open)
										: editPendingDraft(draft)
								}
							>
								{editingDraft?.draftId === draft.draftId && formOpen ? "收起详情" : "详情"}
							</Button>
							<Button
								size="xs"
								variant="ghost"
								disabled={readOnly}
								onClick={() => {
									if (editingDraft?.draftId === draft.draftId) resetForm();
									controller.updateDraft({
										referenceRelationDrafts: controller
											.readLatestDraft()
											.referenceRelationDrafts.filter((entry) => entry.draftId !== draft.draftId),
									});
								}}
							>
								移除关系
							</Button>
						</li>
					))}
				</ul>

				<div className="flex flex-wrap items-center gap-2">
					<span
						hidden={presentation === "task_editor" && !taskEditorRelationGraphOpen}
						className="text-text-secondary"
					>
						预览范围
					</span>
					<NativeSelect
						aria-label="关系图跳数"
						containerClassName={
							presentation === "task_editor" && !taskEditorRelationGraphOpen ? "hidden" : undefined
						}
						size="sm"
						value={controller.depth}
						onChange={(event) => controller.setDepth(Number(event.target.value) as 1 | 2 | 3)}
					>
						<option value={1}>一跳</option>
						<option value={2}>两跳</option>
						<option value={3}>三跳</option>
					</NativeSelect>
					<div className={`ml-auto flex gap-1 ${presentation !== "task_editor" ? "@min-[760px]:hidden" : ""}`}>
						<Button
							size="xs"
							variant={narrowView === "list" ? "default" : "ghost"}
							onClick={() => {
								setNarrowView("list");
								setTaskEditorRelationGraphOpen(false);
							}}
						>
							列表
						</Button>
						<Button
							size="xs"
							variant={narrowView === "graph" ? "default" : "ghost"}
							onClick={() => {
								setNarrowView("graph");
								setTaskEditorRelationGraphOpen(true);
							}}
						>
							关系图
						</Button>
					</div>
				</div>
				{!preview && !controller.error ? (
					<p role="status" className="flex items-center gap-2 py-4 text-text-secondary">
						<Spinner size={12} />
						正在读取关系预览…
					</p>
				) : preview ? (
					<div
						className={
							presentation === "foreground"
								? "grid min-w-0 gap-3 @min-[760px]:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]"
								: presentation === "task_editor"
									? "flex min-w-0 flex-col gap-3"
									: "grid min-w-0 gap-3 @min-[760px]:grid-cols-2"
						}
					>
						<div
							className={`${presentation === "task_editor" || narrowView === "list" ? "" : "hidden"} min-w-0 ${presentation !== "task_editor" ? "@min-[760px]:block" : ""}`}
						>
							<ul className="divide-y divide-border">
								{preview.relations
									.filter(
										(relation) =>
											(relation.relationPresentationState === "saved" ||
												relation.relationPresentationState === "pending_revocation") &&
											(relation.subjectKey === preview.rootWorkUnitKey ||
												relation.anchorKey === preview.rootWorkUnitKey),
									)
									.map((relation) => (
										<li key={relation.relationId} className="py-2">
											<p className="break-words">
												{labels.get(relation.subjectKey) ?? relation.subjectKey}{" "}
												<span className="text-text-secondary">
													{RELATION_GRAPH_LABELS[relation.relationKind] ?? relation.relationKind}
												</span>{" "}
												{[
													"reference_is_generally_related_with",
													"reference_is_cross_repository_counterpart_with",
												].includes(relation.relationKind)
													? "↔"
													: "→"}{" "}
												{labels.get(relation.anchorKey) ?? relation.anchorKey}
											</p>
											<p className="mt-1 text-text-secondary">
												{RELATION_PREVIEW_STATE_LABELS[relation.relationPresentationState]}
												{relation.assertedRelation
													? relation.assertedRelation.relationAsserterWorkUnitRef
														? " · agent 声明"
														: " · 人工声明"
													: relation.relationPresentationState === "saved"
														? " · 系统记录，只读"
														: ""}
											</p>
											{relation.assertedRelation?.relationAssertionRationaleOneSentence ? (
												<p className="mt-1 break-words text-text-secondary">
													{relation.assertedRelation.relationAssertionRationaleOneSentence}
												</p>
											) : null}
											{relation.relationPresentationState === "saved" &&
											relation.assertedRelation &&
											relation.relationKind in REFERENCE_RELATION_LABELS ? (
												<div className="mt-1 flex flex-wrap gap-1">
													<Button
														size="xs"
														variant="ghost"
														onClick={() =>
															editRelation(relation.assertedRelation as AssertedInterWorkUnitRelation)
														}
														disabled={readOnly || hasUnstagedCounterpartSelection}
													>
														修改
													</Button>
													{(["relation_ended_naturally", "relation_was_incorrect"] as const).map(
														(reason) => (
															<Button
																key={reason}
																size="xs"
																variant="ghost"
																onClick={() =>
																	controller.updateDraft({
																		relationRevocations: [
																			// 同一关系以最后一次点击的撤销理由为准，不依赖预览刷新。
																			...controller
																				.readLatestDraft()
																				.relationRevocations.filter(
																					(entry) => entry.relationId !== relation.relationId,
																				),
																			{
																				relationId: relation.relationId,
																				expectedAssertedRelationStateVersion:
																					relation.assertedRelation
																						?.assertedRelationStateVersion ?? 1,
																				relationAssertionRevocationReason: reason,
																			},
																		],
																	})
																}
																disabled={readOnly}
															>
																{reason === "relation_was_incorrect" ? "标记关系有误" : "结束关系"}
															</Button>
														),
													)}
												</div>
											) : relation.relationPresentationState !== "saved" ? (
												<Button
													size="xs"
													variant="ghost"
													onClick={() =>
														controller.updateDraft({
															referenceRelationDrafts: controller.draft.referenceRelationDrafts.filter(
																(entry) =>
																	`draft:${entry.draftId}` !== relation.relationId &&
																	entry.replacesRelationId !== relation.relationId,
															),
															relationRevocations: controller.draft.relationRevocations.filter(
																(entry) => entry.relationId !== relation.relationId,
															),
														})
													}
												>
													撤回此项修改
												</Button>
											) : null}
										</li>
									))}
							</ul>
							{preview.relations.length === 0 ? (
								<p className="py-4 text-text-secondary">还没有关联任务。添加一条关系后，可预览它周围的任务。</p>
							) : null}
						</div>
						<div
							className={`${narrowView === "graph" ? "" : "hidden"} min-w-0 ${presentation !== "task_editor" ? "@min-[760px]:block" : ""}`}
						>
							{presentation !== "task_editor" || taskEditorRelationGraphOpen ? (
								<ReferenceRelationModelingGraph
									preview={preview}
									rootTitle={rootTitle}
									viewportResetKey={preview.rootWorkUnitKey}
									onSelectWorkUnit={(key, trigger) => {
										setNarrowView("graph");
										taskCardPreview.pinPreview(previewTargetForWorkUnit(key), trigger);
									}}
									onHoverWorkUnit={(key, trigger) => {
										setNarrowView("graph");
										taskCardPreview.previewOnHover(previewTargetForWorkUnit(key), trigger);
									}}
									onLeaveWorkUnit={taskCardPreview.cancelPendingPreview}
									onFocusWorkUnit={(key, trigger) => {
										setNarrowView("graph");
										taskCardPreview.previewOnFocus(previewTargetForWorkUnit(key), trigger);
									}}
									expanded={presentation === "foreground"}
								/>
							) : null}
							<p className="mt-2 text-text-secondary">
								实线：已保存。虚线：待保存变更。路径仅表示连通，不代表直接关系。
							</p>
						</div>
					</div>
				) : null}
				{preview?.truncated ? (
					<p role="status" className="text-status-orange">
						关系较多，预览已截断（最多 150 个任务、300 条关系）。可缩小跳数查看。
					</p>
				) : null}
				<details open={presentation !== "task_editor"}>
					<summary className="cursor-pointer text-text-secondary">关系建议（可选）</summary>
					<div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
						<span className="font-medium">AI 关系建议</span>
						<Button
							size="xs"
							disabled={
								!controller.ready ||
								controller.suggestionsLoading ||
								controller.saving ||
								creationInFlight ||
								readOnly
							}
							onClick={() => {
								void controller.requestSuggestions();
							}}
						>
							{controller.suggestionsLoading ? "正在分析任务关系…" : "获取关系建议"}
						</Button>
						<span className="text-text-secondary">选择后加入草稿，保存时再确认。</span>
					</div>
					{controller.suggestionsError ? (
						<p role="alert" className="text-status-orange">
							关系建议失败：{controller.suggestionsError}
						</p>
					) : null}
					{controller.suggestions?.availability === "unavailable" ? (
						<p role="status" className="text-text-secondary">
							{controller.suggestions.unavailableReason}
						</p>
					) : null}
					{controller.suggestions?.availability === "available" &&
					controller.suggestions.candidates.length === 0 ? (
						<p role="status" className="text-text-secondary">
							本次未找到相关任务。
						</p>
					) : null}
					{controller.suggestions?.candidates.map((candidate) => {
						const reference = candidate.relationDraft.counterpartWorkUnit;
						const label =
							reference.workUnitType === "kanban_board_card"
								? `${reference.workspaceId}/${reference.taskId}`
								: reference.nativeConversationSessionId;
						const alreadySelected = controller.draft.referenceRelationDrafts.some(
							(draft) =>
								draft.relationKind === candidate.relationDraft.relationKind &&
								isDeepEqual(draft.counterpartWorkUnit, reference),
						);
						return (
							<div key={candidate.candidateId} className="rounded-md border border-border bg-surface-2 p-3">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<span className="font-medium">
										{label} · {REFERENCE_RELATION_LABELS[candidate.relationDraft.relationKind]}
									</span>
									<Button
										size="xs"
										disabled={alreadySelected || controller.saving || creationInFlight}
										onClick={() => {
											controller.addDraft(candidate.relationDraft);
											onDraftInteraction?.();
										}}
									>
										{alreadySelected ? "已加入草稿" : "加入草稿"}
									</Button>
								</div>
								<p className="mt-2 whitespace-pre-wrap text-text-secondary">{candidate.rationale}</p>
								{candidate.evidencePointers.length ? (
									<ul className="mt-2 list-inside list-disc break-words text-text-secondary">
										{candidate.evidencePointers.map((pointer, index) => (
											<li key={`${index}:${pointer}`}>{pointer}</li>
										))}
									</ul>
								) : null}
							</div>
						);
					})}
				</details>
				{taskId ? (
					<div className="flex gap-2">
						<Button
							size="xs"
							{...FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS}
							disabled={relationSaveDisabled}
							onClick={(event) => void saveRelationsFromExplicitUserGesture(event)}
						>
							{controller.saving ? "正在保存关系…" : "保存关系变更"}
						</Button>
						<Button
							size="xs"
							variant="ghost"
							disabled={!controller.hasChanges || controller.saving || readOnly}
							onClick={controller.discard}
						>
							放弃修改
						</Button>
					</div>
				) : (
					<p className="text-text-secondary">关系将在创建任务时保存。尚未创建任务时，草稿不会写入关系账本。</p>
				)}
				{formOpen && editing ? (
					<p role="status" className="text-text-secondary">
						请先保存当前详情或取消编辑，再提交。
					</p>
				) : null}
			</fieldset>
		</section>
	);
	return (
		<RelationTaskCardPreviewLayout
			controller={taskCardPreview}
			previewActions={
				selected && preview && selected.workUnitKey !== preview.rootWorkUnitKey ? (
					<div>
						{selected.workUnit.workUnitType === "kanban_board_card" ? (
							<div className="flex flex-wrap gap-2">
								{foregroundNavigation ? (
									<Button
										size="xs"
										variant="ghost"
										className="mt-2"
										disabled={formOpen}
										onClick={() => {
											const ref = selected.kanbanBoardCardIdentity?.kanbanBoardCard ?? selected.workUnit;
											if (ref.workUnitType === "kanban_board_card")
												foregroundNavigation.open({ ...ref, viewKind: "task_relations" });
										}}
									>
										以此任务为中心
									</Button>
								) : null}
								<Button
									size="xs"
									className="mt-2"
									disabled={
										readOnly ||
										hasUnstagedCounterpartSelection ||
										selected.kanbanBoardCardIdentity?.permanentlyRemovedFromBoardAt != null
									}
									onClick={() => {
										const canonicalRef = selected.workUnit;
										if (canonicalRef.workUnitType !== "kanban_board_card") return;
										const ref = selected.kanbanBoardCardIdentity?.kanbanBoardCard ?? canonicalRef;
										resetForm();
										// 表单按当前位置搜索；解析器返回 canonical 端点，用它核对同一世身份。
										previewSeededCounterpartCanonicalIdentityRef.current = canonicalRef;
										const selectedForm = {
											...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
											selectedCounterpartKanbanBoardCard: {
												counterpartKanbanBoardCardWorkspaceId: ref.workspaceId,
												counterpartKanbanBoardCardTaskId: ref.taskId,
												counterpartKanbanBoardCardTitle:
													selected.kanbanBoardCardIdentity?.currentTitle ?? ref.taskId,
												counterpartKanbanProjectDisplayName: ref.workspaceId,
											},
										};
										setForm(selectedForm);
										void addFormToDraft(selectedForm, null, true);
										setFormOpen(true);
									}}
								>
									与当前任务建立关系
								</Button>
							</div>
						) : null}
					</div>
				) : null
			}
		>
			{relationModelingContents}
		</RelationTaskCardPreviewLayout>
	);
}
