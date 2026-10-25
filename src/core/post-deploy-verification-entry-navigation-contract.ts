import { z } from "zod";

export const postDeployVerificationEntryReferenceSchema = z.object({
	workspaceId: z.string().min(1),
	deploymentId: z.string().min(1),
	taskId: z.string().min(1),
});
export type PostDeployVerificationEntryReference = z.infer<typeof postDeployVerificationEntryReferenceSchema>;

export const postDeployVerificationFollowUpSourceEntryReferenceSchema =
	postDeployVerificationEntryReferenceSchema.extend({
		taskIncarnationCreatedAtEpochMs: z.number().int().nonnegative(),
		selectedChecklistItemIds: z.array(z.string()).default([]),
	});
export type PostDeployVerificationFollowUpSourceEntryReference = z.infer<
	typeof postDeployVerificationFollowUpSourceEntryReferenceSchema
>;

export const runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequestSchema = z.object({
	taskId: z.string().min(1),
});
export type RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequest = z.infer<
	typeof runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsRequestSchema
>;

export const runtimePostDeployVerificationEntryNavigationTargetSchema = z.object({
	entry: postDeployVerificationEntryReferenceSchema,
	navigationKind: z.enum(["task_own_entry", "follow_up_origin_entry"]),
	deployedAtIso: z.string().nullable(),
	availability: z.enum(["retained", "deployment_record_not_retained"]),
	selectedChecklistItemIds: z.array(z.string()),
});
export type RuntimePostDeployVerificationEntryNavigationTarget = z.infer<
	typeof runtimePostDeployVerificationEntryNavigationTargetSchema
>;

export const runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponseSchema = z.object({
	targets: z.array(runtimePostDeployVerificationEntryNavigationTargetSchema),
	// 关系读失败不抹掉仍可确定的自身部署记录，也不能被当成“没有来源”。
	originEntriesReadError: z.string().nullable(),
});
export type RuntimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponse = z.infer<
	typeof runtimeResolveTaskPostDeployVerificationEntryNavigationTargetsResponseSchema
>;
