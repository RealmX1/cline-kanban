import type { TaskClosureRequest } from "@runtime-task-closure-contract";
import { useEffect, useRef, useState } from "react";
import { hostNonModalFloatingForm } from "@/components/host-non-modal-floating-form";
import { useNonModalFloatingFormWindowHost } from "@/components/non-modal-floating-form-window-host-provider";
import { RetainedTaskClosureFormSession } from "@/components/retained-task-closure-form-session";
import {
	createTaskClosureFormDraft,
	nonemptyClosureFormLines,
	resolveTaskClosureFormDetails,
	TaskClosureFormFields,
} from "@/components/task-closure-form-fields";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NonModalFormDialog as Dialog } from "@/components/ui/non-modal-form-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
	FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS,
	useFormPrimaryActionSubmitKeyboardShortcut,
} from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";
import type { TaskCommentBeforeMoveIntoDoneController } from "@/hooks/use-task-comment-before-move-into-done";

export function TaskCommentBeforeMoveIntoDoneDialogForm({
	controller,
	onSubmit,
}: {
	controller: TaskCommentBeforeMoveIntoDoneController;
	prepareClosurePayloadOnly?: boolean;
	postDeployVerificationCompletionDeploymentId?: string;
	onSubmit: (commentText: string, closure?: TaskClosureRequest) => void | Promise<void>;
}) {
	const { request } = controller;
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [commentText, setCommentText] = useState("");
	const [draft, setDraft] = useState(createTaskClosureFormDraft);
	const [localError, setLocalError] = useState<string | null>(null);
	const [resolvingIdentity, setResolvingIdentity] = useState(false);
	const requestId = request?.taskCommentEntryId;
	const savedCommentText = request?.commentText ?? "";
	useEffect(() => {
		setCommentText(savedCommentText);
		setDraft({
			...createTaskClosureFormDraft(request?.closure?.details),
			selectedArtifactPathsText: request?.closure?.selectedArtifactRelativePaths.join("\n") ?? "",
		});
		setLocalError(null);
	}, [requestId, savedCommentText, request?.closure]);
	const submitting = request?.phase === "submitting" || resolvingIdentity;
	const submitClosure = async () => {
		if (!request || submitting || !draft.outcome) return;
		setResolvingIdentity(true);
		try {
			const details = await resolveTaskClosureFormDetails(draft, request.workspaceId);
			await onSubmit(commentText, {
				closureRequestId: request.closureRequestId,
				expectedTaskUpdatedAtEpochMs: request.expectedTaskUpdatedAtEpochMs,
				details,
				selectedArtifactRelativePaths: nonemptyClosureFormLines(draft.selectedArtifactPathsText),
			});
		} catch (error) {
			setLocalError(error instanceof Error ? error.message : String(error));
		} finally {
			setResolvingIdentity(false);
		}
	};
	const handlePrimaryActionKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: submitClosure,
		disabled: submitting || !draft.outcome || !request,
	});
	return (
		<Dialog
			onKeyDown={handlePrimaryActionKeyDown}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				textareaRef.current?.focus();
			}}
			open={request != null && request.phase !== "awaiting_confirmation"}
			onOpenChange={(open) => {
				if (!open && !submitting) controller.cancel();
			}}
			onEscapeKeyDown={(event) => {
				if (submitting) event.preventDefault();
			}}
			onPointerDownOutside={(event) => {
				if (submitting) event.preventDefault();
			}}
		>
			<DialogHeader title="结案任务" />
			<DialogBody className="flex flex-col gap-3">
				<p className="text-sm text-text-secondary break-words">{request?.taskTitle}</p>
				<TaskClosureFormFields draft={draft} onChange={setDraft} disabled={submitting} />
				<label className="flex flex-col gap-2 text-sm text-text-primary">
					补充评论（可选）
					<textarea
						ref={textareaRef}
						aria-label="任务评论"
						value={commentText}
						disabled={submitting}
						onChange={(event) => setCommentText(event.target.value)}
						rows={2}
						className="w-full resize-y rounded-md border border-border-bright bg-surface-0 p-3 text-sm focus-visible:outline-2 focus-visible:outline-accent"
					/>
				</label>
				{localError || request?.errorMessage ? (
					<p role="alert" className="text-sm text-status-red">
						{localError ?? request?.errorMessage}
					</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button disabled={submitting} onClick={controller.cancel}>
					取消
				</Button>
				<Button
					variant="primary"
					disabled={submitting || !draft.outcome}
					icon={submitting ? <Spinner size={14} /> : undefined}
					{...FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS}
					onClick={() => void submitClosure()}
				>
					归档并结案
				</Button>
			</DialogFooter>
		</Dialog>
	);
}

const HostedTaskClosureFormEntry = hostNonModalFloatingForm(RetainedTaskClosureFormSession, {
	formKind: "task-closure-form",
	openingRequestIdentity: (props) => props.controller.request?.openingRequestIdentity,
	isOpen: (props) => props.controller.request !== null,
	instanceIdentity: (props) =>
		JSON.stringify([
			props.controller.request?.workspaceId,
			props.controller.request?.taskId,
			props.controller.request?.expectedTaskIncarnationCreatedAtEpochMs,
		]),
	ownership: (props) => ({
		workspaceId: props.controller.request?.workspaceId,
		taskId: props.controller.request?.taskId,
		taskIncarnationCreatedAtEpochMs: props.controller.request?.expectedTaskIncarnationCreatedAtEpochMs,
		displayLabel: props.controller.request?.taskTitle,
	}),
	withClose: (props, close) => ({ ...props, controller: { ...props.controller, cancel: close } }),
	onClosed: (props) => props.controller.cancel(),
});
export function TaskCommentBeforeMoveIntoDoneDialog(
	props: React.ComponentProps<typeof TaskCommentBeforeMoveIntoDoneDialogForm>,
) {
	const host = useNonModalFloatingFormWindowHost();
	return host ? <HostedTaskClosureFormEntry {...props} /> : <TaskCommentBeforeMoveIntoDoneDialogForm {...props} />;
}
