import { Pin } from "lucide-react";
import type { KeyboardEvent, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { isKeyboardEventEmittedDuringImeComposition } from "@/utils/keyboard-event-ime-composition-detection";

/**
 * 置顶任务时（以及事后编辑时）填「我为什么盯着它」的小对话框。
 *
 * 用 `Dialog` 而不是 `AlertDialog`：需要一个可输入的 textarea，而 `AlertDialog` 是给不可逆确认用的。
 * 原因**允许留空**——弹框的存在是给一个填写机会，不是设一道门槛，所以确认按钮任何时候都可点。
 */
export interface TaskPinboardPinReasonDialogRequest {
	taskId: string;
	taskTitle: string;
	/** 已置顶的卡走「编辑原因」语义（确认按钮显示 Save，且不改变置顶时间/排序）。 */
	isEditingExistingPin: boolean;
	initialPinReason: string;
}

export function TaskPinboardPinReasonDialog({
	request,
	onCancel,
	onConfirm,
}: {
	request: TaskPinboardPinReasonDialogRequest | null;
	onCancel: () => void;
	onConfirm: (taskId: string, pinReason: string) => void;
}): ReactElement | null {
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

	if (!request) {
		return null;
	}

	const confirmButtonText = request.isEditingExistingPin ? "Save" : "Pin";

	const submit = (): void => {
		onConfirm(request.taskId, draftPinReason.trim());
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
		// 输入法组字期间，按键属于输入法本身（上屏字符原文、翻候选页、取消组字），处理器必须整体让开。
		if (isKeyboardEventEmittedDuringImeComposition(event)) {
			return;
		}
		// 原因是可换行的自由文本，所以裸 Enter 留给换行，用 cmd/ctrl+Enter 提交（与仓库内其他多行输入一致）。
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(isOpen) => {
				if (!isOpen) {
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
				<p className="m-0 line-clamp-2 text-sm font-medium text-text-primary">{request.taskTitle}</p>
				<label className="flex flex-col gap-1 text-xs text-text-secondary">
					Why are you keeping an eye on this task? (optional)
					<textarea
						ref={textareaRef}
						value={draftPinReason}
						rows={3}
						onChange={(event) => setDraftPinReason(event.currentTarget.value)}
						onKeyDown={handleKeyDown}
						placeholder="e.g. blocked on review feedback"
						className="w-full resize-none rounded-md border border-border-bright bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus:border-border-focus focus:outline-none"
					/>
				</label>
			</DialogBody>
			<DialogFooter>
				<Button variant="default" onClick={onCancel}>
					Cancel
				</Button>
				<Button variant="primary" onClick={submit}>
					{confirmButtonText}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
