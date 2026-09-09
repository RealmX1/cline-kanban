import type { ReactElement } from "react";

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

export function ClearTrashDialog({
	open,
	taskCount,
	independentTaskIds = [],
	onCancel,
	onConfirm,
}: {
	open: boolean;
	taskCount: number;
	independentTaskIds?: string[];
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	const taskLabel = taskCount === 1 ? "task" : "tasks";

	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Clear done items permanently?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					This will permanently delete {taskCount} {taskLabel} from Done.
				</AlertDialogDescription>
				<p className="text-text-primary">This action cannot be undone.</p>
				{independentTaskIds.map((taskId) => (
					<p key={taskId} className="text-text-primary break-all">
						同时删除 ~/.cline/kanban/independent-task-workspaces/{taskId}/ 内的全部文件。
					</p>
				))}
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="danger" onClick={onConfirm}>
						Clear Done
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
