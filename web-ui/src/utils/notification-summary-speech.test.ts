import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationIntelligenceSettingsSchema } from "../../../src/core/notification-intelligence-settings-contract";
import { playNotificationSummarySpeech } from "./notification-summary-speech";

const observations = vi.hoisted(() => vi.fn(async () => undefined));
const synthesis = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/notification-intelligence-query", () => ({
	notificationIntelligenceClient: () => ({
		recordClientObservation: { mutate: observations },
		synthesizeSpeech: { mutate: synthesis },
	}),
}));
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	observations.mockClear();
});
describe("通知语音播放器", () => {
	it("排队和网络等待后过时的音频均不播放", async () => {
		const settings = notificationIntelligenceSettingsSchema.parse({ speechProvider: "deepinfra" });
		const triggeredAt = Date.now() - 61_000;
		await playNotificationSummarySpeech({
			settings,
			text: "过时通知",
			candidateId: "stale",
			clientId: "one",
			triggeredAt,
		});
		expect(synthesis).not.toHaveBeenCalled();
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		synthesis.mockImplementationOnce(async () => {
			clock.mockReturnValue(now + 61_000);
			return { audioBase64: "SUQz", mimeType: "audio/mpeg" };
		});
		const audio = vi.fn();
		vi.stubGlobal("Audio", audio);
		await playNotificationSummarySpeech({
			settings,
			text: "合成中变旧",
			candidateId: "late-audio",
			clientId: "one",
			triggeredAt: now,
		});
		expect(audio).not.toHaveBeenCalled();
		expect(observations).toHaveBeenCalledWith(expect.objectContaining({ observation: "speech_stale_skipped" }));
	});
	it("所选语言没有本机音色时明确失败，由调用方回退提示音", async () => {
		vi.stubGlobal(
			"SpeechSynthesisUtterance",
			class {
				text: string;
				constructor(text: string) {
					this.text = text;
				}
			},
		);
		vi.stubGlobal("speechSynthesis", {
			getVoices: () => [{ lang: "en-US", voiceURI: "english", localService: true }],
			speak: vi.fn(),
		});
		await expect(
			playNotificationSummarySpeech({
				settings: notificationIntelligenceSettingsSchema.parse({ summaryLanguage: "zh-CN" }),
				text: "中文",
				preview: true,
			}),
		).rejects.toThrow("没有所选语言");
	});
});
