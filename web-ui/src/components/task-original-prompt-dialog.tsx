import { Check, Copy, FileText } from "lucide-react";
import { useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { TaskImageStrip } from "@/components/task-image-strip";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { BoardCard as BoardCardModel } from "@/types";
import { normalizePromptForDisplay, truncateTaskPromptLabel } from "@/utils/task-prompt";

export function TaskOriginalPromptDialog({
	open,
	card,
	onClose,
}: {
	open: boolean;
	card: Pick<BoardCardModel, "title" | "prompt" | "images" | "createdAt">;
	onClose: () => void;
}): React.ReactElement {
	const [copied, setCopied] = useState(false);
	const displayTitle = normalizePromptForDisplay(card.title) || truncateTaskPromptLabel(card.prompt);

	const handleCopy = async (): Promise<void> => {
		try {
			await navigator.clipboard.writeText(card.prompt);
			setCopied(true);
			setTimeout(() => {
				setCopied(false);
			}, 1500);
		} catch {
			showAppToast(
				{
					intent: "warning",
					message: "Could not copy the prompt. Select the text and copy manually.",
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
			<DialogHeader title="Original prompt" icon={<FileText size={16} />} />
			<DialogBody className="flex flex-col gap-3">
				<div className="flex flex-col gap-0.5">
					<p className="m-0 text-sm font-medium text-text-primary">{displayTitle}</p>
					<p className="m-0 text-[11px] text-text-tertiary">Created {new Date(card.createdAt).toLocaleString()}</p>
				</div>
				{card.images?.length ? <TaskImageStrip images={card.images} label="Attached images" /> : null}
				<pre className="m-0 overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs leading-relaxed text-text-primary whitespace-pre-wrap break-words">
					{card.prompt}
				</pre>
			</DialogBody>
			<DialogFooter>
				<Button
					variant="primary"
					size="sm"
					icon={copied ? <Check size={14} className="text-status-green" /> : <Copy size={14} />}
					onClick={() => {
						void handleCopy();
					}}
				>
					{copied ? "Copied" : "Copy prompt"}
				</Button>
				<Button variant="default" size="sm" onClick={onClose}>
					Close
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
