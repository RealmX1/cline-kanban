import {
	doesPlanModeStartOverridePermissionModeForAgent,
	doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest,
	resolveTaskAgentPermissionModeForAgent,
} from "@runtime-task-agent-permission-mode";
import { FilePen, ShieldCheck, ShieldOff } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "@/components/ui/cn";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeAgentId, RuntimeTaskAgentPermissionMode } from "@/runtime/types";

const TASK_AGENT_PERMISSION_MODE_OPTIONS: Array<{
	value: RuntimeTaskAgentPermissionMode;
	label: string;
	description: string;
	icon: ReactElement;
}> = [
	{
		value: "ask_for_every_tool_use",
		label: "Ask",
		description: "The agent stops and asks before editing files or running commands.",
		icon: <ShieldCheck size={14} />,
	},
	{
		value: "auto_approve_file_edits_only",
		label: "Edits",
		description: "File edits are auto-approved; running shell commands still asks.",
		icon: <FilePen size={14} />,
	},
	{
		value: "bypass_all_permission_prompts",
		label: "Bypass",
		description: "Every tool call is auto-approved. The agent never stops to ask.",
		icon: <ShieldOff size={14} />,
	},
];

// 降级必须在此明示，而且必须报出**真实生效的那一档**——绝不能一律写成「回退到 Ask」。
// 多数 harness 的降级方向确实是收紧到 Ask，但原生 Cline SDK 的进程内审批恒批准，它的降级
// 方向相反：任何更严的档位都会落到 Bypass。把放宽说成收紧，等于告诉用户权限被收紧了、实际
// 却是所有工具自动批准——这正是必须避免的安全语义误导。真实档位一律取自领域解析器
// resolveTaskAgentPermissionModeForAgent，不在 UI 侧重写一份能力矩阵。
interface TaskAgentPermissionModeDegradationForOption {
	effectivePermissionMode: RuntimeTaskAgentPermissionMode;
	widensPermissionsBeyondRequest: boolean;
}

function resolveDegradationForOption(
	selectedAgentId: RuntimeAgentId | null,
	permissionMode: RuntimeTaskAgentPermissionMode,
): TaskAgentPermissionModeDegradationForOption | null {
	if (selectedAgentId === null) {
		return null;
	}
	const resolved = resolveTaskAgentPermissionModeForAgent(selectedAgentId, permissionMode);
	if (!resolved.degradedBecauseAgentCannotExpressRequestedMode) {
		return null;
	}
	return {
		effectivePermissionMode: resolved.effectivePermissionMode,
		widensPermissionsBeyondRequest: doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest(resolved),
	};
}

function findTaskAgentPermissionModeOptionLabel(permissionMode: RuntimeTaskAgentPermissionMode): string {
	return TASK_AGENT_PERMISSION_MODE_OPTIONS.find((option) => option.value === permissionMode)?.label ?? permissionMode;
}

function findTaskAgentPermissionModeOptionDescription(permissionMode: RuntimeTaskAgentPermissionMode): string {
	return TASK_AGENT_PERMISSION_MODE_OPTIONS.find((option) => option.value === permissionMode)?.description ?? "";
}

function buildOptionTooltipContent(
	description: string,
	degradation: TaskAgentPermissionModeDegradationForOption | null,
	selectedAgentLabel: string,
): string {
	if (degradation === null) {
		return description;
	}
	const effectiveLabel = findTaskAgentPermissionModeOptionLabel(degradation.effectivePermissionMode);
	const effectiveDescription = findTaskAgentPermissionModeOptionDescription(degradation.effectivePermissionMode);
	if (degradation.widensPermissionsBeyondRequest) {
		return `${description}\n\nWarning: ${selectedAgentLabel} cannot enforce this tier and will actually run with "${effectiveLabel}" — ${effectiveDescription}`;
	}
	return `${description}\n\n${selectedAgentLabel} cannot express this tier and will fall back to "${effectiveLabel}" — ${effectiveDescription}`;
}

export function TaskAgentPermissionModeControl({
	value,
	onChange,
	selectedAgentId,
	selectedAgentLabel,
	startInPlanMode,
	disabled = false,
	idPrefix,
}: {
	value: RuntimeTaskAgentPermissionMode;
	onChange: (value: RuntimeTaskAgentPermissionMode) => void;
	selectedAgentId: RuntimeAgentId | null;
	selectedAgentLabel: string;
	// 「plan 起步」本是与权限档正交的另一条轴，但少数 harness（droid）把两者压在同一个单轴设置上，
	// plan 起步会整个吃掉权限档。控件必须知道这条轴的当前值，才能在冲突时明示，而不是让用户以为
	// 两个设置都生效了。
	startInPlanMode: boolean;
	disabled?: boolean;
	idPrefix: string;
}): ReactElement {
	// droid 的 autonomyMode 是单轴（spec / normal / auto-high）：勾了 plan 起步就写 spec，
	// 这里选的档位根本不会被写入。这一点必须当场说出来。
	const planModeStartOverridesPermissionMode =
		selectedAgentId !== null && startInPlanMode && doesPlanModeStartOverridePermissionModeForAgent(selectedAgentId);
	// 自带 TooltipProvider：本控件被任务编辑对话框独立挂载（含单测里脱离 App 的渲染），
	// 不能假定外层已经提供了 Radix 的 tooltip context。Provider 允许嵌套。
	return (
		<TooltipProvider>
			<div
				className={cn(
					"inline-grid grid-cols-3 rounded-md border border-border bg-surface-2 p-0.5",
					planModeStartOverridesPermissionMode && "opacity-50",
				)}
			>
				{TASK_AGENT_PERMISSION_MODE_OPTIONS.map((option) => {
					const isSelected = option.value === value;
					const degradation = resolveDegradationForOption(selectedAgentId, option.value);
					return (
						<Tooltip
							key={option.value}
							content={buildOptionTooltipContent(option.description, degradation, selectedAgentLabel)}
						>
							<button
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
								{degradation === null ? null : (
									<span
										className={
											degradation.widensPermissionsBeyondRequest ? "text-status-red" : "text-status-orange"
										}
									>
										*
									</span>
								)}
							</button>
						</Tooltip>
					);
				})}
			</div>
			{planModeStartOverridesPermissionMode ? (
				<p className="mt-1 text-[11px] text-status-orange">
					{selectedAgentLabel} has a single autonomy setting, so "Start in plan mode" overrides this tier for the
					whole session.
				</p>
			) : null}
		</TooltipProvider>
	);
}
