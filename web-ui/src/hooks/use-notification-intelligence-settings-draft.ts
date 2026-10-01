import {
	describeNotificationIntelligencePurposeBindingProblem,
	findNotificationIntelligencePurposeBindingProblems,
	listNewlyIntroducedNotificationIntelligencePurposeBindingProblems,
} from "@runtime-notification-intelligence-purpose-binding-problems";
import { useEffect, useState } from "react";
import {
	type NotificationIntelligenceSettings,
	type NotificationProviderProfile,
	notificationIntelligenceClient,
} from "@/runtime/notification-intelligence-query";

const emptyProvider: NotificationProviderProfile = {
	modelProviderId: "deepinfra",
	displayName: "DeepInfra",
	providerProtocol: "deepinfra",
	credentialSource: "system_credential_store",
	alibabaRegion: "beijing",
	credentialConfigured: false,
	credentialStatusMessage: null,
};
const browserVoiceStorageKey = "kanban-notification-browser-voice-uri";
type ProviderDraft = {
	profile: NotificationProviderProfile;
	savedProfile?: NotificationProviderProfile;
	apiKey: string;
	deleteSavedCredential: boolean;
	changed: boolean;
};
const providerDraft = (profile: NotificationProviderProfile, saved = true): ProviderDraft => ({
	profile,
	savedProfile: saved ? profile : undefined,
	apiKey: "",
	deleteSavedCredential: false,
	changed: false,
});

