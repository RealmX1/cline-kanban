import { Check, Plus, Trash2 } from "lucide-react";
import {
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { TaskCommentEntry } from "@/types";

const COMMENT_TEXTAREA_MAX_HEIGHT = 180;

function createTaskCommentEntryId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `task-comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTaskCommentMetadataTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) {
		return "unknown";
	}
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function useAutosizedCommentTextarea(ref: React.RefObject<HTMLTextAreaElement | null>, value: string): void {
	useLayoutEffect(() => {
		const textarea = ref.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, COMMENT_TEXTAREA_MAX_HEIGHT)}px`;
		textarea.style.overflowY = textarea.scrollHeight > COMMENT_TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
	}, [ref, value]);
}

function TaskCommentMetadataPill({ entry }: { entry: TaskCommentEntry }): React.ReactElement {
	return (
		<div className="pointer-events-none absolute top-0 left-2 z-10 flex max-w-[calc(100%-1rem)] -translate-y-1/2 items-center gap-1 overflow-hidden rounded-full border border-border-bright bg-surface-3 px-2 py-0.5 text-[10px] leading-4 text-text-secondary shadow-sm">
			<span className="truncate">Created {formatTaskCommentMetadataTimestamp(entry.createdAt)}</span>
			<span className="shrink-0 text-text-tertiary">·</span>
			<span className="truncate">Edited {formatTaskCommentMetadataTimestamp(entry.updatedAt)}</span>
		</div>
	);
}

function sortTaskCommentEntriesNewestFirst(entries: TaskCommentEntry[]): TaskCommentEntry[] {
	return [...entries].sort((a, b) => {
		if (b.createdAt !== a.createdAt) {
			return b.createdAt - a.createdAt;
		}
		return b.updatedAt - a.updatedAt;
	});
}

function TaskCommentEntryRow({
	entry,
	onUpdate,
	onDelete,
}: {
	entry: TaskCommentEntry;
	onUpdate: (taskCommentEntryId: string, commentText: string) => void;
	onDelete: (taskCommentEntryId: string) => void;
}): React.ReactElement {
	const [draftText, setDraftText] = useState(entry.commentText);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useAutosizedCommentTextarea(textareaRef, draftText);

	useEffect(() => {
		setDraftText(entry.commentText);
	}, [entry.commentText]);

	const trimmedDraftText = draftText.trim();
	const canSave = trimmedDraftText.length > 0 && trimmedDraftText !== entry.commentText;
	const saveDraftTextIfChanged = useCallback(() => {
		if (!canSave) {
			return;
		}
		onUpdate(entry.taskCommentEntryId, trimmedDraftText);
	}, [canSave, entry.taskCommentEntryId, onUpdate, trimmedDraftText]);
	const keepTextareaFocusedForAction = useCallback((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
	}, []);

	return (
		<div className="group relative mt-2 rounded-md border border-border bg-surface-2 pt-3 focus-within:border-border-focus">
			<TaskCommentMetadataPill entry={entry} />
			<textarea
				ref={textareaRef}
				value={draftText}
				onChange={(event) => setDraftText(event.target.value)}
				onBlur={saveDraftTextIfChanged}
				placeholder="Edit task comment..."
				rows={1}
				spellCheck={false}
				className="block min-h-[1.5rem] w-full resize-none overflow-x-hidden bg-transparent p-1.5 text-xs leading-5 text-text-primary placeholder:text-text-tertiary focus:outline-none"
			/>
			<div className="pointer-events-none absolute right-1 bottom-1 flex items-center gap-0.5 rounded-md border border-border-bright bg-surface-2 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
				<Tooltip content="Save comment">
					<Button
						variant="ghost"
						size="xs"
						icon={<Check size={14} />}
						aria-label="Save task comment"
						disabled={!canSave}
						onMouseDown={keepTextareaFocusedForAction}
						onClick={saveDraftTextIfChanged}
					/>
				</Tooltip>
				<Tooltip content="Delete">
					<Button
						variant="ghost"
						size="xs"
						icon={<Trash2 size={14} />}
						className="hover:text-status-red"
						aria-label="Delete task comment"
						onMouseDown={keepTextareaFocusedForAction}
						onClick={() => onDelete(entry.taskCommentEntryId)}
					/>
				</Tooltip>
			</div>
		</div>
	);
}

