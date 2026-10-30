// dd2db 2.1「添加关系」对话框的表单状态编排：草稿、提交前校验（第一次点提交之后才显示问题，免得边打字边挨骂）、
// 提交中状态、runtime 拒绝时原样转述的那句话。
//
// 提交是决策类 procedure（R3）：点击或键盘手势的原始事件交给传输层，
// runtime 据此拒绝脚本合成事件；绝不在 effect / 自动流程里提交。

import type { InterWorkUnitRelationAssertionWriteResponse } from "@runtime-work-unit-relation-assertion-write-api-contract";
import { useCallback, useState } from "react";
import { describeInterWorkUnitRelationAssertionWriteFailureForUser } from "@/hooks/use-work-unit-relation-neighborhood-panel-of-kanban-board-card";
import {
	type AddReferenceRelationDialogDraft,
	EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT,
	validateAddReferenceRelationDialogDraftIntoAssertionRequest,
} from "@/hooks/work-unit-relation-add-reference-relation-dialog-draft-validation";
import {
	assertReferenceRelationDirectlyAsWebUiUserFromExplicitUserGesture,
	classifyInterWorkUnitRelationAssertionWriteFailure,
	type TriggeringExplicitUserGestureEvent,
} from "@/runtime/work-unit-relation-assertion-write-query";

export interface WorkUnitRelationAddReferenceRelationDialogFormController {
	addReferenceRelationDialogDraft: AddReferenceRelationDialogDraft;
	updateAddReferenceRelationDialogDraft: (draftPatch: Partial<AddReferenceRelationDialogDraft>) => void;
	// 第一次点提交之前为空；之后随草稿实时更新。
	draftValidationProblemMessagesShownAfterSubmitAttempt: string[];
	isReferenceRelationAssertionSubmissionInFlight: boolean;
	// runtime 拒绝（或网络失败）时给用户看的话；含 runtime 原句。
	referenceRelationAssertionWriteFailureMessage: string | null;
	// 只由提交按钮或表单快捷键的显式用户手势调用（见文件头）。
	submitReferenceRelationFromExplicitUserGesture: (event: TriggeringExplicitUserGestureEvent) => void | Promise<void>;
}

export function useWorkUnitRelationAddReferenceRelationDialogForm(input: {
	subjectKanbanBoardCardWorkspaceId: string;
	subjectKanbanBoardCardTaskId: string;
	onReferenceRelationAssertionWriteSucceeded: (writeResponse: InterWorkUnitRelationAssertionWriteResponse) => void;
}): WorkUnitRelationAddReferenceRelationDialogFormController {
	const {
		subjectKanbanBoardCardWorkspaceId,
		subjectKanbanBoardCardTaskId,
		onReferenceRelationAssertionWriteSucceeded,
	} = input;
	const [addReferenceRelationDialogDraft, setAddReferenceRelationDialogDraft] =
		useState<AddReferenceRelationDialogDraft>(EMPTY_ADD_REFERENCE_RELATION_DIALOG_DRAFT);
	const [hasAttemptedSubmission, setHasAttemptedSubmission] = useState(false);
	const [isReferenceRelationAssertionSubmissionInFlight, setIsReferenceRelationAssertionSubmissionInFlight] =
		useState(false);
	const [referenceRelationAssertionWriteFailureMessage, setReferenceRelationAssertionWriteFailureMessage] = useState<
		string | null
	>(null);

	const updateAddReferenceRelationDialogDraft = useCallback((draftPatch: Partial<AddReferenceRelationDialogDraft>) => {
		setAddReferenceRelationDialogDraft((currentDraft) => ({ ...currentDraft, ...draftPatch }));
	}, []);

	const currentDraftValidationOutcome = validateAddReferenceRelationDialogDraftIntoAssertionRequest({
		draft: addReferenceRelationDialogDraft,
		subjectKanbanBoardCardWorkspaceId,
		subjectKanbanBoardCardTaskId,
	});

	const submitReferenceRelationFromExplicitUserGesture = (
		submitUserGestureEvent: TriggeringExplicitUserGestureEvent,
	) => {
		setHasAttemptedSubmission(true);
		if (!currentDraftValidationOutcome.isDraftReadyForSubmission || isReferenceRelationAssertionSubmissionInFlight) {
			return;
		}
		setIsReferenceRelationAssertionSubmissionInFlight(true);
		setReferenceRelationAssertionWriteFailureMessage(null);
		return assertReferenceRelationDirectlyAsWebUiUserFromExplicitUserGesture(submitUserGestureEvent, {
			workspaceId: subjectKanbanBoardCardWorkspaceId,
			referenceRelationAssertion:
				currentDraftValidationOutcome.referenceRelationAssertionRequestWithoutClientCharacteristics,
		})
			.then(
				(writeResponse) => {
					onReferenceRelationAssertionWriteSucceeded(writeResponse);
				},
				(error: unknown) => {
					setReferenceRelationAssertionWriteFailureMessage(
						describeInterWorkUnitRelationAssertionWriteFailureForUser(
							classifyInterWorkUnitRelationAssertionWriteFailure(error),
							"关系",
						),
					);
				},
			)
			.finally(() => {
				setIsReferenceRelationAssertionSubmissionInFlight(false);
			});
	};

	return {
		addReferenceRelationDialogDraft,
		updateAddReferenceRelationDialogDraft,
		draftValidationProblemMessagesShownAfterSubmitAttempt:
			hasAttemptedSubmission && !currentDraftValidationOutcome.isDraftReadyForSubmission
				? currentDraftValidationOutcome.draftValidationProblemMessages
				: [],
		isReferenceRelationAssertionSubmissionInFlight,
		referenceRelationAssertionWriteFailureMessage,
		submitReferenceRelationFromExplicitUserGesture,
	};
}