export function useNotificationIntelligenceSettingsDraft(open: boolean) {
	const [settings, setSettings] = useState<NotificationIntelligenceSettings | null>(null);
	const [savedSettings, setSavedSettings] = useState<NotificationIntelligenceSettings | null>(null);
	const [providerDrafts, setProviderDrafts] = useState<ProviderDraft[]>([]);
	const [browserVoiceUri, setBrowserVoiceUri] = useState("");
	const [savedBrowserVoiceUri, setSavedBrowserVoiceUri] = useState("");
	const [loadError, setLoadError] = useState("");
	useEffect(() => {
		setSettings(null);
		setSavedSettings(null);
		setProviderDrafts([]);
		setLoadError("");
		if (!open) return;
		let cancelled = false;
		const voice = localStorage.getItem(browserVoiceStorageKey) ?? "";
		setBrowserVoiceUri(voice);
		setSavedBrowserVoiceUri(voice);
		void notificationIntelligenceClient()
			.getSettings.query()
			.then((result) => {
				if (cancelled) return;
				setSettings(result.settings);
				setSavedSettings(result.settings);
				setProviderDrafts(result.providers.map((profile) => providerDraft(profile)));
			})
			.catch(() => {
				if (!cancelled) setLoadError("无法读取 AI 与语音设置，请关闭设置后重试");
			});
		return () => {
			cancelled = true;
		};
	}, [open]);
	function updateProvider(providerIndex: number, value: Partial<ProviderDraft>) {
		setProviderDrafts((current) =>
			current.map((draft, index) => (index === providerIndex ? { ...draft, ...value, changed: true } : draft)),
		);
	}
	const hasUnsavedChanges =
		providerDrafts.some((draft) => draft.changed) ||
		JSON.stringify(settings) !== JSON.stringify(savedSettings) ||
		browserVoiceUri !== savedBrowserVoiceUri;
	const purposeBindingProblems = settings
		? findNotificationIntelligencePurposeBindingProblems(
				settings,
				providerDrafts.map((draft) => draft.profile),
			)
		: [];
	async function save() {
		if (!hasUnsavedChanges) return;
		if (!settings) throw new Error(loadError || "AI 与语音设置仍在加载");
		// 写入前校验草稿的最终状态：只拦本次新引入的绑定问题，否则会先写 provider、再被 settings 校验拒绝而半保存。
		const newlyIntroducedPurposeBindingProblems = listNewlyIntroducedNotificationIntelligencePurposeBindingProblems(
			savedSettings
				? findNotificationIntelligencePurposeBindingProblems(
						savedSettings,
						providerDrafts.flatMap((draft) => (draft.savedProfile ? [draft.savedProfile] : [])),
					)
				: [],
			purposeBindingProblems,
		);
		if (newlyIntroducedPurposeBindingProblems.length > 0)
			throw new Error(
				newlyIntroducedPurposeBindingProblems.map(describeNotificationIntelligencePurposeBindingProblem).join("；"),
			);
		const boundProviderIds = [
			settings.taskNameSuggestionBinding,
			settings.notificationAssessmentBinding,
			settings.notificationSpeechBinding,
		].map((binding) => binding?.modelProviderId);
		const changedProviders = providerDrafts.filter(
			(draft) => draft.changed || (!draft.savedProfile && boundProviderIds.includes(draft.profile.modelProviderId)),
		);
		const providerIds = providerDrafts
			.filter((draft) => draft.changed || draft.savedProfile)
			.map((draft) => draft.profile.modelProviderId);
		if (new Set(providerIds).size !== providerIds.length) throw new Error("Provider ID 重复，请使用不同的 ID");
		// 先保存凭据，再保存引用它的用途绑定；失败保留草稿，允许重试。
		for (const draft of changedProviders) {
			await notificationIntelligenceClient().saveProvider.mutate({
				profile: { ...draft.profile, baseUrl: draft.profile.baseUrl || undefined },
				apiKey: draft.apiKey.trim() || undefined,
				deleteSavedCredential: draft.deleteSavedCredential || undefined,
			});
		}
		if (JSON.stringify(settings) !== JSON.stringify(savedSettings))
			await notificationIntelligenceClient().saveSettings.mutate(settings);
		if (browserVoiceUri !== savedBrowserVoiceUri) localStorage.setItem(browserVoiceStorageKey, browserVoiceUri);
		const refreshed = await notificationIntelligenceClient().getSettings.query();
		setProviderDrafts((current) =>
			current.map((draft) => {
				const saved = refreshed.providers.find(
					(profile) => profile.modelProviderId === draft.profile.modelProviderId,
				);
				return saved ? providerDraft(saved) : draft;
			}),
		);
		setSavedSettings(settings);
		setSavedBrowserVoiceUri(browserVoiceUri);
	}
	return {
		settings,
		setSettings,
		savedSettings,
		loadError,
		hasUnsavedChanges,
		purposeBindingProblems,
		save,
		providers: providerDrafts.map((draft) => draft.profile),
		getProviderEditor: (providerIndex: number) => {
			const selectedProviderDraft = providerDrafts[providerIndex];
			if (!selectedProviderDraft) return null;
			return {
				profile: selectedProviderDraft.profile,
				savedProfile: selectedProviderDraft.savedProfile,
				apiKey: selectedProviderDraft.apiKey,
				deleteSavedCredential: selectedProviderDraft.deleteSavedCredential,
				setProfile: (profile: NotificationProviderProfile) => {
					const previousId = selectedProviderDraft.profile.modelProviderId;
					if (previousId !== profile.modelProviderId)
						setSettings((current) => {
							if (!current) return current;
							const next = { ...current };
							for (const key of [
								"taskNameSuggestionBinding",
								"notificationAssessmentBinding",
								"notificationSpeechBinding",
							] as const) {
								const binding = current[key];
								if (binding && binding.modelProviderId === previousId)
									next[key] = { ...binding, modelProviderId: profile.modelProviderId };
							}
							return next;
						});
					updateProvider(providerIndex, { profile });
				},
				setApiKey: (apiKey: string) => updateProvider(providerIndex, { apiKey, deleteSavedCredential: false }),
				toggleCredentialDeletion: () =>
					updateProvider(providerIndex, {
						apiKey: "",
						deleteSavedCredential: !selectedProviderDraft.deleteSavedCredential,
					}),
			};
		},
		addProvider: (providerProtocol: NotificationProviderProfile["providerProtocol"]) => {
			// 自动 id 也要避开用途绑定引用的 id：撞上悬空绑定会把历史 not_found 问题变成「新引入」而锁死保存。
			const occupiedProviderIds = new Set([
				...providerDrafts.map((draft) => draft.profile.modelProviderId),
				...[settings, savedSettings].flatMap((candidate) =>
					candidate
						? [
								candidate.taskNameSuggestionBinding,
								candidate.notificationAssessmentBinding,
								candidate.notificationSpeechBinding,
							].flatMap((binding) => (binding ? [binding.modelProviderId] : []))
						: [],
				),
			]);
			let suffix = providerDrafts.length + 1;
			while (occupiedProviderIds.has(`provider-${suffix}`)) suffix++;
			setProviderDrafts((current) => [
				...current,
				providerDraft(
					{
						...emptyProvider,
						providerProtocol,
						modelProviderId: `provider-${suffix}`,
						displayName: providerProtocol === "openai_compatible" ? "新语言模型服务" : "新语音服务",
					},
					false,
				),
			]);
			return providerDrafts.length;
		},
		browserVoiceUri,
		setBrowserVoiceUri,
	};
}
