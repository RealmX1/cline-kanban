import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { TaskCommentBeforeMoveIntoDoneController } from "@/hooks/use-task-comment-before-move-into-done";

export function TaskCommentBeforeMoveIntoDoneDialog({
	controller,
	onSubmit,
}: {
	controller: TaskCommentBeforeMoveIntoDoneController;
	onSubmit: (commentText: string) => void;
}) {
	const { request } = controller;
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const [commentText, setCommentText] = useState("");
	const requestId = request?.taskCommentEntryId;
	const savedCommentText = request?.commentText ?? "";
	useEffect(() => {
		setCommentText(savedCommentText);
	}, [requestId, savedCommentText]);
	const submitting = request?.phase === "submitting";
	return (
		<Dialog
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
			<DialogHeader title="添加评论并移入 Done" />
			<DialogBody className="flex flex-col gap-3">
				<p className="text-sm text-text-secondary break-words">{request?.taskTitle}</p>
				<label className="flex flex-col gap-2 text-sm text-text-primary">
					任务评论
					<textarea
						ref={textareaRef}
						aria-label="任务评论"
						value={commentText}
						disabled={submitting}
						onChange={(event) => setCommentText(event.target.value)}
						rows={5}
						className="w-full resize-y rounded-md border border-border-bright bg-surface-0 p-3 text-sm focus-visible:outline-2 focus-visible:outline-accent"
					/>
				</label>
				{request?.errorMessage ? (
					<p role="alert" className="text-sm text-status-red">
						{request.errorMessage}
					</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button disabled={submitting} onClick={controller.cancel}>
					取消
				</Button>
				<Button
					variant="primary"
					disabled={submitting || !commentText.trim()}
					icon={submitting ? <Spinner size={14} /> : undefined}
					onClick={() => onSubmit(commentText)}
				>
					提交评论并移入 Done
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
