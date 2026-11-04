import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useId } from "react";
import { CodexConfigurationProfileSelect } from "@/components/codex-configuration-profile-select";
import { CodexTaskReasoningEffortSelect } from "@/components/codex-task-reasoning-effort-select";
import { TaskAgentModelPicker, useTaskAgentModelPicker } from "@/components/task-agent-model-picker";
import { TaskAgentPermissionModeControl } from "@/components/task-agent-permission-mode-control";
import { TaskAgentSessionInitializationControl } from "@/components/task-agent-session-initialization-control";
import { type TaskEditorSetting, TaskEditorSettingGroup } from "@/components/task-editor-setting-groups";
import { NativeSelect } from "@/components/ui/native-select";
import { resolveCodexTaskReasoningEffortSelection } from "@/hooks/codex-task-reasoning-effort-selection";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { RuntimeTaskAgentPermissionMode } from "@/runtime/types";

type AgentModelPickerProps = ComponentProps<typeof TaskAgentModelPicker>;
export interface CreationWorkbenchStartupSettingsProps
	extends Omit<
		AgentModelPickerProps,
		| "renderControls"
		| "agentOptions"
		| "clineProviderOptions"
		| "clineModelOptions"
		| "isLoadingProviders"
		| "isLoadingModels"
	> {
	active: boolean;
	workspaceId: string | null;
	agents?: Parameters<typeof useTaskAgentModelPicker>[0]["agents"];
	selectableAgentIds?: Parameters<typeof useTaskAgentModelPicker>[0]["selectableAgentIds"];
	defaultModelId?: string | null;
	startInPlanMode: boolean;
	onStartInPlanModeChange: (value: boolean) => void;
	startInPlanModeDisabled?: boolean;
	taskAgentPermissionMode: RuntimeTaskAgentPermissionMode;
	onTaskAgentPermissionModeChange: (value: RuntimeTaskAgentPermissionMode) => void;
	codexConfigurationProfileId?: string;
	codexReasoningEffortOverride?: string;
	onCodexReasoningEffortOverrideChange?: (value: string | undefined) => void;
	onCodexReasoningEffortValidationErrorChange?: (value: string | null) => void;
	onCodexConfigurationProfileIdChange?: (value: string | undefined) => void;
	codexConfigurationPermissionSelectionSource?: "profile" | "task_local";
	onCodexConfigurationPermissionSelectionSourceChange?: (value: "profile" | "task_local") => void;
	roleReadOnly?: boolean;
	automaticallyChooseDefaultProfile?: boolean;
	additionalSettings?: TaskEditorSetting[];
	allowAgentSelection?: boolean;
}

