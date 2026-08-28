// Session Map 节点 kind 的显示映射（图标 / 配色 / 文案），chip 与 map 面板共用。
// kind 枚举定义在服务端契约（@runtime-contract，蓝图 §B.1），这里只负责「怎么画」。

import { Bookmark, CornerDownRight, GitFork, MessageCircleQuestion, Milestone } from "lucide-react";
import type { RuntimeExploratorySessionMapNodeKind } from "@/runtime/types";

export interface SessionMapNodeKindDisplay {
	icon: typeof Milestone;
	// 图标/强调色（Tailwind text token）。
	colorClassName: string;
	label: string;
}

const SESSION_MAP_NODE_KIND_DISPLAY: Record<RuntimeExploratorySessionMapNodeKind, SessionMapNodeKindDisplay> = {
	milestone: { icon: Milestone, colorClassName: "text-status-green", label: "Milestone" },
	decision_point: { icon: GitFork, colorClassName: "text-status-blue", label: "Decision point" },
	open_question: { icon: MessageCircleQuestion, colorClassName: "text-status-orange", label: "Open question" },
	digression: { icon: CornerDownRight, colorClassName: "text-status-purple", label: "Digression" },
	finding_reference: { icon: Bookmark, colorClassName: "text-status-gold", label: "Finding" },
};

export function getSessionMapNodeKindDisplay(kind: RuntimeExploratorySessionMapNodeKind): SessionMapNodeKindDisplay {
	return SESSION_MAP_NODE_KIND_DISPLAY[kind];
}
