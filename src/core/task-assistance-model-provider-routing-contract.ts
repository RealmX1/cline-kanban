import { z } from "zod";

const providerReferenceSchema = z
	.string()
	.trim()
	.regex(/^[a-z0-9-]+$/u)
	.max(80);
/** 模型与凭据由 provider 档案持有；用途路由只保存引用。 */
export const taskAssistanceModelProviderRoutingSettingsSchema = z.object({
	preferredModelProviderId: providerReferenceSchema.default("minimax"),
	fallbackModelProviderId: providerReferenceSchema.nullable().default("deepseek"),
});
export type TaskAssistanceModelProviderRoutingSettings = z.infer<
	typeof taskAssistanceModelProviderRoutingSettingsSchema
>;

export const taskAssistanceModelProviderAttemptSchema = z.object({
	operationId: z.string(),
	stage: z.string(),
	modelUsagePurpose: z.string(),
	modelProviderId: z.string(),
	requestedModelId: z.string().nullable(),
	resolvedModelId: z.string().nullable(),
	outcome: z.enum(["completed", "unavailable", "skipped"]),
	elapsedMs: z.number(),
	inputTokens: z.number().optional(),
	outputTokens: z.number().optional(),
	cacheReadTokens: z.number().optional(),
	cacheWriteTokens: z.number().optional(),
	stablePromptPrefixSha256: z.string(),
	fallbackReason: z.string().optional(),
	failureReason: z.string().optional(),
});
export type TaskAssistanceModelProviderAttempt = z.infer<typeof taskAssistanceModelProviderAttemptSchema>;
