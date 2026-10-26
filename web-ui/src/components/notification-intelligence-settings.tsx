import {
	describeNotificationIntelligencePurposeBindingProblem,
	type NotificationIntelligencePurposeBindingProblem,
} from "@runtime-notification-intelligence-purpose-binding-problems";
import { useEffect, useId, useState } from "react";
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

type NotificationSettingsDraft = ReturnType<typeof useNotificationIntelligenceSettingsDraft>;
function NotificationProviderCredentialsEditor({
	draft,
	category,
	disabled,
}: {
	draft: NotificationSettingsDraft;
	category: "language_model" | "speech";
	disabled: boolean;
}) {
	const providerEditorId = useId();
	const [selectedProviderIndex, setSelectedProviderIndex] = useState<number | null>(null);
	const providerCategoryLabel = category === "language_model" ? "语言模型" : "TTS";
	const matchingProviders = draft.providers
		.map((profile, index) => ({ profile, index }))
		.filter(({ profile }) => (profile.providerProtocol === "openai_compatible") === (category === "language_model"));
	const boundProviderId =
		category === "language_model"
			? (draft.savedSettings?.notificationAssessmentBinding?.modelProviderId ??
				draft.savedSettings?.taskNameSuggestionBinding?.modelProviderId)
			: draft.savedSettings?.notificationSpeechBinding?.modelProviderId;
	const providerIndex =
		matchingProviders.find((candidate) => candidate.index === selectedProviderIndex)?.index ??
		matchingProviders.find((candidate) => candidate.profile.modelProviderId === boundProviderId)?.index ??
		matchingProviders[0]?.index;
	const editor = providerIndex === undefined ? null : draft.getProviderEditor(providerIndex);
	const profile = editor?.profile;
	const savedProfile = editor?.savedProfile;
	const apiKey = editor?.apiKey ?? "";
	const setProfile = (profile: NotificationProviderProfile) => editor?.setProfile(profile);
	const setApiKey = (value: string) => editor?.setApiKey(value);
	return (
		<fieldset disabled={disabled} className="space-y-3">
			<legend className="mb-2 font-medium">{providerCategoryLabel} Provider 凭据</legend>
			<NativeSelect
				aria-label={`编辑${providerCategoryLabel} provider`}
				value={providerIndex ?? ""}
				onChange={(event) => setSelectedProviderIndex(Number(event.target.value))}
			>
				{providerIndex === undefined && <option value="">尚未配置{providerCategoryLabel} Provider</option>}
				{matchingProviders.map(({ profile, index }) => (
					<option key={index} value={index}>
						{profile.displayName} · {profile.modelProviderId}
					</option>
				))}
			</NativeSelect>
			<Button
				onClick={() =>
					setSelectedProviderIndex(
						draft.addProvider(category === "language_model" ? "openai_compatible" : "deepinfra"),
					)
				}
			>
				添加{providerCategoryLabel} Provider
			</Button>
			{!editor || !profile ? (
				<p className="text-text-secondary">
					{category === "language_model"
						? "可添加 OpenAI 兼容服务，用于任务起名、通知判断与摘要。"
						: "浏览器系统语音无需凭据；使用 DeepInfra 或阿里百炼时，在这里添加 TTS 凭据。"}
				</p>
			) : (
				<>
					<p role="status" className="text-text-secondary">
						{savedProfile
							? `已保存：${savedProfile.displayName}（${savedProfile.modelProviderId}） · ${savedProfile.credentialSource === "environment" ? "环境变量" : "系统钥匙串"} · ${savedProfile.credentialConfigured ? "凭据已配置（不回显）" : "凭据不可用"}`
							: "新配置，尚未保存"}
						{savedProfile?.credentialStatusMessage ? ` · ${savedProfile.credentialStatusMessage}` : ""}
					</p>
					{apiKey && <p className="text-text-secondary">新密钥待保存</p>}
					{editor.deleteSavedCredential && <p className="text-text-secondary">密钥将在点击 Save 后删除</p>}
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
					{category === "speech" ? (
						<label className="block" htmlFor={`${providerEditorId}-protocol`}>
							服务类型
							<NativeSelect
								id={`${providerEditorId}-protocol`}
								value={profile.providerProtocol}
								onChange={(event) =>
									setProfile({
										...profile,
										providerProtocol: event.target.value as NotificationProviderProfile["providerProtocol"],
									})
								}
							>
								<option value="deepinfra">DeepInfra TTS</option>
								<option value="alibaba">阿里百炼 TTS</option>
							</NativeSelect>
						</label>
					) : (
						<p className="text-text-secondary">接口类型：OpenAI 兼容文本模型</p>
					)}
					<PurposeBindingProblemAlerts
						problems={draft.purposeBindingProblems.filter(
							(problem) => problem.modelProviderId === profile.modelProviderId,
						)}
					/>
					<label className="block" htmlFor={`${providerEditorId}-credential-source`}>
						凭据来源
						<NativeSelect
							id={`${providerEditorId}-credential-source`}
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
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={
										profile.supportsImageInput ?? /^MiniMax-M3(?:\.|$)/iu.test(profile.defaultModelId ?? "")
									}
									onChange={(event) => setProfile({ ...profile, supportsImageInput: event.target.checked })}
								/>
								支持查卡图片输入
							</label>
						</>
					)}
					{profile.providerProtocol === "alibaba" && (
						<>
							<label className="block" htmlFor={`${providerEditorId}-region`}>
								凭据地域
								<NativeSelect
									id={`${providerEditorId}-region`}
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
						<Button variant="default" onClick={editor.toggleCredentialDeletion}>
							{editor.deleteSavedCredential ? "撤销删除密钥" : "删除已保存密钥（待保存）"}
						</Button>
					)}
				</>
			)}
		</fieldset>
	);
}

