import type {
	AssertedInterWorkUnitRelation,
	AssertedReferenceRelationKindSpecificAttributes,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import {
	ASSERTED_INTER_WORK_UNIT_REFERENCE_RELATION_KINDS,
	ASSERTED_INTER_WORK_UNIT_RELATION_KIND_REGISTRY,
} from "@runtime-inter-work-unit-asserted-relation-kind-registry-contract";
import isDeepEqual from "fast-deep-equal";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
	REFERENCE_RELATION_LABELS,
	RELATION_GRAPH_LABELS,
	RELATION_PREVIEW_STATE_LABELS,
	ReferenceRelationModelingGraph,
} from "@/components/detail-panels/reference-relation-modeling-graph";
import { KindSpecificAttributeInput } from "@/components/detail-panels/work-unit-relation-add-reference-relation-dialog";
import { WorkUnitRelationCounterpartKanbanBoardCardPicker } from "@/components/detail-panels/work-unit-relation-counterpart-kanban-board-card-picker";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { useExpandedForegroundViewNavigation } from "@/expanded-foreground-view/expanded-foreground-view-context";
import type { ReferenceRelationModelingEditorController } from "@/hooks/use-reference-relation-modeling-editor";
import type { TaskEditorClipboardTaskSelectionRequest } from "@/hooks/use-task-editor-clipboard-task-reference";
import {
	type AddReferenceRelationDialogDraft,
	EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
	listKindSpecificAttributeKeysShownAsAddReferenceRelationDialogInputs,
	validateAddReferenceRelationDialogDraftIntoAssertionRequest,
} from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";
import { collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent } from "@/runtime/work-unit-relation-assertion-write-query";
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
	presentation?: "embedded" | "foreground";
	readOnly?: boolean;
	clipboardSelectionRequest?: TaskEditorClipboardTaskSelectionRequest | null;
}) {
	const foregroundNavigation = useExpandedForegroundViewNavigation();
	const id = useId();
	const [form, setForm] = useState<AddReferenceRelationDialogDraft>(EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT);
	const [direction, setDirection] = useState(true);
	const [editing, setEditing] = useState<AssertedInterWorkUnitRelation | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [resolving, setResolving] = useState(false);
	const pendingCounterpartResolutionAttemptRef = useRef<symbol | null>(null);
	const [narrowView, setNarrowView] = useState<"list" | "graph">(taskId ? "graph" : "list");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	useEffect(() => {
		onUnstagedFormChange?.(formOpen);
		return () => onUnstagedFormChange?.(false);
	}, [formOpen, onUnstagedFormChange]);
	const preview = controller.preview;
	const labels = new Map(
		preview?.workUnits.map((entry) => [
			entry.workUnitKey,
			entry.kanbanBoardCardIdentity?.currentTitle ?? entry.workUnitDisplayLabel,
		]) ?? [],
	);
	if (preview) labels.set(preview.rootWorkUnitKey, rootTitle);
	const selected = preview?.workUnits.find((entry) => entry.workUnitKey === selectedKey);
	const resetForm = useCallback(() => {
		pendingCounterpartResolutionAttemptRef.current = null;
		setResolving(false);
		setForm(EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT);
		setDirection(true);
		setEditing(null);
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
		setForm({
			...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
			selectedCounterpartKanbanBoardCard: {
				counterpartKanbanBoardCardWorkspaceId: candidate.kanbanBoardCard.workspaceId,
				counterpartKanbanBoardCardTaskId: candidate.kanbanBoardCard.taskId,
				counterpartKanbanBoardCardTitle: candidate.currentTitle ?? candidate.kanbanBoardCard.taskId,
				counterpartKanbanProjectDisplayName: candidate.kanbanBoardCard.workspaceId,
			},
		});
		setClipboardCandidates([]);
		setFormOpen(true);
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
		if (clipboardSelectionRequest.candidates.length === 1 && clipboardSelectionRequest.candidates[0])
			selectClipboardCounterpart(clipboardSelectionRequest.candidates[0]);
		else setClipboardCandidates(clipboardSelectionRequest.candidates);
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
		const attributes =
			relation.assertedRelationKindSpecificAttributes as AssertedReferenceRelationKindSpecificAttributes;
		setForm({
			...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
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
		});
		setDirection(subjectIsRoot);
		setEditing(relation);
		setFormOpen(true);
		setFormError(null);
	}
	async function addFormToDraft() {
		const result = validateAddReferenceRelationDialogDraftIntoAssertionRequest({
			draft: form,
			subjectKanbanBoardCardWorkspaceId: workspaceId,
			subjectKanbanBoardCardTaskId: taskId ?? "task-being-created",
		});
		if (!result.isDraftReadyForSubmission) {
			setFormError(result.draftValidationProblemMessages.join("；"));
			return;
		}
		const counterpart = form.selectedCounterpartKanbanBoardCard;
		if (!counterpart) return;
		const counterpartResolutionAttempt = Symbol();
		pendingCounterpartResolutionAttemptRef.current = counterpartResolutionAttempt;
		const isCurrentCounterpartResolutionAttempt = () =>
			pendingCounterpartResolutionAttemptRef.current === counterpartResolutionAttempt;
		setResolving(true);
		try {
			const ref = await resolveRelationModelingCounterpart(
				counterpart.counterpartKanbanBoardCardWorkspaceId,
				counterpart.counterpartKanbanBoardCardTaskId,
			);
			if (!isCurrentCounterpartResolutionAttempt()) return;
			const value = result.referenceRelationAssertionRequestWithoutClientCharacteristics;
			const attributes = value.assertedRelationKindSpecificAttributes;
			const currentTaskWorkUnit = preview?.workUnits.find(
				(entry) => entry.workUnitKey === preview.rootWorkUnitKey,
			)?.workUnit;
			const statementEndpointsUnchanged =
				currentTaskWorkUnit &&
				isDeepEqual(editing?.relationStatementSubjectWorkUnitRef, direction ? currentTaskWorkUnit : ref) &&
				isDeepEqual(editing?.relationStatementAnchorWorkUnitRef, direction ? ref : currentTaskWorkUnit);
			if (
				editing?.relationKind === "reference_requirement_originates_from" &&
				value.relationKind === editing.relationKind &&
				statementEndpointsUnchanged &&
				editing.assertedRelationKindSpecificAttributes.originatingPostDeployVerificationEntry
			) {
				attributes.originatingPostDeployVerificationEntry = editing.assertedRelationKindSpecificAttributes
					.originatingPostDeployVerificationEntry as AssertedReferenceRelationKindSpecificAttributes["originatingPostDeployVerificationEntry"];
			}
			// 端点完整身份与陈述角色不变时，沿用同名主张的结论；换端点、反向或改写主张均重新核验。
			if (
				editing?.relationKind === value.relationKind &&
				statementEndpointsUnchanged &&
				attributes.claimsUnderVerification
			) {
				const previousClaims = editing.assertedRelationKindSpecificAttributes
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
				replacesRelationId: editing?.relationId ?? null,
				expectedAssertedRelationStateVersion: editing?.assertedRelationStateVersion ?? null,
				counterpartWorkUnit: ref,
				relationKind: value.relationKind,
				currentTaskIsStatementSubject: direction,
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
	return (
		<section
			aria-label="任务关系建模"
			className="@container flex min-w-0 flex-col gap-3 py-3 text-xs text-text-primary"
		>
			<fieldset disabled={controller.saving || creationInFlight} className="flex min-w-0 flex-col gap-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					{clipboardCandidates.length ? (
						<div className="space-y-2" role="group" aria-label="剪贴板任务匹配">
							<p className="text-xs text-text-secondary">剪贴板任务在多个项目中匹配，请选择：</p>
							{clipboardCandidates.map((candidate) => (
								<Button
									key={JSON.stringify(candidate.kanbanBoardCard)}
									size="sm"
									onClick={() => selectClipboardCounterpart(candidate)}
								>
									{candidate.kanbanBoardCard.workspaceId} /{" "}
									{candidate.currentTitle ?? candidate.kanbanBoardCard.taskId}
								</Button>
							))}
						</div>
					) : null}

					<div>
						<h3 className="font-medium">关联任务</h3>
						<p className="mt-1 text-text-secondary">搜索已有任务，说明它与当前任务的关系。</p>
					</div>
					<div className="flex gap-1">
						<Button
							size="xs"
							onClick={() => {
								resetForm();
								setFormOpen(true);
							}}
							disabled={!controller.ready || controller.saving || readOnly}
						>
							添加关系
						</Button>
						<Button size="xs" variant="ghost" onClick={controller.refresh}>
							刷新关系
						</Button>
					</div>
				</div>
				{controller.draft.createdTaskId ? (
					<p role="status" className="rounded-md bg-status-orange/15 p-2 text-text-primary">
						任务 {controller.draft.createdTaskId} 已创建，
						{controller.hasChanges ? "关系尚未保存。" : "尚未完成提交。"}
						再次提交会继续完成这张任务，不会重复创建。
					</p>
				) : null}
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
				{readOnly ? (
					<p role="status" className="text-text-secondary">
						这是已删除任务的历史关系，只读展示这一世身份。
					</p>
				) : null}
				{formOpen ? (
					<div
						className="flex flex-col gap-3 rounded-md border border-border-bright bg-surface-1 p-3"
						role="group"
						aria-label={editing ? "修改参照关系" : "新增参照关系"}
					>
						<WorkUnitRelationCounterpartKanbanBoardCardPicker
							subjectKanbanBoardCardWorkspaceId={workspaceId}
							subjectKanbanBoardCardTaskId={taskId ?? ""}
							selectedCounterpartKanbanBoardCard={form.selectedCounterpartKanbanBoardCard}
							onSelectedCounterpartKanbanBoardCardChange={(value) =>
								setForm((previous) => ({ ...previous, selectedCounterpartKanbanBoardCard: value }))
							}
							searchInputElementId={`${id}-search`}
						/>
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
								<option value="">选择关系类型</option>
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
							关系理由
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
						{formError ? (
							<p role="alert" className="text-status-orange">
								{formError}
							</p>
						) : null}
						<div className="flex gap-2">
							<Button size="xs" disabled={resolving} onClick={() => void addFormToDraft()}>
								{resolving ? "正在解析任务…" : editing ? "暂存修改" : "加入关系草稿"}
							</Button>
							<Button size="xs" variant="ghost" onClick={resetForm}>
								取消
							</Button>
						</div>
					</div>
				) : null}
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-text-secondary">预览范围</span>
					<NativeSelect
						aria-label="关系图跳数"
						size="sm"
						value={controller.depth}
						onChange={(event) => controller.setDepth(Number(event.target.value) as 1 | 2 | 3)}
					>
						<option value={1}>一跳</option>
						<option value={2}>两跳</option>
						<option value={3}>三跳</option>
					</NativeSelect>
					<div className="ml-auto flex gap-1 @min-[760px]:hidden">
						<Button
							size="xs"
							variant={narrowView === "list" ? "default" : "ghost"}
							onClick={() => setNarrowView("list")}
						>
							列表
						</Button>
						<Button
							size="xs"
							variant={narrowView === "graph" ? "default" : "ghost"}
							onClick={() => setNarrowView("graph")}
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
								: "grid min-w-0 gap-3 @min-[760px]:grid-cols-2"
						}
					>
						<div className={`${narrowView === "list" ? "" : "hidden"} min-w-0 @min-[760px]:block`}>
							<ul className="divide-y divide-border">
								{preview.relations
									.filter(
										(relation) =>
											relation.subjectKey === preview.rootWorkUnitKey ||
											relation.anchorKey === preview.rootWorkUnitKey,
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
											{relation.assertedRelation ? (
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
														disabled={readOnly}
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
						<div className={`${narrowView === "graph" ? "" : "hidden"} min-w-0 @min-[760px]:block`}>
							<ReferenceRelationModelingGraph
								preview={preview}
								rootTitle={rootTitle}
								viewportResetKey={preview.rootWorkUnitKey}
								onSelectWorkUnit={setSelectedKey}
								expanded={presentation === "foreground"}
							/>
							<p className="mt-2 text-text-secondary">
								实线：已保存。虚线：待保存变更。路径仅表示连通，不代表直接关系。
							</p>
							{selected && selected.workUnitKey !== preview.rootWorkUnitKey ? (
								<div className="mt-2 rounded-md bg-surface-2 p-2">
									<p>{selected.workUnitDisplayLabel}</p>
									<p className="mt-1 text-text-secondary">
										{selected.kanbanBoardCardIdentity?.promptFirstParagraph}
									</p>
									{selected.workUnit.workUnitType === "kanban_board_card" ? (
										<div className="flex flex-wrap gap-2">
											{foregroundNavigation ? (
												<Button
													size="xs"
													variant="ghost"
													className="mt-2"
													disabled={formOpen}
													onClick={() => {
														const ref = selected.workUnit;
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
												disabled={readOnly}
												onClick={() => {
													const ref = selected.workUnit;
													if (ref.workUnitType !== "kanban_board_card") return;
													resetForm();
													setForm({
														...EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
														selectedCounterpartKanbanBoardCard: {
															counterpartKanbanBoardCardWorkspaceId: ref.workspaceId,
															counterpartKanbanBoardCardTaskId: ref.taskId,
															counterpartKanbanBoardCardTitle:
																selected.kanbanBoardCardIdentity?.currentTitle ?? ref.taskId,
															counterpartKanbanProjectDisplayName: ref.workspaceId,
														},
													});
													setFormOpen(true);
												}}
											>
												与当前任务建立关系
											</Button>
										</div>
									) : null}
								</div>
							) : null}
						</div>
					</div>
				) : null}
				{preview?.truncated ? (
					<p role="status" className="text-status-orange">
						关系较多，预览已截断（最多 150 个任务、300 条关系）。可缩小跳数查看。
					</p>
				) : null}
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
				{controller.suggestions?.availability === "available" && controller.suggestions.candidates.length === 0 ? (
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
				{taskId ? (
					<div className="flex gap-2">
						<Button
							size="xs"
							disabled={!controller.hasChanges || controller.saving || !controller.ready || formOpen || readOnly}
							onClick={(event) => {
								const characteristics =
									collectWebUiUserDecisionClientCharacteristicsFromTriggeringUserGestureEvent(event);
								void controller
									.applyToTask(taskId, characteristics)
									.then(onRelationsSaved)
									.catch(() => undefined);
							}}
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
				{formOpen ? (
					<p role="status" className="text-text-secondary">
						请先将当前关系加入草稿，或取消编辑，再提交。
					</p>
				) : null}
			</fieldset>
		</section>
	);
}
