import { type ReactElement, useEffect, useState } from "react";

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

export function DeleteTaskDialog({
	task,
	onCancel,
	onConfirm,
}: {
	task: BoardCard | null;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	const [hasConfirmedIntent, setHasConfirmedIntent] = useState(false);

	useEffect(() => {
		setHasConfirmedIntent(false);
	}, [task?.id]);

	const title = hasConfirmedIntent ? "Delete task permanently?" : "Delete this task?";
	const description = task
		? `This will permanently delete "${task.title}" from the board.`
		: "This task will be deleted.";

	return (
		<AlertDialog
			open={task !== null}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{title}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>{description}</AlertDialogDescription>
				{hasConfirmedIntent ? (
					<p className="text-text-primary">This action cannot be undone.</p>
				) : (
					<p className="text-text-primary">A second confirmation is required before deletion.</p>
				)}
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				{hasConfirmedIntent ? (
					<AlertDialogAction asChild>
						<Button variant="danger" onClick={onConfirm}>
							Delete Task
						</Button>
					</AlertDialogAction>
				) : (
					<Button variant="danger" onClick={() => setHasConfirmedIntent(true)}>
						Continue
					</Button>
				)}
			</AlertDialogFooter>
		</AlertDialog>
	);
}
