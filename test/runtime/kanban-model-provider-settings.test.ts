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
