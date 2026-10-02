import type {
	KanbanModelProviderProfile,
	NotificationIntelligenceSettings,
} from "../core/notification-intelligence-settings-contract";

// 只列已核对接口和音色的模型；添加模型必须同时补充适配契约测试。
// 推荐依据（2026-10）：qwen-audio-3.0-tts-plus 是百炼推荐表首位，双语音色、支持 SSML 与 instruction，
// 官方难读文本基准中文 68.7% / 英文 65.7%（qwen3-tts-flash 为 57.0% / 60.5%）。
export const NOTIFICATION_SPEECH_MODEL_CATALOG = [
	{
		modelId: "hexgrad/Kokoro-82M",
		isRecommendedForCodingAgentNotificationSpeech: false,
		provider: "deepinfra",
		voices: ["zf_xiaobei", "zf_xiaoni", "af_bella", "af_heart", "am_adam"],
		instructions: false,
		speed: true,
		pitch: false,
	},
	{
		modelId: "qwen-audio-3.0-tts-plus",
		isRecommendedForCodingAgentNotificationSpeech: true,
		provider: "alibaba",
		voices: ["longanlingxin", "longanlufeng"],
		instructions: true,
		speed: true,
		pitch: true,
	},
	{
		modelId: "qwen-audio-3.0-tts-flash",
		isRecommendedForCodingAgentNotificationSpeech: false,
		provider: "alibaba",
		voices: ["longanfengyue", "longanyuanfei", "longanlingxi"],
		instructions: true,
		speed: true,
		pitch: true,
	},
	{
		modelId: "qwen3-tts-flash",
		isRecommendedForCodingAgentNotificationSpeech: false,
		provider: "alibaba",
		voices: ["Cherry", "Ethan", "Serena"],
		instructions: false,
		speed: false,
		pitch: false,
	},
	{
		modelId: "qwen3-tts-instruct-flash",
		isRecommendedForCodingAgentNotificationSpeech: false,
		provider: "alibaba",
		voices: ["Cherry", "Ethan", "Serena"],
		instructions: true,
		speed: false,
		pitch: false,
	},
] as const;
export function validateNotificationSpeechConfiguration(
	settings: NotificationIntelligenceSettings,
	profile?: KanbanModelProviderProfile,
) {
	if (settings.speechProvider === "browser") return;
	const binding = settings.notificationSpeechBinding;
	const model = NOTIFICATION_SPEECH_MODEL_CATALOG.find((candidate) => candidate.modelId === binding?.modelId);
	if (!model || model.provider !== settings.speechProvider || profile?.providerProtocol !== model.provider)
		throw new Error("请选择匹配的 TTS provider 和模型");
	if (model.modelId.startsWith("qwen-audio-") && profile.alibabaRegion !== "beijing")
		throw new Error("Qwen-Audio HTTP 接口仅支持北京地域");
	if (!(model.voices as readonly string[]).includes(settings.speechVoice)) throw new Error("当前模型不支持所选音色");
	if (
		model.provider === "deepinfra" &&
		(settings.summaryLanguage === "zh-CN") !== settings.speechVoice.startsWith("z")
	)
		throw new Error("Kokoro 音色必须匹配所选语言");
	if (model.provider === "alibaba" && (settings.speechSpeed < 0.5 || settings.speechSpeed > 2))
		throw new Error("阿里语速范围为 0.5–2");
	if (!model.speed && settings.speechSpeed !== 1) throw new Error("当前模型不支持语速参数");
	if (!model.pitch && settings.speechPitch !== 1) throw new Error("当前模型不支持音调参数");
	if (!model.instructions && settings.speechStyleInstruction) throw new Error("当前模型不支持风格指令");
}
