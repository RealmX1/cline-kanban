import { z } from "zod";

export const TASK_VISUALIZATION_PUBLICATION_PROTOCOL_VERSION = "task-visualization-artifacts/v1" as const;

export const taskVisualizationTaskAttributionSchema = z.object({
	workspaceId: z.string(),
	taskId: z.string(),
	taskTitle: z.string().nullable(),
});
export type TaskVisualizationTaskAttribution = z.infer<typeof taskVisualizationTaskAttributionSchema>;

export const taskVisualizationArtifactIdentifierSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const taskVisualizationPublicationRequestIdSchema = z.string().uuid();
export const taskVisualizationPublicationRejectionCodeSchema = z.enum(["BAD_REQUEST", "NOT_FOUND", "FORBIDDEN"]);
export const taskVisualizationPublicationStagingSequenceSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);
export const taskVisualizationRelativePathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) =>
			!/[\\\0:]/u.test(value) &&
			!value.startsWith("/") &&
			value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
		"可视化资源必须使用包内相对路径。",
	);
export const taskVisualizationArtifactSchema = z.object({
	workspaceId: z.string(),
	taskId: z.string(),
	visualizationArtifactId: taskVisualizationArtifactIdentifierSchema,
	title: z.string().min(1).max(200),
	taskTitleAtPublication: z.string().min(1).optional(),
	entryHtmlRelativePath: taskVisualizationRelativePathSchema,
	revisionId: taskVisualizationArtifactIdentifierSchema,
	versionNumber: z.number().int().positive(),
	publishedAtMs: z.number(),
	latestSourcePublicationStagedAtMs: z.number().optional(),
	latestSourcePublicationStagingSequence: taskVisualizationPublicationStagingSequenceSchema.optional(),
	sourceConversationSessionId: z.string().nullable(),
});
export type TaskVisualizationArtifact = z.infer<typeof taskVisualizationArtifactSchema>;

export const taskVisualizationPreviewRequestSchema = z.object({
	previewRequestId: z.string().uuid(),
	visualizationArtifactId: taskVisualizationArtifactIdentifierSchema,
	revisionId: taskVisualizationArtifactIdentifierSchema,
	requestedAtMs: z.number(),
	displayedAtMs: z.number().nullable(),
	dismissedAtMs: z.number().nullable().optional(),
	deliveryAttemptCount: z.number().int().nonnegative().optional(),
	attemptedBrowserPageIds: z.array(z.string().uuid()).optional(),
	acceptedDeliveryAttemptId: z.string().uuid().optional(),
	acceptedByBrowserPageId: z.string().uuid().optional(),
	acceptedAtMs: z.number().optional(),
	failedAtMs: z.number().optional(),
	deliveryFailureReason: z.string().optional(),
});
export type TaskVisualizationPreviewRequest = z.infer<typeof taskVisualizationPreviewRequestSchema>;

export const taskVisualizationPublishRequestSchema = z.object({
	taskId: z.string().min(1),
	publicationRequestId: taskVisualizationPublicationRequestIdSchema,
});
export const taskVisualizationPublishResponseSchema = z.object({
	artifact: taskVisualizationArtifactSchema,
	isNewRevision: z.boolean(),
	wasSupersededByNewerPublication: z.boolean(),
	viewerRelativeUrl: z.string(),
});
export const taskVisualizationListRequestSchema = z.object({ taskId: z.string().min(1) });
export const taskVisualizationListResponseSchema = z.object({
	artifacts: z.array(taskVisualizationArtifactSchema),
	taskAttribution: taskVisualizationTaskAttributionSchema,
	latestPreviewRequest: taskVisualizationPreviewRequestSchema.nullable().optional(),
	visualizationPublicationProtocolVersion: z.literal(TASK_VISUALIZATION_PUBLICATION_PROTOCOL_VERSION),
});
export const taskVisualizationSelectArtifactRequestSchema = z.object({
	taskId: z.string().min(1),
	visualizationArtifactId: taskVisualizationArtifactIdentifierSchema,
	revisionId: taskVisualizationArtifactIdentifierSchema.optional(),
});
export const taskVisualizationPreparePreviewResponseSchema = z.object({
	artifact: taskVisualizationArtifactSchema,
	taskAttribution: taskVisualizationTaskAttributionSchema,
	contentRelativeUrl: z.string(),
	viewerRelativeUrl: z.string(),
	contentAccessExpiresAtMs: z.number(),
	contentLoadConfirmationId: z.string().uuid(),
});
export const taskVisualizationRequestPreviewResponseSchema = z.object({ previewRequestId: z.string().uuid() });

export const taskVisualizationBrowserContextMessageSchema = z.object({
	type: z.literal("declare_task_visualization_browser_context"),
	browserPageId: z.string().uuid(),
	taskId: z.string().nullable(),
	isForeground: z.boolean(),
	interactionSequence: z.number().int().nonnegative(),
	previewDeliveryProtocolVersion: z.literal("page-acceptance-and-content-confirmation/v1").optional(),
});
export const taskVisualizationPreviewAcknowledgmentMessageSchema = z.object({
	type: z.literal("acknowledge_task_visualization_preview"),
	browserPageId: z.string().uuid(),
	taskId: z.string(),
	previewRequestId: z.string().uuid(),
	deliveryAttemptId: z.string().uuid(),
	outcome: z.enum(["accepted", "displayed", "declined", "dismissed", "failed"]),
	failureReason: z.string().max(500).optional(),
});
export type TaskVisualizationBrowserContextMessage = z.infer<typeof taskVisualizationBrowserContextMessageSchema>;
export type TaskVisualizationPreviewAcknowledgmentMessage = z.infer<
	typeof taskVisualizationPreviewAcknowledgmentMessageSchema
>;
export const taskVisualizationArtifactsUpdatedMessageSchema = z.object({
	type: z.literal("task_visualization_artifacts_updated"),
	workspaceId: z.string(),
	taskId: z.string(),
});
export const taskVisualizationPreviewRequestedMessageSchema = z.object({
	type: z.literal("task_visualization_preview_requested"),
	workspaceId: z.string(),
	taskId: z.string(),
	browserPageId: z.string().uuid(),
	deliveryAttemptId: z.string().uuid(),
	deliveryState: z.enum(["offered", "accepted", "cancelled"]),
	deliveryFailureReason: z.string().optional(),
	previewRequest: taskVisualizationPreviewRequestSchema,
});
export type TaskVisualizationPreviewRequestedMessage = z.infer<typeof taskVisualizationPreviewRequestedMessageSchema>;
