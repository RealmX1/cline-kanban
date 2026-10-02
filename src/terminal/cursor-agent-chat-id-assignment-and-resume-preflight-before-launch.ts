// Cursor 会话的身份从源头确定，以及「续跑之前先看一眼能不能接上」的纯决策。
//
// 根因回顾（kanban task 203f3）：kanban 从未记录 Cursor 的 chat id——cursor-agent 没有可供 kanban 安装的会话级
// hook——所以每次重启都退回 `cursor-agent --continue`（cwd 桶里最近一段）。从未建立过对话的会话（典型：停在
// Workspace Trust 对话框上）一被重启就撞 `No previous chats found.` exit 1，连撞 5 次熔断；熔断文案让人手动刷新，
// 刷新走的仍是同一条 `--continue`。
//
// 现在的做法：
//   ① 每次全新开局，kanban 先分配一个 UUID、落盘，再以 `--resume <id> <prompt>` 启动——cursor 实测会以该 id 建 chat
//     并自动提交 prompt。此后一切重启都按 id 续跑。
//   ② 续跑之前读 chat store（只读 meta.json / stat）判定能不能接上；接不上就**不 spawn**，给出可执行的出路，
//     而不是起一个注定秒退的进程去喂熔断器。

import { randomUUID } from "node:crypto";

import type {
	RuntimeAgentNativeConversationSessionIdentity,
	RuntimeAgentNativeConversationSessionIdentityEstablishmentMethod,
} from "../core/api-contract";
import {
	type CursorAgentChatConversationInspection,
	isCursorAgentChatConversationEstablished,
} from "./cursor-agent-chat-store-location-and-conversation-inspection";

export function assignCursorAgentChatIdBeforeLaunch(): string {
	// EXPERIMENT_NODE: 用进程内 randomUUID 而非 `cursor-agent create-chat`。create-chat 在 2026.10.01 版本里也只是 randomUUID + 打印、不落盘，但打印后进程永不自行退出（实测 20s 仍挂着），子进程方案得读首行再强杀；若日后 create-chat 改为服务端注册 / 落盘，再改回调用它。
	return randomUUID();
}

export function buildKanbanEstablishedAgentNativeConversationSessionIdentity(input: {
	agentId: string;
	nativeSessionId: string;
	observedAt: number;
	identityEstablishmentMethod: Exclude<
		RuntimeAgentNativeConversationSessionIdentityEstablishmentMethod,
		"observed_from_agent_hook_extension_or_acp_handshake"
	>;
}): RuntimeAgentNativeConversationSessionIdentity {
	return {
		sourceAgentId: input.agentId,
		nativeSessionId: input.nativeSessionId,
		// Cursor 的 transcript 在 `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`，但那是由路径拼出来的，
		// 不是 agent 报告的——身份 sidecar 不收路径推断值。
		transcriptPath: null,
		observedAt: input.observedAt,
		identityEstablishmentMethod: input.identityEstablishmentMethod,
	};
}

export type CursorAgentChatResumeTargetPreflightDecision =
	| {
			// 已记录的 id 在本 cwd 桶里有一段已建立的对话 ⇒ 按 id 续跑。
			kind: "resume_by_recorded_chat_id";
			chatId: string;
	  }
	| {
			// 没有记录 id，桶里**恰好一段**已建立的对话、且没有同 agent 竞争会话 ⇒ 这正是 `--continue` 会选中的那段；
			// 先把它钉成本会话的身份，再按 id 续跑。行为与今天等价，只是此后不再依赖「最近一段」。
			kind: "pin_unique_established_chat_then_resume_by_id";
			chatId: string;
	  }
	| {
			// 没有记录 id，桶里有 ≥2 段已建立的对话 ⇒ 维持现行 `--continue`（桶非空，不会撞 No previous chats），
			// 但有歧义就不钉。
			kind: "resume_latest_established_chat_in_working_directory_bucket";
			establishedChatCount: number;
	  }
	| {
			kind: "refuse_conversation_never_established_in_working_directory";
			recordedChatId: string | null;
			refusalCause:
				| "recorded_chat_has_no_established_conversation_in_working_directory"
				| "working_directory_bucket_has_no_established_conversation";
	  };

