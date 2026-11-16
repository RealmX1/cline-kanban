import { z } from "zod";

export const duplicateProjectConsolidationControlSchema = z.object({
	schemaVersion: z.literal(1).default(1),
	operationId: z.string().uuid(),
	sourceWorkspaceId: z.string(),
	targetWorkspaceId: z.string(),
	sourceRepositoryPath: z.string(),
	targetRepositoryPath: z.string(),
	status: z.enum(["quiescing", "captured", "tasks_transferred", "completed"]),
	tasks: z.array(z.object({ taskId: z.string(), createdAt: z.number() })),
});
export type DuplicateProjectConsolidationControl = z.infer<typeof duplicateProjectConsolidationControlSchema>;

export const duplicateProjectConsolidationPreviewRequestSchema = z.object({
	sourceWorkspaceId: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
	targetWorkspaceId: z.string().regex(/^[a-zA-Z0-9_-]+$/u),
});
export const duplicateProjectConsolidationRequestSchema = duplicateProjectConsolidationPreviewRequestSchema.extend({
	previewFingerprint: z.string().min(1),
});
export const duplicateProjectConsolidationPreviewSchema = duplicateProjectConsolidationPreviewRequestSchema.extend({
	sourceRepositoryPath: z.string(),
	targetRepositoryPath: z.string(),
	gitCommonDirectory: z.string(),
	sourceBoardFingerprint: z.string(),
	previewFingerprint: z.string(),
	tasks: z.array(z.object({ taskId: z.string(), title: z.string(), columnId: z.string(), createdAt: z.number() })),
});
export const duplicateProjectConsolidationResultSchema = z.object({
	ok: z.literal(true),
	operationId: z.string(),
	sourceWorkspaceId: z.string(),
	targetWorkspaceId: z.string(),
	status: z.literal("completed"),
	taskIds: z.array(z.string()),
	receiptPath: z.string(),
});
