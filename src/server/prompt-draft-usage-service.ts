import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import {
	readTaskUserPromptHistoryForDraftUsage,
	type TaskUserPromptForDraftUsage,
} from "../agent-session-history/task-user-prompt-history-for-draft-usage";
import type { RuntimeAgentNativeConversationSessionIdentity, StoredPromptLibraryEntry } from "../core/api-contract";
import { matchPromptDraftAgainstSubmittedUserPrompt } from "../core/prompt-draft-user-prompt-matching";
import { lockedFileSystem } from "../fs/locked-file-system";
import {
	mutateWorkspacePromptLibrary,
	readWorkspacePromptLibrarySnapshotForUsageDetection,
} from "../state/prompt-library-store";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { listWorkspaceIndexEntries, loadPersistedWorkspaceSessionsById } from "../state/workspace-state";

export interface PromptDraftUsageSubmission {
	workspaceId: string;
	taskId: string;
	submittedAtEpochMs: number;
	submittedPromptText?: string;
	currentIdentity?: RuntimeAgentNativeConversationSessionIdentity | null;
	sourceAgentId?: string;
}

interface PromptDraftUsageServiceDependencies {
	readLibrary?: typeof readWorkspacePromptLibrarySnapshotForUsageDetection;
	mutateLibrary?: typeof mutateWorkspacePromptLibrary;
	readHistory?: typeof readTaskUserPromptHistoryForDraftUsage;
	listTaskConversationSessionIds?: (workspaceId: string, workspaceTaskId: string) => Promise<string[]>;
	warn: (message: string) => void;
}

const historicalBackfillProgressSchema = z.object({
	schemaVersion: z.literal(1),
	checkedTaskKeys: z.array(z.string()),
	completedAtEpochMs: z.number().nullable(),
	skippedHistoryWarnings: z.array(z.object({ workspaceId: z.string(), taskId: z.string(), warning: z.string() })),
});

function isUnusedPromptDraft(entry: StoredPromptLibraryEntry): boolean {
	return (
		entry.entryKind !== "reusable_command" &&
		entry.draftUsage?.markedUsedAtEpochMs == null &&
		entry.text.trim().length > 0
	);
}

