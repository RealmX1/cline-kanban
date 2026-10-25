import { isCompleteShortTaskIdShapedText } from "@runtime-task-id";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveTaskEditorClipboardTaskCandidates } from "@/runtime/work-unit-relation-modeling-query";

export function parseTaskEditorClipboardTaskReference(
	text: string,
): { taskId: string; repositoryFolder: string | null } | null {
	const value = text
		.trim()
		.replace(/^["'“‘]|["'”’]$/gu, "")
		.trim();
	if (isCompleteShortTaskIdShapedText(value.toLowerCase()))
		return { taskId: value.toLowerCase(), repositoryFolder: null };
	const pathMatch = /(?:^|\/)\.cline\/worktrees\/([0-9a-z]{5})\/([^/\n]+)\/?$/iu.exec(value);
	return pathMatch?.[1] && pathMatch[2]
		? { taskId: pathMatch[1].toLowerCase(), repositoryFolder: pathMatch[2] }
		: null;
}

export type TaskEditorClipboardTaskCandidate = Awaited<
	ReturnType<typeof resolveTaskEditorClipboardTaskCandidates>
>[number];
export interface TaskEditorClipboardTaskSelectionRequest {
	sequence: number;
	candidates: TaskEditorClipboardTaskCandidate[];
}

export function useTaskEditorClipboardTaskReference(input: {
	open: boolean;
	workspaceId: string | null;
	taskId: string | null;
	onRecognized: () => void;
}) {
	const [selectionRequest, setSelectionRequest] = useState<TaskEditorClipboardTaskSelectionRequest | null>(null);
	const lastTextRef = useRef<string | null>(null);
	const permissionUnavailableRef = useRef(false);
	const generationRef = useRef(0);
	const latestInputRef = useRef(input);
	latestInputRef.current = input;
	const processText = useCallback(async (text: string) => {
		if (text === lastTextRef.current) return;
		lastTextRef.current = text;
		const generation = ++generationRef.current;
		const reference = parseTaskEditorClipboardTaskReference(text);
		const current = latestInputRef.current;
		if (!reference || !current.open || !current.workspaceId) return;
		try {
			const candidates = (await resolveTaskEditorClipboardTaskCandidates(current.workspaceId, reference)).filter(
				(candidate) =>
					candidate.kanbanBoardCard.workspaceId !== current.workspaceId ||
					candidate.kanbanBoardCard.taskId !== current.taskId,
			);
			if (generation !== generationRef.current || !latestInputRef.current.open || !candidates.length) return;
			setSelectionRequest({ sequence: generation, candidates });
			latestInputRef.current.onRecognized();
		} catch {
			/* 自动补全失败时仍保留关系选择器的手动搜索入口。 */
		}
	}, []);
	const checkClipboard = useCallback(() => {
		if (permissionUnavailableRef.current || !navigator.clipboard?.readText) return;
		void navigator.clipboard
			.readText()
			.then(processText)
			.catch(() => {
				permissionUnavailableRef.current = true;
			});
	}, [processText]);
	useEffect(() => {
		generationRef.current++;
		lastTextRef.current = null;
		setSelectionRequest(null);
		if (input.open) checkClipboard();
	}, [input.open, input.workspaceId, input.taskId, checkClipboard]);
	return { selectionRequest, checkClipboard, processPastedText: processText };
}
