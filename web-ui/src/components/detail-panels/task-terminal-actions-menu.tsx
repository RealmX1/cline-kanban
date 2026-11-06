import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";

const TASK_ACTION_MENU_ITEM_CLASS_NAME =
	"flex min-h-8 cursor-pointer items-center rounded-sm px-3 text-xs outline-none focus:bg-surface-3 data-[disabled]:cursor-default data-[disabled]:opacity-50 max-[769px]:min-h-11";

export function TaskTerminalActionsMenu({
	taskId,
	taskColumnId,
	onCommit,
	onOpenPr,
	isCommitLoading,
	isOpenPrLoading,
	onMoveToTrash,
	isMoveToTrashLoading,
	onMoveToValidation,
	isMoveToValidationLoading,
}: {
	taskId: string;
	taskColumnId: string;
	onCommit?: () => void;
	onOpenPr?: () => void;
	isCommitLoading: boolean;
	isOpenPrLoading: boolean;
	onMoveToTrash?: () => void;
	isMoveToTrashLoading: boolean;
	onMoveToValidation?: () => void;
	isMoveToValidationLoading: boolean;
}) {
	const snapshot = useTaskWorkspaceSnapshotValue(taskId);
	const [isOpen, setIsOpen] = useState(false);
	const hasAvailableTaskAction = Boolean(onMoveToTrash || onMoveToValidation);
	useEffect(() => {
		if (!hasAvailableTaskAction) setIsOpen(false);
	}, [hasAvailableTaskAction]);
	const showsGitActions = taskColumnId === "review" && (snapshot?.changedFiles ?? 0) > 0;
	if (!hasAvailableTaskAction) return null;
	return (
		<DropdownMenu.Root open={isOpen} onOpenChange={setIsOpen}>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					aria-label="任务操作"
					className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border-bright bg-surface-2/80 px-2 text-xs text-text-primary hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent active:bg-surface-2 data-[state=open]:bg-surface-2 max-[769px]:h-11 max-[769px]:w-11 max-[769px]:px-0"
				>
					<ListChecks size={16} />
					<span className="max-[769px]:hidden">任务操作</span>
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					onKeyDownCapture={(event) => {
						if (event.key !== "Escape") return;
						event.stopPropagation();
						setIsOpen(false);
					}}
					aria-label="任务操作"
					side="top"
					align="end"
					sideOffset={4}
					collisionPadding={8}
					data-mobile-focus-view-idle-collapse-suspension=""
					className="z-50 min-w-40 max-w-[calc(100vw-1rem)] rounded-md border border-border-bright bg-surface-1 p-1 text-text-primary"
				>
					{showsGitActions && onCommit ? (
						<DropdownMenu.Item
							className={TASK_ACTION_MENU_ITEM_CLASS_NAME}
							disabled={isCommitLoading || isOpenPrLoading}
							onSelect={onCommit}
						>
							{isCommitLoading ? "正在 Commit…" : "Commit"}
						</DropdownMenu.Item>
					) : null}
					{showsGitActions && onOpenPr ? (
						<DropdownMenu.Item
							className={TASK_ACTION_MENU_ITEM_CLASS_NAME}
							disabled={isCommitLoading || isOpenPrLoading}
							onSelect={onOpenPr}
						>
							{isOpenPrLoading ? "正在打开 PR…" : "打开 PR"}
						</DropdownMenu.Item>
					) : null}
					{onMoveToValidation ? (
						<DropdownMenu.Item
							className={TASK_ACTION_MENU_ITEM_CLASS_NAME}
							disabled={isMoveToValidationLoading}
							onSelect={onMoveToValidation}
						>
							{isMoveToValidationLoading ? "正在移至 Validation…" : "移至 Validation"}
						</DropdownMenu.Item>
					) : null}
					{onMoveToTrash ? (
						<DropdownMenu.Item
							className={`${TASK_ACTION_MENU_ITEM_CLASS_NAME} text-status-red`}
							disabled={isMoveToTrashLoading}
							onSelect={onMoveToTrash}
						>
							{isMoveToTrashLoading ? "正在结案…" : "结案任务"}
						</DropdownMenu.Item>
					) : null}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
