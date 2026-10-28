import { z } from "zod";

export const TASK_CLOSURE_OUTCOME_LABELS = {
	delivery_accepted: "交付已接受",
	plan_retired: "方案退役",
	implementation_unnecessary: "确认无需实施",
	merged_into_successor_task: "并入其他任务",
	cancelled_by_user: "用户取消",
	closure_outcome_unspecified: "结案结果未标注",
} as const;
export const taskClosureOutcomeSchema = z.enum([
	"delivery_accepted",
	"plan_retired",
	"implementation_unnecessary",
	"merged_into_successor_task",
	"cancelled_by_user",
	"closure_outcome_unspecified",
]);
export type TaskClosureOutcome = z.infer<typeof taskClosureOutcomeSchema>;
export const taskClosureQualifiedTaskReferenceSchema = z.object({
	workspaceId: z.string().min(1),
	taskId: z.string().min(1),
	taskIncarnationCreatedAtEpochMs: z.number().finite(),
});
export const taskClosureDetailsSchema = z
	.object({
		outcome: taskClosureOutcomeSchema,
		reason: z.string().trim().min(1).optional(),
		authorizationSource: z.string().trim().min(1).optional(),
		successorTask: taskClosureQualifiedTaskReferenceSchema.optional(),
		evidence: z.array(z.string().trim().min(1)).default([]),
		acceptedDeliverables: z
			.array(
				z.object({
					description: z.string().trim().min(1),
					evidence: z.array(z.string().trim().min(1)).min(1),
				}),
			)
			.default([]),
	})
	.superRefine((details, context) => {
		if (!["delivery_accepted", "closure_outcome_unspecified"].includes(details.outcome) && !details.reason)
			context.addIssue({ code: "custom", path: ["reason"], message: "此结案结果必须填写原因或判断依据。" });
		if (details.outcome === "merged_into_successor_task" && !details.successorTask)
			context.addIssue({
				code: "custom",
				path: ["successorTask"],
				message: "并入其他任务必须提供承接任务的完整身份。",
			});
		if (details.outcome === "cancelled_by_user" && !details.authorizationSource)
			context.addIssue({ code: "custom", path: ["authorizationSource"], message: "用户取消必须记录授权来源。" });
	});
export type TaskClosureDetails = z.infer<typeof taskClosureDetailsSchema>;
export const taskClosureRequestSchema = z.object({
	closureRequestId: z.string().uuid(),
	expectedTaskUpdatedAtEpochMs: z.number().finite().optional(),
	details: taskClosureDetailsSchema,
	selectedArtifactRelativePaths: z.array(z.string().min(1)).max(100).default([]),
});
export type TaskClosureRequest = z.infer<typeof taskClosureRequestSchema>;
export const taskClosureArchiveManifestSchema = z.object({
	archiveDirectory: z.string(),
	headCommit: z.string().nullable(),
	persistentHeadReference: z.string().nullable(),
	verifiedAtEpochMs: z.number().nullable(),
	availability: z.enum(["verified_recoverable", "no_task_worktree", "historical_artifacts_unavailable"]),
	preservedFileCount: z.number().int().nonnegative(),
	selectedArtifactRelativePaths: z.array(z.string()),
});
export type TaskClosureArchiveManifest = z.infer<typeof taskClosureArchiveManifestSchema>;
export const taskClosureRecordSchema = z.object({
	closureRequestId: z.string().uuid(),
	taskIdentity: taskClosureQualifiedTaskReferenceSchema,
	details: taskClosureDetailsSchema,
	recordedAtEpochMs: z.number().finite(),
	// 行动者由服务端请求证据解析；客户端不能传入此字段。
	actor: z.record(z.string(), z.unknown()),
	eventKind: z.enum(["closed", "outcome_corrected", "reopened"]),
	previousClosureRequestId: z.string().uuid().nullable(),
	isCurrentlyClosed: z.boolean(),
	archiveManifest: taskClosureArchiveManifestSchema,
});
export type TaskClosureRecord = z.infer<typeof taskClosureRecordSchema>;

export function resolveTaskClosureOutcomeForBoardColumn(
	columnId: string,
	summary?: TaskClosureRecord,
): TaskClosureOutcome | null {
	if (columnId !== "trash") return null;
	return summary?.isCurrentlyClosed ? summary.details.outcome : "closure_outcome_unspecified";
}
export const taskClosureOperationProgressSchema = z.object({
	closureRequestId: z.string().uuid(),
	phase: z.enum([
		"preserving",
		"preservation_waiting_for_recovery",
		"archive_verified",
		"closed_cleanup_pending",
		"completed",
		"cancelled",
	]),
	attemptCount: z.number().int().nonnegative(),
	lastError: z.string().nullable(),
	recoveryCondition: z.string().nullable(),
	nextRetryAtEpochMs: z.number().nullable(),
});
export type TaskClosureOperationProgress = z.infer<typeof taskClosureOperationProgressSchema>;
export const taskClosureHistoryRequestSchema = z.object({
	taskId: z.string().min(1),
	expectedTaskIncarnationCreatedAtEpochMs: z.number().finite(),
});
export const taskClosureHistoryResponseSchema = z.object({
	records: z.array(taskClosureRecordSchema),
	operations: z.array(taskClosureOperationProgressSchema),
	reopeningOperations: z
		.array(z.object({ closureRequestId: z.string().uuid(), phase: z.string(), lastError: z.string().nullable() }))
		.optional(),
});
export const taskClosureOutcomeCorrectionRequestSchema = taskClosureHistoryRequestSchema.extend({
	closure: taskClosureRequestSchema,
	expectedPreviousClosureRequestId: z.string().uuid().nullable(),
});
export const taskClosureArchiveCleanupCredentialSchema = z.object({
	taskIncarnationCreatedAtEpochMs: z.number().finite(),
	closureRequestId: z.string().uuid(),
});
