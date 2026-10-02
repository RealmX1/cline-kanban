import { afterEach, describe, expect, it, vi } from "vitest";
import { notificationIntelligenceSettingsSchema } from "../../../src/core/notification-intelligence-settings-contract";
import {
	BROWSER_NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_PAUSE_MILLISECONDS,
	playNotificationSummarySpeech,
} from "./notification-summary-speech";

const observations = vi.hoisted(() => vi.fn(async () => undefined));
const synthesis = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/notification-intelligence-query", () => ({
	notificationIntelligenceClient: () => ({
		recordClientObservation: { mutate: observations },
		synthesizeSpeech: { mutate: synthesis },
	}),
}));
afterEach(() => {
	vi.useRealTimers();
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
	it("有播报脚本时浏览器系统语音按「先导 → 停顿 → 正文」两段念", async () => {
		vi.useFakeTimers();
		const spokenUtterances: Array<{ text: string; spokenAt: number }> = [];
		vi.stubGlobal(
			"SpeechSynthesisUtterance",
			class {
				text: string;
				onstart: (() => void) | null = null;
				onend: (() => void) | null = null;
				constructor(text: string) {
					this.text = text;
				}
			},
		);
		vi.stubGlobal("speechSynthesis", {
			getVoices: () => [{ lang: "zh-CN", voiceURI: "chinese", localService: true }],
			cancel: vi.fn(),
			speak: (utterance: { text: string; onstart: () => void; onend: () => void }) => {
				spokenUtterances.push({ text: utterance.text, spokenAt: Date.now() });
				queueMicrotask(() => {
					utterance.onstart();
					utterance.onend();
				});
			},
		});
		const playback = playNotificationSummarySpeech({
			settings: notificationIntelligenceSettingsSchema.parse({ summaryLanguage: "zh-CN" }),
			text: "整段摘要",
			announcementScript: { leadInText: "项目 cline kanban，任务：修复通知语音。", bodyText: "已修复，可以查看。" },
			preview: true,
		});
		await vi.advanceTimersByTimeAsync(BROWSER_NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_PAUSE_MILLISECONDS);
		await playback;
		expect(spokenUtterances.map((utterance) => utterance.text)).toEqual([
			"项目 cline kanban，任务：修复通知语音。",
			"已修复，可以查看。",
		]);
		expect(spokenUtterances[1]!.spokenAt - spokenUtterances[0]!.spokenAt).toBeGreaterThanOrEqual(
			BROWSER_NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_PAUSE_MILLISECONDS,
		);
	});
});
