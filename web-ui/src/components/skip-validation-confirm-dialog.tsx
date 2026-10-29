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

export function SkipValidationConfirmDialog({
	open,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}): ReactElement {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Move directly to Done?</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription>
					This skips the Validation step and moves the task straight to Done.
				</AlertDialogDescription>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default">Cancel</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button
						variant="danger"
						onClick={(event) => {
							// 由调用方关闭；Radix 默认关闭会经 onOpenChange 误触取消并恢复结案表单。
							event.preventDefault();
							onConfirm();
						}}
					>
						结案任务
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
