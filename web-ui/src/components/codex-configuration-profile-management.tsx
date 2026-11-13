import { useId, useState } from "react";
import { CodexConfigurationProfileDefaultEditor } from "@/components/codex-configuration-profile-default-editor";
import { Button } from "@/components/ui/button";
import type { useCodexConfigurationSync } from "@/hooks/use-codex-configuration-sync";

type ProfileController = ReturnType<typeof useCodexConfigurationSync>;
const inputClassName =
	"min-h-9 min-w-0 rounded border border-border bg-surface-2 px-2 py-1 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";

export function CodexConfigurationProfileManagement({
	controller,
	selectedProfileId,
	onSelectedProfileIdChange,
}: {
	controller: ProfileController;
	selectedProfileId: string | null;
	onSelectedProfileIdChange: (profileId: string) => void;
}) {
	const profiles = controller.state?.profiles ?? [];
	const [newProfileName, setNewProfileName] = useState("");
	const [renamedProfileName, setRenamedProfileName] = useState("");
	const [renamedProfileExpectedVersion, setRenamedProfileExpectedVersion] = useState<number | null>(null);
	const profile =
		profiles.find((item) => item.profileId === selectedProfileId) ??
		profiles.find((item) => item.profileId === controller.state?.defaultCodexConfigurationProfileId) ??
		profiles[0];
	const profileSelectId = useId();
	const createNameId = useId();
	const renameId = useId();
	const disabled = controller.pendingChangeId !== null;
	if (!profile)
		return (
			<div role="status" className="space-y-1 text-sm text-text-secondary">
				<p className="m-0 font-medium">
					{controller.state?.observationHealth?.status === "limited"
						? "观察受限"
						: controller.state?.observationHealth?.status === "recovering"
							? "自动恢复中"
							: "待核验"}
				</p>
				<p className="m-0">
					{controller.state?.observationHealth?.impact ?? "首次启动看板 Codex 后，会从已采用配置建立兼容配置。"}
				</p>
			</div>
		);
	return (
		<>
			<div
				className="sticky top-0 z-10 bg-surface-1 pb-3"
				data-verification-anchor="codex-configuration-profile-management"
			>
				<div className="flex flex-wrap items-end gap-2">
					<div className="min-w-0 flex-1">
						<label htmlFor={profileSelectId} className="block pb-1 text-xs text-text-secondary">
							配置方案
						</label>
						<select
							id={profileSelectId}
							className={`${inputClassName} w-full`}
							value={profile.profileId}
							onChange={(event) => {
								onSelectedProfileIdChange(event.target.value);
								setRenamedProfileName("");
							}}
						>
							{profiles.map((item) => (
								<option key={item.profileId} value={item.profileId}>
									{item.name}
									{item.profileId === controller.state?.defaultCodexConfigurationProfileId
										? "（新任务默认）"
										: ""}
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
						设为新任务默认
					</Button>
				</div>
				<div className="space-y-1 py-2">
					<p className="m-0 text-base font-semibold text-text-primary">已保存默认</p>
					<p className="m-0 break-words text-sm text-text-primary">
						模型：
						{String(
							profile.fields.find((field) => field.fieldKey === JSON.stringify(["config.toml", "model"]))
								?.value ?? "沿用原生默认",
						)}{" "}
						· 推理强度：
						{String(
							profile.fields.find(
								(field) => field.fieldKey === JSON.stringify(["config.toml", "model_reasoning_effort"]),
							)?.value ?? "沿用原生默认",
						)}
					</p>
					<p className="m-0 text-xs text-text-secondary">
						作用于此配置的现有和未来会话。已保存与实际采用分别核验。
					</p>
				</div>
				{controller.state?.observationHealth && (
					<div
						role="status"
						className={`pt-2 text-sm ${controller.state.observationHealth.status === "recovering" || controller.state.observationHealth.status === "limited" ? "text-status-orange" : "text-text-secondary"}`}
					>
						<p className="m-0 font-medium">
							{
								{ healthy: "观察正常", recovering: "自动恢复中", limited: "观察受限", unverified: "待核验" }[
									controller.state.observationHealth.status
								]
							}
						</p>
						<p className="m-0 pt-1 text-xs">{controller.state.observationHealth.impact}</p>
						<details className="pt-1 text-xs">
							<summary className="cursor-pointer">观察详情</summary>
							<p>
								最近检查：
								{controller.state.observationHealth.checkedAtMs === null
									? "尚未检查"
									: new Date(controller.state.observationHealth.checkedAtMs).toLocaleString()}
							</p>
							<p>{controller.state.observationHealth.recoveryCondition ?? "来源或会话变化时自动重验。"}</p>
							{controller.state.diagnosticCoverage && (
								<p>
									观察目标 {controller.state.diagnosticCoverage.targetCount} 个；原始覆盖缺口{" "}
									{controller.state.diagnosticCoverage.coverageGapCount} 处。缺口不直接代表故障数。
								</p>
							)}
						</details>
					</div>
				)}
			</div>
			<CodexConfigurationProfileDefaultEditor key={profile.profileId} profile={profile} controller={controller} />
			<details>
				<summary className="cursor-pointer text-xs text-text-secondary">管理配置方案</summary>
				<div className="flex flex-wrap items-end gap-2">
					<div className="min-w-0 flex-1">
						<label htmlFor={renameId} className="block pb-1 text-xs text-text-secondary">
							重命名配置方案
						</label>
						<input
							id={renameId}
							className={`${inputClassName} w-full`}
							value={renamedProfileName}
							placeholder={profile.name}
							maxLength={100}
							onChange={(event) => {
								if (!renamedProfileName) setRenamedProfileExpectedVersion(profile.version);
								setRenamedProfileName(event.target.value);
							}}
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
									expectedVersion: renamedProfileExpectedVersion ?? profile.version,
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
							复制当前配置方案
						</label>
						<input
							id={createNameId}
							className={`${inputClassName} w-full`}
							value={newProfileName}
							maxLength={100}
							placeholder="新配置名称"
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
						创建配置方案
					</Button>
				</div>
			</details>
		</>
	);
}
