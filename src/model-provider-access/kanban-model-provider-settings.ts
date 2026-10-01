// Kanban 自身功能的 provider 配置；不接管 agent harness / SDK 的认证。
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import { z } from "zod";
import {
	describeNotificationIntelligencePurposeBindingProblem,
	findNotificationIntelligencePurposeBindingProblems,
	listNewlyIntroducedNotificationIntelligencePurposeBindingProblems,
} from "../core/notification-intelligence-purpose-binding-problems";
import {
	type KanbanModelProviderProfile,
	kanbanModelProviderProfileSchema,
	type NotificationIntelligenceSettings,
	notificationIntelligenceSettingsSchema,
	saveKanbanModelProviderProfileRequestSchema,
} from "../core/notification-intelligence-settings-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { validateNotificationSpeechConfiguration } from "../notifications/notification-speech-provider-catalog";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import {
	getModelProviderApiKeyEnvironmentVariableName,
	KNOWN_MODEL_PROVIDER_DEFAULTS,
	type ModelProviderCredential,
	readConfiguredModelProviderIds,
	resolveDefaultModelProviderId,
	resolveModelProviderCredential,
	toModelProviderEnvironmentVariableSegment,
} from "./model-provider-credentials-from-environment";

const persistedSchema = z.object({
	settings: notificationIntelligenceSettingsSchema.default(() => notificationIntelligenceSettingsSchema.parse({})),
	profiles: z
		.array(kanbanModelProviderProfileSchema.extend({ credentialReference: z.string().optional() }))
		.default([]),
});
function settingsPath() {
	return join(
		process.env.KANBAN_NOTIFICATION_ARCHIVE_TEST_ROOT ?? getRuntimeHomePath(),
		"kanban-model-provider-settings.json",
	);
}
async function readPersistedSettings() {
	try {
		return persistedSchema.parse(JSON.parse(await readFile(settingsPath(), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return persistedSchema.parse({});
		throw error;
	}
}
function credentialEntry(reference: string) {
	const installation = createHash("sha256").update(getRuntimeHomePath()).digest("hex").slice(0, 24);
	return new AsyncEntry(`cline-kanban-model-provider-${installation}`, reference, {
		linux: { store: "secret-service" },
	});
}
// 仅由环境变量配置、尚未落盘的文本 provider：设置页列表与保存校验看到的是同一组档案。
function listEnvironmentConfiguredProviderProfilesMissingFromPersisted(
	persistedProfiles: readonly KanbanModelProviderProfile[],
): KanbanModelProviderProfile[] {
	return readConfiguredModelProviderIds()
		.filter((modelProviderId) => !persistedProfiles.some((profile) => profile.modelProviderId === modelProviderId))
		.map((modelProviderId) => {
			const segment = toModelProviderEnvironmentVariableSegment(modelProviderId);
			return {
				modelProviderId,
				displayName: modelProviderId,
				providerProtocol: "openai_compatible",
				credentialSource: "environment",
				alibabaRegion: "beijing",
				baseUrl:
					process.env[`KANBAN_MODEL_PROVIDER_${segment}_BASE_URL`] ??
					KNOWN_MODEL_PROVIDER_DEFAULTS[modelProviderId]?.baseUrl,
				defaultModelId:
					process.env[`KANBAN_MODEL_PROVIDER_${segment}_MODEL_ID`] ??
					KNOWN_MODEL_PROVIDER_DEFAULTS[modelProviderId]?.modelId,
			};
		});
}
// 这些字段改动时才对语音配置做完整校验；档案变动导致的既有失效不阻止其它字段保存（播放时失败会回退提示音并留档）。
const NOTIFICATION_SPEECH_CONFIGURATION_FIELDS_VALIDATED_ON_CHANGE = [
	"speechMode",
	"speechProvider",
	"notificationSpeechBinding",
	"speechVoice",
	"speechSpeed",
	"speechPitch",
	"speechStyleInstruction",
	"summaryLanguage",
] as const satisfies readonly (keyof NotificationIntelligenceSettings)[];
export async function readNotificationIntelligenceSettings(): Promise<NotificationIntelligenceSettings> {
	return (await readPersistedSettings()).settings;
}
export async function saveNotificationIntelligenceSettings(input: NotificationIntelligenceSettings): Promise<void> {
	const settings = notificationIntelligenceSettingsSchema.parse(input);
	await lockedFileSystem.withLock({ path: settingsPath() }, async () => {
		const persisted = await readPersistedSettings();
		const selectableProfiles = [
			...persisted.profiles,
			...listEnvironmentConfiguredProviderProfilesMissingFromPersisted(persisted.profiles),
		];
		// 只拒绝本次新引入的绑定问题；已落盘的坏绑定若也拦，会让声音模式等无关字段永远存不上。
		const newlyIntroducedProblems = listNewlyIntroducedNotificationIntelligencePurposeBindingProblems(
			findNotificationIntelligencePurposeBindingProblems(persisted.settings, selectableProfiles),
			findNotificationIntelligencePurposeBindingProblems(settings, selectableProfiles),
		);
		if (newlyIntroducedProblems.length > 0)
			throw new Error(newlyIntroducedProblems.map(describeNotificationIntelligencePurposeBindingProblem).join("；"));
		const speechConfigurationChanged = NOTIFICATION_SPEECH_CONFIGURATION_FIELDS_VALIDATED_ON_CHANGE.some(
			(field) => JSON.stringify(settings[field]) !== JSON.stringify(persisted.settings[field]),
		);
		if (settings.speechMode === "summary" && settings.speechProvider !== "browser" && speechConfigurationChanged)
			validateNotificationSpeechConfiguration(
				settings,
				persisted.profiles.find(
					(profile) => profile.modelProviderId === settings.notificationSpeechBinding?.modelProviderId,
				),
			);
		await lockedFileSystem.writeJsonFileAtomic(settingsPath(), { ...persisted, settings }, { lock: null });
	});
}
export async function saveKanbanModelProviderProfile(
	input: z.input<typeof saveKanbanModelProviderProfileRequestSchema>,
): Promise<void> {
	const parsed = saveKanbanModelProviderProfileRequestSchema.parse(input);
	if (parsed.profile.baseUrl) {
		const url = new URL(parsed.profile.baseUrl);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.protocol !== "https:" &&
				!(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
		)
			throw new Error("Provider 地址必须为 HTTPS 或本机 HTTP，且不能包含凭据、查询或片段");
	}
	await lockedFileSystem.withLock({ path: settingsPath() }, async () => {
		const persisted = await readPersistedSettings();
		const previous = persisted.profiles.find((profile) => profile.modelProviderId === parsed.profile.modelProviderId);
		let reference = previous?.credentialReference;
		if (parsed.deleteSavedCredential && reference) {
			await credentialEntry(reference).deletePassword();
			reference = undefined;
		}
		const newReference = parsed.apiKey ? randomUUID() : undefined;
		if (newReference && parsed.apiKey) {
			await credentialEntry(newReference).setPassword(parsed.apiKey);
			reference = newReference;
		}
		try {
			await lockedFileSystem.writeJsonFileAtomic(
				settingsPath(),
				{
					...persisted,
					profiles: [
						...persisted.profiles.filter((profile) => profile.modelProviderId !== parsed.profile.modelProviderId),
						{ ...parsed.profile, credentialReference: reference },
					],
				},
				{ lock: null },
			);
		} catch (error) {
			if (newReference) await credentialEntry(newReference).deletePassword();
			throw error;
		}
		if (newReference && previous?.credentialReference)
			await credentialEntry(previous.credentialReference).deletePassword();
	});
}
export async function resolveKanbanProviderAccess(
	modelProviderId: string,
	environment = process.env,
): Promise<{ profile: KanbanModelProviderProfile; apiKey: string } | null> {
	const persisted = await readPersistedSettings();
	const profile = persisted.profiles.find((candidate) => candidate.modelProviderId === modelProviderId);
	if (!profile) {
		const legacy = resolveModelProviderCredential(modelProviderId, environment);
		return legacy
			? {
					profile: {
						modelProviderId,
						displayName: modelProviderId,
						providerProtocol: "openai_compatible",
						credentialSource: "environment",
						baseUrl: legacy.baseUrl,
						defaultModelId: legacy.modelId,
						alibabaRegion: "beijing",
					},
					apiKey: legacy.apiKey,
				}
			: null;
	}
	const apiKey =
		profile.credentialSource === "environment"
			? environment[getModelProviderApiKeyEnvironmentVariableName(modelProviderId)]?.trim()
			: profile.credentialReference
				? await credentialEntry(profile.credentialReference).getPassword()
				: undefined;
	return apiKey ? { profile, apiKey } : null;
}
export async function resolveKanbanChatCredential(
	purpose: "task_name_suggestion" | "notification_assessment",
	explicitProviderId?: string,
): Promise<ModelProviderCredential | null> {
	const settings = await readNotificationIntelligenceSettings();
	const binding =
		purpose === "task_name_suggestion" ? settings.taskNameSuggestionBinding : settings.notificationAssessmentBinding;
	const providerId = explicitProviderId ?? binding?.modelProviderId ?? resolveDefaultModelProviderId();
	if (!providerId) return null;
	const access = await resolveKanbanProviderAccess(providerId);
	if (!access || access.profile.providerProtocol !== "openai_compatible") return null;
	const modelId = binding?.modelProviderId === providerId ? binding.modelId : access.profile.defaultModelId;
	if (!modelId || !access.profile.baseUrl) return null;
	return {
		modelProviderId: providerId,
		apiKey: access.apiKey,
		baseUrl: access.profile.baseUrl.replace(/\/+$/u, ""),
		modelId,
	};
}
export async function getNotificationIntelligenceSettings() {
	const persisted = await readPersistedSettings();
	const profiles: KanbanModelProviderProfile[] = [
		...persisted.profiles,
		...listEnvironmentConfiguredProviderProfilesMissingFromPersisted(persisted.profiles),
	];
	const providers = await Promise.all(
		profiles.map(async (profile) => {
			try {
				const access = await resolveKanbanProviderAccess(profile.modelProviderId);
				return {
					...kanbanModelProviderProfileSchema.parse(profile),
					credentialConfigured: Boolean(access),
					credentialStatusMessage: access ? null : "当前来源未配置可用凭据",
				};
			} catch {
				return {
					...kanbanModelProviderProfileSchema.parse(profile),
					credentialConfigured: false,
					credentialStatusMessage: "系统凭据库不可用或已锁定；可切换到环境变量",
				};
			}
		}),
	);
	return { settings: persisted.settings, providers };
}
