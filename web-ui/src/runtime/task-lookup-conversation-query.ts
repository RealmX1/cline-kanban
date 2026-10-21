import type { RuntimeAppRouterInputs, RuntimeAppRouterOutputs } from "@runtime-trpc";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export type TaskLookupConversation = RuntimeAppRouterOutputs["support"]["getTaskLookupConversation"];
export type TaskLookupCandidate = NonNullable<TaskLookupConversation["turns"][number]["result"]>["candidates"][number];
export type TaskLookupCandidatePreview = RuntimeAppRouterOutputs["support"]["readTaskLookupCandidatePreview"];
export type TaskLookupScope = TaskLookupConversation["scope"];
export type TaskLookupExecutorSettings = RuntimeAppRouterOutputs["support"]["getExecutorSettings"];
export const taskLookupConversationQueries = {
	list: () => getRuntimeTrpcClient(null).support.listTaskLookupConversations.query(),
	get: (conversationId: string) =>
		getRuntimeTrpcClient(null).support.getTaskLookupConversation.query({ conversationId }),
	create: (input: RuntimeAppRouterInputs["support"]["createTaskLookupConversation"]) =>
		getRuntimeTrpcClient(null).support.createTaskLookupConversation.mutate(input),
	submit: (input: RuntimeAppRouterInputs["support"]["submitTaskLookupTurn"]) =>
		getRuntimeTrpcClient(null).support.submitTaskLookupTurn.mutate(input),
	cancel: (conversationId: string) =>
		getRuntimeTrpcClient(null).support.cancelTaskLookupTurn.mutate({ conversationId }),
	preview: (conversationId: string, candidate: TaskLookupCandidate) =>
		getRuntimeTrpcClient(null).support.readTaskLookupCandidatePreview.query({
			conversationId,
			taskReference: candidate.taskReference,
		}),
	getSettings: (workspaceId: string) => getRuntimeTrpcClient(workspaceId).support.getExecutorSettings.query(),
	saveSettings: (workspaceId: string, settings: TaskLookupExecutorSettings) =>
		getRuntimeTrpcClient(workspaceId).support.setExecutorSettings.mutate(settings),
};
