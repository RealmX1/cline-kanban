import { z } from "zod";

export const taskEditorCreationSubmissionStatusSchema = z.object({
	submissionId: z.string().uuid(),
	workspaceId: z.string(),
	taskId: z.string(),
	taskIncarnationCreatedAtEpochMs: z.number(),
	cardPersisted: z.boolean(),
	relationsCompleted: z.boolean(),
	startRequested: z.boolean(),
	startCompleted: z.boolean(),
	phase: z.enum([
		"saving_card",
		"saving_relations",
		"starting_agent",
		"completed",
		"waiting_for_dependency",
		"waiting_for_evidence",
		"waiting_for_authorization",
		"stopped",
		"identity_conflict",
	]),
	lastError: z.string().nullable(),
	recoveryCondition: z.string().nullable(),
	attemptsInCurrentRecoveryRound: z.number().int().min(0).max(3),
	acceptedAtEpochMs: z.number(),
	updatedAtEpochMs: z.number(),
});
export type TaskEditorCreationSubmissionStatus = z.infer<typeof taskEditorCreationSubmissionStatusSchema>;
