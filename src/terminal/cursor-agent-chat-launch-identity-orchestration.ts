// Cursor 会话在启动漏斗里的三处检查：续跑预检、首轮落盘看门狗、退出时核对。
//
// session-manager 只负责在对的时机调用这里、再把结论经 updateSummary 漏斗写回；读 chat store 与判定都在这里，
// 免得 Cursor 专属的细节散进 5000 行的 manager。判定口径见
// cursor-agent-chat-store-location-and-conversation-inspection.ts 文件头（实测证据也记在那里）。

import type {
	RuntimeAgentNativeConversationPersistenceObservation,
	RuntimeAgentNativeConversationSessionIdentity,
} from "../core/api-contract";
import {
	type CursorAgentChatResumeTargetPreflightDecision,
	decideCursorAgentChatResumeTargetBeforeLaunch,
} from "./cursor-agent-chat-id-assignment-and-resume-preflight-before-launch";
import {
	type CursorAgentChatConversationInspection,
	type CursorAgentChatStoreEnvironmentOverrides,
	inspectCursorAgentChatInWorkingDirectoryBucket,
	listCursorAgentChatsInWorkingDirectoryBucket,
} from "./cursor-agent-chat-store-location-and-conversation-inspection";
import { hasCursorWorkspaceTrustPrompt } from "./cursor-workspace-trust";

// 全新开局后，kanban 分配的 chat 多久还没出现在 chat store 里就算「prompt 没提交」。实测 prompt 提交后约 1s
// store.db 就出现；cursor-agent 冷启动（加载模型目录、MCP）本身要几秒，45s 留足余量。看门狗挂在 15s 一轮的
// 卡顿扫描上，所以实际在 45–60s 之间标出。
export const CURSOR_AGENT_FIRST_PROMPT_PERSISTENCE_STARTUP_WINDOW_MS = 45_000;

// 只取 cursor 会读的那两个 env；启动请求里的 env 覆写优先于运行时进程 env（与 buildTerminalEnvironment 叠加顺序一致）。
export function pickCursorAgentChatStoreEnvironmentOverrides(
	requestEnvironment: Record<string, string | undefined> | undefined,
): CursorAgentChatStoreEnvironmentOverrides {
	return {
		...(requestEnvironment?.CURSOR_CONFIG_DIR !== undefined
			? { CURSOR_CONFIG_DIR: requestEnvironment.CURSOR_CONFIG_DIR }
			: {}),
		...(requestEnvironment?.XDG_CONFIG_HOME !== undefined
			? { XDG_CONFIG_HOME: requestEnvironment.XDG_CONFIG_HOME }
			: {}),
	};
}

// 只认 sourceAgentId 为 cursor 的身份：任务从 claude 换到 cursor 时，summary 上残留的是 claude 的 session id，
// 拿它去 `cursor-agent --resume` 只会开出一段空对话。
export function readRecordedCursorAgentChatId(
	identity: RuntimeAgentNativeConversationSessionIdentity | null | undefined,
): string | null {
	return identity?.sourceAgentId === "cursor" ? identity.nativeSessionId : null;
}

export async function runCursorAgentChatResumeTargetPreflight(input: {
	workingDirectoryPath: string;
	environmentOverrides: CursorAgentChatStoreEnvironmentOverrides;
	recordedIdentity: RuntimeAgentNativeConversationSessionIdentity | null | undefined;
	hasCompetingCursorSessionInWorkingDirectory: boolean;
}): Promise<CursorAgentChatResumeTargetPreflightDecision> {
	const recordedCursorChatId = readRecordedCursorAgentChatId(input.recordedIdentity);
	const [recordedChatInspection, chatsInWorkingDirectoryBucket] = await Promise.all([
		recordedCursorChatId === null
			? Promise.resolve(null)
			: inspectCursorAgentChatInWorkingDirectoryBucket({
					workingDirectoryPath: input.workingDirectoryPath,
					chatId: recordedCursorChatId,
					environmentOverrides: input.environmentOverrides,
				}),
		recordedCursorChatId === null
			? listCursorAgentChatsInWorkingDirectoryBucket({
					workingDirectoryPath: input.workingDirectoryPath,
					environmentOverrides: input.environmentOverrides,
				})
			: Promise.resolve([]),
	]);
	return decideCursorAgentChatResumeTargetBeforeLaunch({
		recordedCursorChatId,
		recordedChatInspection,
		chatsInWorkingDirectoryBucket,
		hasCompetingCursorSessionInWorkingDirectory: input.hasCompetingCursorSessionInWorkingDirectory,
	});
}

