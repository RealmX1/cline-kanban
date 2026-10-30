import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";
import type { CodexConfigurationProfile } from "@/runtime/types";

type ProfileController = ReturnType<typeof useCodexConfigurationSync>;
type ProfileField = CodexConfigurationProfile["fields"][number];
const inputClassName =
	"min-h-9 min-w-0 rounded border border-border bg-surface-2 px-2 py-1 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

function ProfileSettingEditor({
	profile,
	field,
	controller,
}: {
	profile: CodexConfigurationProfile;
	field: ProfileField;
	controller: ProfileController;
}) {
	const serialize = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
	const [draft, setDraft] = useState(() => serialize(field.value));
	const [draftProfileVersion, setDraftProfileVersion] = useState(profile.version);
	const [dirty, setDirty] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const id = useId();
	useEffect(() => {
		if (dirty) return;
		setDraft(serialize(field.value));
		setDraftProfileVersion(profile.version);
	}, [dirty, field.value, profile.version]);
	const isHookState = field.fieldKey.includes('"hooks","state"');
	const label = isHookState ? "hook 启用状态" : field.fieldLabel;
	const save = async () => {
		try {
			const value = isHookState
				? { ...(field.value as Record<string, unknown>), enabled: draft === "true" }
				: typeof field.value === "string"
					? draft
					: JSON.parse(draft);
			const fields =
				field.exceptionGroup === "permissions"
					? profile.fields
							.filter((item) => item.exceptionGroup === "permissions")
							.map((item) => ({
								fieldKey: item.fieldKey,
								value: item.fieldKey === field.fieldKey ? value : item.value,
							}))
					: [{ fieldKey: field.fieldKey, value }];
			if (
				await controller.profileAction({
					action: "update",
					profileId: profile.profileId,
					expectedVersion: draftProfileVersion,
					fields,
					idempotencyKey: crypto.randomUUID(),
				})
			) {
				setDirty(false);
				setError(null);
			}
		} catch {
			setError("设置值格式无效，请检查 JSON、数字或开关。");
		}
	};
	return (
		<div className="min-w-0 space-y-1 border-b border-border py-3">
			<label htmlFor={id} className="block break-words text-xs font-medium text-text-primary">
				{label}
			</label>
			<div className="flex min-w-0 flex-wrap items-start gap-2">
				{typeof field.value === "boolean" || isHookState ? (
					<select
						id={id}
						className={inputClassName}
						value={
							isHookState && !dirty ? String((field.value as Record<string, unknown>).enabled !== false) : draft
						}
						onChange={(event) => {
							if (!dirty) setDraftProfileVersion(profile.version);
							setDirty(true);
							setDraft(event.target.value);
						}}
					>
						<option value="true">开启</option>
						<option value="false">关闭</option>
					</select>
				) : (
					<input
						id={id}
						className={`${inputClassName} flex-1`}
						value={draft}
						onChange={(event) => {
							if (!dirty) setDraftProfileVersion(profile.version);
							setDirty(true);
							setDraft(event.target.value);
						}}
					/>
				)}
				<Button
					size="sm"
					disabled={controller.pendingChangeId !== null || !dirty}
					onClick={() => {
						void save();
					}}
				>
					更新并广播
				</Button>
			</div>
			<p className="m-0 break-words text-xs text-text-secondary">
				有效值：{isHookState ? field.valueSummary : serialize(field.value)} · 来源：{profile.name} · 作用于此
				profile 的现有和未来会话
			</p>
			{isHookState && (
				<p className="m-0 text-xs text-text-secondary">
					信任与撤销按可信来源和定义跨 profile 复用，启停仅作用于此 profile。
				</p>
			)}
			{error && (
				<p role="alert" className="text-xs text-status-red">
					{error}
				</p>
			)}
		</div>
	);
}

