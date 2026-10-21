import { z } from "zod";

export const kanbanModelProviderProfileSchema = z.object({
	modelProviderId: z
		.string()
		.regex(/^[a-z0-9-]+$/u)
		.max(80),
	displayName: z.string().min(1).max(100),
	providerProtocol: z.enum(["openai_compatible", "deepinfra", "alibaba"]),
	credentialSource: z.enum(["environment", "system_credential_store"]),
	baseUrl: z.string().url().optional(),
	defaultModelId: z.string().max(200).optional(),
	alibabaRegion: z.enum(["beijing", "singapore"]).default("beijing"),
	alibabaWorkspaceId: z
		.string()
		.regex(/^[a-zA-Z0-9-]+$/u)
		.optional(),
});
export type KanbanModelProviderProfile = z.infer<typeof kanbanModelProviderProfileSchema>;
export const kanbanModelPurposeBindingSchema = z
	.object({ modelProviderId: z.string(), modelId: z.string().min(1) })
	.nullable();
export const notificationIntelligenceSettingsSchema = z.object({
	assessmentEnabled: z.boolean().default(false),
	summaryLanguage: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
	fallbackAfterMinutes: z.number().int().min(1).max(60).default(10),
	taskNameSuggestionBinding: kanbanModelPurposeBindingSchema.default(null),
	independentTaskCreationDraftGenerationBinding: kanbanModelPurposeBindingSchema.optional(),
	notificationAssessmentBinding: kanbanModelPurposeBindingSchema.default(null),
	notificationSpeechBinding: kanbanModelPurposeBindingSchema.default(null),
	speechMode: z.enum(["off", "chime", "summary"]).default("chime"),
	speechProvider: z.enum(["browser", "deepinfra", "alibaba"]).default("browser"),
	speechVoice: z.string().max(100).default(""),
	speechSpeed: z.number().min(0.25).max(4).default(1),
	speechPitch: z.number().min(0.5).max(2).default(1),
	speechVolume: z.number().min(0).max(1).default(1),
	speechStyleInstruction: z.string().max(1000).default(""),
});
export type NotificationIntelligenceSettings = z.infer<typeof notificationIntelligenceSettingsSchema>;
export const kanbanModelProviderProfileStatusSchema = kanbanModelProviderProfileSchema.extend({
	credentialConfigured: z.boolean(),
	credentialStatusMessage: z.string().nullable(),
});
export const notificationIntelligenceSettingsResponseSchema = z.object({
	settings: notificationIntelligenceSettingsSchema,
	providers: z.array(kanbanModelProviderProfileStatusSchema),
});
export const saveKanbanModelProviderProfileRequestSchema = z
	.object({
		profile: kanbanModelProviderProfileSchema,
		apiKey: z.string().trim().min(1).max(8192).optional(),
		deleteSavedCredential: z.boolean().optional(),
	})
	.superRefine((value, context) => {
		if (value.apiKey && (value.deleteSavedCredential || value.profile.credentialSource !== "system_credential_store"))
			context.addIssue({ code: "custom", message: "密钥输入与凭据来源或删除操作冲突" });
	});
