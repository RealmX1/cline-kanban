import { taskEditorCreationSubmissionRequestSchema } from "@runtime-task-editor-creation-submission-contract";
import { z } from "zod";
import {
	readTaskEditorCreationSubmissionStatus,
	submitTaskEditorCreation,
} from "@/runtime/task-editor-creation-submission-query";

const pendingSubmissionSchema = z.object({
	workspaceId: z.string(),
	request: taskEditorCreationSubmissionRequestSchema,
	editorInputSnapshot: z.string(),
	editorDraftWasExplicitlyDiscarded: z.boolean().optional(),
	openTaskAfterPersistence: z.boolean(),
	keepEditorOpenAfterPersistence: z.boolean().default(false),
	batchPromptsAfterCurrentCard: z.array(z.string()).nullable().default(null),
	keepEditorOpenAfterBatchCompletion: z.boolean().default(false),
});
export type PendingTaskEditorCreationSubmission = z.infer<typeof pendingSubmissionSchema>;
export function taskEditorPendingCreationStorageKey(sourceWorkspaceId: string) {
	const ownerId = sessionStorage.getItem("reference-relation-modeling-browser-tab-identity") ?? "default";
	return `task-editor-pending-creation-submission:${sourceWorkspaceId}:${ownerId}`;
}
export function readPendingTaskEditorCreationSubmission(key: string) {
	const text = localStorage.getItem(key);
	return text ? pendingSubmissionSchema.parse(JSON.parse(text)) : null;
}
export function savePendingTaskEditorCreationSubmission(key: string, pending: PendingTaskEditorCreationSubmission) {
	localStorage.setItem(key, JSON.stringify(pending));
}
export function clearConfirmedPendingTaskEditorCreationSubmission(key: string, submissionId: string) {
	if (readPendingTaskEditorCreationSubmission(key)?.request.submissionId === submissionId)
		localStorage.removeItem(key);
}
export async function confirmTaskEditorCreationCardPersistence(pending: PendingTaskEditorCreationSubmission) {
	let lastFailure = "尚未确认任务保存，原输入与提交身份已保留。";
	// 先查原请求；请求未受理时才重投冻结输入，同一 ID 在服务端幂等处理。
	for (let requestAttempt = 0; requestAttempt < 3; requestAttempt++) {
		try {
			let status = await readTaskEditorCreationSubmissionStatus(pending.workspaceId, pending.request.submissionId);
			if (!status) status = await submitTaskEditorCreation(pending.workspaceId, pending.request);
			for (let poll = 0; poll < 40; poll++) {
				if (status?.cardPersisted) return status;
				if (status?.phase === "identity_conflict" || status?.phase === "stopped")
					throw new Error(status.lastError ?? "提交已停止。");
				if (status?.phase === "waiting_for_dependency") throw new Error(status.lastError ?? lastFailure);
				await new Promise((resolve) => setTimeout(resolve, 250));
				status = await readTaskEditorCreationSubmissionStatus(pending.workspaceId, pending.request.submissionId);
			}
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
		}
	}
	throw new Error(`尚未确认保存，已保留原请求供核验：${lastFailure}`);
}
