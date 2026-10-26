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
	it("历史起名绑定继续读取，但档案缺失、协议变化或缺少 Base URL 均不产生用途问题", () => {
		const legacyBinding = { modelProviderId: "text-provider", modelId: "legacy-name-model" };
		const settings = notificationIntelligenceSettingsSchema.parse({ taskNameSuggestionBinding: legacyBinding });
		expect(settings.taskNameSuggestionBinding).toEqual(legacyBinding);
		for (const profiles of [
			[],
			[{ ...openaiCompatibleTextProfile, providerProtocol: "alibaba" as const }],
			[{ ...openaiCompatibleTextProfile, baseUrl: undefined }],
		])
			expect(findNotificationIntelligencePurposeBindingProblems(settings, profiles)).toEqual([]);
	});
	it.each(["notificationAssessmentBinding", "independentTaskCreationDraftGenerationBinding"] as const)(
		"活动文本用途 %s 必须绑定存在、OpenAI 兼容且带 Base URL 的档案",
		(bindingKey) => {
			const settings = notificationIntelligenceSettingsSchema.parse({
				[bindingKey]: { modelProviderId: "alibaba-speech", modelId: "m" },
			});
			const problems = findNotificationIntelligencePurposeBindingProblems(settings, [alibabaSpeechProfile]);
			expect(problems.map((problem) => [problem.purposeBindingKey, problem.problemKind])).toEqual([
				[bindingKey, "text_purpose_provider_not_openai_compatible"],
			]);
			const purpose = bindingKey === "notificationAssessmentBinding" ? "通知判断与摘要" : "分出独立任务草稿";
			expect(describeNotificationIntelligencePurposeBindingProblem(problems[0])).toBe(
				`「${purpose}」绑定的 provider alibaba-speech 服务类型为阿里百炼 TTS，需为 OpenAI 兼容文本模型`,
			);
			expect(findNotificationIntelligencePurposeBindingProblems(settings, [])[0]?.problemKind).toBe(
				"text_purpose_provider_not_found",
			);
			const textSettings = notificationIntelligenceSettingsSchema.parse({
				[bindingKey]: { modelProviderId: "text-provider", modelId: "m" },
			});
			expect(
				findNotificationIntelligencePurposeBindingProblems(textSettings, [
					{ ...openaiCompatibleTextProfile, baseUrl: undefined },
				])[0]?.problemKind,
			).toBe("text_purpose_provider_missing_base_url");
			expect(
				findNotificationIntelligencePurposeBindingProblems(textSettings, [openaiCompatibleTextProfile]),
			).toEqual([]);
		},
	);
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
				notificationAssessmentBinding: { modelProviderId: "alibaba-speech", modelId: "m" },
			}),
			[alibabaSpeechProfile],
		);
		const brokenBothBindings = findNotificationIntelligencePurposeBindingProblems(
			notificationIntelligenceSettingsSchema.parse({
				notificationAssessmentBinding: { modelProviderId: "alibaba-speech", modelId: "m" },
				independentTaskCreationDraftGenerationBinding: { modelProviderId: "alibaba-speech", modelId: "m" },
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
		).toEqual(["independentTaskCreationDraftGenerationBinding"]);
	});
});
