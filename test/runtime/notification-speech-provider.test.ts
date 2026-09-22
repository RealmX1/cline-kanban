import { describe, expect, it } from "vitest";
import { notificationIntelligenceSettingsSchema } from "../../src/core/notification-intelligence-settings-contract";
import { buildNotificationSpeechProviderRequest } from "../../src/notifications/notification-speech-synthesis";

describe("第三方语音协议", () => {
	it("Kokoro 使用中文音色；Qwen-Audio 与 Qwen3 不混用接口与字段", () => {
		const settings = notificationIntelligenceSettingsSchema.parse({
			speechProvider: "deepinfra",
			speechVoice: "zf_xiaobei",
			notificationSpeechBinding: { modelProviderId: "deepinfra", modelId: "hexgrad/Kokoro-82M" },
		});
		const profile = {
			modelProviderId: "deepinfra",
			displayName: "DeepInfra",
			credentialSource: "environment" as const,
			providerProtocol: "deepinfra" as const,
			alibabaRegion: "beijing" as const,
		};
		expect(buildNotificationSpeechProviderRequest(settings, profile, "任务完成").body).toMatchObject({
			preset_voice: ["zf_xiaobei"],
			text: "任务完成",
			stream: false,
		});
		const alibaba = { ...profile, providerProtocol: "alibaba" as const };
		const audio = buildNotificationSpeechProviderRequest(
			{
				...settings,
				speechProvider: "alibaba",
				speechVoice: "longanlingxin",
				notificationSpeechBinding: { modelProviderId: "alibaba", modelId: "qwen-audio-3.0-tts-plus" },
			},
			alibaba,
			"任务完成",
		);
		expect(audio.url).toContain("/audio/tts/SpeechSynthesizer");
		expect(audio.body).toMatchObject({ input: { language_hints: ["zh"] } });
		const qwen3 = buildNotificationSpeechProviderRequest(
			{
				...settings,
				speechProvider: "alibaba",
				speechVoice: "Cherry",
				notificationSpeechBinding: { modelProviderId: "alibaba", modelId: "qwen3-tts-instruct-flash" },
				speechStyleInstruction: "平静",
			},
			alibaba,
			"任务完成",
		);
		expect(qwen3.url).toContain("/multimodal-generation/generation");
		expect(qwen3.body).toMatchObject({ input: { language_type: "Chinese", instructions: "平静" } });
		expect(() =>
			buildNotificationSpeechProviderRequest({ ...settings, summaryLanguage: "en-US" }, profile, "done"),
		).toThrow(/音色/u);
	});
});
