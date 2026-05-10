import { FolderOpen, GitBranch } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeTaskWorktreeMode } from "@/runtime/types";

const TASK_WORKTREE_MODE_OPTIONS: Array<{
	value: RuntimeTaskWorktreeMode;
	label: string;
	icon: ReactElement;
}> = [
	{ value: "branch", label: "New worktree", icon: <GitBranch size={14} /> },
	{ value: "inplace", label: "Current checkout", icon: <FolderOpen size={14} /> },
];

export function TaskWorktreeModeControl({
	value,
	onChange,
	disabled = false,
	idPrefix,
}: {
	value: RuntimeTaskWorktreeMode;
	onChange: (value: RuntimeTaskWorktreeMode) => void;
	disabled?: boolean;
	idPrefix: string;
}): ReactElement {
	return (
		<div className="inline-grid grid-cols-2 rounded-md border border-border bg-surface-2 p-0.5">
			{TASK_WORKTREE_MODE_OPTIONS.map((option) => {
				const isSelected = option.value === value;
				return (
					<button
						key={option.value}
						id={`${idPrefix}-${option.value}`}
						type="button"
						disabled={disabled}
						aria-pressed={isSelected}
						onClick={() => onChange(option.value)}
						className={cn(
							"inline-flex h-7 items-center justify-center gap-1.5 rounded-sm px-2 text-[12px] font-medium transition-colors",
							isSelected
								? "bg-surface-4 text-text-primary"
								: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
							disabled && "cursor-default opacity-50 hover:bg-transparent hover:text-text-secondary",
						)}
					>
						{option.icon}
						<span className="truncate">{option.label}</span>
					</button>
				);
			})}
		</div>
	);
}
