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

export function DiscardTaskCreateConfirmDialog({
	open,
	onCancel,
	onConfirm,
	alreadyCreatedTaskId = null,
}: {
	open: boolean;
	onCancel: () => void;
	onConfirm: () => void;
	alreadyCreatedTaskId?: string | null;
}): ReactElement {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{alreadyCreatedTaskId ? "放弃剩余草稿？" : "Discard this task?"}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					{alreadyCreatedTaskId
						? `任务 ${alreadyCreatedTaskId} 已创建。关闭仅清除恢复草稿，已保存的任务和关系会保留。`
						: "You have unsaved changes to this new task. Closing now will discard everything you entered."}
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Keep editing
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="danger" onClick={onConfirm}>
						{alreadyCreatedTaskId ? "放弃草稿" : "Discard"}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
