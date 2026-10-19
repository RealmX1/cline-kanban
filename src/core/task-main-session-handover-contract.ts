import { z } from "zod";

export const taskMainSessionHandoverDestinationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("new_codex_session") }),
	z.object({ kind: z.literal("existing_codex_session"), taskConversationSessionId: z.string().min(1) }),
]);

export const taskMainSessionHandoverMaterialSchema = z.object({
	taskTitle: z.string(),
	taskPrompt: z.string(),
	sourceTaskConversationSessionId: z.string(),
	sourceAgentId: z.string(),
	sourceNativeConversationSessionId: z.string().nullable(),
	workspacePath: z.string(),
	currentWorkPhaseGoal: z.string().nullable(),
	planReferences: z.array(
		z.object({
			absolutePath: z.string(),
			approvalStatus: z.enum(["approved", "unconfirmed"]),
			evidenceDescription: z.string(),
		}),
	),
	transcriptReferences: z.array(z.string()),
	lastAgentMessage: z.object({ text: z.string(), sourceReference: z.string() }).nullable(),
	workspaceGitStatus: z.string().nullable(),
	workspaceHeadCommit: z.string().nullable(),
	missingMaterialDescriptions: z.array(z.string()),
	userContextNotes: z.string(),
});
export type TaskMainSessionHandoverMaterial = z.infer<typeof taskMainSessionHandoverMaterialSchema>;

// 正文写持久交接目录；卡片只保存小型控制记录，以免热路径反复广播整份 transcript。
export const taskMainSessionHandoverRecordSchema = z.object({
	handoverId: z.string(),
	sourceTaskConversationSessionId: z.string(),
	targetTaskConversationSessionId: z.string(),
	destination: taskMainSessionHandoverDestinationSchema,
	status: z.enum([
		"waiting_for_sessions_to_stop",
		"report_delivery_pending",
		"awaiting_user_message",
		"failed",
		"cancelled",
		"completed",
	]),
	createdAt: z.number(),
	updatedAt: z.number(),
	userContextNotes: z.string(),
	additionalPlanReferencePaths: z.array(z.string()),
	materialDirectoryPath: z.string().nullable(),
	errorMessage: z.string().nullable(),
	// 在产生任何投递副作用之前持久化；崩溃后的不确定投递不自动重放。
	reportDeliveryStartedAt: z.number().nullable(),
	reportDeliveryAttempt: z.number().int().nonnegative().default(0),
});
export type TaskMainSessionHandoverRecord = z.infer<typeof taskMainSessionHandoverRecordSchema>;

export const taskMainSessionHandoverPrepareRequestSchema = z.object({ taskId: z.string().min(1) });
export const taskMainSessionHandoverRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedMainTaskConversationSessionId: z.string().min(1),
	requestId: z.string().uuid(),
	destination: taskMainSessionHandoverDestinationSchema,
	userContextNotes: z.string().default(""),
	additionalPlanReferencePaths: z.array(z.string().min(1)).default([]),
});
export type TaskMainSessionHandoverRequest = z.infer<typeof taskMainSessionHandoverRequestSchema>;

export const taskMainSessionHandoverPrepareResponseSchema = z.object({
	material: taskMainSessionHandoverMaterialSchema,
	mainTaskConversationSessionId: z.string(),
	codexPeerTaskConversationSessionIds: z.array(z.string()),
	busyTaskConversationSessionIds: z.array(z.string()),
});
export type TaskMainSessionHandoverPrepareResponse = z.infer<typeof taskMainSessionHandoverPrepareResponseSchema>;

export const taskMainSessionHandoverStatusResponseSchema = z.object({
	record: taskMainSessionHandoverRecordSchema.nullable(),
});

export function isTaskMainSessionHandoverSuspendingAutomaticActions(card: {
	taskMainSessionHandover?: TaskMainSessionHandoverRecord;
}): boolean {
	const status = card.taskMainSessionHandover?.status;
	return (
		status === "waiting_for_sessions_to_stop" ||
		status === "report_delivery_pending" ||
		status === "awaiting_user_message" ||
		status === "failed"
	);
}
