import { basename } from "node:path";
import { setImmediate } from "node:timers/promises";
import { readTranscriptRecord } from "../agent-session-history/bounded-agent-transcript-reader";
import type { RuntimeDailyWorkProgressSummary } from "../core/api-contract";
import type { CommittedInterWorkUnitRelationLedgerEvent } from "../core/inter-work-unit-relation-ledger-event-contract";
import {
	doesTaskMessageInjectionRecordMatchRequestedConversationSession,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
} from "../core/task-message-injection-ledger";
import { measureDailyWorkProgressAsynchronousStage } from "../diagnostics/daily-work-progress-collection-cost-recorder";
import { readKanbanBoardCardReferenceFromLedgerPayloadValue } from "../inter-work-unit-relation-ledger/kanban-board-card-identity-projection-from-ledger-events";
import { runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture } from "../inter-work-unit-relation-ledger/kanban-runtime-inter-work-unit-relation-ledger-live-capture-activation";
import {
	getWorkspaceDirectoryPath,
	listWorkspaceIndexEntries,
	loadPersistedWorkspaceSessionsById,
	loadWorkspaceBoardById,
} from "../state/workspace-state";
import { createCodexStatisticsVerifiedHistoryReadCache } from "./codex-statistics-verified-history-read-cache";
import type { DailyWorkProgressStatisticsStore } from "./daily-work-progress-statistics-store";
import { createProgrammaticPromptReceiptTimeIndex } from "./programmatic-prompt-receipt-time-index";
import {
	createProgrammaticPromptReceiptWorkspaceReadCache,
	groupProgrammaticPromptReceiptsByTaskAndTargetSession,
} from "./programmatic-prompt-receipt-workspace-read-cache";
import {
	createEmptyTaskUserPromptStatisticsCursor,
	readTaskUserPromptStatisticsTranscriptIncrement,
} from "./task-user-prompt-statistics-transcript-reader";

export interface DailyWorkProgressCollectionResult {
	projects: RuntimeDailyWorkProgressSummary["projects"];
	liveFactEventIds: string[];
	hasPendingHistoricalReads: boolean;
}
export type DailyWorkProgressCollector = (
	state: DailyWorkProgressStatisticsStore,
) => Promise<DailyWorkProgressCollectionResult>;
const taskKey = (workspaceId: string, taskId: string) => JSON.stringify([workspaceId, taskId]);

