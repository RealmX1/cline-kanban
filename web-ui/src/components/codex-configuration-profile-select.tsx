import { useEffect, useId } from "react";
import { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { CodexConfigurationProfile, RuntimeTaskAgentPermissionMode } from "@/runtime/types";

export function resolveCodexProfilePermissionMode(
	profile: CodexConfigurationProfile | undefined,
): RuntimeTaskAgentPermissionMode | undefined {
	const approval = profile?.fields.find(
		(field) => field.fieldKey === JSON.stringify(["config.toml", "approval_policy"]),
	)?.value;
	const sandbox = profile?.fields.find(
		(field) => field.fieldKey === JSON.stringify(["config.toml", "sandbox_mode"]),
	)?.value;
	if (approval === undefined || sandbox === undefined) return;
	return approval === "never" && sandbox === "danger-full-access"
		? "bypass_all_permission_prompts"
		: "ask_for_every_tool_use";
}

export function CodexConfigurationProfileSelect({
	workspaceId,
	value,
	onChange,
	enabled = true,
	inheritedProfileId,
	onPermissionModeChange,
	automaticallyChooseDefaultProfile = true,
	adoptDefaultProfilePermissions = true,
}: {
	workspaceId: string | null;
	value: string | undefined;
	onChange: (profileId: string | undefined) => void;
	enabled?: boolean;
	inheritedProfileId?: string;
	onPermissionModeChange?: (mode: RuntimeTaskAgentPermissionMode) => void;
	automaticallyChooseDefaultProfile?: boolean;
	adoptDefaultProfilePermissions?: boolean;
}) {
	const controller = useCodexConfigurationSync(workspaceId, enabled);
	const id = useId();
	const profiles = controller.state?.profiles ?? [];
	const defaultProfileId = inheritedProfileId ?? controller.state?.defaultCodexConfigurationProfileId ?? undefined;
	useEffect(() => {
		if (!enabled || !automaticallyChooseDefaultProfile || value || inheritedProfileId || !defaultProfileId) return;
		onChange(defaultProfileId);
		const mode = resolveCodexProfilePermissionMode(
			profiles.find((profile) => profile.profileId === defaultProfileId),
		);
		if (mode && adoptDefaultProfilePermissions) onPermissionModeChange?.(mode);
	}, [
		defaultProfileId,
		enabled,
		inheritedProfileId,
		onChange,
		onPermissionModeChange,
		profiles,
		value,
		automaticallyChooseDefaultProfile,
		adoptDefaultProfilePermissions,
	]);
	return (
		<div className="min-w-0 space-y-1" data-verification-anchor="codex-configuration-profile-select">
			<label htmlFor={id} className="block text-xs text-text-secondary">
				Codex 配置 profile
			</label>
			<select
				id={id}
				value={value ?? ""}
				disabled={!enabled || !controller.state}
				onChange={(event) => {
					const profileId = event.target.value || undefined;
					onChange(profileId);
					const mode = resolveCodexProfilePermissionMode(
						profiles.find((profile) => profile.profileId === (profileId ?? defaultProfileId)),
					);
					if (mode) onPermissionModeChange?.(mode);
				}}
				className="min-h-9 w-full rounded border border-border bg-surface-2 px-2 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
			>
				<option value="">
					{inheritedProfileId
						? `继承 Task：${profiles.find((profile) => profile.profileId === inheritedProfileId)?.name ?? "原绑定"}`
						: "使用默认 profile"}
				</option>
				{value && !profiles.some((profile) => profile.profileId === value) && (
					<option value={value}>原 profile（等待恢复）</option>
				)}
				{profiles.map((profile) => (
					<option key={profile.profileId} value={profile.profileId}>
						{profile.name}
					</option>
				))}
			</select>
			<p className="m-0 text-xs text-text-secondary">普通设置自动共享；模型、Effort、权限可仅作用于当前会话。</p>
			{controller.error && (
				<p role="status" className="text-xs text-status-red">
					{controller.error}
				</p>
			)}
		</div>
	);
}