export function TaskCommentsPanel({
	taskCommentEntries,
	onTaskCommentEntriesChange,
	headerContent,
}: {
	taskCommentEntries: TaskCommentEntry[];
	onTaskCommentEntriesChange: (entries: TaskCommentEntry[]) => void;
	headerContent?: ReactNode;
}): React.ReactElement {
	const [newCommentText, setNewCommentText] = useState("");
	const newCommentTextareaRef = useRef<HTMLTextAreaElement>(null);
	useAutosizedCommentTextarea(newCommentTextareaRef, newCommentText);
	const sortedTaskCommentEntries = useMemo(
		() => sortTaskCommentEntriesNewestFirst(taskCommentEntries),
		[taskCommentEntries],
	);

	const handleAddTaskCommentEntry = useCallback((): void => {
		const commentText = newCommentText.trim();
		if (!commentText) {
			return;
		}
		const now = Date.now();
		onTaskCommentEntriesChange([
			{
				taskCommentEntryId: createTaskCommentEntryId(),
				commentText,
				createdAt: now,
				updatedAt: now,
			},
			...taskCommentEntries,
		]);
		setNewCommentText("");
	}, [newCommentText, onTaskCommentEntriesChange, taskCommentEntries]);
	const keepNewCommentTextareaFocusedForAction = useCallback((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
	}, []);

	const handleUpdateTaskCommentEntry = (taskCommentEntryId: string, commentText: string): void => {
		const now = Date.now();
		onTaskCommentEntriesChange(
			taskCommentEntries.map((entry) =>
				entry.taskCommentEntryId === taskCommentEntryId ? { ...entry, commentText, updatedAt: now } : entry,
			),
		);
	};

	const handleDeleteTaskCommentEntry = (taskCommentEntryId: string): void => {
		onTaskCommentEntriesChange(taskCommentEntries.filter((entry) => entry.taskCommentEntryId !== taskCommentEntryId));
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-surface-1">
			<div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
				{headerContent ?? (
					<span className="text-xs font-medium uppercase tracking-wide text-text-secondary">Comments</span>
				)}
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
				<div className="rounded-md border border-border bg-surface-2 p-2 focus-within:border-border-focus">
					<textarea
						ref={newCommentTextareaRef}
						value={newCommentText}
						onChange={(event) => setNewCommentText(event.target.value)}
						onBlur={handleAddTaskCommentEntry}
						placeholder="Write a task comment..."
						rows={1}
						spellCheck={false}
						className="block min-h-[1.5rem] w-full resize-none overflow-x-hidden rounded-md border border-border bg-surface-1 p-2 text-xs leading-5 text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<div className="mt-2 flex justify-end">
						<Button
							variant="primary"
							size="sm"
							icon={<Plus size={14} />}
							disabled={newCommentText.trim().length === 0}
							onMouseDown={keepNewCommentTextareaFocusedForAction}
							onClick={handleAddTaskCommentEntry}
						>
							Add comment
						</Button>
					</div>
				</div>
				{sortedTaskCommentEntries.length === 0 ? (
					<p className="px-1 py-2 text-xs leading-5 text-text-tertiary">No task comments yet.</p>
				) : (
					sortedTaskCommentEntries.map((entry) => (
						<TaskCommentEntryRow
							key={entry.taskCommentEntryId}
							entry={entry}
							onUpdate={handleUpdateTaskCommentEntry}
							onDelete={handleDeleteTaskCommentEntry}
						/>
					))
				)}
			</div>
		</div>
	);
}