// 活会话上的看门狗状态（挂在 ActiveProcessState 上，只在「kanban 分配 id 的全新开局」时创建）。
export interface KanbanAssignedCursorAgentChatFirstPromptPersistenceWatch {
	nativeSessionId: string;
	workingDirectoryPath: string;
	environmentOverrides: CursorAgentChatStoreEnvironmentOverrides;
	watchStartedAtEpochMs: number;
	// 上一次写进 summary 的状态，用来只在变化时写（每 15s 一轮，不变就不广播）。
	lastPublishedPersistenceStatus: RuntimeAgentNativeConversationPersistenceObservation["persistenceStatus"] | null;
}

export type KanbanAssignedCursorAgentChatFirstPromptPersistenceVerdict =
	| { kind: "conversation_established_in_agent_native_store" }
	// store.db 已出现（prompt 已提交），首个检查点还没到——长首轮时这段可以很长，属正常。
	| { kind: "first_prompt_submitted_awaiting_first_checkpoint" }
	| { kind: "still_within_startup_window" }
	| {
			kind: "first_prompt_not_persisted_within_startup_window";
			suspectedBlockingCause: RuntimeAgentNativeConversationPersistenceObservation["suspectedBlockingCause"];
	  };

export function deriveKanbanAssignedCursorAgentChatFirstPromptPersistenceVerdict(input: {
	inspection: CursorAgentChatConversationInspection;
	elapsedSinceWatchStartedMs: number;
	terminalScreenText: string | null;
}): KanbanAssignedCursorAgentChatFirstPromptPersistenceVerdict {
	if (input.inspection.storeDatabaseFileExists && input.inspection.hasConversation === true) {
		return { kind: "conversation_established_in_agent_native_store" };
	}
	if (input.inspection.storeDatabaseFileExists) {
		return { kind: "first_prompt_submitted_awaiting_first_checkpoint" };
	}
	if (input.elapsedSinceWatchStartedMs < CURSOR_AGENT_FIRST_PROMPT_PERSISTENCE_STARTUP_WINDOW_MS) {
		return { kind: "still_within_startup_window" };
	}
	return {
		kind: "first_prompt_not_persisted_within_startup_window",
		suspectedBlockingCause:
			input.terminalScreenText !== null && hasCursorWorkspaceTrustPrompt(input.terminalScreenText)
				? "agent_workspace_trust_prompt_awaiting_answer"
				: null,
	};
}

export async function inspectKanbanAssignedCursorAgentChatFirstPromptPersistence(input: {
	watch: KanbanAssignedCursorAgentChatFirstPromptPersistenceWatch;
	currentTimeEpochMs: number;
	readTerminalScreenText: () => Promise<string | null>;
}): Promise<KanbanAssignedCursorAgentChatFirstPromptPersistenceVerdict> {
	const inspection = await inspectCursorAgentChatInWorkingDirectoryBucket({
		workingDirectoryPath: input.watch.workingDirectoryPath,
		chatId: input.watch.nativeSessionId,
		environmentOverrides: input.watch.environmentOverrides,
	});
	const elapsedSinceWatchStartedMs = input.currentTimeEpochMs - input.watch.watchStartedAtEpochMs;
	// 屏幕只在要下「没提交」结论时才读：读全屏快照有成本，窗口内或已提交时都用不上。
	const needsTerminalScreenText =
		!inspection.storeDatabaseFileExists &&
		elapsedSinceWatchStartedMs >= CURSOR_AGENT_FIRST_PROMPT_PERSISTENCE_STARTUP_WINDOW_MS;
	return deriveKanbanAssignedCursorAgentChatFirstPromptPersistenceVerdict({
		inspection,
		elapsedSinceWatchStartedMs,
		terminalScreenText: needsTerminalScreenText ? await input.readTerminalScreenText() : null,
	});
}

// PTY 退出时的最终核对：这段对话到底建立了没有。
export async function wasKanbanAssignedCursorAgentChatConversationEstablishedAtExit(
	watch: KanbanAssignedCursorAgentChatFirstPromptPersistenceWatch,
): Promise<boolean> {
	const inspection = await inspectCursorAgentChatInWorkingDirectoryBucket({
		workingDirectoryPath: watch.workingDirectoryPath,
		chatId: watch.nativeSessionId,
		environmentOverrides: watch.environmentOverrides,
	});
	return inspection.storeDatabaseFileExists && inspection.hasConversation === true;
}
