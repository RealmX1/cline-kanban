import type { Command } from "commander";
import {
	type LegacyNativeHistoryResolution,
	localNativeHistorySourceInstanceId,
	nativeHistoryOwnershipFingerprint,
} from "../agent-session-history/legacy-native-history-source";
import { openNativeHistoryArchiveAudit } from "../agent-session-history/native-history-audit-archive";
import { loadTaskConversationHistoryPage } from "../agent-session-history/task-conversation-history-page";
import type { RuntimeTaskConversationHistoryPageResponse } from "../core/api-contract";
import { resolveCliHardTimeoutOverrideMs } from "../core/cli-process-guards";
import { doesConversationSessionBelongToTask } from "../core/task-main-conversation-session-binding";
import { resolveProjectInputPath } from "../projects/project-path";
import { removeTaskSessionSummariesOwnedByOtherWorkspaces } from "../state/task-session-summaries-owned-by-other-workspaces-removal";
import {
	getTaskWorktreesHomePath,
	loadPersistedWorkspaceStateById,
	loadWorkspaceContext,
} from "../state/workspace-state";

interface TaskNativeHistoryAuditOptions {
	projectPath: string;
	taskId?: string[];
	archiveDirectory?: string;
	archiveSourceManifest?: string;
	archiveSourceInstanceId?: string;
	includeArchiveMessages?: boolean;
}

const defaultNativeHistoryAuditWorkBudgetMs = 10 * 60_000;
const nativeHistoryAuditReportFinalizationReserveMs = 5_000;

