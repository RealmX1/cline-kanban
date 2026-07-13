import { AlertTriangle } from "lucide-react";
import type { ReactElement } from "react";
import { formatBoardColumnLabel } from "@/components/guided-verification/guided-verification-format";
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
import type { BoardColumnId } from "@/types";

// Grilling #3–5：全勾后从 review / in_progress 直接入 Done 会跳过 Validation 列，需一次确认，
// 额外展示该任务最近一条 agent response（按 agent 类型分源，由后端 requestVerificationComplete 预置）。
// in_progress 场景本对话框是「第一次确认」，通过后 controller 追加 InProgressDoneWarningDialog（第二次）。
export interface GuidedVerificationDoneConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	taskTitle: string;
	fromColumnId: BoardColumnId;
	agentResponsePreview: string | undefined;
	// true 表示后面还有第二次确认（in_progress）——按钮文案改为「继续」。
	requiresSecondConfirmation: boolean;
	isBusy: boolean;
	onConfirm: () => void;
}

export function GuidedVerificationDoneConfirmDialog({
	open,
	onOpenChange,
	taskTitle,
	fromColumnId,
	agentResponsePreview,
	requiresSecondConfirmation,
	isBusy,
	onConfirm,
}: GuidedVerificationDoneConfirmDialogProps): ReactElement {
	const columnLabel = formatBoardColumnLabel(fromColumnId);
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogHeader>
				<AlertDialogTitle className="flex items-center gap-2">
					<AlertTriangle size={16} className="text-status-orange" />
					跳过 Validation，直接移入 Done
				</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<p className="m-0 text-text-primary">{taskTitle}</p>
				<AlertDialogDescription className="m-0">
					该任务当前位于 <span className="font-medium text-text-primary">{columnLabel}</span>{" "}
					列。全部核对项已勾选， 完成核对将<span className="text-status-orange">跳过 Validation 列</span>并直接移入
					Done，同时停止会话、清理 worktree。
				</AlertDialogDescription>
				<div className="rounded-md border border-border bg-surface-2 p-2">
					<p className="m-0 mb-1 text-[12px] font-medium text-text-secondary">最近一条 agent 回复</p>
					{agentResponsePreview ? (
						<pre className="m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-primary">
							{agentResponsePreview}
						</pre>
					) : (
						<p className="m-0 text-[12px] italic text-text-tertiary">无可用 agent 回复</p>
					)}
				</div>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" disabled={isBusy}>
						取消
					</Button>
				</AlertDialogCancel>
				{/* asChild 会让 Radix 关闭对话框；in_progress 需保持流程继续到第二次确认，故这里不用 Action wrapper。 */}
				<Button
					variant="danger"
					disabled={isBusy}
					icon={isBusy ? <Spinner size={14} /> : undefined}
					onClick={onConfirm}
				>
					{requiresSecondConfirmation ? "继续" : "确认移入 Done"}
				</Button>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
