import { Check, Copy, FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { TaskImageStrip } from "@/components/task-image-strip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { PermanentlyDeletedTaskPromptVersionsResponse } from "@/runtime/types";
import type { BoardCard as BoardCardModel } from "@/types";
import { normalizePromptForDisplay, truncateTaskPromptLabel } from "@/utils/task-prompt";
import { writeTextToSystemClipboardWithInsecureContextFallback } from "@/utils/write-text-to-system-clipboard-with-insecure-context-fallback";

export function TaskOriginalPromptDialog({
	open,
	card,
	onClose,
	permanentlyDeletedTaskPromptHistory,
}: {
	open: boolean;
	card: Pick<BoardCardModel, "title" | "prompt" | "images" | "createdAt">;
	onClose: () => void;
	permanentlyDeletedTaskPromptHistory?: {
		versions: PermanentlyDeletedTaskPromptVersionsResponse | null;
		isLoading: boolean;
		errorMessage: string | null;
		onRetry: () => void;
		workspaceId: string;
		deletedAt: number;
	};
}): React.ReactElement {
	const [copied, setCopied] = useState(false);
	const latestPromptCopyRequestIdRef = useRef(0);
	const copiedFeedbackResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [selectedVersion, setSelectedVersion] = useState<"beforePermanentRemoval" | "atCreation">(
		"beforePermanentRemoval",
	);
	const history = permanentlyDeletedTaskPromptHistory;
	const promptVersion = history?.versions?.[selectedVersion];
	const promptText = history ? (promptVersion?.text ?? null) : card.prompt;
	const displayTitle = normalizePromptForDisplay(card.title) || truncateTaskPromptLabel(card.prompt);

	useEffect(() => {
		setCopied(false);
		return () => {
			latestPromptCopyRequestIdRef.current += 1;
			if (copiedFeedbackResetTimeoutRef.current !== null) {
				clearTimeout(copiedFeedbackResetTimeoutRef.current);
			}
		};
	}, [open, promptText, selectedVersion]);

	const handleCopy = async (): Promise<void> => {
		if (promptText === null) return;
		const promptCopyRequestId = ++latestPromptCopyRequestIdRef.current;
		if (copiedFeedbackResetTimeoutRef.current !== null) {
			clearTimeout(copiedFeedbackResetTimeoutRef.current);
		}
		setCopied(false);
		try {
			await writeTextToSystemClipboardWithInsecureContextFallback(promptText);
			if (promptCopyRequestId !== latestPromptCopyRequestIdRef.current) return;
			setCopied(true);
			copiedFeedbackResetTimeoutRef.current = setTimeout(() => {
				if (promptCopyRequestId !== latestPromptCopyRequestIdRef.current) return;
				setCopied(false);
				copiedFeedbackResetTimeoutRef.current = null;
			}, 1500);
		} catch {
			if (promptCopyRequestId !== latestPromptCopyRequestIdRef.current) return;
			setCopied(false);
			showAppToast(
				{
					intent: "warning",
					message: history
						? "复制失败，请选中文字手动复制。"
						: "Could not copy the prompt. Select the text and copy manually.",
					timeout: 4000,
				},
				"task-original-prompt-copy-failed",
			);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
			contentClassName="max-w-2xl"
		>
			<DialogHeader title={history ? "历史 Prompt" : "Original prompt"} icon={<FileText size={16} />} />
			<DialogBody className="flex flex-col gap-3">
				<div className="flex flex-col gap-0.5">
					<p className="m-0 text-sm font-medium text-text-primary">{displayTitle}</p>
					<p className="m-0 text-[11px] text-text-tertiary">
						{history ? "创建于" : "Created"} {new Date(card.createdAt).toLocaleString()}
					</p>
				</div>
				{history ? (
					<>
						<p className="m-0 text-xs text-text-secondary">
							{history.workspaceId} · 删除于 {new Date(history.deletedAt).toLocaleString()}
						</p>
						<div role="group" aria-label="Prompt 版本" className="flex flex-wrap gap-2">
							<Button
								aria-pressed={selectedVersion === "beforePermanentRemoval"}
								variant={selectedVersion === "beforePermanentRemoval" ? "primary" : "default"}
								onClick={() => {
									latestPromptCopyRequestIdRef.current += 1;
									setSelectedVersion("beforePermanentRemoval");
									setCopied(false);
								}}
							>
								删除前 Prompt
							</Button>
							<Button
								aria-pressed={selectedVersion === "atCreation"}
								variant={selectedVersion === "atCreation" ? "primary" : "default"}
								onClick={() => {
									latestPromptCopyRequestIdRef.current += 1;
									setSelectedVersion("atCreation");
									setCopied(false);
								}}
							>
								创建时 Prompt
							</Button>
						</div>
						{history.isLoading ? (
							<p role="status">正在读取完整 Prompt…</p>
						) : history.errorMessage ? (
							<div role="alert">
								<p>{history.errorMessage}</p>
								<Button onClick={history.onRetry}>重试读取</Button>
							</div>
						) : (
							<p className="m-0 text-xs text-text-secondary">
								{history.versions?.comparison === "same"
									? "删除前 Prompt 与创建时相同"
									: history.versions?.comparison === "different"
										? "创建时与删除前 Prompt 存在差异，请按版本查看和复制。"
										: "历史不完整，无法比较两个版本。"}
							</p>
						)}
						{promptVersion?.availability === "not_recorded" ? (
							<p>未记录此版本的 Prompt。可切换查看其他版本。</p>
						) : promptVersion?.availability === "content_missing_or_invalid" ? (
							<p>此版本的 Prompt 正文缺失或损坏。可切换查看其他版本。</p>
						) : null}
					</>
				) : null}
				{card.images?.length ? <TaskImageStrip images={card.images} label="Attached images" /> : null}
				{promptText !== null ? (
					<pre className="m-0 overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs leading-relaxed text-text-primary whitespace-pre-wrap break-words">
						{promptText}
					</pre>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button
					variant="primary"
					disabled={promptText === null}
					size="sm"
					icon={copied ? <Check size={14} className="text-status-green" /> : <Copy size={14} />}
					onClick={() => {
						void handleCopy();
					}}
				>
					{history ? (copied ? "已复制" : "复制完整 Prompt") : copied ? "Copied" : "Copy prompt"}
				</Button>
				<Button variant="default" size="sm" onClick={onClose}>
					{history ? "返回列表" : "Close"}
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