async function readWithinNativeHistoryAuditDeadline<Result>(deadline: number, read: () => Promise<Result>) {
	const remainingMs = Math.ceil(deadline - performance.now());
	if (remainingMs <= 0) return undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			new Promise<undefined>((resolve) => {
				timeout = setTimeout(resolve, remainingMs, undefined);
			}),
			read(),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

export async function auditTaskNativeHistory(options: TaskNativeHistoryAuditOptions) {
	const hardTimeoutMs = resolveCliHardTimeoutOverrideMs();
	const workBudgetMs =
		hardTimeoutMs === undefined
			? defaultNativeHistoryAuditWorkBudgetMs
			: hardTimeoutMs - Math.min(nativeHistoryAuditReportFinalizationReserveMs, Math.ceil(hardTimeoutMs / 5));
	const auditWorkDeadline = performance.now() + workBudgetMs;
	const archiveArguments = [options.archiveDirectory, options.archiveSourceManifest, options.archiveSourceInstanceId];
	if ((archiveArguments.some(Boolean) || options.includeArchiveMessages) && !archiveArguments.every(Boolean))
		throw new Error(
			"归档核验需要同时指定 --archive-directory、--archive-source-manifest、--archive-source-instance-id。",
		);
	const archiveAudit =
		options.archiveDirectory && options.archiveSourceManifest && options.archiveSourceInstanceId
			? await openNativeHistoryArchiveAudit({
					archiveDirectory: options.archiveDirectory,
					sourceManifestPath: options.archiveSourceManifest,
					expectedSourceInstanceId: options.archiveSourceInstanceId,
					includeMessages: options.includeArchiveMessages === true,
				})
			: undefined;
	const workspace = await loadWorkspaceContext(resolveProjectInputPath(options.projectPath, process.cwd()), {
		autoCreateIfMissing: false,
	});
	const scope = { workspaceId: workspace.workspaceId, workspacePath: workspace.repoPath };
	const state = await loadPersistedWorkspaceStateById(scope.workspaceId);
	const sessions = removeTaskSessionSummariesOwnedByOtherWorkspaces({
		workspaceId: scope.workspaceId,
		workspaceRepositoryPath: scope.workspacePath,
		taskWorktreesHomePath: getTaskWorktreesHomePath(),
		sessions: state.sessions,
	}).sessionsWithoutSummariesOwnedByOtherWorkspaces;
	const requestedTaskIds = [...new Set(options.taskId ?? [])].sort();
	const cards = state.board.columns
		.flatMap((column) => column.cards)
		.filter((card) => !requestedTaskIds.length || requestedTaskIds.includes(card.id))
		.sort((left, right) => left.id.localeCompare(right.id, "en"));
	const rows = [];
	const ownershipFingerprints = new Map<string, string>();
	const tasksWithoutNativeSessions = [];
	const coveredConversationSessionIds = new Set<string>();
	let firstCardIndexWithUnverifiedAuditWork: number | undefined;
	auditCards: for (const [cardIndex, card] of cards.entries()) {
		if (performance.now() >= auditWorkDeadline) {
			firstCardIndexWithUnverifiedAuditWork = cardIndex;
			break;
		}
		const taskSessions = Object.values(sessions)
			.filter(
				(summary) =>
					doesConversationSessionBelongToTask(summary, card.id) &&
					(summary.agentId === "codex" || summary.agentId === "claude"),
			)
			.sort((left, right) => left.taskId.localeCompare(right.taskId, "en"));
		if (!taskSessions.length) tasksWithoutNativeSessions.push(card.id);
		for (const summary of taskSessions) {
			const agentId = summary.agentId;
			if (agentId !== "codex" && agentId !== "claude") continue;
			coveredConversationSessionIds.add(summary.taskId);
			ownershipFingerprints.set(summary.taskId, nativeHistoryOwnershipFingerprint(card, summary, sessions));
			const resolution: { result?: LegacyNativeHistoryResolution } = {};
			const readPage = (cursor: string | null) =>
				readWithinNativeHistoryAuditDeadline(auditWorkDeadline, () =>
					loadTaskConversationHistoryPage({
						card,
						sessions,
						nativeHistoryScope: scope,
						waitForNativeHistoryScan: true,
						request: {
							workspaceTaskId: card.id,
							taskConversationSessionId: summary.taskId,
							cursor,
							transcriptReadConsistency: "stable_snapshot",
						},
						onNativeHistoryResolution: (result) => {
							resolution.result ??= result;
						},
					}),
				);
			const first = await readPage(null);
			let page: RuntimeTaskConversationHistoryPageResponse | undefined = first;
			const cursors = new Set<string>();
			const notices = new Set<string>();
			let availability = first?.availability ?? "unavailable";
			let messageCount = first?.messages.length ?? 0;
			let pageCount = availability === "unavailable" ? 0 : 1;
			let sawPartialPage = availability === "partially_available";
			let nativeHistoryAuditTimeBudgetExhausted = !first;
			while (page) {
				if (page.notice) notices.add(page.notice);
				if (!page.nextCursor || pageCount >= 256 || cursors.has(page.nextCursor)) break;
				cursors.add(page.nextCursor);
				const olderPage = await readPage(page.nextCursor);
				if (!olderPage) {
					nativeHistoryAuditTimeBudgetExhausted = true;
					break;
				}
				page = olderPage;
				if (page.availability === "partially_available") {
					sawPartialPage = true;
					availability = "partially_available";
				}
				if (page.availability !== "unavailable") pageCount++;
				messageCount += page.messages.length;
			}
			if (nativeHistoryAuditTimeBudgetExhausted)
				notices.add(first ? "批量核验时间预算已用尽，剩余正文待验。" : "批量核验时间预算已用尽，首屏正文待验。");
			else if (page?.nextCursor) notices.add("分页核验达到预算或游标未前进，剩余正文待验。");
			if (sawPartialPage) notices.add("较早分页存在缺口，不能把该会话视为完整。");
			const lookup = resolution.result;
			const archive =
				archiveAudit && !nativeHistoryAuditTimeBudgetExhausted
					? await readWithinNativeHistoryAuditDeadline(auditWorkDeadline, () =>
							archiveAudit.read(
								{
									sourceWorkspaceId: scope.workspaceId,
									sourceTaskId: card.id,
									sourceTaskIncarnationCreatedAtEpochMs: card.createdAt,
									sourceConversationSessionId: summary.taskId,
									sourceAgentId: agentId,
								},
								summary.agentNativeConversationSessionIdentity?.nativeSessionId,
							),
						)
					: undefined;
			if (archiveAudit && !archive) notices.add("批量核验时间预算已用尽，归档待验。");
			rows.push({
				taskId: card.id,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				conversationSessionId: summary.taskId,
				agentId,
				nativeHistory: {
					availability,
					pagination:
						page?.nextCursor || sawPartialPage || (pageCount && page?.availability === "unavailable")
							? "incomplete"
							: pageCount
								? "end_reached"
								: "unavailable",
					pageCount,
					messageCount,
					notices: [...notices],
					unavailabilityReason: first?.unavailabilityReason,
					persistedNativeSessionId: summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? null,
					persistedTranscriptPath: summary.agentNativeConversationSessionIdentity?.transcriptPath ?? null,
					readOnlyBinding: lookup?.evidence?.binding,
					searchStatus: lookup?.status,
					searchedDirectories: lookup?.roots ?? [],
					queriedIndexDirectories: lookup?.indexDirectories ?? [],
					candidates: lookup?.candidates ?? [],
					rejectedCandidates: lookup?.rejectedCandidates ?? [],
					scanWindow: lookup?.scanWindow,
					unresolvedCandidateCount: lookup?.unresolvedCandidateCount ?? (first ? 0 : undefined),
					scanCost: lookup?.scanCost,
				},
				archive,
			});
			if (nativeHistoryAuditTimeBudgetExhausted || (archiveAudit && !archive)) {
				firstCardIndexWithUnverifiedAuditWork = cardIndex;
				break auditCards;
			}
		}
		if (!archiveAudit) continue;
		const manifestSessions = archiveAudit.sessions
			.filter(
				(session) =>
					session.sourceWorkspaceId === scope.workspaceId &&
					session.sourceTaskId === card.id &&
					session.sourceTaskIncarnationCreatedAtEpochMs === card.createdAt &&
					!coveredConversationSessionIds.has(session.sourceConversationSessionId),
			)
			.sort((left, right) =>
				left.sourceConversationSessionId.localeCompare(right.sourceConversationSessionId, "en"),
			);
		for (const session of manifestSessions) {
			const archive = await readWithinNativeHistoryAuditDeadline(auditWorkDeadline, () =>
				archiveAudit.read(session),
			);
			if (!archive) {
				firstCardIndexWithUnverifiedAuditWork = cardIndex;
				break auditCards;
			}
			coveredConversationSessionIds.add(session.sourceConversationSessionId);
			ownershipFingerprints.set(
				session.sourceConversationSessionId,
				nativeHistoryOwnershipFingerprint(card, undefined, sessions),
			);
			rows.push({
				taskId: card.id,
				taskIncarnationCreatedAtEpochMs: card.createdAt,
				conversationSessionId: session.sourceConversationSessionId,
				agentId: session.sourceAgentId,
				nativeHistory: {
					availability: "unavailable",
					pagination: "unavailable",
					pageCount: 0,
					messageCount: 0,
					notices: ["当前持久状态没有该会话摘要，已按来源清单核验归档。"],
					persistedNativeSessionId: null,
					persistedTranscriptPath: null,
					searchedDirectories: [],
					queriedIndexDirectories: [],
					candidates: [],
					rejectedCandidates: [],
					unresolvedCandidateCount: 0,
				},
				archive,
			});
		}
	}
	const current = await loadPersistedWorkspaceStateById(scope.workspaceId);
	const currentCards = new Map(current.board.columns.flatMap((column) => column.cards).map((card) => [card.id, card]));
	const currentSessions = removeTaskSessionSummariesOwnedByOtherWorkspaces({
		workspaceId: scope.workspaceId,
		workspaceRepositoryPath: scope.workspacePath,
		taskWorktreesHomePath: getTaskWorktreesHomePath(),
		sessions: current.sessions,
	}).sessionsWithoutSummariesOwnedByOtherWorkspaces;
	const changedConversationSessionIds: string[] = [];
	const verifiedRows = rows.filter((row) => {
		const sameOwnership =
			ownershipFingerprints.get(row.conversationSessionId) ===
			nativeHistoryOwnershipFingerprint(
				currentCards.get(row.taskId),
				currentSessions[row.conversationSessionId],
				currentSessions,
			);
		if (!sameOwnership) changedConversationSessionIds.push(row.conversationSessionId);
		return sameOwnership;
	});
	return {
		ok: true,
		schemaVersion: 1,
		sourceInstanceId: localNativeHistorySourceInstanceId(),
		workspaceId: scope.workspaceId,
		missingTaskIds: requestedTaskIds.filter((taskId) => !cards.some((card) => card.id === taskId)),
		tasksWithoutNativeSessions,
		rows: verifiedRows,
		changedConversationSessionIds,
		...(firstCardIndexWithUnverifiedAuditWork !== undefined
			? {
					auditTimeBudget: {
						status: "exhausted",
						workBudgetMs,
						taskIdsWithUnverifiedAuditWork: cards
							.slice(firstCardIndexWithUnverifiedAuditWork)
							.map(({ id }) => id),
						recheckCondition: "按 --task-id 分批重验这些任务，或调高 KANBAN_CLI_HARD_TIMEOUT_MS 后重试。",
					},
				}
			: {}),
		...(changedConversationSessionIds.length
			? { recheckCondition: "会话归属在核验期间变化；重新运行这些会话所属任务。" }
			: {}),
	};
}

export function registerTaskNativeHistoryAuditCommand(
	task: Command,
	runTaskCommand: (operation: () => Promise<Record<string, unknown>>) => Promise<void>,
) {
	task
		.command("audit-native-history")
		.description("从已登记项目只读核验 Codex 和 Claude 原生历史，默认省略正文。")
		.requiredOption("--project-path <path>", "已登记项目主仓库路径。")
		.option(
			"--task-id <id>",
			"限制到指定 Task ID，可重复指定。",
			(taskId: string, taskIds: string[]) => [...taskIds, taskId],
			[],
		)
		.option("--archive-directory <path>", "M2 归档的 history 目录，其中包含以归档摘要命名的子目录。")
		.option("--archive-source-manifest <path>", "含来源实例和原会话归档摘要的 JSON 清单。")
		.option("--archive-source-instance-id <id>", "来源清单对应的原始实例 ID。")
		.option("--include-archive-messages", "仅导出摘要核验通过的归档分页正文。")
		.action((options: TaskNativeHistoryAuditOptions) => runTaskCommand(() => auditTaskNativeHistory(options)));
}
