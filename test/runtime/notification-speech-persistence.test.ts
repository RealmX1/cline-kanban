import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { notificationIntelligenceSettingsSchema } from "../../src/core/notification-intelligence-settings-contract";
import {
	getNotificationArchiveDirectory,
	getNotificationLifecycleArchive,
} from "../../src/notifications/notification-lifecycle-archive";
import { readPcmWavSegment } from "../../src/notifications/notification-speech-pcm-wav-segment-join";
import {
	NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_SILENCE_GAP_MILLISECONDS,
	readArchivedNotificationAudio,
	recoverPersistedNotificationSpeech,
	synthesizeNotificationSpeech,
} from "../../src/notifications/notification-speech-synthesis";

vi.mock("../../src/model-provider-access/kanban-model-provider-settings", () => ({
	readNotificationIntelligenceSettings: async () =>
		notificationIntelligenceSettingsSchema.parse({
			speechProvider: "deepinfra",
			speechVoice: "zf_xiaobei",
			notificationSpeechBinding: { modelProviderId: "deepinfra", modelId: "hexgrad/Kokoro-82M" },
		}),
	resolveKanbanProviderAccess: async () => ({
		apiKey: "test-secret-never-archive",
		profile: {
			modelProviderId: "deepinfra",
			providerProtocol: "deepinfra",
			alibabaRegion: "beijing",
			credentialSource: "environment",
			displayName: "test",
		},
	}),
}));
async function capture(candidateId: string) {
	await getNotificationLifecycleArchive().capture({
		candidateId,
		workspaceId: "speech",
		taskId: "task",
		triggeredAt: Date.now(),
		sourceKind: "test",
		userTurnKind: "review",
		summaryText: "任务已完成",
		notificationPanelVisibility: "visible",
	});
	await getNotificationLifecycleArchive().claimDelivery(candidateId, "browser");
}
// 24kHz 16 位单声道 PCM WAV，样本值逐个给出。
function pcmWav(samples: number[]): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + samples.length * 2, 4);
	header.write("WAVEfmt ", 8, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(24_000, 24);
	header.writeUInt32LE(48_000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(samples.length * 2, 40);
	const pcm = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => {
		pcm.writeInt16LE(sample, index * 2);
	});
	return Buffer.concat([header, pcm]);
}
// 按请求文本返回不同的 WAV：先导样本全是 11，正文全是 22，便于断言拼接顺序与停顿。
function fetchReturningWavPerSegment() {
	return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const text = (JSON.parse(String(init?.body)) as { text: string }).text;
		const samples = text.startsWith("项目") ? [11, 11, 11] : [22, 22];
		return new Response(
			JSON.stringify({ audio: pcmWav(samples).toString("base64"), inference_status: { cost: 0.001 } }),
		);
	});
}
describe("语音永久留档与计费边界", () => {
	it("合成结果留档并复用；并发请求和失败后的自动重试不再次计费", async () => {
		await capture("speech-success");
		const fetch = fetchReturningWavPerSegment();
		const input = { candidateId: "speech-success", clientId: "browser" };
		const results = await Promise.allSettled([
			synthesizeNotificationSpeech(input, fetch),
			synthesizeNotificationSpeech(input, fetch),
		]);
		const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		expect(fulfilled).toHaveLength(1);
		// 先导与正文各一次请求。
		expect(fetch).toHaveBeenCalledTimes(2);
		expect((await synthesizeNotificationSpeech(input, fetch)).audioBase64).toBe(fulfilled[0]?.audioBase64);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(await getNotificationLifecycleArchive().get(input.candidateId))).not.toContain(
			"test-secret-never-archive",
		);
		await capture("speech-failure");
		const failedFetch = vi.fn(async () => new Response("failure", { status: 503 }));
		await expect(
			synthesizeNotificationSpeech({ candidateId: "speech-failure", clientId: "browser" }, failedFetch),
		).rejects.toThrow("未自动重试");
		await expect(
			synthesizeNotificationSpeech({ candidateId: "speech-failure", clientId: "browser" }, failedFetch),
		).rejects.toThrow("可能再次计费");
		expect(failedFetch).toHaveBeenCalledTimes(2);
	});
	it("先导与正文拼成一个 WAV，中间插入停顿；旧记录缺播报脚本时现场组装", async () => {
		const candidateId = "speech-lead-in-and-body";
		await capture(candidateId);
		const fetch = fetchReturningWavPerSegment();
		const audio = await synthesizeNotificationSpeech({ candidateId, clientId: "browser" }, fetch);
		expect(audio.mimeType).toBe("audio/wav");
		const { pcmSampleBytes } = readPcmWavSegment(Buffer.from(audio.audioBase64, "base64"));
		const samples = Array.from({ length: pcmSampleBytes.length / 2 }, (_, index) =>
			pcmSampleBytes.readInt16LE(index * 2),
		);
		const silenceSampleCount = (24_000 * NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_SILENCE_GAP_MILLISECONDS) / 1000;
		expect(samples).toEqual([11, 11, 11, ...Array(silenceSampleCount).fill(0), 22, 22]);
		const requestedTexts = fetch.mock.calls.map(
			([, init]) => (JSON.parse(String(init?.body)) as { text: string }).text,
		);
		expect(requestedTexts).toEqual(["项目 speech，任务：task。", "任务已完成"]);
		const lifecycle = await getNotificationLifecycleArchive().get(candidateId);
		expect(
			lifecycle?.events.find((event) => event.eventType === "speech_synthesis_requested")?.details,
		).toMatchObject({ announcementScript: { leadInText: "项目 speech，任务：task。", bodyText: "任务已完成" } });
	});
	it("文件写完但数据库确认前中断，恢复音频关联无需请求 provider", async () => {
		const candidateId = "speech-crash-recovery";
		await capture(candidateId);
		const bytes = Buffer.from("ID3completed-before-crash");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const stagingFilename = `${sha256}.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.pending`;
		await getNotificationLifecycleArchive().update(candidateId, {}, "speech_audio_persistence_started", {
			sha256,
			stagingFilename,
		});
		const directory = join(getNotificationArchiveDirectory(), "synthesized-notification-audio");
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, stagingFilename), bytes);
		await recoverPersistedNotificationSpeech();
		expect((await readArchivedNotificationAudio(candidateId)).sha256).toBe(sha256);
		expect((await getNotificationLifecycleArchive().get(candidateId))?.events.at(-1)?.eventType).toBe(
			"speech_audio_persistence_recovered",
		);
	});
});
