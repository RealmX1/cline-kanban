import { Bot, Cpu, Gem, Hexagon, type LucideIcon, Sparkles, Wind } from "lucide-react";

import type { RuntimeAgentId } from "@/runtime/types";

/**
 * 每-agent 的角标视觉：一个可辨识的 lucide 图标 + 一个 status-* 配色 token。
 * 纯数据映射（无包装层），供任务卡左上角的 agent 纯图标角标着色。
 * 配色取自 globals.css 的 status 设计 token；起始映射仅要求互相可辨识，随时可调。
 */
export interface AgentVisual {
	Icon: LucideIcon;
	className: string;
}

const AGENT_VISUAL_BY_ID: Partial<Record<RuntimeAgentId, AgentVisual>> = {
	claude: { Icon: Sparkles, className: "text-status-orange" },
	codex: { Icon: Hexagon, className: "text-status-green" },
	cline: { Icon: Bot, className: "text-status-blue" },
	droid: { Icon: Cpu, className: "text-status-purple" },
	kiro: { Icon: Wind, className: "text-status-gold" },
	gemini: { Icon: Gem, className: "text-status-red" },
};

const FALLBACK_AGENT_VISUAL: AgentVisual = { Icon: Bot, className: "text-text-secondary" };

export function getAgentVisual(agentId: RuntimeAgentId | string | null | undefined): AgentVisual {
	if (!agentId) {
		return FALLBACK_AGENT_VISUAL;
	}
	return AGENT_VISUAL_BY_ID[agentId as RuntimeAgentId] ?? FALLBACK_AGENT_VISUAL;
}
