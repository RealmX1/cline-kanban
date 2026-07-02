import { Check, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { TaskCommentEntry } from "@/types";

function createTaskCommentEntryId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `task-comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTaskCommentTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) {
		return "";
	}
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
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

	useEffect(() => {
		setDraftText(entry.commentText);
	}, [entry.commentText]);

	const trimmedDraftText = draftText.trim();
	const canSave = trimmedDraftText.length > 0 && trimmedDraftText !== entry.commentText;
	const timestampLabel = formatTaskCommentTimestamp(entry.updatedAt || entry.createdAt);

	return (
		<div className="rounded-md border border-border bg-surface-2 p-2 focus-within:border-border-focus">
			<div className="mb-1.5 flex items-center justify-between gap-2">
				<span className="truncate text-[11px] text-text-tertiary">{timestampLabel}</span>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="xs"
						icon={<Check size={14} />}
						disabled={!canSave}
						onClick={() => onUpdate(entry.taskCommentEntryId, trimmedDraftText)}
					>
						Save
					</Button>
					<Button
						variant="ghost"
						size="xs"
						icon={<Trash2 size={14} />}
						className="hover:text-status-red"
						aria-label="Delete task comment"
						onClick={() => onDelete(entry.taskCommentEntryId)}
					/>
				</div>
			</div>
			<textarea
				value={draftText}
				onChange={(event) => setDraftText(event.target.value)}
				placeholder="Edit task comment..."
				rows={3}
				className="block min-h-16 w-full resize-y rounded-md border border-border bg-surface-1 p-2 text-xs leading-5 text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
			/>
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
	const sortedTaskCommentEntries = useMemo(
		() => sortTaskCommentEntriesNewestFirst(taskCommentEntries),
		[taskCommentEntries],
	);

	const handleAddTaskCommentEntry = (): void => {
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
	};

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
						value={newCommentText}
						onChange={(event) => setNewCommentText(event.target.value)}
						placeholder="Write a task comment..."
						rows={3}
						className="block min-h-16 w-full resize-y rounded-md border border-border bg-surface-1 p-2 text-xs leading-5 text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<div className="mt-2 flex justify-end">
						<Button
							variant="primary"
							size="sm"
							icon={<Plus size={14} />}
							disabled={newCommentText.trim().length === 0}
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
