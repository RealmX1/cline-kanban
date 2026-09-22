import {
	type NotificationIntelligenceSettings,
	notificationIntelligenceClient,
} from "@/runtime/notification-intelligence-query";

let notificationSpeechPlaybackChain: Promise<void> = Promise.resolve();
export function playNotificationSummarySpeech(input: {
	settings: NotificationIntelligenceSettings;
	text: string;
	candidateId?: string;
	clientId?: string;
	triggeredAt?: number;
	preview?: boolean;
}): Promise<void> {
	const play = async () => {
		const observe = (
			observation:
				| "speech_started"
				| "speech_ended"
				| "speech_failed"
				| "speech_stale_skipped"
				| "browser_speech_has_no_audio_export",
		) => {
			if (input.candidateId && input.clientId)
				void notificationIntelligenceClient()
					.recordClientObservation.mutate({
						candidateId: input.candidateId,
						clientId: input.clientId,
						observation,
					})
					.catch(() => undefined);
		};
		if (!input.preview && input.triggeredAt && Date.now() - input.triggeredAt > 60_000) {
			observe("speech_stale_skipped");
			return;
		}
		try {
			if (input.settings.speechProvider === "browser") {
				if (!("speechSynthesis" in window)) throw new Error("当前浏览器不支持系统语音");
				const utterance = new SpeechSynthesisUtterance(input.text.slice(0, 500));
				utterance.lang = input.settings.summaryLanguage;
				utterance.rate = input.settings.speechSpeed;
				utterance.pitch = input.settings.speechPitch;
				utterance.volume = input.settings.speechVolume;
				const voices = window.speechSynthesis.getVoices();
				const savedUri = localStorage.getItem("kanban-notification-browser-voice-uri");
				const matchingVoices = voices.filter((voice) =>
					voice.lang.toLowerCase().startsWith(input.settings.summaryLanguage.slice(0, 2)),
				);
				if (voices.length > 0 && matchingVoices.length === 0)
					throw new Error("当前设备没有所选语言的语音，请安装语音或选择第三方服务");
				utterance.voice =
					matchingVoices.find((voice) => voice.voiceURI === savedUri) ??
					matchingVoices.find((voice) => voice.localService) ??
					matchingVoices[0] ??
					null;
				observe("browser_speech_has_no_audio_export");
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						window.speechSynthesis.cancel();
						reject(new Error("浏览器语音播放超时"));
					}, 120_000);
					utterance.onstart = () => observe("speech_started");
					utterance.onend = () => {
						clearTimeout(timeout);
						resolve();
					};
					utterance.onerror = () => {
						clearTimeout(timeout);
						reject(new Error("浏览器阻止了语音播放，请点击试听启用"));
					};
					window.speechSynthesis.speak(utterance);
				});
			} else {
				const audio = input.preview
					? await notificationIntelligenceClient().previewSpeech.mutate()
					: await notificationIntelligenceClient().synthesizeSpeech.mutate({
							candidateId: input.candidateId ?? "",
							clientId: input.clientId ?? "",
						});
				if (!input.preview && input.triggeredAt && Date.now() - input.triggeredAt > 60_000) {
					observe("speech_stale_skipped");
					return;
				}
				const player = new Audio(`data:${audio.mimeType};base64,${audio.audioBase64}`);
				player.volume = input.settings.speechVolume;
				await new Promise<void>((resolve, reject) => {
					const timeout = setTimeout(() => {
						player.pause();
						reject(new Error("音频播放超时"));
					}, 120_000);
					player.onplaying = () => observe("speech_started");
					player.onended = () => {
						clearTimeout(timeout);
						resolve();
					};
					player.onerror = () => {
						clearTimeout(timeout);
						reject(new Error("音频播放失败"));
					};
					void player.play().catch((error) => {
						clearTimeout(timeout);
						reject(error);
					});
				});
			}
			observe("speech_ended");
		} catch (error) {
			observe("speech_failed");
			throw error;
		}
	};
	const next = notificationSpeechPlaybackChain.then(play, play);
	notificationSpeechPlaybackChain = next.catch(() => undefined);
	return next;
}