export function CodexConfigurationProfileManagement({ controller }: { controller: ProfileController }) {
	const profiles = controller.state?.profiles ?? [];
	const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
	const [newProfileName, setNewProfileName] = useState("");
	const [renamedProfileName, setRenamedProfileName] = useState("");
	const profile =
		profiles.find((item) => item.profileId === selectedProfileId) ??
		profiles.find((item) => item.profileId === controller.state?.defaultCodexConfigurationProfileId) ??
		profiles[0];
	const profileSelectId = useId();
	const createNameId = useId();
	const renameId = useId();
	const disabled = controller.pendingChangeId !== null;
	if (!profile)
		return <p className="text-xs text-text-secondary">首次启动看板 Codex 后，会从已采用配置建立兼容 profile。</p>;
	return (
		<div className="min-w-0 space-y-3 pb-4" data-verification-anchor="codex-configuration-profile-management">
			<div className="flex flex-wrap items-end gap-2">
				<div className="min-w-0 flex-1">
					<label htmlFor={profileSelectId} className="block pb-1 text-xs text-text-secondary">
						管理 profile
					</label>
					<select
						id={profileSelectId}
						className={`${inputClassName} w-full`}
						value={profile.profileId}
						onChange={(event) => {
							setSelectedProfileId(event.target.value);
							setRenamedProfileName("");
						}}
					>
						{profiles.map((item) => (
							<option key={item.profileId} value={item.profileId}>
								{item.name}
								{item.profileId === controller.state?.defaultCodexConfigurationProfileId ? "（默认）" : ""}
							</option>
						))}
					</select>
				</div>
				<Button
					size="sm"
					disabled={disabled || profile.profileId === controller.state?.defaultCodexConfigurationProfileId}
					onClick={() => {
						void controller.profileAction({
							action: "set_default",
							profileId: profile.profileId,
							idempotencyKey: crypto.randomUUID(),
						});
					}}
				>
					设为默认
				</Button>
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<div className="min-w-0 flex-1">
					<label htmlFor={renameId} className="block pb-1 text-xs text-text-secondary">
						重命名当前 profile
					</label>
					<input
						id={renameId}
						className={`${inputClassName} w-full`}
						value={renamedProfileName}
						placeholder={profile.name}
						maxLength={100}
						onChange={(event) => setRenamedProfileName(event.target.value)}
					/>
				</div>
				<Button
					size="sm"
					disabled={disabled || !renamedProfileName.trim()}
					onClick={() => {
						void controller
							.profileAction({
								action: "update",
								profileId: profile.profileId,
								expectedVersion: profile.version,
								name: renamedProfileName.trim(),
								idempotencyKey: crypto.randomUUID(),
							})
							.then((saved) => {
								if (saved) setRenamedProfileName("");
							});
					}}
				>
					保存名称
				</Button>
			</div>
			<div className="flex flex-wrap items-end gap-2">
				<div className="min-w-0 flex-1">
					<label htmlFor={createNameId} className="block pb-1 text-xs text-text-secondary">
						从当前 profile 复制
					</label>
					<input
						id={createNameId}
						className={`${inputClassName} w-full`}
						value={newProfileName}
						maxLength={100}
						placeholder="新 profile 名称"
						onChange={(event) => setNewProfileName(event.target.value)}
					/>
				</div>
				<Button
					size="sm"
					disabled={disabled || !newProfileName.trim()}
					onClick={() => {
						void controller
							.profileAction({
								action: "create",
								name: newProfileName.trim(),
								copyFromProfileId: profile.profileId,
								idempotencyKey: crypto.randomUUID(),
							})
							.then((saved) => {
								if (saved) setNewProfileName("");
							});
					}}
				>
					创建 profile
				</Button>
			</div>
			<details>
				<summary className="cursor-pointer py-2 text-sm text-text-primary">
					共享设置 · {profile.fields.length} 项
				</summary>
				<div>
					{profile.fields.map((field) => (
						<ProfileSettingEditor
							key={`${profile.profileId}:${field.fieldKey}`}
							profile={profile}
							field={field}
							controller={controller}
						/>
					))}
				</div>
			</details>
			{controller.state?.sessionProfileBindings
				?.filter((binding) => binding.codexConfigurationProfileId === profile.profileId)
				.map((binding) => (
					<div
						key={`${binding.workspaceId}:${binding.conversationSessionId}`}
						className="m-0 break-words text-xs text-text-secondary"
					>
						{binding.workspaceId} · {binding.conversationSessionId}
						{binding.localExceptionGroups.length
							? ` · 局部选择：${binding.localExceptionGroups.join("、")}`
							: " · 跟随 profile"}
						{binding.adoptionReason && <p className="m-0 pt-1">{binding.adoptionReason}</p>}
						<label className="mt-1 flex flex-wrap items-center gap-2">
							<span>会话所属 profile</span>
							<select
								className={inputClassName}
								aria-label={`会话 ${binding.conversationSessionId} 所属 profile`}
								value={binding.codexConfigurationProfileId}
								disabled={disabled || !binding.runtimeSessionIncarnationId}
								onChange={(event) => {
									if (!binding.runtimeSessionIncarnationId) return;
									void controller.profileAction({
										action: "bind_session",
										profileId: event.target.value,
										workspaceId: binding.workspaceId,
										conversationSessionId: binding.conversationSessionId,
										expectedRuntimeSessionIncarnationId: binding.runtimeSessionIncarnationId,
										idempotencyKey: crypto.randomUUID(),
									});
								}}
							>
								{profiles
									.filter((item) => item.sourceIdentity === profile.sourceIdentity)
									.map((item) => (
										<option key={item.profileId} value={item.profileId}>
											{item.name}
										</option>
									))}
							</select>
						</label>
					</div>
				))}
		</div>
	);
}
