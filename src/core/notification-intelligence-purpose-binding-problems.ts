// 用途绑定与 provider 档案之间的引用完整性判定。服务端保存校验、设置页写入前校验与失效提示共用这一处，
// 且只把「本次新引入」的问题当作拒绝理由：已落盘的历史坏绑定只提示，不能锁死其它字段的保存。
import type {
	KanbanModelProviderProfile,
	NotificationIntelligenceSettings,
} from "./notification-intelligence-settings-contract";

export type NotificationIntelligencePurposeBindingKey =
	| "taskNameSuggestionBinding"
	| "notificationAssessmentBinding"
	| "notificationSpeechBinding";

export type NotificationIntelligencePurposeBindingProblemKind =
	| "text_purpose_provider_not_found"
	| "text_purpose_provider_not_openai_compatible"
	| "text_purpose_provider_missing_base_url"
	| "speech_purpose_provider_not_found"
	| "speech_purpose_provider_protocol_mismatch";

export type NotificationIntelligencePurposeBindingProblem = {
	purposeBindingKey: NotificationIntelligencePurposeBindingKey;
	modelProviderId: string;
	problemKind: NotificationIntelligencePurposeBindingProblemKind;
	boundProviderProtocol: KanbanModelProviderProfile["providerProtocol"] | null;
};

type ProviderProfileFieldsRelevantToPurposeBinding = {
	modelProviderId: string;
	providerProtocol: KanbanModelProviderProfile["providerProtocol"];
	baseUrl?: string | null;
};

type SettingsFieldsRelevantToPurposeBinding = Pick<
	NotificationIntelligenceSettings,
	| "taskNameSuggestionBinding"
	| "notificationAssessmentBinding"
	| "notificationSpeechBinding"
	| "speechMode"
	| "speechProvider"
>;

const TEXT_PURPOSE_BINDING_KEYS = ["taskNameSuggestionBinding", "notificationAssessmentBinding"] as const;

const PURPOSE_BINDING_DISPLAY_NAMES: Record<NotificationIntelligencePurposeBindingKey, string> = {
	taskNameSuggestionBinding: "任务起名",
	notificationAssessmentBinding: "通知判断与摘要",
	notificationSpeechBinding: "语音合成",
};

export const PROVIDER_PROTOCOL_DISPLAY_NAMES: Record<KanbanModelProviderProfile["providerProtocol"], string> = {
	openai_compatible: "OpenAI 兼容文本模型",
	deepinfra: "DeepInfra TTS",
	alibaba: "阿里百炼 TTS",
};

export function findNotificationIntelligencePurposeBindingProblems(
	settings: SettingsFieldsRelevantToPurposeBinding,
	profiles: readonly ProviderProfileFieldsRelevantToPurposeBinding[],
): NotificationIntelligencePurposeBindingProblem[] {
	const problems: NotificationIntelligencePurposeBindingProblem[] = [];
	for (const purposeBindingKey of TEXT_PURPOSE_BINDING_KEYS) {
		const binding = settings[purposeBindingKey];
		if (!binding) continue;
		const profile = profiles.find((candidate) => candidate.modelProviderId === binding.modelProviderId);
		const problemKind: NotificationIntelligencePurposeBindingProblemKind | null = !profile
			? "text_purpose_provider_not_found"
			: profile.providerProtocol !== "openai_compatible"
				? "text_purpose_provider_not_openai_compatible"
				: !profile.baseUrl
					? "text_purpose_provider_missing_base_url"
					: null;
		if (problemKind)
			problems.push({
				purposeBindingKey,
				modelProviderId: binding.modelProviderId,
				problemKind,
				boundProviderProtocol: profile?.providerProtocol ?? null,
			});
	}
	const speechBinding = settings.notificationSpeechBinding;
	if (settings.speechMode === "summary" && settings.speechProvider !== "browser" && speechBinding?.modelProviderId) {
		const profile = profiles.find((candidate) => candidate.modelProviderId === speechBinding.modelProviderId);
		const problemKind: NotificationIntelligencePurposeBindingProblemKind | null = !profile
			? "speech_purpose_provider_not_found"
			: profile.providerProtocol !== settings.speechProvider
				? "speech_purpose_provider_protocol_mismatch"
				: null;
		if (problemKind)
			problems.push({
				purposeBindingKey: "notificationSpeechBinding",
				modelProviderId: speechBinding.modelProviderId,
				problemKind,
				boundProviderProtocol: profile?.providerProtocol ?? null,
			});
	}
	return problems;
}

function purposeBindingProblemIdentity(problem: NotificationIntelligencePurposeBindingProblem): string {
	return [problem.purposeBindingKey, problem.modelProviderId, problem.problemKind].join("\u0000");
}

export function listNewlyIntroducedNotificationIntelligencePurposeBindingProblems(
	previouslyPersistedProblems: readonly NotificationIntelligencePurposeBindingProblem[],
	problemsAfterChange: readonly NotificationIntelligencePurposeBindingProblem[],
): NotificationIntelligencePurposeBindingProblem[] {
	const previouslyPersistedIdentities = new Set(previouslyPersistedProblems.map(purposeBindingProblemIdentity));
	return problemsAfterChange.filter(
		(problem) => !previouslyPersistedIdentities.has(purposeBindingProblemIdentity(problem)),
	);
}

export function describeNotificationIntelligencePurposeBindingProblem(
	problem: NotificationIntelligencePurposeBindingProblem,
): string {
	const purpose = `「${PURPOSE_BINDING_DISPLAY_NAMES[problem.purposeBindingKey]}」绑定的 provider ${problem.modelProviderId}`;
	const boundProtocol = problem.boundProviderProtocol
		? PROVIDER_PROTOCOL_DISPLAY_NAMES[problem.boundProviderProtocol]
		: "未知";
	switch (problem.problemKind) {
		case "text_purpose_provider_not_found":
		case "speech_purpose_provider_not_found":
			return `${purpose} 不存在或未配置`;
		case "text_purpose_provider_not_openai_compatible":
			return `${purpose} 服务类型为${boundProtocol}，需为 OpenAI 兼容文本模型`;
		case "text_purpose_provider_missing_base_url":
			return `${purpose} 缺少 Base URL`;
		case "speech_purpose_provider_protocol_mismatch":
			return `${purpose} 服务类型为${boundProtocol}，与所选语音来源不一致`;
	}
}
