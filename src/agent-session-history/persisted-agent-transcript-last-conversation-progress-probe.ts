// 持久转录只按 summary 已确认的原生身份寻址。主会话、peer 与 By the way 即使共用 cwd，
// 也不能互相借用转录，更不能用目录中其他会话的最大时间冒充本会话历史。
import { stat } from "node:fs/promises";
import type {
	RuntimeAgentId,
	RuntimeAgentNativeConversationSessionIdentity,
	RuntimeLastConversationProgressObservation,
} from "../core/api-contract";
import {
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
	readTranscriptRecord,
} from "./bounded-agent-transcript-reader";
import { parseNativeAgentConversationTranscriptActivity } from "./native-agent-conversation-transcript-activity";

export const MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE = 256 * 1024;
// 精确寻址后一次只会冷读一个文件，保留导出名供旧消费者读取成本上限。
export const MAX_UNCACHED_TRANSCRIPT_READ_BYTES_PER_PROBE = MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE;
const PROBE_RESULT_CACHE_MAXIMUM_ENTRIES = 1_000;
interface CachedProbeResult {
	signature: string;
	observation: RuntimeLastConversationProgressObservation | null;
}
const probeResultCacheByFilePath = new Map<string, CachedProbeResult>();
export function resetPersistedAgentTranscriptProbeStateForTests(): void {
	probeResultCacheByFilePath.clear();
}
export function getPersistedAgentTranscriptProbeCacheSizeForTests(): number {
	return probeResultCacheByFilePath.size;
}
export function supportsPersistedAgentTranscriptConversationProgressProbe(
	agentId: RuntimeAgentId | null | undefined,
): boolean {
	return agentId === "claude" || agentId === "omp" || agentId === "codex";
}
export interface PersistedAgentTranscriptProbeInput {
	agentId: RuntimeAgentId | null | undefined;
	workspacePath: string | null | undefined;
	agentNativeConversationSessionIdentity?: RuntimeAgentNativeConversationSessionIdentity | null;
	// 旧调用参数保持兼容，但不再据此扫描整个 home/cwd。
	homeDirectoryPath?: string;
}

export function transcriptMetadataMatchesNativeConversationIdentity(
	identity: RuntimeAgentNativeConversationSessionIdentity,
	record: Record<string, unknown>,
): boolean {
	if (identity.sourceAgentId === "codex" && record.type === "session_meta") {
		const payload = readTranscriptRecord(record.payload);
		const source = readTranscriptRecord(payload?.source);
		return (
			payload?.id === identity.nativeSessionId &&
			(payload.thread_source === undefined || payload.thread_source === "user") &&
			source?.subagent === undefined
		);
	}
	if (identity.sourceAgentId === "omp" && record.type === "session") return record.id === identity.nativeSessionId;
	return typeof record.sessionId !== "string" || record.sessionId === identity.nativeSessionId;
}

export async function probePersistedAgentTranscriptLastConversationProgress(
	input: PersistedAgentTranscriptProbeInput,
): Promise<RuntimeLastConversationProgressObservation | null> {
	const identity = input.agentNativeConversationSessionIdentity;
	const filePath = identity?.transcriptPath?.trim();
	if (
		!identity ||
		!filePath ||
		!identity.nativeSessionId.trim() ||
		identity.sourceAgentId !== input.agentId ||
		!supportsPersistedAgentTranscriptConversationProgressProbe(input.agentId)
	)
		return null;
	try {
		const metadata = await stat(filePath);
		if (!metadata.isFile()) return null;
		const cacheKey = `${identity.sourceAgentId}:${identity.nativeSessionId}:${filePath}`;
		const signature = `${metadata.dev}:${metadata.ino}:${metadata.mtimeMs}:${metadata.size}`;
		const cached = probeResultCacheByFilePath.get(cacheKey);
		if (cached?.signature === signature) {
			probeResultCacheByFilePath.delete(cacheKey);
			probeResultCacheByFilePath.set(cacheKey, cached);
			return cached.observation;
		}
		const { lines } = await readBoundedJsonLines(filePath, metadata.size, MAX_TRANSCRIPT_BYTES_PER_PROBE_FILE);
		let observedAtMs: number | null = null;
		let rejectedIdentity = false;
		for (const line of lines) {
			const record = parseTranscriptJsonRecord(line);
			if (!record) continue;
			if (!transcriptMetadataMatchesNativeConversationIdentity(identity, record)) {
				rejectedIdentity = true;
				break;
			}
			const activity = parseNativeAgentConversationTranscriptActivity({ identity, record, serializedRecord: line });
			if (
				activity?.activityKind === "agent_output" &&
				(observedAtMs === null || activity.observedAtMs > observedAtMs)
			)
				observedAtMs = activity.observedAtMs;
		}
		const observation: RuntimeLastConversationProgressObservation | null =
			rejectedIdentity || observedAtMs === null
				? null
				: { observedAtMs, evidenceKind: "persisted_agent_transcript" };
		probeResultCacheByFilePath.delete(cacheKey);
		probeResultCacheByFilePath.set(cacheKey, { signature, observation });
		while (probeResultCacheByFilePath.size > PROBE_RESULT_CACHE_MAXIMUM_ENTRIES) {
			const oldestKey = probeResultCacheByFilePath.keys().next().value;
			if (oldestKey === undefined) break;
			probeResultCacheByFilePath.delete(oldestKey);
		}
		return observation;
	} catch {
		return null;
	}
}
