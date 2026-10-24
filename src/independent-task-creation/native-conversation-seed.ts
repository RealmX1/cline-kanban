import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
	inferCodexHomeDirectoryPathFromTranscriptPath,
	resolveRecordedCodexConversationHome,
} from "../codex-conversation-storage/codex-conversation-storage-home";
import type { RuntimeTaskAgentSessionInitialization, RuntimeTaskSessionSummary } from "../core/api-contract";
import { withCodexAppServerRequestConnection } from "../rvf-automatic-closeout/codex-app-server-request-connection";
import {
	readCodexConversationTurns,
	verifyRestoredCodexConversationPrefix,
} from "../rvf-automatic-closeout/codex-native-conversation-prefix";

/** 只复制原生历史，不发起模型回合；后续新任务再从这个不可变种子 fork。 */
export async function freezeIndependentTaskConversationSeed(summary: RuntimeTaskSessionSummary): Promise<{
	seed: RuntimeTaskAgentSessionInitialization | null;
	unavailableReason: string | null;
}> {
	const identity = summary.agentNativeConversationSessionIdentity;
	if (identity && identity.sourceAgentId !== summary.agentId)
		return { seed: null, unavailableReason: "原生身份与当前 Agent 不一致，未使用旧 Agent 留下的会话身份。" };
	if (!identity || !summary.workspacePath)
		return { seed: null, unavailableReason: "缺少可靠原生会话身份或工作目录，无法完整继承。" };
	if (identity.sourceAgentId === "codex") {
		return await withCodexAppServerRequestConnection(
			{
				workingDirectory: summary.workspacePath,
				codexConversationStorageNativeSessionId: identity.nativeSessionId,
				codexConversationStorageHomeDirectoryPath: resolveRecordedCodexConversationHome({
					...summary,
					transcriptPath: identity.transcriptPath,
				}),
			},
			async (port) => {
				const turns = await readCodexConversationTurns(port, identity.nativeSessionId);
				const last = turns.at(-1);
				if (!last || last.status !== "completed")
					return { seed: null, unavailableReason: "最后一个原生回合尚未完整结束，暂不能完整继承。" };
				const result = z.object({ thread: z.object({ id: z.string(), path: z.string() }) }).parse(
					await port.request("thread/fork", {
						threadId: identity.nativeSessionId,
						lastTurnId: last.id,
						cwd: summary.workspacePath,
						excludeTurns: true,
					}),
				);
				if (result.thread.id === identity.nativeSessionId) throw new Error("原生分支没有取得独立身份。");
				await verifyRestoredCodexConversationPrefix(
					port,
					result.thread.id,
					turns.map((turn) => turn.id),
				);
				return {
					seed: {
						sourceAgentId: "codex",
						sourceSessionId: result.thread.id,
						sourceSessionReuseMode: "fork_existing_session",
						sourceSessionWorkingDirectoryPath: summary.workspacePath ?? undefined,
						codexConversationStorageHomeDirectoryPath:
							inferCodexHomeDirectoryPathFromTranscriptPath(result.thread.path) ??
							resolveRecordedCodexConversationHome({
								...summary,
								transcriptPath: identity.transcriptPath,
							}),
					},
					unavailableReason: null,
				};
			},
		);
	}
	if (identity.sourceAgentId === "claude" && identity.transcriptPath) {
		const forked = await forkSession(identity.nativeSessionId, {
			dir: summary.workspacePath,
			title: "Kanban 独立任务的固定来源",
		});
		if (forked.sessionId === identity.nativeSessionId) throw new Error("原生分支没有取得独立身份。");
		await stat(join(dirname(identity.transcriptPath), `${forked.sessionId}.jsonl`));
		return {
			seed: {
				sourceAgentId: "claude",
				sourceSessionId: forked.sessionId,
				sourceSessionReuseMode: "fork_existing_session",
				sourceSessionWorkingDirectoryPath: summary.workspacePath,
			},
			unavailableReason: null,
		};
	}
	return { seed: null, unavailableReason: "此 Agent 尚未接入可靠的独立任务历史分叉，请选择全新上下文。" };
}
