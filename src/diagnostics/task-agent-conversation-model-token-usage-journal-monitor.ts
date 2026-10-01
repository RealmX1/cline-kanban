// 终端 agent（Claude Code / Codex）模型 token 用量的周期采集：每 5 分钟遍历带原生会话身份的会话，
// 增量读它们的 transcript / rollout，写一条累计快照进 journal。
//
// 成本控制：
//   - transcript 的大小与修改时间都没变 ⇒ 跳过（绝大多数空闲会话每个 tick 都命中这条）；
//   - 首次见到的文件只处理最近 24 小时内改过的：重启后不把几百个历史 transcript 从头读一遍；
//   - 读取是增量的（每个文件保留偏移量），长寿会话每次只读新增的字节。

import {
	type AgentConversationModelTokenUsageIncrementalReader,
	type AgentConversationModelTokenUsageTotals,
	createAgentConversationModelTokenUsageIncrementalReader,
} from "../agent-session-history/agent-conversation-model-token-usage-incremental-reader";
import type { RuntimeLiveTaskResourceUsageSnapshot, RuntimeTaskSessionSummary } from "../core/api-contract";
import { resolveSessionCategoryAndAttributedTaskCardId } from "../server/task-resource-usage-attribution-root-enumeration";
import type {
	DiagnosticEventJournalChannel,
	DiagnosticEventJournalPayload,
} from "./rotating-jsonl-diagnostic-event-journal";
import { recordTaskAgentConversationModelTokenUsageCumulativeSnapshotToJournal } from "./task-agent-conversation-model-token-usage-journal-recorder";

type LiveTaskModelTokenUsageAcrossTaskSessions = NonNullable<
	RuntimeLiveTaskResourceUsageSnapshot["modelTokenUsageAcrossTaskSessions"]
>;

const TASK_AGENT_CONVERSATION_MODEL_TOKEN_USAGE_SAMPLE_INTERVAL_MS = 5 * 60_000;
// EXPERIMENT_NODE: 首次见到的 transcript 只处理最近 24 小时内改过的——更长的回溯窗口能补全历史用量，代价是启动时的读盘量。
const FIRST_SEEN_TRANSCRIPT_MAXIMUM_AGE_MS = 24 * 60 * 60_000;

export interface TaskAgentConversationModelTokenUsageJournalMonitorDependencies {
	listSessionSummariesWithWorkspace: () => Array<{ workspaceId: string; summary: RuntimeTaskSessionSummary }>;
	reader?: AgentConversationModelTokenUsageIncrementalReader;
	now?: () => number;
	appendJournalEvent?: (channel: DiagnosticEventJournalChannel, payload: DiagnosticEventJournalPayload) => void;
}

function parseTranscriptFileModifiedAtEpochMs(signature: string): number {
	const modifiedAtText = signature.split(":")[1];
	return modifiedAtText === undefined ? 0 : Number.parseFloat(modifiedAtText);
}

