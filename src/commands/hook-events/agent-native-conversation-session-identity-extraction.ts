// N0a：从 hook stdin 载荷抽出终端 agent 的**原生会话身份**（harness 自己的 session id + transcript 路径）。
//
// Claude Code 与 Codex 的 hooks 载荷都带 `session_id` / `transcript_path`（Codex 镜像 Claude 格式）；
// Kiro / Droid 等只带 transcript 路径或什么都不带——抽不到 session id 就不产出身份（宁缺毋滥，
// 绝不用路径反推 id）。产出经 hooks.ingest 落到 summary 的加性 sidecar
// `agentNativeConversationSessionIdentity`，是 exploration thread graph 维护作业
// （`claude -p --resume <nativeSessionId> --fork-session`）与 transcript 投影的唯一身份来源。

import type { RuntimeAgentNativeConversationSessionIdentity } from "../../core/api-contract";
import { readStringField } from "./hook-utils";

// transcript 路径必须逐字保留：`readStringField` 经 `normalizeWhitespace` 会把路径内部的连续空格 / 制表符压成单空格
// （那是给显示文本用的），写入 sidecar 的路径就会指向不存在的文件。这里只裁首尾空白，内部字符一律原样保留。
function readVerbatimFilesystemPathField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function readAgentNativeConversationTranscriptPathFromHookPayload(
	payload: Record<string, unknown> | null,
): string | null {
	return payload
		? (readVerbatimFilesystemPathField(payload, "transcript_path") ??
				readVerbatimFilesystemPathField(payload, "transcriptPath"))
		: null;
}

// Codex 的 memory phase-2 作业会继承主进程的 hooks 与任务 env，却没有持久转录或 agent_id。
// 这类事件不能代表主任务；普通新会话的首个 SessionStart 已带路径（0.163.0 原生隔离探针已证）。
export function isCodexConversationWithoutPersistedTranscript(input: {
	sourceAgentId: string | null | undefined;
	transcriptPath: string | null | undefined;
}): boolean {
	return input.sourceAgentId?.trim().toLowerCase() === "codex" && !input.transcriptPath?.trim();
}

export function extractAgentNativeConversationSessionIdentityFromHookPayload(input: {
	payload: Record<string, unknown> | null;
	// 已解析的 harness 来源（flag 或 inferHookSourceFromPayload）；null = 判不出来源 ⇒ 不产出身份。
	sourceAgentId: string | null;
	observedAt?: number;
}): RuntimeAgentNativeConversationSessionIdentity | undefined {
	const { payload, sourceAgentId } = input;
	if (!payload || !sourceAgentId || readStringField(payload, "agent_id") || readStringField(payload, "agentId")) {
		return undefined;
	}
	const nativeSessionId = (readStringField(payload, "session_id") ?? readStringField(payload, "sessionId"))?.trim();
	if (!nativeSessionId) {
		return undefined;
	}
	const transcriptPath = readAgentNativeConversationTranscriptPathFromHookPayload(payload);
	if (isCodexConversationWithoutPersistedTranscript({ sourceAgentId, transcriptPath })) return undefined;
	return {
		sourceAgentId: sourceAgentId.trim().toLowerCase(),
		nativeSessionId,
		transcriptPath: transcriptPath ? transcriptPath : null,
		observedAt: input.observedAt ?? Date.now(),
	};
}

// 同一身份的幂等判定：三个身份字段全等即视为未变化（observedAt 不参与——每个 hook 事件都会重报）。
export function isSameAgentNativeConversationSessionIdentity(
	left: RuntimeAgentNativeConversationSessionIdentity | null | undefined,
	right: RuntimeAgentNativeConversationSessionIdentity,
): boolean {
	return (
		left != null &&
		left.sourceAgentId === right.sourceAgentId &&
		left.nativeSessionId === right.nativeSessionId &&
		left.transcriptPath === right.transcriptPath
	);
}
