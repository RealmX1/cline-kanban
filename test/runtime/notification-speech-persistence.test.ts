import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { notificationIntelligenceSettingsSchema } from "../../src/core/notification-intelligence-settings-contract";
import {
	getNotificationArchiveDirectory,
	getNotificationLifecycleArchive,
} from "../../src/notifications/notification-lifecycle-archive";
import {
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
describe("语音永久留档与计费边界", () => {
	it("合成结果留档并复用；并发请求和失败后的自动重试不再次计费", async () => {
		await capture("speech-success");
		const bytes = Buffer.from("ID3test-mp3-payload");
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ audio: bytes.toString("base64"), inference_status: { cost: 0.001 } })),
		);
		const input = { candidateId: "speech-success", clientId: "browser" };
		const results = await Promise.allSettled([
			synthesizeNotificationSpeech(input, fetch),
			synthesizeNotificationSpeech(input, fetch),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect((await synthesizeNotificationSpeech(input, fetch)).audioBase64).toBe(bytes.toString("base64"));
		expect(fetch).toHaveBeenCalledTimes(1);
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
		expect(failedFetch).toHaveBeenCalledTimes(1);
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
