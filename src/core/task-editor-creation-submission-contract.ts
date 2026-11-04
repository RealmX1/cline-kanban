import { z } from "zod";
import {
	type RuntimeAgentTerminalGeometryForTaskSessionSpawn,
	type RuntimeBoardCard,
	runtimeAgentTerminalGeometryForTaskSessionSpawnSchema,
	runtimeBoardCardSchema,
	runtimeCreationResolvedSettingsSchema,
} from "./api-contract";
import {
	type WebUiUserDecisionClientCharacteristics,
	webUiUserDecisionClientCharacteristicsSchema,
} from "./work-unit-relation-assertion-write-api-contract";
import {
	type ReferenceRelationModelingDraft,
	referenceRelationModelingDraftSchema,
	referenceRelationModelingRevocationSchema,
} from "./work-unit-relation-modeling-api-contract";

// 仅接收新卡可编辑字段；关闭、历史会话和运行时观测不能从创建表单注入。
export interface TaskEditorCreationSubmissionRequest {
	submissionId: string;
	newTaskCard: RuntimeBoardCard;
	referenceRelationDrafts: ReferenceRelationModelingDraft[];
	relationRevocations: z.infer<typeof referenceRelationModelingRevocationSchema>[];
	startAgentAfterCreation: boolean;
	suggestNameAfterCreation?: boolean;
	agentTerminalGeometryForTaskSessionSpawn?: RuntimeAgentTerminalGeometryForTaskSessionSpawn;
	webUiUserDecisionClientCharacteristics: WebUiUserDecisionClientCharacteristics;
}
export const taskEditorCreationSubmissionRequestSchema: z.ZodType<TaskEditorCreationSubmissionRequest> = z.object({
	submissionId: z.string().uuid(),
	newTaskCard: runtimeBoardCardSchema.in
		.pick({
			id: true,
			title: true,
			prompt: true,
			startInPlanMode: true,
			taskAgentPermissionMode: true,
			autoReviewEnabled: true,
			autoReviewMode: true,
			images: true,
			agentId: true,
			ompAgentSessionTransport: true,
			taskConversationMode: true,
			clineSettings: true,
			terminalAgentModelOverrideSettings: true,
			codexReasoningEffortOverride: true,
			codexConfigurationProfileId: true,
			codexConfigurationPermissionSelectionSource: true,
			taskAgentSessionInitialization: true,
			baseRef: true,
			worktreeMode: true,
			createdAt: true,
			updatedAt: true,
		})
		.extend({ id: z.string().regex(/^[a-z0-9]{5}$/), prompt: z.string().trim().min(1), baseRef: z.string().min(1) })
		.transform((card) => runtimeBoardCardSchema.parse(card)),
	referenceRelationDrafts: z.array(referenceRelationModelingDraftSchema).max(50),
	relationRevocations: z.array(referenceRelationModelingRevocationSchema).max(50),
	startAgentAfterCreation: z.boolean(),
	suggestNameAfterCreation: z.boolean().optional(),
	agentTerminalGeometryForTaskSessionSpawn: runtimeAgentTerminalGeometryForTaskSessionSpawnSchema.optional(),
	webUiUserDecisionClientCharacteristics: webUiUserDecisionClientCharacteristicsSchema,
});

export const taskEditorCreationSubmissionStatusSchema = z.object({
	resolvedSettings: runtimeCreationResolvedSettingsSchema.optional(),
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
export const taskEditorCreationSubmissionLookupSchema = z.object({ submissionId: z.string().uuid() });
export const taskEditorCreationSubmissionsForTaskRequestSchema = z.object({
	taskId: z.string().min(1),
	taskIncarnationCreatedAtEpochMs: z.number(),
});
export const taskEditorCreationSubmissionRetryRequestSchema = taskEditorCreationSubmissionLookupSchema.extend({
	webUiUserDecisionClientCharacteristics: webUiUserDecisionClientCharacteristicsSchema,
});
