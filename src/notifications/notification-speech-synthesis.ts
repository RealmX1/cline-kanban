import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
	KanbanModelProviderProfile,
	NotificationIntelligenceSettings,
} from "../core/notification-intelligence-settings-contract";
import {
	readNotificationIntelligenceSettings,
	resolveKanbanProviderAccess,
} from "../model-provider-access/kanban-model-provider-settings";
import { getNotificationArchiveDirectory, getNotificationLifecycleArchive } from "./notification-lifecycle-archive";
import { composeNotificationSpeechAnnouncementScript } from "./notification-speech-announcement-script";
import { joinPcmWavSegmentsWithSilenceGap } from "./notification-speech-pcm-wav-segment-join";
import { validateNotificationSpeechConfiguration } from "./notification-speech-provider-catalog";

// EXPERIMENT_NODE: 先导与正文之间插入的静音时长（两段各自还带首尾留白，实际听感约多 0.3 秒）
export const NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_SILENCE_GAP_MILLISECONDS = 1200;

export function buildNotificationSpeechProviderRequest(
	settings: NotificationIntelligenceSettings,
	profile: KanbanModelProviderProfile,
	text: string,
): { url: string; body: Record<string, unknown> } {
	validateNotificationSpeechConfiguration(settings, profile);
	const model = settings.notificationSpeechBinding?.modelId;
	if (settings.speechProvider === "deepinfra")
		return {
			url: "https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M",
			body: {
				text,
				preset_voice: [settings.speechVoice],
				speed: settings.speechSpeed,
				// 一律要未压缩 WAV：先导与正文要在服务端按 PCM 拼接并插入静音。
				output_format: "wav",
				stream: false,
			},
		};
	const origin =
		profile.alibabaRegion === "singapore"
			? "https://dashscope-intl.aliyuncs.com"
			: profile.alibabaWorkspaceId
				? `https://${profile.alibabaWorkspaceId}.cn-beijing.maas.aliyuncs.com`
				: "https://dashscope.aliyuncs.com";
	if (model?.startsWith("qwen-audio-"))
		return {
			url: `${origin}/api/v1/services/audio/tts/SpeechSynthesizer`,
			body: {
				model,
				input: {
					text,
					voice: settings.speechVoice,
					language_hints: [settings.summaryLanguage === "zh-CN" ? "zh" : "en"],
					format: "wav",
					sample_rate: 24000,
					rate: settings.speechSpeed,
					pitch: settings.speechPitch,
					// 音量由播放器统一控制，避免服务端和客户端重复衰减。
					volume: 100,
					...(settings.speechStyleInstruction ? { instruction: settings.speechStyleInstruction } : {}),
				},
			},
		};
	return {
		url: `${origin}/api/v1/services/aigc/multimodal-generation/generation`,
		body: {
			model,
			input: {
				text,
				voice: settings.speechVoice,
				// EXPERIMENT_NODE: 中英混读时 language_type 用 "Chinese" 还是 "Auto"（官方称 Auto 不保证准确，社区实测说法不一）
				language_type: settings.summaryLanguage === "zh-CN" ? "Chinese" : "English",
				...(settings.speechStyleInstruction
					? { instructions: settings.speechStyleInstruction, optimize_instructions: false }
					: {}),
			},
		},
	};
}
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
async function readLimitedResponse(response: Response, limit: number): Promise<Buffer> {
	if (!response.ok) throw new Error(`语音服务 HTTP ${response.status}`);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("语音服务返回空响应");
	const chunks: Buffer[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.length;
			if (bytes > limit) throw new Error("语音响应超过大小限制");
			chunks.push(Buffer.from(chunk.value));
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks);
}
function detectAudioMime(bytes: Buffer): string {
	if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE") return "audio/wav";
	if (bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
		return "audio/mpeg";
	throw new Error("语音服务没有返回有效的 WAV/MP3 音频");
}
async function persistAudio(bytes: Buffer, candidateId: string): Promise<string> {
	const hash = createHash("sha256").update(bytes).digest("hex");
	const directory = join(getNotificationArchiveDirectory(), "synthesized-notification-audio");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const stagingFilename = `${hash}.${randomUUID()}.pending`;
	const stagingPath = join(directory, stagingFilename);
	// 文件与 SQLite 无法共用事务：先记落盘意图，重启后按哈希恢复关联，不再次请求付费服务。
	await getNotificationLifecycleArchive().update(candidateId, {}, "speech_audio_persistence_started", {
		sha256: hash,
		stagingFilename,
	});
	const file = await open(stagingPath, "wx", 0o600);
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(stagingPath, join(directory, `${hash}.audio`));
	if (process.platform !== "win32") {
		const directoryHandle = await open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	}
	return hash;
}
export async function readArchivedNotificationAudio(candidateId: string) {
	const candidate = (await getNotificationLifecycleArchive().get(candidateId))?.candidate;
	if (!candidate?.audioSha256 || !/^[a-f0-9]{64}$/u.test(candidate.audioSha256))
		throw new Error("此记录没有已保存的音频");
	const bytes = await readFile(
		join(getNotificationArchiveDirectory(), "synthesized-notification-audio", `${candidate.audioSha256}.audio`),
	);
	return { audioBase64: bytes.toString("base64"), mimeType: detectAudioMime(bytes), sha256: candidate.audioSha256 };
}
async function requestSynthesizedAudioSegmentFromProvider(
	settings: NotificationIntelligenceSettings,
	request: { url: string; body: Record<string, unknown> },
	apiKey: string,
	fetchImplementation: typeof globalThis.fetch,
): Promise<{ bytes: Buffer; usage: unknown; requestId: string | undefined }> {
	const response = await fetchImplementation(request.url, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify(request.body),
		signal: AbortSignal.timeout(30_000),
		redirect: "error",
	});
	const reply: unknown = JSON.parse((await readLimitedResponse(response, MAX_AUDIO_BYTES * 2)).toString("utf8"));
	let bytes: Buffer;
	let usage: unknown;
	let requestId: string | undefined;
	if (settings.speechProvider === "deepinfra") {
		const parsed = z
			.object({ audio: z.string(), request_id: z.string().nullish(), inference_status: z.unknown().optional() })
			.parse(reply);
		bytes = Buffer.from(parsed.audio.replace(/^data:[^,]+,/u, ""), "base64");
		usage = parsed.inference_status;
		requestId = parsed.request_id ?? undefined;
	} else {
		const parsed = z
			.object({
				request_id: z.string().optional(),
				usage: z.unknown().optional(),
				output: z.object({ audio: z.object({ url: z.string().url() }) }),
			})
			.parse(reply);
		const url = new URL(parsed.output.audio.url);
		if (
			!/^dashscope-result-[a-z0-9-]+\.oss-[a-z0-9-]+\.aliyuncs\.com$/u.test(url.hostname) ||
			!["http:", "https:"].includes(url.protocol) ||
			url.port ||
			url.username ||
			url.password
		)
			throw new Error("语音下载目标不在 provider 结果域名范围内");
		url.protocol = "https:";
		// 结果下载不携带 API Key；禁止重定向到其它主机。
		bytes = await readLimitedResponse(
			await fetchImplementation(url, { signal: AbortSignal.timeout(30_000), redirect: "error" }),
			MAX_AUDIO_BYTES,
		);
		usage = parsed.usage;
		requestId = parsed.request_id;
	}
	if (bytes.length > MAX_AUDIO_BYTES) throw new Error("音频超过大小限制");
	return { bytes, usage, requestId };
}
const activeSyntheses = new Set<string>();
export async function synthesizeNotificationSpeech(
	input: { candidateId: string; clientId?: string; preview?: boolean; retry?: boolean },
	fetchImplementation = globalThis.fetch,
) {
	await recoverPersistedNotificationSpeech();
	const archive = getNotificationLifecycleArchive();
	const lifecycle = await archive.get(input.candidateId);
	if (!lifecycle) throw new Error("通知不存在");
	const candidate = lifecycle.candidate;
	if (!input.preview && (!input.clientId || candidate.deliveryClaimedBy !== input.clientId))
		throw new Error("此客户端未领取通知播报");
	if (candidate.audioSha256 && !input.retry) return await readArchivedNotificationAudio(input.candidateId);
	if (activeSyntheses.has(input.candidateId) || activeSyntheses.size >= 2)
		throw new Error("语音合成正在进行，请稍后重试");
	if (!input.retry && lifecycle.events.some((event) => event.eventType === "speech_synthesis_requested"))
		throw new Error("已有语音请求，结果可能不确定；请明确重试，可能再次计费");
	const startedAt = Date.now();
	activeSyntheses.add(input.candidateId);
	try {
		const settings = {
			...(await readNotificationIntelligenceSettings()),
			summaryLanguage: candidate.summaryLanguage,
		};
		if (settings.speechProvider === "browser") throw new Error("浏览器系统语音由当前设备播放，没有音频导出接口");
		const providerId = settings.notificationSpeechBinding?.modelProviderId;
		const access = providerId ? await resolveKanbanProviderAccess(providerId) : null;
		if (!access) throw new Error("未配置所选 TTS provider 的凭据");
		const announcementScript =
			candidate.notificationSpeechAnnouncementScript ?? composeNotificationSpeechAnnouncementScript(candidate);
		// 先导与正文分两次请求、并行合成，再在服务端拼成一个带停顿的音频；留档、重放、重新合成链路都不用改。
		const requests = [announcementScript.leadInText, announcementScript.bodyText].map((text) =>
			buildNotificationSpeechProviderRequest(settings, access.profile, text),
		);
		await archive.update(input.candidateId, {}, "speech_synthesis_requested", {
			modelProviderId: providerId,
			announcementScript,
			requests,
			settings,
			retry: Boolean(input.retry),
		});
		// 任一段失败即整体失败：沿用「不自动重试、回退提示音」的计费边界。
		const segments = await Promise.all(
			requests.map((request) =>
				requestSynthesizedAudioSegmentFromProvider(settings, request, access.apiKey, fetchImplementation),
			),
		);
		const bytes = joinPcmWavSegmentsWithSilenceGap(
			segments.map((segment) => segment.bytes),
			NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_SILENCE_GAP_MILLISECONDS,
			MAX_AUDIO_BYTES,
		);
		if (bytes.length > MAX_AUDIO_BYTES) throw new Error("音频超过大小限制");
		const mimeType = detectAudioMime(bytes);
		const sha256 = await persistAudio(bytes, input.candidateId);
		await archive.update(input.candidateId, { audioSha256: sha256 }, "speech_synthesis_completed", {
			sha256,
			mimeType,
			byteLength: bytes.length,
			silenceGapMilliseconds: NOTIFICATION_SPEECH_LEAD_IN_TO_BODY_SILENCE_GAP_MILLISECONDS,
			segments: segments.map((segment) => ({
				requestId: segment.requestId,
				usage: segment.usage,
				byteLength: segment.bytes.length,
			})),
			elapsedMs: Date.now() - startedAt,
		});
		return { audioBase64: bytes.toString("base64"), mimeType, sha256 };
	} catch (error) {
		// provider 回包/网络异常可能含敏感参数，不原样写入日志或回传浏览器。
		await archive.update(input.candidateId, {}, "speech_synthesis_failed", {
			elapsedMs: Date.now() - startedAt,
			errorName: error instanceof Error ? error.name : "UnknownError",
			outcomeMayHaveBeenBilled: true,
		});
		throw new Error("语音合成失败，未自动重试；请检查凭据、地域、音色或稍后明确重试。");
	} finally {
		activeSyntheses.delete(input.candidateId);
	}
}
// 试听故意带上文件路径、行号范围和提交哈希，让用户一次听到先导、停顿和技术文本规整的效果。
const NOTIFICATION_SPEECH_PREVIEW_SAMPLE_BY_SUMMARY_LANGUAGE = {
	"zh-CN": {
		repositoryNameSnapshot: "kanban-demo-project",
		taskTitleSnapshot: "[DEMO] 通知语音试听：检查先导与停顿",
		summaryText:
			"这是一条通知语音试听：已修复 `web-ui/src/hooks/use-review-ready-notifications.ts:280-370` 的播报逻辑并提交（d017a1e3），测试 T1–T3 全部通过，可以查看结果。",
	},
	"en-US": {
		repositoryNameSnapshot: "kanban-demo-project",
		taskTitleSnapshot: "[DEMO] Notification voice preview: lead-in and pause",
		summaryText:
			"This is a notification voice preview: fixed the playback logic in `web-ui/src/hooks/use-review-ready-notifications.ts:280-370` and committed it (d017a1e3); tests T1–T3 passed, ready for review.",
	},
} as const;
export async function previewNotificationSpeech() {
	const settings = await readNotificationIntelligenceSettings();
	const candidateId = randomUUID();
	const previewSample = NOTIFICATION_SPEECH_PREVIEW_SAMPLE_BY_SUMMARY_LANGUAGE[settings.summaryLanguage];
	const taskId = "notification-speech-preview";
	await getNotificationLifecycleArchive().capture({
		candidateId,
		workspaceId: "notification-speech-preview",
		taskId,
		userTurnKind: "review",
		sourceKind: "user_requested_speech_preview",
		triggeredAt: Date.now(),
		notificationPanelVisibility: "excluded",
		notificationProcessingStatus: "preview",
		summaryLanguage: settings.summaryLanguage,
		...previewSample,
		notificationSpeechAnnouncementScript: composeNotificationSpeechAnnouncementScript({
			...previewSample,
			taskId,
			summaryLanguage: settings.summaryLanguage,
		}),
	});
	return { candidateId, ...(await synthesizeNotificationSpeech({ candidateId, preview: true })) };
}

