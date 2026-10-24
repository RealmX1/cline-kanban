import { z } from "zod";

export const runtimeCodexConversationStorageOperationRequestSchema = z.object({
	operation: z.enum(["status", "migrate_stopped", "rollback_stopped"]),
	conversationSessionId: z.string().min(1).optional(),
});
export type RuntimeCodexConversationStorageOperationRequest = z.infer<
	typeof runtimeCodexConversationStorageOperationRequestSchema
>;
export const runtimeCodexConversationStorageOperationResponseSchema = z.object({
	entries: z.array(
		z.object({
			conversationSessionId: z.string(),
			agentProcessId: z.number().int().positive().nullable(),
			nativeSessionId: z.string().nullable(),
			homeDirectoryPath: z.string().nullable(),
			status: z.enum(["active_deferred", "eligible", "isolated", "migrated", "rolled_back", "refused"]),
			message: z.string(),
		}),
	),
});
export type RuntimeCodexConversationStorageOperationResponse = z.infer<
	typeof runtimeCodexConversationStorageOperationResponseSchema
>;
