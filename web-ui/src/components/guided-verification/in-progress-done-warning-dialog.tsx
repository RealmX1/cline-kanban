import { Radio } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

// Grilling #6：in_progress 任务入 Done 的第二次确认——强调任务仍在 in_progress，
// 其 agent session 可能仍在运行，移入 Done 会停止会话并清理 worktree，用户需确认已理解。
export interface InProgressDoneWarningDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	taskTitle: string;
	isBusy: boolean;
	onConfirm: () => void;
}

export function InProgressDoneWarningDialog({
	open,
	onOpenChange,
	taskTitle,
	isBusy,
	onConfirm,
}: InProgressDoneWarningDialogProps): ReactElement {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogHeader>
				<AlertDialogTitle className="flex items-center gap-2">
					<Radio size={16} className="text-status-red" />
					任务仍在 In Progress
				</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<p className="m-0 text-text-primary">{taskTitle}</p>
				<AlertDialogDescription className="m-0">
					该任务尚未离开 <span className="font-medium text-text-primary">In Progress</span> 列， 其 agent{" "}
					<span className="text-status-red">会话可能仍在运行</span>。移入 Done 会立即
					<span className="text-status-red">停止会话并清理 worktree</span>，未提交的进行中改动可能丢失。
				</AlertDialogDescription>
				<p className="m-0">确认你已了解上述影响并仍要完成核对、移入 Done。</p>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" disabled={isBusy}>
						取消
					</Button>
				</AlertDialogCancel>
				<Button
					variant="danger"
					disabled={isBusy}
					icon={isBusy ? <Spinner size={14} /> : undefined}
					onClick={onConfirm}
				>
					我已了解，移入 Done
				</Button>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
