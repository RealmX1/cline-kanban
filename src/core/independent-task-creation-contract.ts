import { z } from "zod";

export const independentTaskWorktreeSourceSchema = z.enum([
	"local_main_immediately",
	"local_main_after_source_task_landed",
	"copy_source_git_working_state_immediately",
]);
export const independentTaskContextInheritanceSchema = z.enum(["fork_source_conversation", "fresh_conversation"]);

// 来源是可追溯事实，不自动赋予子任务、覆盖或依赖关系。
export const independentTaskCreationProvenanceSchema = z.object({
	creationRequestId: z.string().uuid(),
	sourceWorkspaceId: z.string(),
	sourceTaskId: z.string(),
	sourceTaskIncarnationCreatedAtEpochMs: z.number().optional(),
	sourceTaskConversationSessionId: z.string(),
	sourceNativeSessionId: z.string().nullable(),
	sourceContextCapturedAt: z.number(),
	contextInheritance: independentTaskContextInheritanceSchema,
	worktreeSource: independentTaskWorktreeSourceSchema,
	contextArtifactDirectory: z.string(),
	inheritedGitHeadCommit: z.string().optional(),
	inheritedGitWorkingStateIncludedUncommittedChanges: z.boolean().optional(),
});
export type IndependentTaskCreationProvenance = z.infer<typeof independentTaskCreationProvenanceSchema>;

export const independentTaskCreationDraftRequestSchema = z.object({
	sourceTaskId: z.string().min(1),
	sourceTaskConversationSessionId: z.string().min(1),
	requestId: z.string().uuid(),
});
export const independentTaskCreationDraftEditSchema = z.object({
	requestId: z.string().uuid(),
	userTaskDescription: z.string(),
	title: z.string().max(80),
	initialPrompt: z.string(),
	titleWasEditedByUser: z.boolean(),
	initialPromptWasEditedByUser: z.boolean(),
	contextInheritance: independentTaskContextInheritanceSchema,
	worktreeSource: independentTaskWorktreeSourceSchema,
	modelProviderId: z.string().optional(),
	generationSource: z.enum(["kanban_model_provider", "source_agent_fork"]).default("kanban_model_provider"),
	expectedRevision: z.number().int().nonnegative(),
});

export const independentTaskCreationDraftSchema = z.object({
	requestId: z.string().uuid(),
	sourceTaskId: z.string(),
	sourceTaskConversationSessionId: z.string(),
	revision: z.number().int().nonnegative(),
	status: z.enum(["waiting_for_source_turn", "ready", "generating", "creating", "created"]),
	userTaskDescription: z.string(),
	suggestedTaskDescription: z.string(),
	title: z.string(),
	initialPrompt: z.string(),
	titleWasEditedByUser: z.boolean(),
	initialPromptWasEditedByUser: z.boolean(),
	contextInheritance: independentTaskContextInheritanceSchema,
	worktreeSource: independentTaskWorktreeSourceSchema,
	modelProviderId: z.string().optional(),
	generationSource: z.enum(["kanban_model_provider", "source_agent_fork"]).default("kanban_model_provider"),
	sourceAgentGenerationUnavailableReason: z.string().nullable().default(null),
	generatedFromDescription: z.string().nullable(),
	contextCapturedAt: z.number().nullable(),
	contextWarnings: z.array(z.string()),
	forkUnavailableReason: z.string().nullable(),
	sourceGitStatus: z.string(),
	sourceCommitsNotInLocalMain: z.number().nullable(),
	errorMessage: z.string().nullable(),
	createdTaskId: z.string().nullable(),
});
export type IndependentTaskCreationDraft = z.infer<typeof independentTaskCreationDraftSchema>;
export type IndependentTaskCreationDraftEdit = z.infer<typeof independentTaskCreationDraftEditSchema>;

export const independentTaskCreationListRequestSchema = z.object({
	sourceTaskId: z.string().min(1),
	sourceTaskConversationSessionId: z.string().optional(),
});
export const independentTaskCreationListResponseSchema = z.object({
	tasks: z.array(z.object({ taskId: z.string(), title: z.string(), sourceTaskConversationSessionId: z.string() })),
});
