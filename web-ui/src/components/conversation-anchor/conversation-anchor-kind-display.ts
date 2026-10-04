// 聊天内导航锚 chip 的 kind 显示映射（图标 / 配色 / 文案）。
//
// 【休眠】旧 session map 的锚 marker 机制已退役（会话结构改由 agent-conversation-exploration-thread-graph
// 包的 work-branch 作业维护，agent 不再埋 marker）。本目录保留 marker 解析 / chip / spotlight 三件套
// 供将来「聊天消息 ↔ thread graph turn 行」的双向定位复用；kind 枚举随之改为本地定义，不再依赖
// 服务端契约。
import { Bookmark, CornerDownRight, GitFork, MessageCircleQuestion, Milestone } from "lucide-react";

export type ConversationAnchorKind =
	| "milestone"
	| "decision_point"
	| "open_question"
	| "digression"
	| "finding_reference";

export interface ConversationAnchorKindDisplay {
	icon: typeof Milestone;
	// 图标/强调色（Tailwind text token）。
	colorClassName: string;
	label: string;
}

const CONVERSATION_ANCHOR_KIND_DISPLAY: Record<ConversationAnchorKind, ConversationAnchorKindDisplay> = {
	milestone: { icon: Milestone, colorClassName: "text-status-green", label: "Milestone" },
	decision_point: { icon: GitFork, colorClassName: "text-status-blue", label: "Decision point" },
	open_question: { icon: MessageCircleQuestion, colorClassName: "text-status-orange", label: "Open question" },
	digression: { icon: CornerDownRight, colorClassName: "text-status-purple", label: "Digression" },
	finding_reference: { icon: Bookmark, colorClassName: "text-status-gold", label: "Finding" },
};

export function getConversationAnchorKindDisplay(kind: ConversationAnchorKind): ConversationAnchorKindDisplay {
	return CONVERSATION_ANCHOR_KIND_DISPLAY[kind];
}
