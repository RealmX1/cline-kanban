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
			seenEventIds: string[];
	  };
export interface NativeAgentConversationActivityReadResult {
	events: NativeAgentConversationTranscriptActivityObservation[];
	cursor: NativeAgentConversationActivityReadCursor | null;
	moreAppendedTranscriptBytesRemain?: boolean;
	codexNativeDirectInputReadiness?: CodexNativeDirectInputReadinessObservation;
	codexNativeAgentTurnExecution?: CodexNativeAgentTurnExecutionObservation;
	codexNativeAgentTurnExecutionReadFailure?: string;
	nativeActivityProjectionReadFailure?: string;
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
	if (
		summary.agentId !== "codex" ||
		identity?.sourceAgentId !== "codex" ||
		!identity.nativeSessionId ||
		!endpoint ||
		endpoint.workspaceId !== input.workspaceId ||
		endpoint.conversationSessionId !== summary.taskId ||
		endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
	)
		return null;
	let execution: CodexNativeAgentTurnExecutionObservation | null = null;
	let executionReadFailure: string | undefined;
	if (input.shouldReadCodexNativeAgentTurnExecution !== false) {
		try {
			execution = await readCodexNativeAgentTurnExecution(input);
		} catch (error) {
			executionReadFailure = error instanceof Error ? error.message : String(error);
		}
	}
	const cursor = input.cursor?.transport === "codex_control" ? input.cursor : null;
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
					if (!loaded.data.includes(identity.nativeSessionId)) return null;
				}
				const page = nativeTurnPageSchema.parse(
					await port.request("thread/turns/list", {
						threadId: identity.nativeSessionId,
						cursor: null,
						limit: MAX_RECENT_CODEX_NATIVE_ACTIVITY_TURNS,
						sortDirection: "desc",
						itemsView: "full",
					}),
				);
				const turns = [...page.data].reverse();
				const predecessorIndex = cursor?.predecessorTurnId
					? turns.findIndex((turn) => turn.id === cursor.predecessorTurnId)
					: -1;
				const isBaseline = !cursor || (cursor.predecessorTurnId !== null && predecessorIndex < 0);
				const seen = new Set(cursor?.seenEventIds ?? []);
				const eligibleTurns = isBaseline ? turns : turns.slice(Math.max(0, predecessorIndex));
				// 超长当前回合缺少可完整保留的消息游标时保持未知，不能因逐出旧 ID 而重报接受。
				if (
					eligibleTurns.reduce((count, turn) => count + turn.items.length, 0) >
					MAX_REMEMBERED_NATIVE_ACTIVITY_EVENT_IDS
				) {
					// 独立证明输入就绪不初始化活动基线；超预算时保留原游标，首次读取仍为 null。
					return { events: [], cursor, ...independentObservations };
				}
				const events: NativeAgentConversationTranscriptActivityObservation[] = [];
				for (const turn of eligibleTurns) {
					const firstUserInputIndex = turn.items.findIndex((item) => item.type === "userMessage");
					const firstUserInput = turn.items[firstUserInputIndex];
					const hasModelResponseAfterFirstUserInput =
						firstUserInputIndex >= 0 &&
						turn.items.slice(firstUserInputIndex + 1).some(isCodexNativeModelResponseItem);
					for (const item of turn.items) {
						const nativeItemIdentity = `${identity.nativeSessionId}:${turn.id}:${item.id}`;
						const eventId =
							item.type === "userMessage"
								? `codex:${nativeItemIdentity}`
								: `codex:${nativeItemIdentity}:${createHash("sha256").update(serializeCodexNativeItemSemanticActivity(item)).digest("hex")}`;
						if (seen.has(eventId)) continue;
						seen.add(eventId);
						if (isBaseline) continue;
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
					}
				}
				return {
					events,
					...independentObservations,
					cursor: {
						transport: "codex_control",
						predecessorTurnId: turns.at(-1)?.id ?? null,
						seenEventIds: rememberEventIds(seen),
					},
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
		if (execution)
			return {
				events: [],
				cursor,
				...independentObservations,
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
