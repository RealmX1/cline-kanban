import { describe, expect, it } from "vitest";
import {
	describeNotificationIntelligencePurposeBindingProblem,
	findNotificationIntelligencePurposeBindingProblems,
	listNewlyIntroducedNotificationIntelligencePurposeBindingProblems,
} from "../../src/core/notification-intelligence-purpose-binding-problems";
import { notificationIntelligenceSettingsSchema } from "../../src/core/notification-intelligence-settings-contract";

const openaiCompatibleTextProfile = {
	modelProviderId: "text-provider",
	providerProtocol: "openai_compatible" as const,
	baseUrl: "https://example.invalid",
};
const alibabaSpeechProfile = { modelProviderId: "alibaba-speech", providerProtocol: "alibaba" as const };

describe("通知智能用途绑定的引用完整性判定", () => {
	it("文本用途必须绑定存在、OpenAI 兼容且带 Base URL 的档案", () => {
		const settings = notificationIntelligenceSettingsSchema.parse({
			taskNameSuggestionBinding: { modelProviderId: "alibaba-speech", modelId: "m" },
			notificationAssessmentBinding: { modelProviderId: "missing-provider", modelId: "m" },
		});
		const problems = findNotificationIntelligencePurposeBindingProblems(settings, [
			openaiCompatibleTextProfile,
			alibabaSpeechProfile,
		]);
		expect(problems.map((problem) => [problem.purposeBindingKey, problem.problemKind])).toEqual([
			["taskNameSuggestionBinding", "text_purpose_provider_not_openai_compatible"],
			["notificationAssessmentBinding", "text_purpose_provider_not_found"],
		]);
		expect(describeNotificationIntelligencePurposeBindingProblem(problems[0])).toBe(
			"「任务起名」绑定的 provider alibaba-speech 服务类型为阿里百炼 TTS，需为 OpenAI 兼容文本模型",
		);
		expect(
			findNotificationIntelligencePurposeBindingProblems(
				notificationIntelligenceSettingsSchema.parse({
					taskNameSuggestionBinding: { modelProviderId: "text-provider", modelId: "m" },
				}),
				[{ ...openaiCompatibleTextProfile, baseUrl: undefined }],
			)[0]?.problemKind,
		).toBe("text_purpose_provider_missing_base_url");
	});
	it("语音绑定只在摘要语音且使用第三方来源时校验服务类型一致", () => {
		const speechBinding = { modelProviderId: "alibaba-speech", modelId: "hexgrad/Kokoro-82M" };
		const mismatched = notificationIntelligenceSettingsSchema.parse({
			speechMode: "summary",
			speechProvider: "deepinfra",
			notificationSpeechBinding: speechBinding,
		});
		expect(findNotificationIntelligencePurposeBindingProblems(mismatched, [alibabaSpeechProfile])).toEqual([
			{
				purposeBindingKey: "notificationSpeechBinding",
				modelProviderId: "alibaba-speech",
				problemKind: "speech_purpose_provider_protocol_mismatch",
				boundProviderProtocol: "alibaba",
			},
		]);
		for (const inactive of [
			{ ...mismatched, speechMode: "chime" as const },
			{ ...mismatched, speechProvider: "browser" as const },
		])
			expect(findNotificationIntelligencePurposeBindingProblems(inactive, [alibabaSpeechProfile])).toEqual([]);
	});
	it("只把本次新出现的问题视为新引入，已落盘的历史问题不计入", () => {
		const brokenTextBinding = findNotificationIntelligencePurposeBindingProblems(
			notificationIntelligenceSettingsSchema.parse({
				taskNameSuggestionBinding: { modelProviderId: "alibaba-speech", modelId: "m" },
			}),
			[alibabaSpeechProfile],
		);
		const brokenBothBindings = findNotificationIntelligencePurposeBindingProblems(
			notificationIntelligenceSettingsSchema.parse({
				taskNameSuggestionBinding: { modelProviderId: "alibaba-speech", modelId: "m" },
				notificationAssessmentBinding: { modelProviderId: "alibaba-speech", modelId: "m" },
			}),
			[alibabaSpeechProfile],
		);
		expect(
			listNewlyIntroducedNotificationIntelligencePurposeBindingProblems(brokenTextBinding, brokenTextBinding),
		).toEqual([]);
		expect(
			listNewlyIntroducedNotificationIntelligencePurposeBindingProblems(brokenTextBinding, brokenBothBindings).map(
				(problem) => problem.purposeBindingKey,
			),
		).toEqual(["notificationAssessmentBinding"]);
	});
});
