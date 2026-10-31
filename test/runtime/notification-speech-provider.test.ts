import { describe, expect, it } from "vitest";
import {
	type KanbanModelProviderProfile,
	notificationIntelligenceSettingsSchema,
} from "../../src/core/notification-intelligence-settings-contract";
import { NOTIFICATION_SPEECH_MODEL_CATALOG } from "../../src/notifications/notification-speech-provider-catalog";
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
		// 先导与正文要按 PCM 拼接插入停顿，所有 provider 一律请求 WAV。
		expect(buildNotificationSpeechProviderRequest(settings, profile, "任务完成").body).toMatchObject({
			preset_voice: ["zf_xiaobei"],
			text: "任务完成",
			output_format: "wav",
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
		expect(audio.body).toMatchObject({ input: { language_hints: ["zh"], format: "wav" } });
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

describe("Qwen-Audio 3.1 Plus 通知语音", () => {
	const settings = notificationIntelligenceSettingsSchema.parse({
		speechProvider: "alibaba",
		speechVoice: "longanlingxin_v3.1",
		notificationSpeechBinding: { modelProviderId: "alibaba", modelId: "qwen-audio-3.1-tts-plus" },
		speechSpeed: 1.1,
		speechPitch: 0.9,
		speechStyleInstruction: "平静自然",
	});
	const profile: KanbanModelProviderProfile = {
		modelProviderId: "alibaba",
		displayName: "阿里百炼",
		credentialSource: "environment",
		providerProtocol: "alibaba",
		alibabaRegion: "beijing",
	};

	it("目录推荐 3.1 Plus，并保留现有模型", () => {
		expect(
			NOTIFICATION_SPEECH_MODEL_CATALOG.filter((model) => model.isRecommendedForCodingAgentNotificationSpeech).map(
				(model) => model.modelId,
			),
		).toEqual(["qwen-audio-3.1-tts-plus"]);
		expect(NOTIFICATION_SPEECH_MODEL_CATALOG.map((model) => model.modelId)).toEqual(
			expect.arrayContaining([
				"hexgrad/Kokoro-82M",
				"qwen-audio-3.0-tts-plus",
				"qwen-audio-3.0-tts-flash",
				"qwen3-tts-flash",
				"qwen3-tts-instruct-flash",
			]),
		);
	});

	it.each([
		["zh-CN", "zh"],
		["en-US", "en"],
	] as const)("%s 使用 Audio HTTP 字段，保留语速、音调和风格指令", (summaryLanguage, languageHint) => {
		expect(buildNotificationSpeechProviderRequest({ ...settings, summaryLanguage }, profile, "任务完成")).toEqual({
			url: "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
			body: {
				model: "qwen-audio-3.1-tts-plus",
				input: {
					text: "任务完成",
					voice: "longanlingxin_v3.1",
					language_hints: [languageHint],
					format: "wav",
					sample_rate: 24000,
					rate: 1.1,
					pitch: 0.9,
					volume: 100,
					instruction: "平静自然",
				},
			},
		});
	});

	it.each(["longanlingxin_v3.1", "xunanchuan_v3.1", "longanhuan_v3.1", "longanfengyue_v3.1"])(
		"接受配套音色 %s，未配置风格时省略 instruction",
		(speechVoice) => {
			const request = buildNotificationSpeechProviderRequest(
				{ ...settings, speechVoice, speechStyleInstruction: "" },
				{ ...profile, alibabaWorkspaceId: "speech-workspace" },
				"任务完成",
			);
			expect(request.url).toBe(
				"https://speech-workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
			);
			expect(request.body).toMatchObject({ input: { voice: speechVoice } });
			expect(request.body.input).not.toHaveProperty("instruction");
		},
	);

	it.each(["Cherry", "longanlingxin", "longanlufeng"])("拒绝跨模型音色 %s", (speechVoice) => {
		expect(() => buildNotificationSpeechProviderRequest({ ...settings, speechVoice }, profile, "任务完成")).toThrow(
			"当前模型不支持所选音色",
		);
	});

	it("保留北京地域限制", () => {
		expect(() =>
			buildNotificationSpeechProviderRequest(settings, { ...profile, alibabaRegion: "singapore" }, "任务完成"),
		).toThrow("Qwen-Audio HTTP 接口仅支持北京地域");
	});
});