/** 仅提交边沿驱动；全进程串行，合并任务的待检查提交，不轮询、不阻塞 hook。 */
export function createPromptDraftUsageService(deps: PromptDraftUsageServiceDependencies) {
	const readLibrary = deps.readLibrary ?? readWorkspacePromptLibrarySnapshotForUsageDetection;
	const mutateLibrary = deps.mutateLibrary ?? mutateWorkspacePromptLibrary;
	const readHistory = deps.readHistory ?? readTaskUserPromptHistoryForDraftUsage;
	const listTaskConversationSessionIds =
		deps.listTaskConversationSessionIds ??
		(async (workspaceId, workspaceTaskId) => {
			const summaries = await loadPersistedWorkspaceSessionsById(workspaceId);
			return [
				workspaceTaskId,
				...Object.values(summaries)
					.filter((summary) => summary.taskConversationSessionMetadata?.workspaceTaskId === workspaceTaskId)
					.map((summary) => summary.taskId),
			];
		});
	const pendingSubmissionsByTaskKey = new Map<string, PromptDraftUsageSubmission[]>();
	let closed = false;
	let running: Promise<void> | null = null;
	let backfill: Promise<void> | null = null;
	let reconciliationTail: Promise<unknown> = Promise.resolve();
	function serializeReconciliation(submissions: PromptDraftUsageSubmission[]): Promise<string[]> {
		const operation = reconciliationTail.then(() => reconcile(submissions));
		reconciliationTail = operation.catch(() => {});
		return operation;
	}

	async function reconcile(submissions: PromptDraftUsageSubmission[]): Promise<string[]> {
		const latest = submissions[submissions.length - 1];
		const snapshot = await readLibrary(latest.workspaceId);
		const conversationSessionIds = await listTaskConversationSessionIds(latest.workspaceId, latest.taskId);
		const candidates = [
			...snapshot.globalScopedPrompts,
			...snapshot.repoScopedPrompts,
			...[...new Set(conversationSessionIds)].flatMap(
				(sessionId) => snapshot.taskScopedPromptsByTaskId[sessionId] ?? [],
			),
		].filter(isUnusedPromptDraft);
		if (candidates.length === 0 || closed) return [];
		const pending = new Map(candidates.map((entry) => [entry.id, entry]));
		const checkPrompt = async (prompt: TaskUserPromptForDraftUsage) => {
			for (const [id, entry] of pending) {
				if (closed) return;
				const cutoff = entry.draftUsage?.ignoreUserPromptsSubmittedAtOrBeforeEpochMs ?? null;
				if (cutoff !== null && (prompt.submittedAtEpochMs === null || prompt.submittedAtEpochMs <= cutoff))
					continue;
				const matchKind = matchPromptDraftAgainstSubmittedUserPrompt(entry.text, prompt.text);
				if (matchKind) {
					await mutateLibrary(latest.workspaceId, {
						kind: "mark_prompt_used_from_user_prompt_match",
						promptId: id,
						expectedPromptTextSha256: createHash("sha256").update(entry.text).digest("hex"),
						expectedIgnoreUserPromptsSubmittedAtOrBeforeEpochMs: cutoff,
						evidence: {
							workspaceId: latest.workspaceId,
							taskId: latest.taskId,
							sourceAgentId: prompt.sourceAgentId,
							nativeSessionId: prompt.nativeSessionId,
							userPromptMessageId: prompt.messageId,
							userPromptSubmittedAtEpochMs: prompt.submittedAtEpochMs,
							matchKind,
						},
					});
					pending.delete(id);
				}
				// 每对文本最多 200 万格；配对之间主动让出主事件循环。
				await setImmediate();
			}
		};
		for (const submission of submissions) {
			if (!submission.submittedPromptText) continue;
			await checkPrompt({
				text: submission.submittedPromptText,
				sourceAgentId: submission.currentIdentity?.sourceAgentId ?? submission.sourceAgentId ?? "unknown",
				nativeSessionId: submission.currentIdentity?.nativeSessionId ?? null,
				messageId: `submission:${createHash("sha256").update(`${submission.submittedAtEpochMs}:${submission.submittedPromptText}`).digest("hex")}`,
				submittedAtEpochMs: submission.submittedAtEpochMs,
			});
		}
		if (pending.size === 0 || closed) return [];
		const history = await readHistory({
			workspaceId: latest.workspaceId,
			taskId: latest.taskId,
			currentIdentity: latest.currentIdentity,
			isCancelled: () => closed,
		});
		for await (const prompt of history.prompts) {
			await checkPrompt(prompt);
			if (pending.size === 0 || closed) break;
		}
		return history.warnings;
	}

	const taskKey = (input: { workspaceId: string; taskId: string }) =>
		JSON.stringify([input.workspaceId, input.taskId]);
	function startPendingChecks(): void {
		if (running || closed) return;
		running = (async () => {
			while (pendingSubmissionsByTaskKey.size > 0 && !closed) {
				const first = pendingSubmissionsByTaskKey.entries().next().value;
				if (!first) break;
				const [key, submissions] = first;
				pendingSubmissionsByTaskKey.delete(key);
				try {
					const warnings = await serializeReconciliation(submissions);
					if (warnings.length > 0)
						deps.warn(`prompt-draft-usage-history-partial task=${key} warnings=${warnings.join(",")}`);
				} catch {
					deps.warn(`prompt-draft-usage-check-failed task=${key}`);
				}
			}
		})().finally(() => {
			running = null;
			if (pendingSubmissionsByTaskKey.size > 0 && !closed) startPendingChecks();
		});
	}

	async function whenIdle(): Promise<void> {
		while (running) await running;
	}

	async function runInitialHistoricalBackfill(): Promise<void> {
		const progressPath = join(getRuntimeHomePath(), "prompt-draft-usage-historical-backfill-v1.json");
		await lockedFileSystem.withLock({ path: progressPath, type: "file", retries: 0 }, async () => {
			let progress: z.infer<typeof historicalBackfillProgressSchema>;
			try {
				progress = historicalBackfillProgressSchema.parse(JSON.parse(await readFile(progressPath, "utf8")));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				progress = { schemaVersion: 1, checkedTaskKeys: [], completedAtEpochMs: null, skippedHistoryWarnings: [] };
			}
			if (progress.completedAtEpochMs !== null) return;
			const checked = new Set(progress.checkedTaskKeys);
			for (const workspace of await listWorkspaceIndexEntries()) {
				if (closed) return;
				const library = await readLibrary(workspace.workspaceId);
				const summaries = await loadPersistedWorkspaceSessionsById(workspace.workspaceId);
				const tasks = new Set([
					...Object.keys(library.taskScopedPromptsByTaskId),
					...Object.values(summaries).map(
						(summary) => summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId,
					),
				]);
				for (const taskId of tasks) {
					if (closed) return;
					const submission = { workspaceId: workspace.workspaceId, taskId, submittedAtEpochMs: Date.now() };
					const key = taskKey(submission);
					if (checked.has(key)) continue;
					await whenIdle();
					const warnings = await serializeReconciliation([submission]);
					if (closed) return;
					for (const warning of warnings)
						progress.skippedHistoryWarnings.push({ workspaceId: workspace.workspaceId, taskId, warning });
					checked.add(key);
					progress.checkedTaskKeys = [...checked];
					await lockedFileSystem.writeJsonFileAtomic(progressPath, progress, { lock: null });
				}
			}
			if (closed) return;
			progress.completedAtEpochMs = Date.now();
			await lockedFileSystem.writeJsonFileAtomic(progressPath, progress, { lock: null });
			if (progress.skippedHistoryWarnings.length > 0)
				deps.warn(
					`prompt-draft-usage-backfill-completed-with-skipped-history count=${progress.skippedHistoryWarnings.length} report=${progressPath}`,
				);
		});
	}

	return {
		notifyUserPromptSubmitted(input: PromptDraftUsageSubmission): void {
			if (closed) return;
			const key = taskKey(input);
			pendingSubmissionsByTaskKey.set(key, [...(pendingSubmissionsByTaskKey.get(key) ?? []), input]);
			startPendingChecks();
		},
		whenIdle,
		startInitialHistoricalBackfill(): void {
			if (backfill || closed) return;
			backfill = runInitialHistoricalBackfill().catch(() => {
				deps.warn("prompt-draft-usage-backfill-incomplete-or-running-in-another-instance");
			});
		},
		async waitForInitialHistoricalBackfill(): Promise<void> {
			await backfill;
		},
		async close(): Promise<void> {
			closed = true;
			pendingSubmissionsByTaskKey.clear();
			await Promise.all([running, backfill]);
		},
	};
}