function PurposeBindingProblemAlerts({ problems }: { problems: NotificationIntelligencePurposeBindingProblem[] }) {
	return problems.map((problem) => (
		<p
			key={`${problem.purposeBindingKey}-${problem.modelProviderId}-${problem.problemKind}`}
			role="alert"
			className="text-status-orange"
		>
			{describeNotificationIntelligencePurposeBindingProblem(problem)}
		</p>
	));
}
export function NotificationIntelligenceSettingsSection({
	draft,
	disabled,
}: {
	draft: ReturnType<typeof useNotificationIntelligenceSettingsDraft>;
	disabled: boolean;
}) {
	const { settings, setSettings, providers, browserVoiceUri, setBrowserVoiceUri, purposeBindingProblems } = draft;
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
		<section aria-label="AI 与语音设置" className="mb-4 space-y-5 text-sm">
			<h3 className="font-semibold">智能通知与语音</h3>
			<p className="text-text-secondary">
				所有修改统一由底部 Save 保存；Cancel 放弃本次修改。密钥不回显，凭据来源不会自动切换。
			</p>

			<label className="block" htmlFor="notification-intelligence-selection-5">
				摘要与播报语言
				<NativeSelect
					id="notification-intelligence-selection-5"
					disabled={busy || disabled}
					value={settings.summaryLanguage}
					onChange={(event) =>
						patch({ summaryLanguage: event.target.value as "zh-CN" | "en-US", speechVoice: "" })
					}
				>
					<option value="zh-CN">中文</option>
					<option value="en-US">English</option>
				</NativeSelect>
			</label>
			<fieldset disabled={busy || disabled} className="space-y-4 rounded-lg border border-border bg-surface-0 p-4">
				<legend className="px-1 text-base font-semibold">语言模型</legend>
				<p className="text-text-secondary">生成文本：任务起名、通知完成判断与摘要。</p>
				<NotificationProviderCredentialsEditor
					draft={draft}
					category="language_model"
					disabled={busy || disabled}
				/>
				<h4 className="border-t border-border pt-4 font-medium">语言模型用途</h4>
				{(["notificationAssessmentBinding", "independentTaskCreationDraftGenerationBinding"] as const).map(
					(bindingKey) => (
						<div key={bindingKey} className="space-y-1">
							<label className="block" htmlFor={`notification-intelligence-selection-4-${bindingKey}`}>
								{bindingKey === "independentTaskCreationDraftGenerationBinding"
									? "分出独立任务 provider"
									: "通知判断与摘要 provider"}
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
									{/* 失效的当前绑定必须照实显示，不能落到空值选项上伪装成「沿用环境变量默认配置」。 */}
									{settings[bindingKey] &&
										!chatProviders.some(
											(candidate) => candidate.modelProviderId === settings[bindingKey]?.modelProviderId,
										) && (
											<option value={settings[bindingKey].modelProviderId}>
												{settings[bindingKey].modelProviderId}（已失效）
											</option>
										)}
								</NativeSelect>
							</label>
							<PurposeBindingProblemAlerts
								problems={purposeBindingProblems.filter((problem) => problem.purposeBindingKey === bindingKey)}
							/>
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
					),
				)}
				<label className="flex items-center gap-2">
					<input
						type="checkbox"
						checked={settings.assessmentEnabled}
						onChange={(event) => patch({ assessmentEnabled: event.target.checked })}
					/>
					启用 AI 完成判断与摘要（会发送相关任务证据并产生 API 费用）
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
			</fieldset>
			<fieldset disabled={busy || disabled} className="space-y-4 rounded-lg border border-border bg-surface-0 p-4">
				<legend className="px-1 text-base font-semibold">语音合成 TTS</legend>
				<p className="text-text-secondary">
					将通知摘要朗读为音频。浏览器系统语音无需 API Key；第三方语音使用独立的 TTS Provider 配置。
				</p>
				<NotificationProviderCredentialsEditor draft={draft} category="speech" disabled={busy || disabled} />
				<h4 className="border-t border-border pt-4 font-medium">播报设置</h4>
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
										{settings.notificationSpeechBinding?.modelProviderId &&
											!providers.some(
												(candidate) =>
													candidate.providerProtocol === settings.speechProvider &&
													candidate.modelProviderId ===
														settings.notificationSpeechBinding?.modelProviderId,
											) && (
												<option value={settings.notificationSpeechBinding.modelProviderId}>
													{settings.notificationSpeechBinding.modelProviderId}（已失效）
												</option>
											)}
									</NativeSelect>
								</label>
								<PurposeBindingProblemAlerts
									problems={purposeBindingProblems.filter(
										(problem) => problem.purposeBindingKey === "notificationSpeechBinding",
									)}
								/>
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
													{model.isRecommendedForCodingAgentNotificationSpeech ? "（推荐）" : ""}
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
										// 浏览器系统语音试听也按「先导 → 停顿 → 正文」播放；第三方 TTS 的试听脚本由服务端组装。
										announcementScript:
											settings.summaryLanguage === "zh-CN"
												? {
														leadInText: "项目 示例项目，任务：语音试听。",
														bodyText: "这是一条通知语音试听，先导和正文之间会停顿一下。",
													}
												: {
														leadInText: "Project demo project, task: voice preview.",
														bodyText:
															"This is a notification voice preview, with a short pause after the lead-in.",
													},
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
