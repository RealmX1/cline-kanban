import { NativeSelect } from "@/components/ui/native-select";
import type { useTaskAssistanceModelProviderRoutingSettingsDraft } from "@/hooks/use-task-assistance-model-provider-routing-settings-draft";
import type { NotificationProviderProfile } from "@/runtime/notification-intelligence-query";

export function TaskAssistanceModelProviderRoutingSettingsSection({
	draft,
	disabled,
	providers = [],
}: {
	draft: ReturnType<typeof useTaskAssistanceModelProviderRoutingSettingsDraft>;
	disabled: boolean;
	providers?: readonly NotificationProviderProfile[];
}) {
	const settings = draft.settings;
	const providerIds = [
		...new Set(
			[
				"minimax",
				"deepseek",
				...providers
					.filter((provider) => provider.providerProtocol === "openai_compatible")
					.map((provider) => provider.modelProviderId),
				settings?.preferredModelProviderId,
				settings?.fallbackModelProviderId,
			].filter((id): id is string => Boolean(id)),
		),
	];
	return (
		<section className="space-y-3 border-t border-border pt-4" aria-label="AI 任务分析">
			<h2 className="text-base font-semibold text-text-primary">AI 任务分析</h2>
			<p className="text-xs text-text-secondary">
				项目归属、查卡、任务起名和关系分析共用 API 主备路由。模型与凭据使用下方 provider 档案。
			</p>
			{draft.loadError ? (
				<p role="alert" className="text-xs text-status-red">
					{draft.loadError}
				</p>
			) : null}
			{(["preferredModelProviderId", "fallbackModelProviderId"] as const).map((field) => {
				const provider = providers.find((candidate) => candidate.modelProviderId === settings?.[field]);
				return (
					<label
						key={field}
						htmlFor={`task-assistance-provider-routing-${field}`}
						className="flex flex-col gap-1 text-xs text-text-secondary"
					>
						{field === "preferredModelProviderId" ? "首选 provider" : "备用 provider"}
						<NativeSelect
							fill
							id={`task-assistance-provider-routing-${field}`}
							aria-label={
								field === "preferredModelProviderId" ? "任务分析首选 provider" : "任务分析备用 provider"
							}
							value={settings?.[field] ?? ""}
							disabled={disabled || !settings}
							onChange={(event) =>
								settings && draft.setSettings({ ...settings, [field]: event.target.value || null })
							}
						>
							{field === "fallbackModelProviderId" ? <option value="">不使用备用</option> : null}
							{providerIds.map((id) => (
								<option key={id} value={id}>
									{providers.find((candidate) => candidate.modelProviderId === id)?.displayName ?? id}
								</option>
							))}
						</NativeSelect>
						<span>
							{provider
								? `模型：${provider.defaultModelId ?? "尚未配置"} · ${provider.credentialConfigured ? "凭据已配置" : "凭据不可用"}`
								: settings?.[field]
									? "尚未配置可用档案"
									: "未设置备用 provider"}
						</span>
					</label>
				);
			})}
			<p className="text-xs text-text-secondary">
				每个阶段每家最多请求一次。首选失败后冷却 60 秒，之后的新请求自动重验；取消立即停止。保存后应用于新请求。
			</p>
		</section>
	);
}