export async function recoverPersistedNotificationSpeech(): Promise<void> {
	const archive = getNotificationLifecycleArchive();
	for (const candidateId of await archive.pendingAudioPersistenceCandidates()) {
		if (activeSyntheses.has(candidateId)) continue;
		const lifecycle = await archive.get(candidateId);
		const receipt = lifecycle?.events
			.slice()
			.reverse()
			.find((event) => event.eventType === "speech_audio_persistence_started");
		const parsed = z
			.object({
				sha256: z.string().regex(/^[a-f0-9]{64}$/u),
				stagingFilename: z.string().regex(/^[a-f0-9]{64}\.[a-f0-9-]+\.pending$/u),
			})
			.safeParse(receipt?.details);
		if (!parsed.success) continue;
		const directory = join(getNotificationArchiveDirectory(), "synthesized-notification-audio");
		const finalPath = join(directory, `${parsed.data.sha256}.audio`);
		try {
			let bytes: Buffer;
			try {
				bytes = await readFile(finalPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const stagingPath = join(directory, parsed.data.stagingFilename);
				bytes = await readFile(stagingPath);
				if (createHash("sha256").update(bytes).digest("hex") !== parsed.data.sha256) continue;
				await rename(stagingPath, finalPath);
			}
			if (createHash("sha256").update(bytes).digest("hex") !== parsed.data.sha256) continue;
			await archive.update(candidateId, { audioSha256: parsed.data.sha256 }, "speech_audio_persistence_recovered", {
				sha256: parsed.data.sha256,
				byteLength: bytes.length,
				mimeType: detectAudioMime(bytes),
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
