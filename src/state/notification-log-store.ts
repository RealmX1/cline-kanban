// 旧通知 API 的兼容层：永久档案是真相源，清空仅改变面板可见性。
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type RuntimeTaskSessionUserTurnKind, runtimeTaskSessionUserTurnKindSchema } from "../core/api-contract";
import type { NotificationCandidate } from "../core/notification-lifecycle-contract";
import { logAgentSessionRetentionWarning } from "../diagnostics/agent-session-retention-logger";
import { getNotificationLifecycleArchive } from "../notifications/notification-lifecycle-archive";
import { buildNotificationFeedEntries } from "./notification-feed-builder";
import { getWorkspaceDirectoryPath, getWorkspacesRootPath, listWorkspaceIndexEntries } from "./workspace-state";

const legacyEntrySchema = z.object({
	id: z.string(),
	taskId: z.string(),
	userTurnKind: runtimeTaskSessionUserTurnKindSchema,
	triggeredAt: z.number(),
	visitedAt: z.number().nullable(),
});
export type PersistedNotificationEntry = z.infer<typeof legacyEntrySchema> & {
	candidateId?: string;
	notificationPanelVisibility?: NotificationCandidate["notificationPanelVisibility"];
	summaryText?: string;
	taskTitleSnapshot?: string;
	repositoryNameSnapshot?: string;
};
export interface AppendNotificationLogEntryInput {
	taskId: string;
	userTurnKind: RuntimeTaskSessionUserTurnKind;
	triggeredAt: number;
}
function getNotificationLogPath(workspaceId: string): string {
	const workspaceDirectory = resolve(getWorkspaceDirectoryPath(workspaceId));
	if (dirname(workspaceDirectory) !== resolve(getWorkspacesRootPath()))
		throw new Error("Refusing notification log access outside workspaces root");
	return join(workspaceDirectory, "notifications.json");
}
const importedLegacyPaths = new Set<string>();
export async function importLegacyWorkspaceNotifications(workspaceId: string): Promise<void> {
	const sourcePath = getNotificationLogPath(workspaceId);
	if (importedLegacyPaths.has(sourcePath)) return;
	const archive = getNotificationLifecycleArchive();
	if (await archive.hasImportedLegacySource(sourcePath)) {
		importedLegacyPaths.add(sourcePath);
		return;
	}
	let entries: z.infer<typeof legacyEntrySchema>[];
	try {
		entries = z.array(legacyEntrySchema).parse(JSON.parse(await readFile(sourcePath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		// 保留原文件与重试机会；迁移故障不得阻断永久档案，诊断不输出通知正文。
		logAgentSessionRetentionWarning(
			`notification-legacy-import-failed: ${JSON.stringify({ sourcePath, errorType: error instanceof Error ? error.name : "unknown", errorCode: (error as NodeJS.ErrnoException).code })}；原文件未修改，下次访问重试。`,
		);
		return;
	}
	const snapshots = new Map(
		(await buildNotificationFeedEntries(workspaceId, entries)).map((entry) => [entry.id, entry]),
	);
	await archive.importLegacy(
		sourcePath,
		entries.map((entry) => ({
			candidateId: `${workspaceId}:${entry.id}`,
			workspaceId,
			taskId: entry.taskId,
			triggeredAt: entry.triggeredAt,
			userTurnKind: entry.userTurnKind ?? "review",
			sourceKind: "legacy_imported",
			taskTitleSnapshot: snapshots.get(entry.id)?.taskTitle ?? `Task ${entry.taskId}`,
			repositoryNameSnapshot: snapshots.get(entry.id)?.repoName ?? workspaceId,
			rawPayload: entry,
			notificationVisitedAt: entry.visitedAt,
			notificationPanelVisibility: "visible",
			notificationProcessingStatus: "legacy_imported",
		})),
	);
	importedLegacyPaths.add(sourcePath);
}
export function notificationCandidateToPersistedEntry(candidate: NotificationCandidate): PersistedNotificationEntry {
	return {
		id: `${candidate.taskId}:${candidate.triggeredAt}`,
		candidateId: candidate.candidateId,
		taskId: candidate.taskId,
		userTurnKind: runtimeTaskSessionUserTurnKindSchema.parse(candidate.userTurnKind),
		triggeredAt: candidate.triggeredAt,
		visitedAt: candidate.notificationVisitedAt,
		notificationPanelVisibility: candidate.notificationPanelVisibility,
		summaryText: candidate.summaryText,
		taskTitleSnapshot: candidate.taskTitleSnapshot,
		repositoryNameSnapshot: candidate.repositoryNameSnapshot,
	};
}
export async function readNotificationLog(workspaceId: string, limit?: number): Promise<PersistedNotificationEntry[]> {
	await importLegacyWorkspaceNotifications(workspaceId);
	const entries: PersistedNotificationEntry[] = [];
	let beforeSequence: number | undefined;
	do {
		const page = await getNotificationLifecycleArchive().list({
			workspaceId,
			panelOnly: true,
			limit: Math.min(limit ?? 100, 100),
			beforeSequence,
		});
		entries.push(...page.entries.map(notificationCandidateToPersistedEntry));
		beforeSequence = page.nextBeforeSequence ?? undefined;
	} while (beforeSequence && !limit);
	return entries.reverse();
}
export async function readAllNotificationLogs(): Promise<Record<string, PersistedNotificationEntry[]>> {
	const result: Record<string, PersistedNotificationEntry[]> = {};
	for (const entry of await listWorkspaceIndexEntries()) {
		const entries = await readNotificationLog(entry.workspaceId, 50);
		if (entries.length) result[entry.workspaceId] = entries;
	}
	return result;
}
export async function appendNotificationLogEntry(
	workspaceId: string,
	input: AppendNotificationLogEntryInput,
): Promise<void> {
	await importLegacyWorkspaceNotifications(workspaceId);
	const feed = await buildNotificationFeedEntries(workspaceId, [
		{ id: `${input.taskId}:${input.triggeredAt}`, ...input, visitedAt: null },
	]);
	await getNotificationLifecycleArchive().capture({
		taskTitleSnapshot: feed[0]?.taskTitle,
		repositoryNameSnapshot: feed[0]?.repoName,
		candidateId: `${workspaceId}:${input.taskId}:${input.triggeredAt}`,
		workspaceId,
		...input,
		userTurnKind: input.userTurnKind ?? "review",
		sourceKind: "runtime_notification",
		notificationPanelVisibility: "visible",
		notificationProcessingStatus: "published",
	});
}
export async function markTaskNotificationsVisited(
	workspaceId: string,
	taskId: string,
	visitedAt: number,
): Promise<void> {
	await importLegacyWorkspaceNotifications(workspaceId);
	await getNotificationLifecycleArchive().markVisited(workspaceId, taskId, visitedAt);
}
export async function clearNotificationLog(workspaceId: string): Promise<void> {
	await importLegacyWorkspaceNotifications(workspaceId);
	await getNotificationLifecycleArchive().clearPanel(workspaceId);
}
