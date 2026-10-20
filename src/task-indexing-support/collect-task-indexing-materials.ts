import { stat } from "node:fs/promises";
import pLimit from "p-limit";
import {
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
} from "../agent-session-history/bounded-agent-transcript-reader";
import { resolveClaudeTranscriptFileForAgentNativeConversationSession } from "../agent-session-history/claude-transcript-file-location-for-resume";
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TaskIndexingMaterial } from "../core/task-indexing-support-contract";
import { resolveMainTaskConversationSessionId } from "../core/task-main-conversation-session-binding";
import { deriveProjectDisplayNameFromRepoPath } from "../projects/project-display-name";
import {
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceSessionsById,
	loadWorkspaceBoardById,
} from "../state/workspace-state";
import { readLatestNotificationSummaryTextOfTaskCardFromNotificationLifecycleArchive } from "../trpc/work-unit-relation-read-api";

const materialReadConcurrencyLimiter = pLimit(4);

export function readClaudeAwaySummaryFromExistingTranscriptLine(line: string): string | null {
	const record = parseTranscriptJsonRecord(line);
	if (!record || record.isSidechain === true) return null;
	if (record.type === "system" && record.subtype === "away_summary" && typeof record.content === "string")
		return record.content;
	if (record.type === "away_summary" && typeof record.summary === "string") return record.summary;
	return typeof record.away_summary === "string" ? record.away_summary : null;
}

async function readExistingClaudeAwaySummary(
	summary: RuntimeTaskSessionSummary | undefined,
	workspacePath: string,
): Promise<{ text: string | null; missing: string[] }> {
	const identity = summary?.agentNativeConversationSessionIdentity;
	if (identity?.sourceAgentId !== "claude")
		return { text: null, missing: ["claude_away_summary_unavailable_for_this_agent"] };
	try {
		const path =
			identity.transcriptPath ??
			(
				await resolveClaudeTranscriptFileForAgentNativeConversationSession({
					workspacePath,
					agentNativeConversationSessionId: identity.nativeSessionId,
				})
			)?.filePath;
		if (!path) return { text: null, missing: ["claude_transcript_not_found"] };
		const lines = await readBoundedJsonLines(path, (await stat(path)).size, 1024 * 1024);
		let text: string | null = null;
		for (const line of lines.lines) {
			text = readClaudeAwaySummaryFromExistingTranscriptLine(line) ?? text;
		}
		return {
			text,
			missing: [
				...(text ? [] : ["claude_away_summary_not_present"]),
				...(lines.transcriptWasTruncated ? ["claude_transcript_scan_bounded"] : []),
			],
		};
	} catch {
		return { text: null, missing: ["claude_away_summary_read_failed"] };
	}
}

/** 复用看板与会话权威材料，不生成新的摘要；跨项目只需极简目录。 */
export async function collectTaskIndexingMaterials(input: {
	workspaceId: string;
	listLiveSessionSummaries: (workspaceId: string) => readonly RuntimeTaskSessionSummary[];
	includeRecapSources?: boolean;
}): Promise<{ materials: TaskIndexingMaterial[]; missingContextParts: string[] }> {
	const missingContextParts: string[] = [];
	const projects = await listWorkspaceIndexEntries();
	const groups = await Promise.all(
		projects.map((project) =>
			materialReadConcurrencyLimiter(async () => {
				let board: RuntimeBoardData;
				try {
					board = await loadWorkspaceBoardById(project.workspaceId);
				} catch (error) {
					if (project.workspaceId === input.workspaceId) throw error;
					missingContextParts.push(`${project.workspaceId}:board_unreadable`);
					return [];
				}
				const isCurrentProject = project.workspaceId === input.workspaceId && input.includeRecapSources !== false;
				const persisted = isCurrentProject ? await loadPersistedWorkspaceSessionsById(project.workspaceId) : {};
				const summaries = new Map(Object.entries(persisted));
				for (const summary of input.listLiveSessionSummaries(project.workspaceId)) {
					// 空占位摘要不覆盖已持久的真实材料。
					if (summary.startedAt !== null || !summaries.has(summary.taskId)) summaries.set(summary.taskId, summary);
				}
				const materials: TaskIndexingMaterial[] = [];
				for (const column of board.columns)
					for (const card of column.cards) {
						const summary = summaries.get(resolveMainTaskConversationSessionId(card));
						const missing: string[] = [];
						let notification: string | null = null;
						let away: string | null = null;
						if (isCurrentProject) {
							try {
								notification =
									(
										await readLatestNotificationSummaryTextOfTaskCardFromNotificationLifecycleArchive(
											project.workspaceId,
											card.id,
										)
									)?.summaryText ?? null;
							} catch {
								missing.push("notification_archive_unavailable");
							}
							if (!notification) missing.push("latest_notification_summary_text_missing");
							const result = await readExistingClaudeAwaySummary(
								summary,
								summary?.workspacePath ?? project.repoPath,
							);
							away = result.text;
							missing.push(...result.missing);
							if (!summary?.latestHookActivity?.finalMessage) missing.push("latest_hook_final_message_missing");
						}
						materials.push({
							taskReference: {
								workUnitType: "kanban_board_card",
								workspaceId: project.workspaceId,
								taskId: card.id,
								taskIncarnationCreatedAtEpochMs: card.createdAt,
							},
							projectName: deriveProjectDisplayNameFromRepoPath(project.repoPath),
							title: card.title ?? "",
							prompt: card.prompt,
							columnId: column.id,
							latestNotificationSummaryText: notification,
							latestHookFinalMessage: isCurrentProject
								? (summary?.latestHookActivity?.finalMessage ?? null)
								: null,
							claudeAwaySummary: away,
							missingContextParts: missing,
						});
					}
				return materials;
			}),
		),
	);
	if (!projects.some((project) => project.workspaceId === input.workspaceId))
		throw new Error("目标项目尚未注册，不能返回空索引冒充有效材料。");
	return { materials: groups.flat(), missingContextParts: missingContextParts.sort() };
}
