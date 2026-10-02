// 运行时启动、hydrate 之前，给存量 Cursor 会话补上身份 / 校正状态（fill-only，逐会话只读自己 cwd 的 chat 桶）。
//
// 背景：task 203f3 之前 kanban 从未记录 Cursor 的 chat id，存量会话的续跑一律是 `--continue`。部署新版本后：
//   - 桶里**恰好一段**已建立的对话、且没有同 cwd 的其它 cursor 会话 ⇒ 把它钉成身份。这与 `--continue` 今天会选中的
//     那一段等价，行为不变，只是此后不再依赖「最近一段」。
//   - 一段已建立的对话都没有 ⇒ 标成「从未建立对话」，并把熔断留下的过期文案（「请手动刷新终端」——刷新无效）
//     换成如实的说明。8ef28 / aa23d / 49a31 落在这一类。
//   - ≥2 段或有竞争者 ⇒ 不动：有歧义就不猜。
//
// 政策说明：post-mortem 2026-09-24 定的是「身份只认 agent 报告，绝不从路径反推；不做投机性历史迁移」。本回填是用户在
// task 203f3 授权的**窄例外**：只在唯一时钉、且与 `--continue` 的选择逐一等价；钉下的身份带
// identityEstablishmentMethod = unique_established_chat_in_working_directory_bucket_backfill，审计可分。
//
// 只处理**本 workspace 看板上确有其卡**的会话：各 workspace 的 sessions.json 里有跨看板的幽灵副本（同一个 taskId
// 出现在十几个 workspace 里），对它们动手只会制造更多不一致。

import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import {
	buildKanbanEstablishedAgentNativeConversationSessionIdentity,
	decideCursorAgentChatResumeTargetBeforeLaunch,
	describeCursorAgentConversationNeverEstablishedResumeRefusal,
} from "./cursor-agent-chat-id-assignment-and-resume-preflight-before-launch";
import { readRecordedCursorAgentChatId } from "./cursor-agent-chat-launch-identity-orchestration";
import {
	type CursorAgentChatStoreEnvironmentOverrides,
	inspectCursorAgentChatInWorkingDirectoryBucket,
	listCursorAgentChatsInWorkingDirectoryBucket,
} from "./cursor-agent-chat-store-location-and-conversation-inspection";

export interface CursorAgentChatIdentityBackfillBeforeHydrateOutcome {
	pinnedTaskConversationSessionIds: string[];
	markedConversationNeverEstablishedTaskConversationSessionIds: string[];
}

function resolveHostWorkspaceTaskId(taskConversationSessionId: string, summary: RuntimeTaskSessionSummary): string {
	return summary.taskConversationSessionMetadata?.workspaceTaskId ?? taskConversationSessionId;
}

export async function backfillCursorAgentChatIdentityAndNeverEstablishedStateBeforeHydrate(input: {
	sessions: Record<string, RuntimeTaskSessionSummary>;
	taskIdsOnWorkspaceBoard: ReadonlySet<string>;
	currentTimeEpochMs: number;
	environmentOverrides?: CursorAgentChatStoreEnvironmentOverrides;
}): Promise<CursorAgentChatIdentityBackfillBeforeHydrateOutcome> {
	const outcome: CursorAgentChatIdentityBackfillBeforeHydrateOutcome = {
		pinnedTaskConversationSessionIds: [],
		markedConversationNeverEstablishedTaskConversationSessionIds: [],
	};
	const cursorSessionsOnBoard = Object.entries(input.sessions).filter(
		([taskConversationSessionId, summary]) =>
			summary.agentId === "cursor" &&
			summary.workspacePath !== null &&
			input.taskIdsOnWorkspaceBoard.has(resolveHostWorkspaceTaskId(taskConversationSessionId, summary)),
	);
	for (const [taskConversationSessionId, summary] of cursorSessionsOnBoard) {
		const workingDirectoryPath = summary.workspacePath;
		if (workingDirectoryPath === null) {
			continue;
		}
		const recordedCursorChatId = readRecordedCursorAgentChatId(summary.agentNativeConversationSessionIdentity);
		const hasCompetingCursorSessionInWorkingDirectory = cursorSessionsOnBoard.some(
			([otherTaskConversationSessionId, otherSummary]) =>
				otherTaskConversationSessionId !== taskConversationSessionId &&
				otherSummary.workspacePath === workingDirectoryPath,
		);
		const decision = decideCursorAgentChatResumeTargetBeforeLaunch({
			recordedCursorChatId,
			recordedChatInspection:
				recordedCursorChatId === null
					? null
					: await inspectCursorAgentChatInWorkingDirectoryBucket({
							workingDirectoryPath,
							chatId: recordedCursorChatId,
							environmentOverrides: input.environmentOverrides,
						}),
			chatsInWorkingDirectoryBucket:
				recordedCursorChatId === null
					? await listCursorAgentChatsInWorkingDirectoryBucket({
							workingDirectoryPath,
							environmentOverrides: input.environmentOverrides,
						})
					: [],
			hasCompetingCursorSessionInWorkingDirectory,
		});
		if (decision.kind === "pin_unique_established_chat_then_resume_by_id") {
			input.sessions[taskConversationSessionId] = {
				...summary,
				agentNativeConversationSessionIdentity: buildKanbanEstablishedAgentNativeConversationSessionIdentity({
					agentId: "cursor",
					nativeSessionId: decision.chatId,
					observedAt: input.currentTimeEpochMs,
					identityEstablishmentMethod: "unique_established_chat_in_working_directory_bucket_backfill",
				}),
			};
			outcome.pinnedTaskConversationSessionIds.push(taskConversationSessionId);
			continue;
		}
		if (decision.kind !== "refuse_conversation_never_established_in_working_directory") {
			continue;
		}
		input.sessions[taskConversationSessionId] = {
			...summary,
			warningMessage: describeCursorAgentConversationNeverEstablishedResumeRefusal({
				refusalCause: decision.refusalCause,
				recordedChatId: decision.recordedChatId,
				workingDirectoryPath,
			}),
			agentNativeConversationPersistenceObservation: {
				persistenceStatus: "conversation_never_established_in_agent_native_store",
				nativeSessionId: decision.recordedChatId,
				workingDirectoryPath,
				suspectedBlockingCause:
					summary.agentNativeConversationPersistenceObservation?.suspectedBlockingCause ?? null,
				observedAt: input.currentTimeEpochMs,
			},
		};
		outcome.markedConversationNeverEstablishedTaskConversationSessionIds.push(taskConversationSessionId);
	}
	return outcome;
}
