import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { readAppendedCompleteJsonLines } from "agent-conversation-exploration-thread-graph/harness-claude-code";
import { z } from "zod";
import type {
	RuntimeLastEffectiveAgentConversationActivityObservation,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import type { CodexNativeAgentTurnExecutionObservation } from "../core/codex-native-agent-turn-execution-observation";
import {
	type CodexNativeDirectInputReadinessObservation,
	isCodexNeedsInputNativeReconciliationCandidate,
} from "../core/codex-native-direct-input-readiness";
import { withRunningCodexAppServerControlSocketConnection } from "../rvf-automatic-closeout/codex-app-server-request-connection";
import { parseTranscriptJsonRecord, readBoundedJsonLines } from "./bounded-agent-transcript-reader";
import {
	type CodexCurrentNativeTurnToolActivityReadCursor,
	readCodexCurrentNativeTurnToolActivity,
} from "./codex-current-native-turn-tool-activity-reader";
import {
	readCodexNativeAgentTurnExecution,
	withCodexNativeObservationReadSlot,
} from "./codex-native-agent-turn-execution-reader";
import {
	type CodexPromptSubmissionAcceptanceReconciliation,
	reconcileCodexPromptSubmissionAcceptance,
} from "./codex-prompt-submission-acceptance-reconciliation";
import {
	type KimiNativeConversationActivityReadCursor,
	readKimiNativeConversationActivity,
} from "./kimi-native-conversation-activity-reader";
import {
	type NativeAgentConversationTranscriptActivityObservation,
	parseNativeAgentConversationTranscriptActivity,
} from "./native-agent-conversation-transcript-activity";
import { transcriptMetadataMatchesNativeConversationIdentity } from "./persisted-agent-transcript-last-conversation-progress-probe";
import { extractSubmittedUserPromptFromTranscriptRecord } from "./submitted-user-prompt-transcript-record-parser";

export const MAX_INCREMENTAL_NATIVE_ACTIVITY_TRANSCRIPT_READ_BYTES = 256 * 1024;
export const MAX_RECENT_CODEX_NATIVE_ACTIVITY_TURNS = 32;
const MAX_REMEMBERED_NATIVE_ACTIVITY_EVENT_IDS = 512;

interface CodexFullMessageSummaryPageReadFrame {
	summaryPageCursor: string | null;
	turnIdSequenceDigest: string;
}
type CodexFullMessagePageReadRecovery =
	| {
			phase: "locating_predecessor";
			nextSummaryPageCursor: string;
			newerSummaryPages: CodexFullMessageSummaryPageReadFrame[];
	  }
	| {
			phase: "reading_full_pages";
			summaryPagesPendingFullRead: CodexFullMessageSummaryPageReadFrame[];
	  }
	| { phase: "establishing_rewind_baseline" };

export type NativeAgentConversationActivityReadCursor =
	| KimiNativeConversationActivityReadCursor
	| {
			transport: "transcript";
			fileIdentity: string;
			nextByteOffset: number;
			baselineAtMs: number;
			seenEventIds: string[];
	  }
	| {
			transport: "codex_control";
			predecessorTurnId: string | null;
			lastAcceptedUserInputItemId?: string | null;
			activityProjectionWasOverBudget?: boolean;
			acceptedSummaryUserInputEventIdsPendingFullRead?: string[];
			fullMessagePageReadRecovery?: CodexFullMessagePageReadRecovery;
			seenEventIds: string[];
	  };
export interface NativeAgentConversationActivityReadResult {
	events: NativeAgentConversationTranscriptActivityObservation[];
	cursor: NativeAgentConversationActivityReadCursor | null;
	moreAppendedTranscriptBytesRemain?: boolean;
	promptSubmissionAcceptanceReconciliation?: CodexPromptSubmissionAcceptanceReconciliation | null;
	codexNativeDirectInputReadiness?: CodexNativeDirectInputReadinessObservation;
	codexNativeAgentTurnExecution?: CodexNativeAgentTurnExecutionObservation;
	codexNativeAgentTurnExecutionReadFailure?: string;
	nativeActivityProjectionReadFailure?: string;
	codexFullMessageReadContinuation?: { progressToken: string; madeProgress: boolean };
	codexToolTranscriptCursor?: CodexCurrentNativeTurnToolActivityReadCursor;
}
export interface ReadNativeAgentConversationActivityInput {
	workspaceId: string;
	summary: RuntimeTaskSessionSummary;
	cursor: NativeAgentConversationActivityReadCursor | null;
	observedAtMs: number;
	signal?: AbortSignal;
	codexToolTranscriptCursor?: CodexCurrentNativeTurnToolActivityReadCursor | null;
	// false 仅跳过独立执行状态查询，保留原生消息活动与输入接受核验。
	shouldReadCodexNativeAgentTurnExecution?: boolean;
	shouldReconcilePromptSubmissionAcceptance?: boolean;
	forcePromptSubmissionAcceptanceReconciliation?: boolean;
}

function rememberEventIds(ids: Iterable<string>): string[] {
	return [...new Set(ids)].slice(-MAX_REMEMBERED_NATIVE_ACTIVITY_EVENT_IDS);
}

async function readExactNativeTranscriptActivity(
	input: ReadNativeAgentConversationActivityInput,
): Promise<NativeAgentConversationActivityReadResult | null> {
	const identity = input.summary.agentNativeConversationSessionIdentity;
	const path = identity?.transcriptPath;
	if (
		!identity ||
		!path ||
		!["claude", "omp"].includes(identity.sourceAgentId) ||
		identity.sourceAgentId !== input.summary.agentId
	)
		return null;
	const metadata = await stat(path);
	if (!metadata.isFile()) return null;
	const fileIdentity = `${metadata.dev}:${metadata.ino}`;
	const cursor = input.cursor?.transport === "transcript" ? input.cursor : null;
	if (!cursor || cursor.fileIdentity !== fileIdentity || metadata.size < cursor.nextByteOffset) {
		// 重启、身份更换、转录替换或截断只建立新基线，不重放历史的接受边沿。
		const baseline = await readBoundedJsonLines(
			path,
			metadata.size,
			MAX_INCREMENTAL_NATIVE_ACTIVITY_TRANSCRIPT_READ_BYTES,
		);
		const seenEventIds: string[] = [];
		for (const line of baseline.lines) {
			const record = parseTranscriptJsonRecord(line);
			if (!record) continue;
			if (!transcriptMetadataMatchesNativeConversationIdentity(identity, record)) return null;
			const activity = parseNativeAgentConversationTranscriptActivity({ identity, record, serializedRecord: line });
			if (activity?.eventId) seenEventIds.push(activity.eventId);
		}
		return {
			events: [],
			cursor: {
				transport: "transcript",
				fileIdentity,
				nextByteOffset: metadata.size,
				baselineAtMs: input.observedAtMs,
				seenEventIds: rememberEventIds(seenEventIds),
			},
		};
	}
	const appended = await readAppendedCompleteJsonLines(
		path,
		cursor.nextByteOffset,
		MAX_INCREMENTAL_NATIVE_ACTIVITY_TRANSCRIPT_READ_BYTES,
	);
	if (appended.fileWasTruncated) return null;
	const latestMetadata = await stat(path);
	if (`${latestMetadata.dev}:${latestMetadata.ino}` !== fileIdentity) return null;
	const seen = new Set(cursor.seenEventIds);
	const events: NativeAgentConversationTranscriptActivityObservation[] = [];
	for (const line of appended.completeLines) {
		const record = parseTranscriptJsonRecord(line);
		if (!record) continue;
		if (!transcriptMetadataMatchesNativeConversationIdentity(identity, record)) return null;
		const event = parseNativeAgentConversationTranscriptActivity({ identity, record, serializedRecord: line });
		if (!event?.eventId || seen.has(event.eventId)) continue;
		seen.add(event.eventId);
		// 新追加的旧转录复制记录不能伪装成刚接受的输入；其余活动保留自身时间交 reducer 合并。
		if (event.activityKind === "accepted_user_input" && event.observedAtMs < cursor.baselineAtMs) continue;
		events.push(event);
	}
	return {
		events,
		cursor: { ...cursor, nextByteOffset: appended.nextByteOffset, seenEventIds: rememberEventIds(seen) },
		moreAppendedTranscriptBytesRemain: appended.appendedBytesRemainBeyondIncrementalReadBudget,
	};
}

const nativeItemSchema = z.looseObject({ id: z.string(), type: z.string() });
const nativeTurnSchema = z.looseObject({ id: z.string(), status: z.string(), items: z.array(nativeItemSchema) });
const nativeTurnPageSchema = z.object({
	data: z.array(nativeTurnSchema),
	nextCursor: z.string().nullable().optional(),
});

function describeCodexFullMessageSummaryPage(
	summaryPageCursor: string | null,
	page: z.infer<typeof nativeTurnPageSchema>,
): CodexFullMessageSummaryPageReadFrame {
	return {
		summaryPageCursor,
		turnIdSequenceDigest: createHash("sha256")
			.update(JSON.stringify(page.data.map((turn) => turn.id)))
			.digest("hex"),
	};
}

function codexFullMessageReadContinuation(
	cursor: NativeAgentConversationActivityReadCursor | null,
	madeProgress: boolean,
): Pick<NativeAgentConversationActivityReadResult, "codexFullMessageReadContinuation"> {
	if (
		cursor?.transport !== "codex_control" ||
		(cursor.acceptedSummaryUserInputEventIdsPendingFullRead === undefined && !cursor.fullMessagePageReadRecovery)
	)
		return {};
	return {
		codexFullMessageReadContinuation: {
			progressToken: createHash("sha256")
				.update(
					JSON.stringify([
						cursor.predecessorTurnId,
						cursor.lastAcceptedUserInputItemId,
						cursor.acceptedSummaryUserInputEventIdsPendingFullRead,
						cursor.fullMessagePageReadRecovery,
					]),
				)
				.digest("hex"),
			madeProgress,
		},
	};
}

function serializeCodexNativeItemSemanticActivity(item: Record<string, unknown>): string {
	const semanticItem = { ...item };
	// 子代理自己的状态与工具耗时变化不等于主对话收到新结果；调用/完成状态和实际输出仍参与身份。
	delete semanticItem.agentsStates;
	delete semanticItem.durationMs;
	return JSON.stringify(semanticItem);
}

function isCodexNativeModelResponseItem(item: Record<string, unknown>): boolean {
	if (item.type === "agentMessage") return typeof item.text === "string" && item.text.trim().length > 0;
	return (
		item.type === "reasoning" &&
		[item.summary, item.content].some(
			(parts) => Array.isArray(parts) && parts.some((part) => typeof part === "string" && part.trim().length > 0),
		)
	);
}

async function readCurrentCodexNativeActivity(
	input: ReadNativeAgentConversationActivityInput,
): Promise<NativeAgentConversationActivityReadResult | null> {
	const { summary } = input;
	const identity = summary.agentNativeConversationSessionIdentity;
	const endpoint = summary.codexNativeSessionControlEndpoint;
	if (summary.agentId !== "codex" || identity?.sourceAgentId !== "codex" || !identity.nativeSessionId) return null;
	const cursor = input.cursor?.transport === "codex_control" ? input.cursor : null;
	const reconciliation =
		input.shouldReconcilePromptSubmissionAcceptance === false
			? null
			: await reconcileCodexPromptSubmissionAcceptance({
					summary,
					observedAtMs: input.observedAtMs,
					force: input.forcePromptSubmissionAcceptanceReconciliation,
				});
	if (
		!endpoint ||
		endpoint.workspaceId !== input.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return reconciliation ? { events: [], cursor, promptSubmissionAcceptanceReconciliation: reconciliation } : null;

	let execution: CodexNativeAgentTurnExecutionObservation | null = null;
	let executionReadFailure: string | undefined;
	if (input.shouldReadCodexNativeAgentTurnExecution !== false) {
		try {
			execution = await readCodexNativeAgentTurnExecution(input);
		} catch (error) {
			executionReadFailure = error instanceof Error ? error.message : String(error);
		}
	}
	const independentObservations = {
		...(execution ? { codexNativeAgentTurnExecution: execution } : {}),
		...(executionReadFailure ? { codexNativeAgentTurnExecutionReadFailure: executionReadFailure } : {}),
		...(isCodexNeedsInputNativeReconciliationCandidate(summary) &&
		execution?.threadStatus === "idle" &&
		execution.canAcceptDirectInput === true
			? {
					codexNativeDirectInputReadiness: {
						nativeSessionId: identity.nativeSessionId,
						observedAtMs: input.observedAtMs,
					},
				}
			: {}),
	};
	const result = await withCodexNativeObservationReadSlot(() =>
		withRunningCodexAppServerControlSocketConnection(
			async (port): Promise<NativeAgentConversationActivityReadResult | null> => {
				// 独立状态查询已经核对完整有界加载列表，不能再由消息路径的第一页限制吞掉该证明。
				// 状态未知时仍单独核对加载身份，不 resume、不 turn/start、不向共享 daemon 写入。
				if (!execution) {
					const loaded = z
						.object({ data: z.array(z.string()), nextCursor: z.string().nullable().optional() })
						.parse(await port.request("thread/loaded/list", { cursor: null, limit: 100 }));
					if (!loaded.data.includes(identity.nativeSessionId))
						return reconciliation
							? { events: [], cursor, promptSubmissionAcceptanceReconciliation: reconciliation }
							: null;
				}
				const recoveryBeforeRead = cursor?.fullMessagePageReadRecovery;
				// 一次只定位或完整读取一页；先证明前驱仍在分支中，再按旧到新消费保存的页书签。
				const expectedFullReadFrame =
					recoveryBeforeRead?.phase === "reading_full_pages"
						? recoveryBeforeRead.summaryPagesPendingFullRead.at(-1)
						: undefined;
				const summaryPageCursor =
					recoveryBeforeRead?.phase === "locating_predecessor"
						? recoveryBeforeRead.nextSummaryPageCursor
						: (expectedFullReadFrame?.summaryPageCursor ?? null);
				const summaryPage = nativeTurnPageSchema.parse(
					await port.request("thread/turns/list", {
						threadId: identity.nativeSessionId,
						cursor: summaryPageCursor,
						limit: MAX_RECENT_CODEX_NATIVE_ACTIVITY_TURNS,
						sortDirection: "desc",
						itemsView: "summary",
					}),
				);
				const summaryPageFrame = describeCodexFullMessageSummaryPage(summaryPageCursor, summaryPage);
				if (
					expectedFullReadFrame &&
					expectedFullReadFrame.turnIdSequenceDigest !== summaryPageFrame.turnIdSequenceDigest
				) {
					// 页布局已经变化，旧书签不能证明当前分支；保留已消费位置，从最新页重新定位。
					const resetCursor = cursor ? { ...cursor, fullMessagePageReadRecovery: undefined } : null;
					return {
						events: [],
						cursor: resetCursor,
						...independentObservations,
						promptSubmissionAcceptanceReconciliation: reconciliation,
						...codexFullMessageReadContinuation(resetCursor, true),
						nativeActivityProjectionReadFailure: "原生回合页布局已变化，自动重新定位待补前驱。",
					};
				}
				const summaryTurns = [...summaryPage.data].reverse();
				const predecessorIndex = cursor?.predecessorTurnId
					? summaryTurns.findIndex((turn) => turn.id === cursor.predecessorTurnId)
					: -1;
				let fullMessagePageReadRecovery = recoveryBeforeRead;
				if (
					cursor?.acceptedSummaryUserInputEventIdsPendingFullRead !== undefined &&
					cursor.predecessorTurnId !== null &&
					predecessorIndex < 0 &&
					!expectedFullReadFrame &&
					recoveryBeforeRead?.phase !== "establishing_rewind_baseline" &&
					(summaryPage.nextCursor || recoveryBeforeRead?.phase === "locating_predecessor")
				) {
					const newerSummaryPages =
						recoveryBeforeRead?.phase === "locating_predecessor" ? recoveryBeforeRead.newerSummaryPages : [];
					if (
						summaryPage.nextCursor &&
						(!summaryPage.data.length ||
							[...newerSummaryPages, summaryPageFrame].some(
								(frame) => frame.summaryPageCursor === summaryPage.nextCursor,
							))
					)
						throw new Error("原生回合分页没有向前推进，保留恢复位置并退避重试。");
					const nextCursor = {
						...cursor,
						fullMessagePageReadRecovery: summaryPage.nextCursor
							? {
									phase: "locating_predecessor" as const,
									nextSummaryPageCursor: summaryPage.nextCursor,
									newerSummaryPages: [...newerSummaryPages, summaryPageFrame],
								}
							: { phase: "establishing_rewind_baseline" as const },
					};
					return {
						events: [],
						cursor: nextCursor,
						...independentObservations,
						promptSubmissionAcceptanceReconciliation: reconciliation,
						...codexFullMessageReadContinuation(nextCursor, true),
					};
				}
				if (recoveryBeforeRead?.phase === "locating_predecessor" && predecessorIndex >= 0)
					fullMessagePageReadRecovery = {
						phase: "reading_full_pages",
						summaryPagesPendingFullRead: [...recoveryBeforeRead.newerSummaryPages, summaryPageFrame],
					};
				const isPagedFullRead = fullMessagePageReadRecovery?.phase === "reading_full_pages";
				const isBaseline =
					recoveryBeforeRead?.phase === "establishing_rewind_baseline" ||
					!cursor ||
					(!isPagedFullRead && cursor.predecessorTurnId !== null && predecessorIndex < 0);
				// 首次只读取最新回合建立基线；之后只读取前驱起的新增前缀，避免每次搬运旧工具历史。

				const fullReadLimit = isBaseline ? 1 : Math.max(1, summaryTurns.length - Math.max(0, predecessorIndex));
				let fullPage = summaryPage;
				let fullReadFailure: string | undefined;
				try {
					fullPage = nativeTurnPageSchema.parse(
						await port.request("thread/turns/list", {
							threadId: identity.nativeSessionId,
							cursor: summaryPageCursor,
							limit: fullReadLimit,
							sortDirection: "desc",
							itemsView: "full",
						}),
					);
					if (fullPage.data.length < Math.min(fullReadLimit, summaryPage.data.length))
						throw new Error("完整原生回合页尚未覆盖待核验前驱，保留恢复水位。");
				} catch (error) {
					fullReadFailure = error instanceof Error ? error.message : String(error);
					fullPage = summaryPage;
					// 冷启动仍须完整建基线；已有前驱时，新回合首条输入的 summary 证据可以独立落地。
					if (isBaseline)
						return {
							events: [],
							cursor,
							...independentObservations,
							promptSubmissionAcceptanceReconciliation: reconciliation,
							...codexFullMessageReadContinuation(cursor, false),
							nativeActivityProjectionReadFailure: fullReadFailure,
						};
				}

				const fullTurns = fullPage.data.slice(0, fullReadLimit);
				if (fullTurns.some((turn, index) => turn.id !== summaryPage.data[index]?.id))
					return {
						events: [],
						cursor,
						...independentObservations,
						...codexFullMessageReadContinuation(cursor, false),
						nativeActivityProjectionReadFailure: "summary 与 full 原生回合位置不一致，等待重新核验。",
					};
				const turns = fullTurns.reverse();
				const seen = new Set(cursor?.seenEventIds ?? []);
				const acceptedSummaryUserInputEventIdsPendingFullRead = new Set(
					cursor?.acceptedSummaryUserInputEventIdsPendingFullRead ?? [],
				);
				const eligibleTurns = isBaseline ? turns.slice(-1) : turns;
				const activityBudgetExceeded =
					eligibleTurns.reduce((count, turn) => count + turn.items.length, 0) >
					MAX_REMEMBERED_NATIVE_ACTIVITY_EVENT_IDS;

				const events: NativeAgentConversationTranscriptActivityObservation[] = [];
				for (const turn of eligibleTurns) {
					const predecessorUserInputIndex =
						turn.id === cursor?.predecessorTurnId && cursor.lastAcceptedUserInputItemId
							? turn.items.findIndex(
									(item) => item.id === cursor.lastAcceptedUserInputItemId && item.type === "userMessage",
								)
							: -1;
					const firstUserInputIndex = turn.items.findIndex((item) => item.type === "userMessage");
					const firstUserInput = turn.items[firstUserInputIndex];
					const hasModelResponseAfterFirstUserInput =
						firstUserInputIndex >= 0 &&
						turn.items.slice(firstUserInputIndex + 1).some(isCodexNativeModelResponseItem);
					for (const [itemIndex, item] of turn.items.entries()) {
						const nativeItemIdentity = `${identity.nativeSessionId}:${turn.id}:${item.id}`;
						const eventId =
							item.type === "userMessage"
								? `codex:${nativeItemIdentity}`
								: `codex:${nativeItemIdentity}:${createHash("sha256").update(serializeCodexNativeItemSemanticActivity(item)).digest("hex")}`;
						if (
							seen.has(eventId) ||
							(item.type === "userMessage" && acceptedSummaryUserInputEventIdsPendingFullRead.has(eventId))
						)
							continue;
						seen.add(eventId);
						if (isBaseline) continue;
						if (item.type === "userMessage") {
							if (
								activityBudgetExceeded &&
								turn.id === cursor?.predecessorTurnId &&
								cursor.lastAcceptedUserInputItemId === undefined
							)
								continue;
							// 用户消息有独立位置水位，不因工具条目挤出 512 个去重 ID 而重复或丢失接受。
							if (
								turn.id === cursor?.predecessorTurnId &&
								cursor.lastAcceptedUserInputItemId !== undefined &&
								cursor.lastAcceptedUserInputItemId !== null &&
								(predecessorUserInputIndex < 0 || itemIndex <= predecessorUserInputIndex)
							)
								continue;
						} else if (
							activityBudgetExceeded ||
							// 分页补读只补用户接受；旧工具历史留作基线，不以发现时刻刷新当前活动。
							isPagedFullRead ||
							(cursor?.activityProjectionWasOverBudget && turn.id === cursor.predecessorTurnId)
						)
							continue;
						let activityKind: RuntimeLastEffectiveAgentConversationActivityObservation["activityKind"] | null =
							null;
						if (item.type === "userMessage") activityKind = "accepted_user_input";
						else if (["agentMessage", "reasoning", "plan", "imageGeneration"].includes(item.type))
							activityKind = "agent_output";
						else if (
							[
								"commandExecution",
								"fileChange",
								"mcpToolCall",
								"dynamicToolCall",
								"collabAgentToolCall",
								"webSearch",
								"imageView",
								"functionCallOutput",
							].includes(item.type)
						)
							activityKind = "tool_activity";
						else if (item.type === "contextCompaction") activityKind = "context_compaction";
						const prompt =
							item.type === "userMessage"
								? extractSubmittedUserPromptFromTranscriptRecord("codex", {
										type: "response_item",
										payload: { type: "message", role: "user", id: item.id, content: item.content },
									})
								: null;
						if (activityKind)
							events.push({
								observedAtMs: input.observedAtMs,
								activityKind,
								evidenceKind:
									activityKind === "accepted_user_input"
										? "native_user_prompt_acceptance"
										: "structured_agent_session_event",
								eventId,
								nativeSessionId: identity.nativeSessionId,
								...(item.type === "userMessage"
									? {
											acceptedNativeAgentTurnIsInProgress: turn.status === "inProgress",
											acceptedNativeAgentTurnHasModelResponse:
												item === firstUserInput && hasModelResponseAfterFirstUserInput,
										}
									: {}),
								...(isCodexNativeModelResponseItem(item)
									? {
											...(firstUserInput
												? {
														nativeAgentResponseAcceptedUserInputEventId: `codex:${identity.nativeSessionId}:${turn.id}:${firstUserInput.id}`,
													}
												: {}),
											// 已结束回合没有原始时间：只能由匹配的本代提交时间补估计，不能拿发现时刻续期。
											...(turn.status === "inProgress"
												? {
														nativeAgentResponsePromptCacheReferenceObservation: {
															observedAtMs: input.observedAtMs,
															evidenceKind:
																"main_agent_conversation_request_processing_cache_reference_estimate" as const,
														},
													}
												: {}),
										}
									: {}),
								...(prompt ? { submittedPromptText: prompt.text } : {}),
							});
						if (activityKind === "accepted_user_input" && fullReadFailure)
							acceptedSummaryUserInputEventIdsPendingFullRead.add(eventId);
					}
				}
				if (!fullReadFailure && fullMessagePageReadRecovery?.phase === "reading_full_pages") {
					const remainingSummaryPages = fullMessagePageReadRecovery.summaryPagesPendingFullRead.slice(0, -1);
					fullMessagePageReadRecovery = remainingSummaryPages.length
						? { phase: "reading_full_pages", summaryPagesPendingFullRead: remainingSummaryPages }
						: undefined;
				} else if (!fullReadFailure) fullMessagePageReadRecovery = undefined;
				const nextCursor: Extract<NativeAgentConversationActivityReadCursor, { transport: "codex_control" }> = {
					transport: "codex_control",
					activityProjectionWasOverBudget: fullReadFailure
						? cursor?.activityProjectionWasOverBudget
						: activityBudgetExceeded || isPagedFullRead,
					// summary 只证明首条输入；完整位置须等 full 覆盖后再推进，避免跳过旧回合 steering。
					predecessorTurnId: fullReadFailure ? (cursor?.predecessorTurnId ?? null) : (turns.at(-1)?.id ?? null),
					lastAcceptedUserInputItemId: fullReadFailure
						? cursor?.lastAcceptedUserInputItemId
						: (turns
								.at(-1)
								?.items.slice()
								.reverse()
								.find((item) => item.type === "userMessage")?.id ?? null),
					...(fullReadFailure || fullMessagePageReadRecovery
						? {
								acceptedSummaryUserInputEventIdsPendingFullRead: [
									...acceptedSummaryUserInputEventIdsPendingFullRead,
								],
							}
						: {}),
					...(fullMessagePageReadRecovery ? { fullMessagePageReadRecovery } : {}),
					seenEventIds: rememberEventIds(seen),
				};
				return {
					events,
					promptSubmissionAcceptanceReconciliation: reconciliation,
					...(fullReadFailure ? { nativeActivityProjectionReadFailure: fullReadFailure } : {}),
					...independentObservations,
					cursor: nextCursor,
					...codexFullMessageReadContinuation(nextCursor, !fullReadFailure),
				};
			},
			{
				socketPath: endpoint.socketPath,
				clientName: "kanban_native_conversation_activity_observer",
				requestTimeoutMs: 2_000,
				signal: input.signal,
			},
		),
	).catch((error: unknown) => {
		// 消息投影读取失败不能吞掉已取得的轻量执行状态，也不消费活动游标。
		if (execution || reconciliation || cursor?.acceptedSummaryUserInputEventIdsPendingFullRead !== undefined)
			return {
				events: [],
				cursor,
				...independentObservations,
				promptSubmissionAcceptanceReconciliation: reconciliation,
				...codexFullMessageReadContinuation(cursor, false),
				nativeActivityProjectionReadFailure: error instanceof Error ? error.message : String(error),
			};
		throw error;
	});
	if (!result || !execution) return result;
	try {
		const tools = await readCodexCurrentNativeTurnToolActivity({
			summary,
			execution,
			cursor: input.codexToolTranscriptCursor ?? null,
			observedAtMs: input.observedAtMs,
			maximumReadBytes: MAX_INCREMENTAL_NATIVE_ACTIVITY_TRANSCRIPT_READ_BYTES,
		});
		if (tools)
			return {
				...result,
				events: [...result.events, ...tools.events],
				codexToolTranscriptCursor: tools.cursor,
				moreAppendedTranscriptBytesRemain: tools.moreAppendedTranscriptBytesRemain,
			};
	} catch {
		// 转录暂缺、正在轮换或无法证明分支时，只暂停工具补充，原生状态和消息读取继续工作。
	}
	return result;
}

export async function readNativeAgentConversationActivity(
	input: ReadNativeAgentConversationActivityInput,
): Promise<NativeAgentConversationActivityReadResult | null> {
	if (input.signal?.aborted) return null;
	if (input.summary.agentId === "codex") return readCurrentCodexNativeActivity(input);
	if (input.summary.agentId === "kimi") return readKimiNativeConversationActivity(input);
	return readExactNativeTranscriptActivity(input);
}
