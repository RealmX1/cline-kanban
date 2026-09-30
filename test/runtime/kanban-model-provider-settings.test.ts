import { describe, expect, it, vi } from "vitest";
import { notificationIntelligenceSettingsSchema } from "../../src/core/notification-intelligence-settings-contract";
import {
	getNotificationIntelligenceSettings,
	resolveKanbanChatCredential,
	resolveKanbanProviderAccess,
	saveKanbanModelProviderProfile,
	saveNotificationIntelligenceSettings,
} from "../../src/model-provider-access/kanban-model-provider-settings";

const vault = vi.hoisted(() => new Map<string, string>());
vi.mock("@napi-rs/keyring", () => ({
	AsyncEntry: class {
		constructor(
			_service: string,
			private reference: string,
		) {}
		async getPassword() {
			return vault.get(this.reference);
		}
		async setPassword(value: string) {
			vault.set(this.reference, value);
		}
		async deletePassword() {
			return vault.delete(this.reference);
		}
	},
}));
describe("统一 BYOK 凭据来源", () => {
	it("保存密钥只返回状态；起名使用绑定模型；删除后不悄悄使用环境密钥", async () => {
		const profile = {
			modelProviderId: "test-provider",
			displayName: "测试",
			providerProtocol: "openai_compatible" as const,
			credentialSource: "system_credential_store" as const,
			baseUrl: "https://example.invalid",
			defaultModelId: "text-model",
			alibabaRegion: "beijing" as const,
		};
		await saveKanbanModelProviderProfile({ profile, apiKey: "private-saved-key" });
		const settings = notificationIntelligenceSettingsSchema.parse({
			taskNameSuggestionBinding: { modelProviderId: profile.modelProviderId, modelId: "selected-model" },
		});
		await saveNotificationIntelligenceSettings(settings);
		expect(await resolveKanbanChatCredential("task_name_suggestion")).toMatchObject({
			apiKey: "private-saved-key",
			modelId: "selected-model",
		});
		const view = await getNotificationIntelligenceSettings();
		expect(JSON.stringify(view)).not.toContain("private-saved-key");
		expect(
			view.providers.find((candidate) => candidate.modelProviderId === profile.modelProviderId)
				?.credentialConfigured,
		).toBe(true);
		await saveKanbanModelProviderProfile({ profile, deleteSavedCredential: true });
		expect(
			await resolveKanbanProviderAccess(profile.modelProviderId, {
				KANBAN_MODEL_PROVIDER_TEST_PROVIDER_API_KEY: "environment-key",
			}),
		).toBeNull();
		await saveKanbanModelProviderProfile({ profile: { ...profile, credentialSource: "environment" } });
		expect(
			(
				await resolveKanbanProviderAccess(profile.modelProviderId, {
					KANBAN_MODEL_PROVIDER_TEST_PROVIDER_API_KEY: "environment-key",
				})
			)?.apiKey,
		).toBe("environment-key");
	});
	it("已落盘的坏文本绑定不再锁死无关字段的保存，新引入的坏绑定仍被拒并写明用途", async () => {
		const textProfile = {
			modelProviderId: "text-provider-later-mislabeled-as-tts",
			displayName: "文本服务",
			providerProtocol: "openai_compatible" as const,
			credentialSource: "environment" as const,
			baseUrl: "https://example.invalid",
			defaultModelId: "text-model",
			alibabaRegion: "beijing" as const,
		};
		await saveKanbanModelProviderProfile({ profile: textProfile });
		const textBinding = { modelProviderId: textProfile.modelProviderId, modelId: "text-model" };
		await saveNotificationIntelligenceSettings(
			notificationIntelligenceSettingsSchema.parse({
				taskNameSuggestionBinding: textBinding,
				notificationAssessmentBinding: textBinding,
			}),
		);
		// 复现现场：被文本用途引用的档案之后被改成 TTS 服务类型。
		await saveKanbanModelProviderProfile({ profile: { ...textProfile, providerProtocol: "alibaba" } });
		await saveNotificationIntelligenceSettings(
			notificationIntelligenceSettingsSchema.parse({
				taskNameSuggestionBinding: textBinding,
				notificationAssessmentBinding: textBinding,
				speechMode: "summary",
				speechProvider: "browser",
			}),
		);
		expect((await getNotificationIntelligenceSettings()).settings.speechMode).toBe("summary");
		const ttsProfile = { ...textProfile, modelProviderId: "tts-only-provider", providerProtocol: "alibaba" as const };
		await saveKanbanModelProviderProfile({ profile: ttsProfile });
		await expect(
			saveNotificationIntelligenceSettings(
				notificationIntelligenceSettingsSchema.parse({
					taskNameSuggestionBinding: { modelProviderId: ttsProfile.modelProviderId, modelId: "text-model" },
					notificationAssessmentBinding: textBinding,
				}),
			),
		).rejects.toThrow(/任务起名.*tts-only-provider.*阿里百炼 TTS/u);
	});
	it("已落盘的语音配置因档案变动失效时，不阻止保存无关字段；改动语音字段仍做完整校验", async () => {
		const speechProfile = {
			modelProviderId: "speech-provider-later-changed",
			displayName: "语音服务",
			providerProtocol: "deepinfra" as const,
			credentialSource: "environment" as const,
			alibabaRegion: "beijing" as const,
		};
		await saveKanbanModelProviderProfile({ profile: speechProfile });
		const speechSettings = {
			speechMode: "summary",
			speechProvider: "deepinfra",
			notificationSpeechBinding: { modelProviderId: speechProfile.modelProviderId, modelId: "hexgrad/Kokoro-82M" },
			speechVoice: "zf_xiaobei",
		};
		await saveNotificationIntelligenceSettings(notificationIntelligenceSettingsSchema.parse(speechSettings));
		await saveKanbanModelProviderProfile({ profile: { ...speechProfile, providerProtocol: "alibaba" } });
		await saveNotificationIntelligenceSettings(
			notificationIntelligenceSettingsSchema.parse({ ...speechSettings, fallbackAfterMinutes: 20 }),
		);
		expect((await getNotificationIntelligenceSettings()).settings.fallbackAfterMinutes).toBe(20);
		await expect(
			saveNotificationIntelligenceSettings(
				notificationIntelligenceSettingsSchema.parse({ ...speechSettings, speechVoice: "zf_xiaoni" }),
			),
		).rejects.toThrow(/TTS provider/u);
	});
	it("拒绝将密钥发送到含凭据或查询参数的配置端点", async () => {
		await expect(
			saveKanbanModelProviderProfile({
				profile: {
					modelProviderId: "bad-url",
					displayName: "bad",
					providerProtocol: "openai_compatible",
					credentialSource: "environment",
					baseUrl: "https://example.invalid/?api_key=secret",
				},
			}),
		).rejects.toThrow(/地址/u);
	});
});