export function decideCursorAgentChatResumeTargetBeforeLaunch(input: {
	// summary 上记录的 Cursor chat id（sourceAgentId 必须是 cursor）；没有就是 null。
	recordedCursorChatId: string | null;
	// recordedCursorChatId 在本次执行工作目录桶里的检查结果；没有记录 id 时为 null。
	recordedChatInspection: CursorAgentChatConversationInspection | null;
	// 本次执行工作目录桶里的全部 chat。
	chatsInWorkingDirectoryBucket: readonly CursorAgentChatConversationInspection[];
	// 同一个执行工作目录里是否还有别的 cursor 会话（主会话 + By the way 侧问、多个 inplace 任务…）。
	hasCompetingCursorSessionInWorkingDirectory: boolean;
}): CursorAgentChatResumeTargetPreflightDecision {
	if (input.recordedCursorChatId !== null) {
		// 有 id 就只认这个 id：`--resume <id>` 找不到时**不报错**，而是静默开一段同 id 的空对话（实测），所以
		// 不能指望 cursor 自己拒绝。也不回退去 `--continue`——那会把别的对话接到本会话名下。
		if (input.recordedChatInspection && isCursorAgentChatConversationEstablished(input.recordedChatInspection)) {
			return { kind: "resume_by_recorded_chat_id", chatId: input.recordedCursorChatId };
		}
		return {
			kind: "refuse_conversation_never_established_in_working_directory",
			recordedChatId: input.recordedCursorChatId,
			refusalCause: "recorded_chat_has_no_established_conversation_in_working_directory",
		};
	}
	const establishedChats = input.chatsInWorkingDirectoryBucket.filter(isCursorAgentChatConversationEstablished);
	if (establishedChats.length === 0) {
		return {
			kind: "refuse_conversation_never_established_in_working_directory",
			recordedChatId: null,
			refusalCause: "working_directory_bucket_has_no_established_conversation",
		};
	}
	const [uniqueEstablishedChat] = establishedChats;
	if (establishedChats.length === 1 && uniqueEstablishedChat && !input.hasCompetingCursorSessionInWorkingDirectory) {
		return { kind: "pin_unique_established_chat_then_resume_by_id", chatId: uniqueEstablishedChat.chatId };
	}
	return {
		kind: "resume_latest_established_chat_in_working_directory_bucket",
		establishedChatCount: establishedChats.length,
	};
}

// 拒绝文案。出路只写当前产品里真的走得通的动作（终端面板上的两个按钮），并说清为什么「刷新」没用。
export function describeCursorAgentConversationNeverEstablishedResumeRefusal(input: {
	refusalCause: Extract<
		CursorAgentChatResumeTargetPreflightDecision,
		{ kind: "refuse_conversation_never_established_in_working_directory" }
	>["refusalCause"];
	recordedChatId: string | null;
	workingDirectoryPath: string;
}): string {
	const conversationLocation =
		input.refusalCause === "recorded_chat_has_no_established_conversation_in_working_directory"
			? `记录的 Cursor 对话 ${input.recordedChatId} 在 ${input.workingDirectoryPath} 里没有已建立的内容`
			: `${input.workingDirectoryPath} 里没有任何已建立的 Cursor 对话`;
	return (
		`没有可续接的 Cursor 对话：${conversationLocation}（首轮从未落盘，常见原因是当时停在了 Workspace Trust 对话框）。` +
		`已停止续跑，没有启动 cursor-agent——续跑只会得到 "No previous chats found." 或一段空对话，刷新也一样。` +
		`可以在终端面板里选择「用原 prompt 全新开局」，或「从既有 Cursor 对话迁入」。`
	);
}
