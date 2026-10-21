import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { TaskCommentsPanel } from "@/components/detail-panels/task-comments-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogHeader } from "@/components/ui/dialog";
import { readTaskCardWithBoardColumnInWorkspace } from "@/runtime/task-card-action-query";
import { mergeTaskCommentEditsIntoLatestTaskComments } from "@/state/merge-task-comment-edits-into-latest-task-comments";
import { updateTaskCardFieldValuesThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import type { TaskCommentEntry } from "@/types";

interface TaskCommentsDialogController {
	currentWorkspaceId: string | null;
	openTaskComments: (workspaceId: string, taskId: string) => void;
}
const TaskCommentsDialogContext = createContext<TaskCommentsDialogController | null>(null);
export function useTaskCommentsDialog() {
	return useContext(TaskCommentsDialogContext);
}

export function TaskCommentsDialogProvider({
	currentWorkspaceId,
	children,
}: {
	currentWorkspaceId: string | null;
	children: ReactNode;
}) {
	const [target, setTarget] = useState<{ workspaceId: string; taskId: string } | null>(null);
	const [entries, setEntries] = useState<TaskCommentEntry[]>([]);
	const [title, setTitle] = useState("");
	const [isLoading, setLoading] = useState(false);
	const [hasLoaded, setHasLoaded] = useState(false);
	const [isSaving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const readGeneration = useRef(0);
	const lastSavedEntries = useRef<TaskCommentEntry[]>([]);
	const openTaskComments = useCallback((workspaceId: string, taskId: string) => {
		const generation = ++readGeneration.current;
		setTarget({ workspaceId, taskId });
		setEntries([]);
		setTitle(taskId);
		setLoading(true);
		setHasLoaded(false);
		setError(null);
		void readTaskCardWithBoardColumnInWorkspace(workspaceId, taskId)
			.then((result) => {
				if (generation !== readGeneration.current) return;
				if (result.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
					throw new Error("任务已不存在。");
				setTitle(result.taskCardSnapshot.taskCard.title);
				setEntries(result.taskCardSnapshot.taskCard.taskCommentEntries ?? []);
				lastSavedEntries.current = result.taskCardSnapshot.taskCard.taskCommentEntries ?? [];
				setHasLoaded(true);
			})
			.catch((cause: unknown) => {
				if (generation === readGeneration.current) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (generation === readGeneration.current) setLoading(false);
			});
	}, []);
	const contextValue = useMemo(
		() => ({ currentWorkspaceId, openTaskComments }),
		[currentWorkspaceId, openTaskComments],
	);
	const saveComments = async (nextEntries: TaskCommentEntry[]) => {
		if (!target || isSaving || !hasLoaded) return;
		setEntries(nextEntries);
		setSaving(true);
		setError(null);

		try {
			const latest = await readTaskCardWithBoardColumnInWorkspace(target.workspaceId, target.taskId);
			if (latest.taskCardLookupOutcome !== "task_card_found_on_workspace_board")
				throw new Error("任务已不存在，未保存评论。");
			const mergedEntries = mergeTaskCommentEditsIntoLatestTaskComments(
				latest.taskCardSnapshot.taskCard.taskCommentEntries ?? [],
				lastSavedEntries.current,
				nextEntries,
			);
			const result = await updateTaskCardFieldValuesThroughRuntime({
				...target,
				taskCardFieldValuePatch: { taskCommentEntries: mergedEntries },
			});
			if (result.taskCardActionCommandExecutionOutcome !== "command_completed_by_runtime")
				throw new Error(
					result.taskCardActionCommandExecutionOutcome === "command_failed"
						? result.commandFailureMessage
						: "此任务有其他操作正在进行，请重试保存。",
				);
			setEntries(mergedEntries);
			lastSavedEntries.current = mergedEntries;
		} catch (cause: unknown) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSaving(false);
		}
	};
	return (
		<TaskCommentsDialogContext.Provider value={contextValue}>
			{children}
			<Dialog
				contentClassName="h-[70svh]"
				open={target !== null}
				onOpenChange={(open) => {
					if (!open && !isSaving) {
						++readGeneration.current;
						setTarget(null);
					}
				}}
			>
				<DialogHeader title={`任务评论 · ${title}`} />
				<DialogDescription className="sr-only">查看与编辑此任务的评论。</DialogDescription>
				<DialogBody className="flex min-h-0 flex-col">
					{isLoading ? (
						<p className="p-3 text-xs">正在读取任务评论…</p>
					) : hasLoaded ? (
						<fieldset disabled={isSaving} className="min-h-0 flex-1" aria-busy={isSaving}>
							<TaskCommentsPanel
								submitNewCommentOnBlur={false}
								taskCommentEntries={entries}
								onTaskCommentEntriesChange={(next) => void saveComments(next)}
							/>
						</fieldset>
					) : null}
					{error ? (
						<div role="alert" className="p-3 text-xs text-status-red">
							{error}
							<Button
								size="sm"
								onClick={() => {
									if (hasLoaded) void saveComments(entries);
									else if (target) openTaskComments(target.workspaceId, target.taskId);
								}}
								disabled={isLoading || isSaving}
							>
								{hasLoaded ? "重试保存" : "重新读取"}
							</Button>
						</div>
					) : null}
				</DialogBody>
			</Dialog>
		</TaskCommentsDialogContext.Provider>
	);
}