export function createTaskAgentConversationModelTokenUsageJournalMonitor(
	deps: TaskAgentConversationModelTokenUsageJournalMonitorDependencies,
) {
	const reader = deps.reader ?? createAgentConversationModelTokenUsageIncrementalReader();
	const now = deps.now ?? Date.now;
	const lastRecordedSignatureByTranscriptPath = new Map<string, string>();
	// 每个 transcript 最近一次读到的累计值（供看板详情面板按卡片汇总；journal 才是完整记录）。
	const latestTokenUsageByTranscriptPath = new Map<
		string,
		{ workspaceId: string; attributedTaskCardId: string | null; totals: AgentConversationModelTokenUsageTotals }
	>();
	let sampleTimer: NodeJS.Timeout | null = null;
	let tickInFlight = false;
	let stopped = false;

	const runTick = async (): Promise<void> => {
		if (tickInFlight || stopped) {
			return;
		}
		tickInFlight = true;
		try {
			const handledTranscriptPaths = new Set<string>();
			for (const { workspaceId, summary } of deps.listSessionSummariesWithWorkspace()) {
				const identity = summary.agentNativeConversationSessionIdentity;
				const transcriptPath = identity?.transcriptPath;
				if (!identity || !transcriptPath || handledTranscriptPaths.has(transcriptPath)) {
					continue;
				}
				if (identity.sourceAgentId !== "claude" && identity.sourceAgentId !== "codex") {
					continue;
				}
				handledTranscriptPaths.add(transcriptPath);
				const signature = await reader.readTranscriptFileSignature(transcriptPath);
				const lastRecordedSignature = lastRecordedSignatureByTranscriptPath.get(transcriptPath);
				if (signature === null || signature === lastRecordedSignature) {
					continue;
				}
				if (
					lastRecordedSignature === undefined &&
					now() - parseTranscriptFileModifiedAtEpochMs(signature) > FIRST_SEEN_TRANSCRIPT_MAXIMUM_AGE_MS
				) {
					continue;
				}
				try {
					const { attributedTaskCardId } = resolveSessionCategoryAndAttributedTaskCardId(summary);
					const baseSnapshot = {
						workspaceId,
						attributedTaskCardId,
						sessionTaskId: summary.taskId,
						agentId: summary.agentId,
						nativeSessionId: identity.nativeSessionId,
						harnessReportedCumulativeCostUsd: null,
						contextWindowUsedTokens: null,
					};
					if (identity.sourceAgentId === "claude") {
						const { totals, subagentTranscriptCount } =
							await reader.readClaudeCodeCumulativeTokenUsage(transcriptPath);
						recordTaskAgentConversationModelTokenUsageCumulativeSnapshotToJournal(
							{
								...baseSnapshot,
								modelTokenUsageSource: "claude_code_transcript",
								totals,
								subagentTranscriptCount,
							},
							deps.appendJournalEvent,
						);
						latestTokenUsageByTranscriptPath.set(transcriptPath, { workspaceId, attributedTaskCardId, totals });
					} else {
						const totals = await reader.readCodexCumulativeTokenUsage(transcriptPath);
						if (totals !== null) {
							recordTaskAgentConversationModelTokenUsageCumulativeSnapshotToJournal(
								{
									...baseSnapshot,
									modelTokenUsageSource: "codex_rollout",
									totals,
									subagentTranscriptCount: null,
								},
								deps.appendJournalEvent,
							);
							latestTokenUsageByTranscriptPath.set(transcriptPath, {
								workspaceId,
								attributedTaskCardId,
								totals,
							});
						}
					}
					lastRecordedSignatureByTranscriptPath.set(transcriptPath, signature);
				} catch {
					// 单个 transcript 读失败不影响其余会话；下个 tick 重试。
				}
			}
		} finally {
			tickInFlight = false;
		}
	};

	return {
		start: () => {
			if (sampleTimer !== null || stopped) {
				return;
			}
			void runTick();
			sampleTimer = setInterval(() => {
				void runTick();
			}, TASK_AGENT_CONVERSATION_MODEL_TOKEN_USAGE_SAMPLE_INTERVAL_MS);
			sampleTimer.unref();
		},
		stop: () => {
			stopped = true;
			if (sampleTimer !== null) {
				clearInterval(sampleTimer);
				sampleTimer = null;
			}
		},
		runTick,
		summarizeLatestModelTokenUsageForTaskCard: (
			workspaceId: string,
			attributedTaskCardId: string,
		): LiveTaskModelTokenUsageAcrossTaskSessions | null => {
			const summary: LiveTaskModelTokenUsageAcrossTaskSessions = {
				sessionCount: 0,
				cumulativeInputTokens: 0,
				cumulativeCacheCreationInputTokens: 0,
				cumulativeCacheReadInputTokens: 0,
				cumulativeOutputTokens: 0,
			};
			for (const entry of latestTokenUsageByTranscriptPath.values()) {
				if (entry.workspaceId !== workspaceId || entry.attributedTaskCardId !== attributedTaskCardId) {
					continue;
				}
				summary.sessionCount += 1;
				summary.cumulativeInputTokens += entry.totals.cumulativeInputTokens;
				summary.cumulativeCacheCreationInputTokens += entry.totals.cumulativeCacheCreationInputTokens;
				summary.cumulativeCacheReadInputTokens += entry.totals.cumulativeCacheReadInputTokens;
				summary.cumulativeOutputTokens += entry.totals.cumulativeOutputTokens;
			}
			return summary.sessionCount === 0 ? null : summary;
		},
	};
}
