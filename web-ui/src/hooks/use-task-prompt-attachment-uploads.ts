import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { fileToTaskImage, isAcceptedTaskImageFile } from "@/components/task-image-input-utils";
import { agentPromptFileAttachmentQueries } from "@/runtime/agent-prompt-file-attachment-query";
import type { TaskImage } from "@/types";
import { readBrowserFileAsBase64 } from "@/utils/read-browser-file-as-base64";

export function useTaskPromptAttachmentUploads(input: {
	value: string;
	onValueChange: (value: string) => void;
	onImagesPrepared: (images: TaskImage[]) => void;
	onPreparationPendingChange?: (pending: boolean) => void;
	enabled: boolean;
}) {
	const latestInputRef = useRef(input);
	latestInputRef.current = input;
	const uploadGenerationRef = useRef<symbol | null>(null);
	const pendingBatchCountRef = useRef(0);
	const [isPreparingAttachments, setIsPreparingAttachments] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	useLayoutEffect(() => {
		uploadGenerationRef.current = input.enabled ? Symbol("task-prompt-attachment-upload-generation") : null;
		setIsPreparingAttachments(false);
		return () => {
			uploadGenerationRef.current = null;
			pendingBatchCountRef.current = 0;
			latestInputRef.current.onPreparationPendingChange?.(false);
		};
	}, [input.enabled]);

	const addAttachments = useCallback((files: File[]) => {
		const generation = uploadGenerationRef.current;
		if (!generation || !files.length) return;
		const isCurrentDraft = () => uploadGenerationRef.current === generation;
		pendingBatchCountRef.current += 1;
		setIsPreparingAttachments(true);
		latestInputRef.current.onPreparationPendingChange?.(true);
		setErrorMessage(null);
		void (async () => {
			try {
				for (const file of files) {
					if (!isCurrentDraft()) return;
					try {
						if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过单文件 20MB 限额。`);
						if (isAcceptedTaskImageFile(file)) {
							const image = await fileToTaskImage(file);
							if (!image) throw new Error(`${file.name} 图片读取失败，请重新选择。`);
							if (isCurrentDraft()) latestInputRef.current.onImagesPrepared([image]);
						} else {
							const fileContentBase64 = await readBrowserFileAsBase64(file);
							if (!isCurrentDraft()) return;
							const saved = await agentPromptFileAttachmentQueries.save({
								fileName: file.name,
								fileContentBase64,
							});
							if (!isCurrentDraft()) return;
							const latest = latestInputRef.current;
							const reference = `附件：${JSON.stringify(saved.fileName)}\n持久路径：${JSON.stringify(saved.filePath)}`;
							const value = `${latest.value}${latest.value ? "\n\n" : ""}${reference}`;
							latestInputRef.current = { ...latest, value };
							latest.onValueChange(value);
						}
					} catch (error) {
						if (isCurrentDraft()) setErrorMessage(error instanceof Error ? error.message : String(error));
					}
				}
			} finally {
				if (isCurrentDraft()) {
					pendingBatchCountRef.current -= 1;
					const pending = pendingBatchCountRef.current > 0;
					setIsPreparingAttachments(pending);
					latestInputRef.current.onPreparationPendingChange?.(pending);
				}
			}
		})();
	}, []);
	return { addAttachments, isPreparingAttachments, errorMessage };
}