/** 所有创建类型只在这里渲染启动设置，显示偏好共用，表单值由各自草稿持有。 */
export function CreationWorkbenchStartupSettings(props: CreationWorkbenchStartupSettingsProps) {
	const picker = useTaskAgentModelPicker({
		active: props.active,
		workspaceId: props.workspaceId,
		agentId: props.agentId,
		clineSettings: props.clineSettings,
		agents: props.agents,
		selectableAgentIds: props.selectableAgentIds,
		defaultAgentId: props.defaultAgentId,
		defaultProviderId: props.defaultProviderId,
		defaultModelId: props.defaultModelId,
	});
	const planCheckboxId = useId();
	const agentId = props.agentId ?? props.defaultAgentId ?? null;
	const codexConfiguration = useCodexConfigurationSync(
		props.workspaceId,
		props.active && agentId === "codex" && Boolean(props.onCodexReasoningEffortOverrideChange),
	);
	const codexReasoningEffortSelection = resolveCodexTaskReasoningEffortSelection({
		profile: codexConfiguration.state?.profiles?.find(
			(profile) =>
				profile.profileId ===
				(props.codexConfigurationProfileId ?? codexConfiguration.state?.defaultCodexConfigurationProfileId),
		),
		explicitModelId:
			props.terminalAgentModelOverrideSettings?.agentId === "codex"
				? props.terminalAgentModelOverrideSettings.modelId
				: undefined,
		override: props.codexReasoningEffortOverride,
		catalog: picker.terminalAgentModelCatalog,
		catalogWarning: picker.terminalAgentModelCatalogWarning,
		catalogIsLoading: picker.isLoadingTerminalAgentModels,
	});
	const codexReasoningEffortValidationError =
		agentId === "codex" && props.onCodexReasoningEffortOverrideChange
			? codexReasoningEffortSelection.validationError
			: null;
	const reportCodexReasoningEffortValidationError = props.onCodexReasoningEffortValidationErrorChange;
	useEffect(() => {
		reportCodexReasoningEffortValidationError?.(codexReasoningEffortValidationError);
	}, [codexReasoningEffortValidationError, reportCodexReasoningEffortValidationError]);
	const settings: TaskEditorSetting[] = [
		{
			key: "plan_mode",
			label: "Plan Mode",
			summary: props.startInPlanMode ? "开启" : "关闭",
			content: (
				<label
					htmlFor={planCheckboxId}
					className="flex min-h-8 cursor-pointer items-center gap-2 text-xs text-text-primary"
				>
					<RadixCheckbox.Root
						id={planCheckboxId}
						checked={props.startInPlanMode}
						onCheckedChange={(value) => props.onStartInPlanModeChange(value === true)}
						disabled={props.startInPlanModeDisabled}
						className="flex h-4 w-4 items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent"
					>
						<RadixCheckbox.Indicator>
							<Check size={12} className="text-white" />
						</RadixCheckbox.Indicator>
					</RadixCheckbox.Root>
					以 Plan Mode 启动
				</label>
			),
		},
		{
			key: "permissions",
			label: "Agent 权限",
			summary: props.roleReadOnly
				? "持续只读"
				: props.codexConfigurationPermissionSelectionSource === "profile"
					? "跟随 profile"
					: {
							ask_for_every_tool_use: "每次询问",
							auto_approve_file_edits_only: "允许编辑文件",
							bypass_all_permission_prompts: "全部允许",
						}[props.taskAgentPermissionMode],
			content: props.roleReadOnly ? (
				<p className="text-xs text-text-secondary">By the way 持续只读，Plan 和 profile 选择均不能解除此限制。</p>
			) : (
				<TaskAgentPermissionModeControl
					value={props.taskAgentPermissionMode}
					onChange={(value) => {
						props.onTaskAgentPermissionModeChange(value);
						props.onCodexConfigurationPermissionSelectionSourceChange?.("task_local");
					}}
					selectionComesFromCodexProfile={
						agentId === "codex" && props.codexConfigurationPermissionSelectionSource === "profile"
					}
					selectedAgentId={agentId}
					selectedAgentLabel={getRuntimeAgentCatalogEntry(agentId ?? "codex")?.label ?? "Agent"}
					startInPlanMode={props.startInPlanMode}
					idPrefix={planCheckboxId}
				/>
			),
		},
		...(agentId === "codex" && props.onCodexConfigurationProfileIdChange
			? [
					{
						key: "codex_configuration_profile",
						label: "Codex profile",
						summary: props.codexConfigurationProfileId ? "已绑定" : "默认配置",
						content: (
							<CodexConfigurationProfileSelect
								workspaceId={props.workspaceId}
								value={props.codexConfigurationProfileId}
								onChange={props.onCodexConfigurationProfileIdChange}
								enabled={props.active}
								automaticallyChooseDefaultProfile={props.automaticallyChooseDefaultProfile ?? false}
								adoptDefaultProfilePermissions={props.codexConfigurationPermissionSelectionSource === "profile"}
								onPermissionModeChange={(value) => {
									props.onTaskAgentPermissionModeChange(value);
									props.onCodexConfigurationPermissionSelectionSourceChange?.("profile");
								}}
							/>
						),
					},
				]
			: []),
		...(props.additionalSettings ?? []),
	];
	return (
		<TaskAgentModelPicker
			{...props}
			{...picker}
			renderControls={({ agentSelection, modelSelection }) => (
				<TaskEditorSettingGroup
					title="常用设置"
					settings={[
						...(props.allowAgentSelection === false
							? []
							: [
									{ key: "agent", label: "Agent", summary: agentId ?? "默认", content: agentSelection },
									{
										key: "model",
										label: "模型与参数",
										summary: `${props.terminalAgentModelOverrideSettings?.modelId ?? "Agent 默认配置"}${agentId === "codex" && props.onCodexReasoningEffortOverrideChange ? ` · 推理：${props.codexReasoningEffortOverride ?? "沿用 Codex 配置"}${codexReasoningEffortValidationError ? "（不兼容）" : ""}` : ""}`,
										content: (
											<>
												{modelSelection}
												{agentId === "codex" && props.onCodexReasoningEffortOverrideChange && (
													<CodexTaskReasoningEffortSelect
														value={props.codexReasoningEffortOverride}
														onChange={props.onCodexReasoningEffortOverrideChange}
														selection={codexReasoningEffortSelection}
														onRetry={picker.retryTerminalAgentModelCatalog}
													/>
												)}
											</>
										),
									},
								]),
						...settings,
					]}
				/>
			)}
		/>
	);
}

export function CreationWorkbenchContextControl(props: {
	nativeSessionInitialization?: ComponentProps<typeof TaskAgentSessionInitializationControl>;
	sideSessionContext?: {
		value: "fresh" | "current_main";
		onChange: (value: "fresh" | "current_main") => void;
		forkRejectionReason: string | null;
	};
	children?: ReactNode;
}) {
	const contextSelectId = useId();
	if (props.nativeSessionInitialization)
		return <TaskAgentSessionInitializationControl {...props.nativeSessionInitialization} />;
	if (!props.sideSessionContext) return null;
	return (
		<div>
			<label htmlFor={contextSelectId} className="mb-1 block text-xs text-text-secondary">
				会话上下文
			</label>
			<NativeSelect
				id={contextSelectId}
				value={props.sideSessionContext.value}
				onChange={(event) =>
					props.sideSessionContext?.onChange(event.currentTarget.value as "fresh" | "current_main")
				}
			>
				<option value="current_main" disabled={Boolean(props.sideSessionContext.forkRejectionReason)}>
					复刻当前主会话
				</option>
				<option value="fresh">全新上下文</option>
			</NativeSelect>
			{props.sideSessionContext.forkRejectionReason && (
				<p className="mt-1 text-xs text-text-secondary">{props.sideSessionContext.forkRejectionReason}</p>
			)}
			{props.children}
		</div>
	);
}
