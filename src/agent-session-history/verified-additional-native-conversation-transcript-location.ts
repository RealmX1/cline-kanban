import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	inspectCursorAgentChatInWorkingDirectoryBucket,
	isCursorAgentChatConversationEstablished,
	resolvePhysicalWorkingDirectoryPath,
} from "../terminal/cursor-agent-chat-store-location-and-conversation-inspection";
import { resolveExactKimiMainWirePath } from "./kimi-native-conversation-activity-reader";

// 身份来自持久绑定；路径只用于精确寻址，不从路径反推身份，也不打开 Cursor 的 sqlite。
export async function resolveVerifiedAdditionalNativeConversationTranscriptPath(
	summary: RuntimeTaskSessionSummary,
): Promise<string | null> {
	const identity = summary.agentNativeConversationSessionIdentity;
	if (!identity || identity.sourceAgentId !== summary.agentId || !summary.workspacePath) return null;
	if (summary.agentId === "kimi") return await resolveExactKimiMainWirePath({ summary }).catch(() => null);
	if (summary.agentId !== "cursor") return null;
	const inspection = await inspectCursorAgentChatInWorkingDirectoryBucket({
		workingDirectoryPath: summary.workspacePath,
		chatId: identity.nativeSessionId,
	});
	if (!isCursorAgentChatConversationEstablished(inspection)) return null;
	const nativeSessionFileName = encodeURIComponent(identity.nativeSessionId).replaceAll("%", "_").slice(0, 200);
	const dataDirectory = process.env.CURSOR_DATA_DIR?.trim() || join(homedir(), ".cursor");
	const paths = new Set<string>();
	for (const cwd of new Set([
		summary.workspacePath,
		await resolvePhysicalWorkingDirectoryPath(summary.workspacePath),
	])) {
		// Cursor 原生 workspace slug 和现代/旧版主会话导出布局；不扫描其他会话。
		const slug = cwd
			.replace(/[^a-zA-Z0-9]/gu, "-")
			.replace(/-+/gu, "-")
			.replace(/^-+|-+$/gu, "");
		for (const path of [
			join(
				dataDirectory,
				"projects",
				slug,
				"agent-transcripts",
				nativeSessionFileName,
				`${nativeSessionFileName}.jsonl`,
			),
			join(dataDirectory, "projects", slug, "agent-transcripts", `${nativeSessionFileName}.jsonl`),
		]) {
			if (
				await stat(path).then(
					(metadata) => metadata.isFile(),
					() => false,
				)
			)
				paths.add(await realpath(path));
		}
	}
	if (identity.transcriptPath) {
		const recorded = await realpath(identity.transcriptPath).catch(() => null);
		if (recorded && paths.has(recorded)) return recorded;
	}
	return paths.size === 1 ? [...paths][0] : null;
}