export function applyCommittedLedgerEventToDailyWorkProgressStatistics(
	state: DailyWorkProgressStatisticsStore,
	event: CommittedInterWorkUnitRelationLedgerEvent,
): string | null {
	const workspaceId = event.subjectWorkspaceId;
	if (!workspaceId) return null;
	if (event.eventKind === "board_state_baseline_observed_at_live_task_mutation_capture_activation") {
		state.workspaceCaptureStartedAtEpochMs[workspaceId] = Math.min(
			state.workspaceCaptureStartedAtEpochMs[workspaceId] ?? event.occurredAt,
			event.occurredAt,
		);
		for (const value of Array.isArray(event.eventPayload.baselineTaskCards)
			? event.eventPayload.baselineTaskCards
			: []) {
			const reference = readKanbanBoardCardReferenceFromLedgerPayloadValue(
				readTranscriptRecord(value)?.kanbanBoardCard,
			);
			if (reference) {
				const key = taskKey(reference.workspaceId, reference.taskId);
				state.tasksByWorkspaceAndTaskKey[key] = {
					...reference,
					taskTitle: state.tasksByWorkspaceAndTaskKey[key]?.taskTitle ?? `Task ${reference.taskId}`,
				};
			}
		}
	}
	const card = readKanbanBoardCardReferenceFromLedgerPayloadValue(event.eventPayload.subjectKanbanBoardCard);
	if (card) {
		const key = taskKey(card.workspaceId, card.taskId);
		state.tasksByWorkspaceAndTaskKey[key] = {
			...card,
			taskTitle: state.tasksByWorkspaceAndTaskKey[key]?.taskTitle ?? `Task ${card.taskId}`,
		};
	}
	if (event.eventFamily === "agent_conversation_session_identity_event") {
		const identity = readTranscriptRecord(event.eventPayload.conversationSessionIdentityKey);
		const metadata = readTranscriptRecord(event.eventPayload.taskConversationSessionMetadata);
		const owningTaskId =
			typeof metadata?.workspaceTaskId === "string" ? metadata.workspaceTaskId : event.subjectTaskId;
		const task = owningTaskId ? state.tasksByWorkspaceAndTaskKey[taskKey(workspaceId, owningTaskId)] : null;
		const sourceAgentId = identity?.conversationSessionHostKanbanAgentId;
		const nativeSessionId = identity?.nativeConversationSessionId;
		const transcriptPath = event.eventPayload.agentNativeConversationSessionTranscriptPath;
		if (
			task &&
			typeof sourceAgentId === "string" &&
			typeof nativeSessionId === "string" &&
			typeof transcriptPath === "string"
		)
			state.nativeSourcesByIdentityKey[JSON.stringify([workspaceId, sourceAgentId, nativeSessionId])] = {
				...task,
				sourceAgentId,
				nativeSessionId,
				transcriptPath,
				kanbanConversationSessionId: event.subjectTaskId ?? task.taskId,
			};
	}
	if (
		event.eventFamily !== "task_mutation_event" ||
		!["task_card_moved_between_non_trash_board_columns", "task_card_moved_to_trash_column"].includes(
			event.eventKind,
		) ||
		!card
	)
		return null;
	const from = event.eventPayload.fromBoardColumnId;
	const to = event.eventPayload.toBoardColumnId;
	const metric =
		// Done 的 canonical 列 id 是 trash；done 只保留为早期事件的兼容读值。
		(to === "trash" || to === "done") && from !== "done" && from !== "trash"
			? "entered_done"
			: to === "validation" && (from === "backlog" || from === "in_progress" || from === "review")
				? "entered_validation"
				: null;
	if (!metric) return null;
	const eventId = `board:${event.globalCommittedEventSequence}`;
	if (state.factsByEventId[eventId]) return null;
	const task = state.tasksByWorkspaceAndTaskKey[taskKey(card.workspaceId, card.taskId)];
	if (!task) return null;
	state.factsByEventId[eventId] = {
		...task,
		eventId,
		metric,
		occurredAtEpochMs: event.occurredAt,
	};
	return eventId;
}

