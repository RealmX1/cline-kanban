import { open, stat } from "node:fs/promises";
import {
	parseTranscriptJsonRecord,
	readBoundedJsonLines,
	readTranscriptRecord,
} from "../agent-session-history/bounded-agent-transcript-reader";
import { transcriptMetadataMatchesNativeConversationIdentity } from "../agent-session-history/persisted-agent-transcript-last-conversation-progress-probe";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { configurationDigest } from "./codex-configuration-field-projection";

// 无原进程端点的旧会话只从绑定转录补证；不把历史完成写成新的活动或输入接受。
export async function readCodexProfileAdoptionNativeTurnCompletionEvidence(
	summary: RuntimeTaskSessionSummary,
): Promise<{ nativeTurnId: string; evidenceFingerprint: string } | null> {
	const identity = summary.agentNativeConversationSessionIdentity;
	const path = identity?.transcriptPath;
	if (summary.agentId !== "codex" || identity?.sourceAgentId !== "codex" || !path) return null;
	try {
		const before = await stat(path);
		if (!before.isFile() || before.size === 0) return null;
		const handle = await open(path, "r");
		try {
			const lastByte = Buffer.alloc(1);
			await handle.read(lastByte, 0, 1, before.size - 1);
			if (lastByte[0] !== 0x0a) return null;
		} finally {
			await handle.close();
		}
		const { lines } = await readBoundedJsonLines(path, before.size, 1024 * 1024);
		let metadataVerified = false;
		let completedTurnId: string | null = null;
		let completionRecord: Record<string, unknown> | null = null;
		for (const line of lines) {
			const record = parseTranscriptJsonRecord(line);
			const payload = readTranscriptRecord(record?.payload);
			if (!record || !payload) {
				completedTurnId = null;
				continue;
			}
			if (record.type === "session_meta") {
				if (
					!transcriptMetadataMatchesNativeConversationIdentity(identity, record) ||
					payload.cwd !== summary.workspacePath ||
					!["cli", "vscode"].includes(String(payload.source))
				)
					return null;
				metadataVerified = true;
				completedTurnId = null;
				continue;
			}
			if (
				!metadataVerified ||
				record.synthetic === true ||
				record.isMeta === true ||
				record.isSidechain === true ||
				payload.synthetic === true ||
				payload.isMeta === true ||
				payload.isSidechain === true
			)
				continue;
			if (
				record.type === "event_msg" &&
				["task_complete", "turn_aborted"].includes(String(payload.type)) &&
				typeof payload.turn_id === "string" &&
				payload.turn_id
			) {
				completedTurnId = payload.turn_id;
				completionRecord = record;
				continue;
			}
			if (record.type === "event_msg" && payload.type === "token_count") continue;
			// 任何后续执行、用户消息、回滚或未知新记录均不能沿用旧的完成事实。
			completedTurnId = null;
		}
		const after = await stat(path);
		if (
			!metadataVerified ||
			!completedTurnId ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		)
			return null;
		return {
			nativeTurnId: completedTurnId,
			evidenceFingerprint: configurationDigest([
				identity.nativeSessionId,
				summary.workspacePath,
				before.dev,
				before.ino,
				before.size,
				before.mtimeMs,
				completionRecord,
			]),
		};
	} catch {
		return null;
	}
}
