// 会话模式选择控件（蓝图 §A.1）：建卡/编辑对话框里的 operational ⇄ exploratory 声明。
// 模式是「下次启动生效」的卡片快照——活会话不热切换（活会话读 summary 投影）。

import { Compass, Wrench } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeTaskConversationMode } from "@/runtime/types";

const TASK_CONVERSATION_MODE_OPTIONS: Array<{
	value: RuntimeTaskConversationMode;
	label: string;
	icon: ReactElement;
}> = [
	{ value: "operational", label: "Operational", icon: <Wrench size={14} /> },
	{ value: "exploratory", label: "Exploratory", icon: <Compass size={14} /> },
];

export function TaskConversationModeControl({
	value,
	onChange,
	disabled = false,
	idPrefix,
}: {
	value: RuntimeTaskConversationMode;
	onChange: (value: RuntimeTaskConversationMode) => void;
	disabled?: boolean;
	idPrefix: string;
}): ReactElement {
	return (
		<div className="inline-grid grid-cols-2 rounded-md border border-border bg-surface-2 p-0.5">
			{TASK_CONVERSATION_MODE_OPTIONS.map((option) => {
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
