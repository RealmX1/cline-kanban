import { type ReactElement, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import type { BoardCard } from "@/types";

export function StartAllReadyBacklogTasksConfirmDialog({
	tasks,
	onCancel,
	onConfirm,
}: {
	tasks: BoardCard[] | null;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	const confirmationAcceptedRef = useRef(false);
	const taskCount = tasks?.length ?? 0;
	const taskLabel = taskCount === 1 ? "task" : "tasks";
	const confirmationDescription =
		taskCount === 1
			? "This will move 1 ready backlog task to In Progress and launch its agent."
			: `This will move ${taskCount} ready backlog tasks to In Progress and launch an agent for each task.`;

	useEffect(() => {
		if (tasks !== null) {
			confirmationAcceptedRef.current = false;
		}
	}, [tasks]);

	return (
		<AlertDialog
			open={tasks !== null && taskCount > 0}
			onOpenChange={(isOpen) => {
				if (isOpen) return;
				if (confirmationAcceptedRef.current) {
					confirmationAcceptedRef.current = false;
					return;
				}
				onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{`Start ${taskCount} ready backlog ${taskLabel}?`}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>{confirmationDescription}</AlertDialogDescription>
				<ul
					aria-label="Ready backlog tasks to start"
					className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-surface-0 p-2 text-text-primary"
				>
					{tasks?.map((task) => (
						<li key={task.id} className="truncate rounded-sm px-2 py-1.5" title={task.title}>
							{task.title}
						</li>
					))}
				</ul>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default">Cancel</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button
						variant="primary"
						onClick={() => {
							confirmationAcceptedRef.current = true;
							onConfirm();
						}}
					>
						{`Start ${taskCount} ${taskLabel}`}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
