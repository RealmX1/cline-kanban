import { Bot, Cpu, Wind } from "lucide-react";
import type { ComponentType } from "react";

import { ClaudeIcon, CodexIcon, GeminiIcon } from "@/components/ui/agent-brand-icons";
import { ClineIcon } from "@/components/ui/cline-icon";
import type { RuntimeAgentId } from "@/runtime/types";

/**
 * agent 角标图标既可能是 lucide 图标，也可能是内联品牌 SVG（Claude/Codex/Cline/Gemini 用真实品牌标）。
 * 两者都接受 `{ size, className }`，故统一收敛到这个组件类型，避免把品牌标硬塞成 LucideIcon。
 */
export type AgentIconComponent = ComponentType<{ size?: number | string; className?: string }>;

/**
 * 每-agent 的角标视觉：一个可辨识的图标 + 一个着色 className（status-* / text-* 设计 token）。
 * 纯数据映射（无包装层），供任务卡左上角的 agent 纯图标角标使用。
 * claude/codex/cline/gemini 用真实品牌标（内联 SVG）；droid/kiro 暂用可辨识的 lucide 图标 + status 配色。
 */
export interface AgentVisual {
	Icon: AgentIconComponent;
	className: string;
}

const AGENT_VISUAL_BY_ID: Partial<Record<RuntimeAgentId, AgentVisual>> = {
	claude: { Icon: ClaudeIcon, className: "text-status-orange" },
	codex: { Icon: CodexIcon, className: "text-text-primary" },
	cline: { Icon: ClineIcon, className: "text-status-blue" },
	gemini: { Icon: GeminiIcon, className: "text-status-purple" },
	droid: { Icon: Cpu, className: "text-status-red" },
	kiro: { Icon: Wind, className: "text-status-gold" },
};

const FALLBACK_AGENT_VISUAL: AgentVisual = { Icon: Bot, className: "text-text-secondary" };

export function getAgentVisual(agentId: RuntimeAgentId | string | null | undefined): AgentVisual {
	if (!agentId) {
		return FALLBACK_AGENT_VISUAL;
	}
	return AGENT_VISUAL_BY_ID[agentId as RuntimeAgentId] ?? FALLBACK_AGENT_VISUAL;
}