/** 账本按全局序号追赶；转录按字节偏移追赶，后台每批主动让出事件循环。 */
export function createDailyWorkProgressStatisticsCollector(
	options: { now?: () => number } = {},
): DailyWorkProgressCollector {
	const now = options.now ?? Date.now;
	const canonicalRecordPersistenceEnabled =
		process.env.KANBAN_DAILY_WORK_PROGRESS_CANONICAL_RECORD_PERSISTENCE_DISABLED !== "1";
	const codexHistoryReadCache =
		process.env.KANBAN_DAILY_WORK_PROGRESS_CODEX_HISTORY_CACHE_DISABLED === "1"
			? undefined
			: createCodexStatisticsVerifiedHistoryReadCache();
	const receiptIndexEnabled = process.env.KANBAN_DAILY_WORK_PROGRESS_RECEIPT_INDEX_DISABLED !== "1";
	const receiptLedgerCacheEnabled = process.env.KANBAN_DAILY_WORK_PROGRESS_RECEIPT_LEDGER_CACHE_DISABLED !== "1";
	const receiptReadCache = createProgrammaticPromptReceiptWorkspaceReadCache({
		createTimeIndexes: receiptIndexEnabled,
	});
	const emptyReceiptTimeIndex = createProgrammaticPromptReceiptTimeIndex([]);
	async function readWorkspaceReceipts(path: string) {
		if (!receiptIndexEnabled && !receiptLedgerCacheEnabled) return readTaskMessageInjectionLedger(path);
		return receiptLedgerCacheEnabled
			? receiptReadCache.read(path)
			: groupProgrammaticPromptReceiptsByTaskAndTargetSession(
					await readTaskMessageInjectionLedger(path),
					receiptIndexEnabled,
				);
	}
	const startedAt = now();
	let projects: RuntimeDailyWorkProgressSummary["projects"] = [];
	let lastWorkspaceDiscoveryAt = -Infinity;
	let sourceRoundRobinOffset = 0;
	let activeIdentityKeys = new Set<string>();
	const temporarilyUnreadableSourceKeys = new Set<string>();
	return async (state) => {
		const programmaticReceiptsByWorkspace = new Map<string, Awaited<ReturnType<typeof readWorkspaceReceipts>>>();
		const liveFactEventIds: string[] = [];
		let hasPendingHistoricalReads = false;
		if (now() - lastWorkspaceDiscoveryAt >= 10_000) {
			const entries = await measureDailyWorkProgressAsynchronousStage("project_discovery", () =>
				listWorkspaceIndexEntries(),
			);
			projects = entries.map((entry) => ({ workspaceId: entry.workspaceId, projectName: basename(entry.repoPath) }));
			activeIdentityKeys = new Set();
			for (const entry of entries) {
				const warnings: string[] = [];
				state.workspacePromptSourceInventoryDiscoveryCompleted[entry.workspaceId] = false;
				try {
					const [board, summaries, injections] = await Promise.all([
						measureDailyWorkProgressAsynchronousStage("workspace_board_read", () =>
							loadWorkspaceBoardById(entry.workspaceId),
						),
						measureDailyWorkProgressAsynchronousStage("workspace_sessions_read", () =>
							loadPersistedWorkspaceSessionsById(entry.workspaceId),
						),
						measureDailyWorkProgressAsynchronousStage("injection_ledger_read", () =>
							readWorkspaceReceipts(
								getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(entry.workspaceId)),
							),
						),
					]);
					programmaticReceiptsByWorkspace.set(entry.workspaceId, injections);
					for (const column of board.columns)
						for (const card of column.cards) {
							state.tasksByWorkspaceAndTaskKey[taskKey(entry.workspaceId, card.id)] = {
								workspaceId: entry.workspaceId,
								taskId: card.id,
								taskIncarnationCreatedAtEpochMs: card.createdAt,
								taskTitle: card.title,
							};
							const mainConversationSessionId = card.mainTaskConversationSessionId ?? card.id;
							if (
								card.mostRecentlyLaunchedAgentSessionAgentId &&
								!summaries[mainConversationSessionId] &&
								!Object.values(state.nativeSourcesByIdentityKey).some(
									(source) =>
										source.workspaceId === entry.workspaceId &&
										source.taskId === card.id &&
										source.taskIncarnationCreatedAtEpochMs === card.createdAt &&
										(source.kanbanConversationSessionId ?? source.taskId) === mainConversationSessionId,
								)
							)
								warnings.push("部分已启动任务缺少可确认的原生转录");
						}
					for (const summary of Object.values(summaries)) {
						const owner = summary.taskConversationSessionMetadata?.workspaceTaskId ?? summary.taskId;
						const task = state.tasksByWorkspaceAndTaskKey[taskKey(entry.workspaceId, owner)];
						if (!task) continue;
						const identity = summary.agentNativeConversationSessionIdentity;
						if (!identity?.transcriptPath) {
							warnings.push("部分已启动任务缺少可确认的原生转录");
							continue;
						}
						const key = JSON.stringify([entry.workspaceId, identity.sourceAgentId, identity.nativeSessionId]);
						const sourceNativeConversationIdentityFields = {
							sourceAgentId: identity.sourceAgentId,
							nativeSessionId: identity.nativeSessionId,
							transcriptPath: identity.transcriptPath,
						};
						// 与持久 schema 的键顺序一致，避免发现轮次仅因对象键重排而写盘。
						state.nativeSourcesByIdentityKey[key] = canonicalRecordPersistenceEnabled
							? {
									...task,
									kanbanConversationSessionId: summary.taskId,
									...sourceNativeConversationIdentityFields,
								}
							: {
									...task,
									...sourceNativeConversationIdentityFields,
									kanbanConversationSessionId: summary.taskId,
								};
						if (summary.liveness === "live") activeIdentityKeys.add(key);
					}
					state.workspacePromptSourceInventoryDiscoveryCompleted[entry.workspaceId] = true;
				} catch {
					warnings.push("部分项目的任务历史暂时不可读");
				}
				state.workspaceWarnings[entry.workspaceId] = [...new Set(warnings)];
				await setImmediate();
			}
			lastWorkspaceDiscoveryAt = now();
		}
		try {
			await measureDailyWorkProgressAsynchronousStage("relation_ledger_catch_up", () =>
				runInterWorkUnitRelationLedgerClientOperationOfActiveKanbanRuntimeLiveCapture(async (client) => {
					for (let page = 0; page < 4; page++) {
						const events = await client.listCommittedEvents({
							afterGlobalCommittedEventSequence: state.ledgerCursor,
							limit: 500,
						});
						for (const event of events) {
							const eventId = applyCommittedLedgerEventToDailyWorkProgressStatistics(state, event);
							if (eventId && event.occurredAt >= startedAt) liveFactEventIds.push(eventId);
							state.ledgerCursor = event.globalCommittedEventSequence;
						}
						state.ledgerCaughtUp = events.length < 500;
						if (state.ledgerCaughtUp) break;
						hasPendingHistoricalReads = true;
						await setImmediate();
					}
				}),
			);
		} catch {
			state.ledgerCaughtUp = false;
			for (const project of projects)
				state.workspaceWarnings[project.workspaceId] = [
					...new Set([...(state.workspaceWarnings[project.workspaceId] ?? []), "任务流转账本暂时不可用"]),
				];
		}
		const allKeys = Object.keys(state.nativeSourcesByIdentityKey);
		const incomplete = allKeys.filter(
			(key) =>
				!state.transcriptCursorsByIdentityKey[key]?.complete &&
				!state.transcriptCursorsByIdentityKey[key]?.rejectedDescendantSession &&
				!temporarilyUnreadableSourceKeys.has(key),
		);
		const rotated = allKeys.length
			? [...allKeys.slice(sourceRoundRobinOffset), ...allKeys.slice(0, sourceRoundRobinOffset)]
			: [];
		// 活会话和历史追赶各留配额；坏文件不能永远占住队首，使其它项目饥饿。
		const selectedKeys = [
			...new Set([...activeIdentityKeys].slice(0, 6).concat(incomplete.slice(0, 4), rotated.slice(0, 8))),
		];
		sourceRoundRobinOffset = (sourceRoundRobinOffset + 8) % Math.max(allKeys.length, 1);
		for (const key of selectedKeys) {
			const source = state.nativeSourcesByIdentityKey[key];
			if (!source) continue;
			if (
				!["codex", "claude", "omp", "kimi", "cursor"].includes(source.sourceAgentId) ||
				!source.transcriptPath.endsWith(".jsonl")
			) {
				temporarilyUnreadableSourceKeys.add(key);
				state.transcriptCursorsByIdentityKey[key] ??= createEmptyTaskUserPromptStatisticsCursor();
				state.workspaceWarnings[source.workspaceId] = [
					...new Set([...(state.workspaceWarnings[source.workspaceId] ?? []), "部分 agent 转录格式尚不支持统计"]),
				];
				continue;
			}
			if (!programmaticReceiptsByWorkspace.has(source.workspaceId)) {
				try {
					programmaticReceiptsByWorkspace.set(
						source.workspaceId,
						await measureDailyWorkProgressAsynchronousStage("injection_ledger_read", () =>
							readWorkspaceReceipts(
								getTaskMessageInjectionLedgerPath(getWorkspaceDirectoryPath(source.workspaceId)),
							),
						),
					);
				} catch {
					state.workspaceWarnings[source.workspaceId] = [
						...new Set([...(state.workspaceWarnings[source.workspaceId] ?? []), "程序化投递来源记录暂时不可读"]),
					];
					continue;
				}
			}
			const workspaceReceipts = programmaticReceiptsByWorkspace.get(source.workspaceId);
			const programmaticReceiptTimeIndex =
				receiptIndexEnabled && workspaceReceipts && !Array.isArray(workspaceReceipts)
					? (receiptReadCache.find(
							workspaceReceipts,
							source.taskId,
							source.kanbanConversationSessionId ?? source.taskId,
						) ?? emptyReceiptTimeIndex)
					: undefined;
			const programmaticSubmissionReceipts =
				workspaceReceipts && !Array.isArray(workspaceReceipts)
					? receiptReadCache.findReceipts(
							workspaceReceipts,
							source.taskId,
							source.kanbanConversationSessionId ?? source.taskId,
						)
					: (Array.isArray(workspaceReceipts) ? workspaceReceipts : [])
							.filter(
								(receipt) =>
									receipt.task_id === source.taskId &&
									doesTaskMessageInjectionRecordMatchRequestedConversationSession(
										receipt,
										source.kanbanConversationSessionId ?? source.taskId,
									) &&
									receipt.terminal_delivery_status !== "delivery_failed",
							)
							.map((receipt) => ({
								promptSha256: receipt.prompt_sha256,
								confirmedAtEpochMs: Date.parse(receipt.terminal_delivery_status_updated_at),
							}));
			const result = await measureDailyWorkProgressAsynchronousStage("transcript_increment", () =>
				readTaskUserPromptStatisticsTranscriptIncrement({
					...source,
					cursor: state.transcriptCursorsByIdentityKey[key] ?? createEmptyTaskUserPromptStatisticsCursor(),
					programmaticSubmissionReceipts,
					programmaticReceiptTimeIndex,
					codexHistoryReadCache,
				}),
			);
			const excludedDescendantSession = result.cursor.rejectedDescendantSession;
			if (result.warning && !excludedDescendantSession) temporarilyUnreadableSourceKeys.add(key);
			else temporarilyUnreadableSourceKeys.delete(key);
			state.transcriptCursorsByIdentityKey[key] = {
				...result.cursor,
				complete: (!result.warning || excludedDescendantSession) && result.cursor.complete,
			};
			if (!result.warning && !result.cursor.complete && !excludedDescendantSession) hasPendingHistoricalReads = true;
			for (const submission of result.submissions) {
				// 显式复用外部会话时，建卡以前的转录属于先前工作，不能记到新任务。
				if (submission.submittedAtEpochMs < source.taskIncarnationCreatedAtEpochMs) continue;
				const eventId = `prompt:${submission.submissionId}`;
				if (state.factsByEventId[eventId]) continue;
				state.factsByEventId[eventId] = {
					// 事实只写持久契约字段；来源扩展字段会在下轮校验被剥离，导致迟到的清理写入。
					...(canonicalRecordPersistenceEnabled
						? {
								workspaceId: source.workspaceId,
								taskId: source.taskId,
								taskIncarnationCreatedAtEpochMs: source.taskIncarnationCreatedAtEpochMs,
								taskTitle: source.taskTitle,
							}
						: source),
					eventId,
					metric: "human_prompt",
					occurredAtEpochMs: submission.submittedAtEpochMs,
				};
				if (submission.submittedAtEpochMs >= startedAt) liveFactEventIds.push(eventId);
			}
			await setImmediate();
		}
		if (allKeys.some((key) => !state.transcriptCursorsByIdentityKey[key])) hasPendingHistoricalReads = true;
		return { projects, liveFactEventIds, hasPendingHistoricalReads };
	};
}
