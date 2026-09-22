import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { useNotificationIntelligenceSettingsDraft } from "@/hooks/use-notification-intelligence-settings-draft";
import {
	type NotificationIntelligenceSettings,
	type NotificationProviderProfile,
	notificationIntelligenceClient,
} from "@/runtime/notification-intelligence-query";
import { playNotificationSummarySpeech } from "@/utils/notification-summary-speech";

const inputClassName = "w-full rounded border border-border bg-surface-0 px-2 py-1.5 text-sm text-text-primary";
export function NotificationIntelligenceSettingsSection({
	draft,
	disabled,
}: {
	draft: ReturnType<typeof useNotificationIntelligenceSettingsDraft>;
	disabled: boolean;
}) {
	const {
		settings,
		setSettings,
		providers,
		profile,
		setProfile,
		apiKey,
		setApiKey,
		savedProfile,
		browserVoiceUri,
		setBrowserVoiceUri,
	} = draft;
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
	const [models, setModels] = useState<
		Awaited<ReturnType<ReturnType<typeof notificationIntelligenceClient>["speechModels"]["query"]>>[number][]
	>([]);
	useEffect(() => {
		void notificationIntelligenceClient()
			.speechModels.query()
			.then((value) => setModels([...value]))
			.catch(() => setNotice("无法读取模型目录"));
		if (!("speechSynthesis" in window)) return;
		const updateVoices = () => setVoices(window.speechSynthesis.getVoices());
		updateVoices();
		window.speechSynthesis.addEventListener("voiceschanged", updateVoices);
		return () => window.speechSynthesis.removeEventListener("voiceschanged", updateVoices);
	}, []);
	async function run(operation: () => Promise<void>) {
		setBusy(true);
		setNotice("");
		try {
			await operation();
			setNotice("试听结束");
		} catch (error) {
			setNotice(error instanceof Error ? error.message : "操作失败");
		} finally {
			setBusy(false);
		}
	}
	if (!settings)
		return (
			<p className="text-sm text-text-secondary" role="status">
				{draft.loadError || notice || "正在读取 AI 与语音设置…"}
			</p>
		);
	const selectedModel = models.find((model) => model.modelId === settings.notificationSpeechBinding?.modelId);
	function patch(value: Partial<NotificationIntelligenceSettings>) {
		setSettings((current) => (current ? { ...current, ...value } : current));
	}
	const chatProviders = providers.filter((candidate) => candidate.providerProtocol === "openai_compatible");
	return (
		<section
			aria-label="AI 与语音设置"
			className="mb-4 space-y-4 rounded-lg border border-border bg-surface-0 p-4 text-sm"
		>
			<h3 className="font-semibold">智能通知与 BYOK</h3>
			<p className="text-text-secondary">
				所有修改统一由底部 Save 保存；Cancel 放弃本次修改。密钥不回显，凭据来源不会自动切换。
			</p>
			<fieldset disabled={busy || disabled} className="space-y-3">
				<legend className="mb-2 font-medium">Provider 凭据</legend>
				<NativeSelect
					aria-label="编辑 provider"
					value={draft.selectedProviderIndex}
					onChange={(event) => draft.setSelectedProviderIndex(Number(event.target.value))}
				>
					{providers.map((candidate, index) => (
						<option key={index} value={index}>
							{candidate.displayName} · {candidate.modelProviderId}
						</option>
					))}
				</NativeSelect>
				<Button onClick={draft.addProvider}>添加 Provider</Button>
				<p role="status" className="text-text-secondary">
					{savedProfile
						? `已保存：${savedProfile.displayName}（${savedProfile.modelProviderId}） · ${savedProfile.credentialSource === "environment" ? "环境变量" : "系统钥匙串"} · ${savedProfile.credentialConfigured ? "凭据已配置（不回显）" : "凭据不可用"}`
						: "新配置，尚未保存"}
					{savedProfile?.credentialStatusMessage ? ` · ${savedProfile.credentialStatusMessage}` : ""}
				</p>
				{apiKey && <p className="text-text-secondary">新密钥待保存</p>}
				{draft.deleteSavedCredential && <p className="text-text-secondary">密钥将在点击 Save 后删除</p>}
				<label className="block">
					Provider ID
					<input
						className={inputClassName}
						value={profile.modelProviderId}
						disabled={Boolean(savedProfile)}
						onChange={(event) => setProfile({ ...profile, modelProviderId: event.target.value })}
					/>
				</label>
				<label className="block">
					显示名称
					<input
						className={inputClassName}
						value={profile.displayName}
						onChange={(event) => setProfile({ ...profile, displayName: event.target.value })}
					/>
				</label>
				<label className="block" htmlFor="notification-intelligence-selection-1">
					服务类型
					<NativeSelect
						id="notification-intelligence-selection-1"
						value={profile.providerProtocol}
						onChange={(event) =>
							setProfile({
								...profile,
								providerProtocol: event.target.value as NotificationProviderProfile["providerProtocol"],
							})
						}
					>
						<option value="openai_compatible">OpenAI 兼容文本模型</option>
						<option value="deepinfra">DeepInfra TTS</option>
						<option value="alibaba">阿里百炼 TTS</option>
					</NativeSelect>
				</label>
				<label className="block" htmlFor="notification-intelligence-selection-2">
					凭据来源
					<NativeSelect
						id="notification-intelligence-selection-2"
						value={profile.credentialSource}
						onChange={(event) => {
							setProfile({
								...profile,
								credentialSource: event.target.value as NotificationProviderProfile["credentialSource"],
							});
							setApiKey("");
						}}
					>
						<option value="environment">环境变量</option>
						<option value="system_credential_store">设置页保存至系统钥匙串</option>
					</NativeSelect>
				</label>
				{profile.credentialSource === "environment" ? (
					<p className="break-all text-text-secondary">
						KANBAN_MODEL_PROVIDER_{profile.modelProviderId.toUpperCase().replaceAll("-", "_")}_API_KEY ·
						修改后需重启运行时
					</p>
				) : (
					<label className="block">
						API Key（留空保留，保存后不回显）
						<input
							type="password"
							autoComplete="new-password"
							className={inputClassName}
							value={apiKey}
							onChange={(event) => setApiKey(event.target.value)}
						/>
					</label>
				)}
				{profile.providerProtocol === "openai_compatible" && (
					<>
						<label className="block">
							Base URL
							<input
								className={inputClassName}
								value={profile.baseUrl ?? ""}
								onChange={(event) => setProfile({ ...profile, baseUrl: event.target.value })}
							/>
						</label>
						<label className="block">
							默认文本模型
							<input
								className={inputClassName}
								value={profile.defaultModelId ?? ""}
								onChange={(event) => setProfile({ ...profile, defaultModelId: event.target.value })}
							/>
						</label>
					</>
				)}
				{profile.providerProtocol === "alibaba" && (
					<>
						<label className="block" htmlFor="notification-intelligence-selection-3">
							凭据地域
							<NativeSelect
								id="notification-intelligence-selection-3"
								value={profile.alibabaRegion}
								onChange={(event) =>
									setProfile({ ...profile, alibabaRegion: event.target.value as "beijing" | "singapore" })
								}
							>
								<option value="beijing">北京</option>
								<option value="singapore">新加坡（仅 Qwen3）</option>
							</NativeSelect>
						</label>
						<label className="block">
							Workspace ID（可选）
							<input
								className={inputClassName}
								value={profile.alibabaWorkspaceId ?? ""}
								onChange={(event) =>
									setProfile({ ...profile, alibabaWorkspaceId: event.target.value || undefined })
								}
							/>
						</label>
					</>
				)}
				{profile.credentialSource === "system_credential_store" && savedProfile && (
					<Button variant="default" onClick={draft.toggleCredentialDeletion}>
						{draft.deleteSavedCredential ? "撤销删除密钥" : "删除已保存密钥（待保存）"}
					</Button>
				)}
			</fieldset>
			<fieldset disabled={busy || disabled} className="space-y-3">
				<legend className="mb-2 font-medium">功能模型与通知</legend>
				{(["taskNameSuggestionBinding", "notificationAssessmentBinding"] as const).map((bindingKey) => (
					<div key={bindingKey} className="space-y-1">
						<label className="block" htmlFor={`notification-intelligence-selection-4-${bindingKey}`}>
							{bindingKey === "taskNameSuggestionBinding" ? "任务起名 provider" : "通知判断与摘要 provider"}
							<NativeSelect
								id={`notification-intelligence-selection-4-${bindingKey}`}
								value={settings[bindingKey]?.modelProviderId ?? ""}
								onChange={(event) =>
									patch({
										[bindingKey]: event.target.value
											? {
													modelProviderId: event.target.value,
													modelId:
														chatProviders.find(
															(candidate) => candidate.modelProviderId === event.target.value,
														)?.defaultModelId ?? "",
												}
											: null,
									})
								}
							>
								<option value="">沿用环境变量默认配置</option>
								{chatProviders.map((candidate) => (
									<option key={candidate.modelProviderId} value={candidate.modelProviderId}>
										{candidate.displayName}
									</option>
								))}
							</NativeSelect>
						</label>
						{settings[bindingKey] && (
							<label className="block">
								模型 ID
								<input
									className={inputClassName}
									value={settings[bindingKey]?.modelId ?? ""}
									onChange={(event) =>
										patch({
											[bindingKey]: {
												modelProviderId: settings[bindingKey]?.modelProviderId ?? "",
												modelId: event.target.value,
											},
										})
									}
								/>
							</label>
						)}
					</div>
				))}
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={settings.assessmentEnabled}
						onChange={(event) => patch({ assessmentEnabled: event.target.checked })}
					/>
					启用 AI 完成判断与摘要（会发送相关任务证据并产生 API 费用）
				</label>
				<label className="block" htmlFor="notification-intelligence-selection-5">
					摘要与播报语言
					<NativeSelect
						id="notification-intelligence-selection-5"
						value={settings.summaryLanguage}
						onChange={(event) =>
							patch({ summaryLanguage: event.target.value as "zh-CN" | "en-US", speechVoice: "" })
						}
					>
						<option value="zh-CN">中文</option>
						<option value="en-US">English</option>
					</NativeSelect>
				</label>
				<label className="block">
					延期兜底（分钟）
					<input
						type="number"
						min={1}
						max={60}
						className={inputClassName}
						value={settings.fallbackAfterMinutes}
						onChange={(event) => patch({ fallbackAfterMinutes: Number(event.target.value) })}
					/>
				</label>
				<label className="block" htmlFor="notification-intelligence-selection-6">
					声音模式
					<NativeSelect
						id="notification-intelligence-selection-6"
						value={settings.speechMode}
						onChange={(event) =>
							patch({ speechMode: event.target.value as NotificationIntelligenceSettings["speechMode"] })
						}
					>
						<option value="off">关闭</option>
						<option value="chime">提示音</option>
						<option value="summary">摘要语音</option>
					</NativeSelect>
				</label>
				{settings.speechMode === "summary" && (
					<>
						<label className="block" htmlFor="notification-intelligence-selection-7">
							语音来源
							<NativeSelect
								id="notification-intelligence-selection-7"
								value={settings.speechProvider}
								onChange={(event) =>
									patch({
										speechProvider: event.target.value as NotificationIntelligenceSettings["speechProvider"],
										notificationSpeechBinding: null,
										speechVoice: "",
										speechStyleInstruction: "",
										speechSpeed: 1,
										speechPitch: 1,
									})
								}
							>
								<option value="browser">浏览器系统语音</option>
								<option value="deepinfra">DeepInfra · BYOK</option>
								<option value="alibaba">阿里百炼 · BYOK</option>
							</NativeSelect>
						</label>
						{settings.speechProvider === "browser" ? (
							<label className="block" htmlFor="notification-intelligence-selection-8">
								本设备音色
								<NativeSelect
									id="notification-intelligence-selection-8"
									value={browserVoiceUri}
									onChange={(event) => {
										setBrowserVoiceUri(event.target.value);
									}}
								>
									<option value="">按语言自动选择</option>
									{voices
										.filter((voice) =>
											voice.lang.toLowerCase().startsWith(settings.summaryLanguage.slice(0, 2)),
										)
										.map((voice) => (
											<option key={voice.voiceURI} value={voice.voiceURI}>
												{voice.name}
												{voice.localService ? " · 本机" : " · 网络"}
											</option>
										))}
								</NativeSelect>
							</label>
						) : (
							<>
								<label className="block" htmlFor="notification-intelligence-selection-9">
									TTS provider 凭据
									<NativeSelect
										id="notification-intelligence-selection-9"
										value={settings.notificationSpeechBinding?.modelProviderId ?? ""}
										onChange={(event) =>
											patch({
												notificationSpeechBinding: {
													modelProviderId: event.target.value,
													modelId: settings.notificationSpeechBinding?.modelId ?? "",
												},
											})
										}
									>
										<option value="">请选择</option>
										{providers
											.filter((candidate) => candidate.providerProtocol === settings.speechProvider)
											.map((candidate) => (
												<option key={candidate.modelProviderId} value={candidate.modelProviderId}>
													{candidate.displayName} · {candidate.alibabaRegion}
												</option>
											))}
									</NativeSelect>
								</label>
								<label className="block" htmlFor="notification-intelligence-selection-10">
									TTS 模型
									<NativeSelect
										id="notification-intelligence-selection-10"
										value={settings.notificationSpeechBinding?.modelId ?? ""}
										onChange={(event) =>
											patch({
												notificationSpeechBinding: {
													modelProviderId: settings.notificationSpeechBinding?.modelProviderId ?? "",
													modelId: event.target.value,
												},
												speechVoice: "",
												speechStyleInstruction: "",
												speechSpeed: 1,
												speechPitch: 1,
											})
										}
									>
										<option value="">请选择</option>
										{models
											.filter((model) => model.provider === settings.speechProvider)
											.map((model) => (
												<option key={model.modelId} value={model.modelId}>
													{model.modelId}
												</option>
											))}
									</NativeSelect>
								</label>
								<label className="block" htmlFor="notification-intelligence-selection-11">
									音色
									<NativeSelect
										id="notification-intelligence-selection-11"
										value={settings.speechVoice}
										onChange={(event) => patch({ speechVoice: event.target.value })}
									>
										<option value="">请选择</option>
										{selectedModel?.voices
											.filter(
												(voice) =>
													settings.speechProvider !== "deepinfra" ||
													voice.startsWith("z") === (settings.summaryLanguage === "zh-CN"),
											)
											.map((voice) => (
												<option key={voice} value={voice}>
													{voice}
												</option>
											))}
									</NativeSelect>
								</label>
							</>
						)}
						{(settings.speechProvider === "browser" || selectedModel?.speed) && (
							<label className="block">
								语速
								<input
									className={inputClassName}
									type="number"
									step={0.1}
									min={settings.speechProvider === "alibaba" ? 0.5 : 0.25}
									max={settings.speechProvider === "alibaba" ? 2 : 4}
									value={settings.speechSpeed}
									onChange={(event) => patch({ speechSpeed: Number(event.target.value) })}
								/>
							</label>
						)}
						{(settings.speechProvider === "browser" || selectedModel?.pitch) && (
							<label className="block">
								音调
								<input
									className={inputClassName}
									type="number"
									step={0.1}
									min={0.5}
									max={2}
									value={settings.speechPitch}
									onChange={(event) => patch({ speechPitch: Number(event.target.value) })}
								/>
							</label>
						)}
						<label className="block">
							音量
							<input
								className={inputClassName}
								type="number"
								step={0.1}
								min={0}
								max={1}
								value={settings.speechVolume}
								onChange={(event) => patch({ speechVolume: Number(event.target.value) })}
							/>
						</label>
						{selectedModel?.instructions && (
							<label className="block">
								风格指令
								<input
									className={inputClassName}
									value={settings.speechStyleInstruction}
									onChange={(event) => patch({ speechStyleInstruction: event.target.value })}
									placeholder="例如：语气平静，清晰简短"
								/>
							</label>
						)}
						<p className="text-text-secondary">
							第三方只接收播报文本；生成音频永久留档。浏览器语音不导出音频。页面关闭或被冻结时不能保证播放。
						</p>
					</>
				)}
				{draft.hasUnsavedChanges && (
					<p className="text-text-secondary">有未保存的修改；请先点击底部 Save，再打开设置试听。</p>
				)}
				<div className="flex gap-2">
					{settings.speechMode === "summary" && (
						<Button
							variant="default"
							disabled={draft.hasUnsavedChanges}
							onClick={() =>
								void run(async () => {
									await playNotificationSummarySpeech({
										settings,
										text:
											settings.summaryLanguage === "zh-CN"
												? "这是一条通知语音试听。"
												: "This is a notification voice preview.",
										preview: true,
									});
								})
							}
						>
							试听已保存设置{settings.speechProvider !== "browser" ? "（产生 API 费用）" : ""}
						</Button>
					)}
				</div>
			</fieldset>
			{notice && (
				<p role="status" className="text-text-secondary">
					{notice}
				</p>
			)}
		</section>
	);
}
