import { Pin } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { hostNonModalFloatingForm } from "@/components/host-non-modal-floating-form";
import { useNonModalFloatingFormWindowSession } from "@/components/non-modal-floating-form-window-host-provider";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { NonModalFormDialog as Dialog } from "@/components/ui/non-modal-form-dialog";
import {
	FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS,
	useFormPrimaryActionSubmitKeyboardShortcut,
} from "@/hooks/use-form-primary-action-submit-keyboard-shortcut";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { setTaskPinboardPinStateOfTaskCardThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";

/**
 * 置顶任务时（以及事后编辑时）填「我为什么盯着它」的小对话框。
 *
 * 用 `Dialog` 而不是 `AlertDialog`：需要一个可输入的 textarea，而 `AlertDialog` 是给不可逆确认用的。
 * 原因**允许留空**——弹框的存在是给一个填写机会，不是设一道门槛，所以确认按钮任何时候都可点。
 */
export interface TaskPinboardPinReasonDialogRequest {
	workspaceId?: string;
	taskIncarnationCreatedAtEpochMs?: number;
	taskId: string;
	taskTitle: string;
	/** 已置顶的卡走「编辑原因」语义（确认按钮显示 Save，且不改变置顶时间/排序）。 */
	isEditingExistingPin: boolean;
	initialPinReason: string;
}

function TaskPinboardPinReasonDialogForm({
	request,
	onCancel,
	onConfirm,
}: {
	request: TaskPinboardPinReasonDialogRequest | null;
	onCancel: () => void;
	onConfirm: (taskId: string, pinReason: string) => void;
}): ReactElement | null {
	const hostedSession = useNonModalFloatingFormWindowSession();
	const [boundIncarnation, setBoundIncarnation] = useState(request?.taskIncarnationCreatedAtEpochMs);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [identityReadAttempt, setIdentityReadAttempt] = useState(0);
	useEffect(() => {
		if (!hostedSession || !request?.workspaceId || boundIncarnation !== undefined) return;
		let cancelled = false;
		void readTaskCardWithBoardColumnInWorkspace(request.workspaceId, request.taskId)
			.then((found) => {
				if (cancelled) return;
				if (found.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
					throw new Error("原任务不可达，填写内容已保留。");
				setBoundIncarnation(found.taskCardSnapshot.taskCard.createdAt);
				setError(null);
			})
			.catch((failure: unknown) => {
				if (!cancelled) setError(String(failure));
			});
		return () => {
			cancelled = true;
		};
	}, [request, hostedSession, boundIncarnation, identityReadAttempt]);
	const [draftPinReason, setDraftPinReason] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const requestedTaskId = request?.taskId ?? null;

	// 每次针对新任务打开都重置草稿；同一次打开期间不受父层重渲影响。
	useEffect(() => {
		if (requestedTaskId == null) {
			return;
		}
		setDraftPinReason(request?.initialPinReason ?? "");
	}, [requestedTaskId, request?.initialPinReason]);

	useEffect(() => {
		if (requestedTaskId == null) {
			return;
		}
		const focusTimer = window.setTimeout(() => {
			const textarea = textareaRef.current;
			textarea?.focus();
			textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
		}, 0);
		return () => window.clearTimeout(focusTimer);
	}, [requestedTaskId]);

	const submit = async () => {
		if (!request || isSaving) return;
		setIsSaving(true);
		setError(null);
		try {
			if (hostedSession && request.workspaceId) {
				if (boundIncarnation === undefined) {
					setIdentityReadAttempt((attempt) => attempt + 1);
					throw new Error("正在重新核验原任务身份，请稍后重试。");
				}
				const result = await setTaskPinboardPinStateOfTaskCardThroughRuntime({
					workspaceId: request.workspaceId,
					taskId: request.taskId,
					expectedTaskIncarnationCreatedAtEpochMs: boundIncarnation,
					taskPinboardPinChange: {
						taskPinboardPinAction: "pin_task_card_or_update_pin_reason",
						taskPinboardPinReason: draftPinReason.trim(),
					},
				});
				if (result.taskCardActionCommandExecutionOutcome !== "command_completed_by_runtime")
					throw new Error(
						result.taskCardActionCommandExecutionOutcome === "command_failed"
							? result.commandFailureMessage
							: "该任务另有操作在执行，请稍后重试。",
					);
				onCancel();
			} else onConfirm(request.taskId, draftPinReason.trim());
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setIsSaving(false);
		}
	};
	const handlePrimaryActionKeyDown = useFormPrimaryActionSubmitKeyboardShortcut({
		onSubmit: submit,
		disabled: !request || isSaving,
	});
	if (!request) return null;
	const confirmButtonText = request.isEditingExistingPin ? "Save" : "Pin";

	return (
		<Dialog
			onKeyDown={handlePrimaryActionKeyDown}
			open
			onOpenChange={(isOpen) => {
				if (!isOpen && !isSaving) {
					onCancel();
				}
			}}
			contentClassName="max-w-md"
		>
			<DialogHeader
				title={request.isEditingExistingPin ? "Edit pin reason" : "Pin task to pinboard"}
				icon={<Pin size={14} />}
			/>
			<DialogBody className="flex flex-col gap-2">
				{error && (
					<p role="alert" className="text-sm text-status-red">
						{error}
					</p>
				)}
				<p className="m-0 line-clamp-2 text-sm font-medium text-text-primary">{request.taskTitle}</p>
				<label className="flex flex-col gap-1 text-xs text-text-secondary">
					Why are you keeping an eye on this task? (optional)
					<textarea
						ref={textareaRef}
						value={draftPinReason}
						rows={3}
						onChange={(event) => setDraftPinReason(event.currentTarget.value)}
						placeholder="e.g. blocked on review feedback"
						className="w-full resize-none rounded-md border border-border-bright bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus:border-border-focus focus:outline-none"
					/>
				</label>
			</DialogBody>
			<DialogFooter>
				<Button variant="default" disabled={isSaving} onClick={onCancel}>
					Cancel
				</Button>
				<Button
					{...FORM_PRIMARY_ACTION_SUBMIT_SHORTCUT_BUTTON_PROPS}
					variant="primary"
					disabled={isSaving}
					onClick={() => void submit()}
				>
					{confirmButtonText}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}

export const TaskPinboardPinReasonDialog = hostNonModalFloatingForm(TaskPinboardPinReasonDialogForm, {
	formKind: "TaskPinboardPinReasonDialog",
	openingRequestIdentity: (props) => props.request,
	isOpen: (props) => props.request !== null,
	instanceIdentity: (props) =>
		JSON.stringify([
			props.request?.workspaceId,
			props.request?.taskId,
			props.request?.taskIncarnationCreatedAtEpochMs,
		]),
	ownership: (props) => ({
		workspaceId: props.request?.workspaceId,
		taskId: props.request?.taskId,
		taskIncarnationCreatedAtEpochMs: props.request?.taskIncarnationCreatedAtEpochMs,
		displayLabel: props.request?.taskTitle,
	}),
	withClose: (props, close) => ({ ...props, onCancel: close }),
	onClosed: (props) => props.onCancel(),
});
