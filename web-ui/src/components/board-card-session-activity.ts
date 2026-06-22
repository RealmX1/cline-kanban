// 看板卡片「会话活性预览」（状态点颜色 + 单行预览文案）的纯派生逻辑——从 board-card.tsx 抽出为
// 独立、零 React 依赖、可直接单测的模块（双轴会话状态重构 Stage 3 首步抽取，零行为变更）。
//
// 真相源：Stage 3 余区已把本派生的全部 legacy 一维 `summary.state` 读迁到双轴 facet
// （resolveSessionFacets + isAwaitingUserReviewTurn，叠加 connectionRetry / latestHookActivity），
// 逐项等价、零可见行为变更，由本模块单测作「迁移前可见行为基线」回归护栏钉住。
// 仍属「行为保持」：channel C 的人轴文案增强（按 userTurnKind 细分 question / permission / error…）
// 是后续与列映射 / 通知白名单同批的改动，本模块此刻不引入新文案、不改可见行为。

import { formatClineToolCallLabel } from "@runtime-cline-tool-call-display";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "@runtime-session-activity";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export interface CardSessionActivity {
	dotColor: string;
	text: string;
}

export const SESSION_ACTIVITY_COLOR = {
	thinking: "var(--color-status-blue)",
	success: "var(--color-status-green)",
	waiting: "var(--color-status-gold)",
	error: "var(--color-status-red)",
	warning: "var(--color-status-orange)",
	muted: "var(--color-text-tertiary)",
	secondary: "var(--color-text-secondary)",
} as const;

function extractToolInputSummaryFromActivityText(activityText: string, toolName: string): string | null {
	const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = activityText.match(
		new RegExp(`^(?:Using|Completed|Failed|Calling)\\s+${escapedToolName}(?::\\s*(.+))?$`),
	);
	if (!match) {
		return null;
	}
	const rawSummary = match[1]?.trim() ?? "";
	if (!rawSummary) {
		return null;
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return operationSummary?.trim() || null;
	}
	return rawSummary;
}

function parseToolCallFromActivityText(
	activityText: string,
): { toolName: string; toolInputSummary: string | null } | null {
	const match = activityText.match(/^(?:Using|Completed|Failed|Calling)\s+([^:()]+?)(?::\s*(.+))?$/);
	if (!match?.[1]) {
		return null;
	}
	const toolName = match[1].trim();
	if (!toolName) {
		return null;
	}
	const rawSummary = match[2]?.trim() ?? "";
	if (!rawSummary) {
		return { toolName, toolInputSummary: null };
	}
	if (activityText.startsWith("Failed ")) {
		const [operationSummary] = rawSummary.split(": ");
		return {
			toolName,
			toolInputSummary: operationSummary?.trim() || null,
		};
	}
	return {
		toolName,
		toolInputSummary: rawSummary,
	};
}

function resolveToolCallLabel(
	activityText: string | undefined,
	toolName: string | null,
	toolInputSummary: string | null,
): string | null {
	if (toolName) {
		const parsedSummary = extractToolInputSummaryFromActivityText(activityText ?? "", toolName);
		if (!toolInputSummary && !parsedSummary) {
			return null;
		}
		return formatClineToolCallLabel(toolName, toolInputSummary ?? parsedSummary);
	}
	if (!activityText) {
		return null;
	}
	const parsed = parseToolCallFromActivityText(activityText);
	if (!parsed) {
		return null;
	}
	return formatClineToolCallLabel(parsed.toolName, parsed.toolInputSummary);
}

export function isCardCreditLimitError(summary: RuntimeTaskSessionSummary | undefined): boolean {
	if (!summary) {
		return false;
	}
	// 旧 `state ∈ {awaiting_review, failed, interrupted}` ⟺ turnOwner==="user"（这三态是 user 回合的全部 legacy 投影）。
	if (resolveSessionFacets(summary).turnOwner !== "user") {
		return false;
	}
	return summary.latestHookActivity?.notificationType === "credit_limit";
}

export function deriveCardSessionActivity(summary: RuntimeTaskSessionSummary | undefined): CardSessionActivity | null {
	if (!summary) {
		return null;
	}
	// Stage 3 余区：本派生从 legacy 一维 `summary.state` 读 → 双轴 facet 真相源（零可见行为变更）。
	// 各 state 读逐项等价：running⟺turnOwner==="agent"；awaiting_review⟺isAwaitingUserReviewTurn；
	// failed⟺turnOwner==="user" && liveness==="failed"（全表等价见 session-facets.test.ts）。
	const facets = resolveSessionFacets(summary);
	if (isCardCreditLimitError(summary)) {
		return { dotColor: SESSION_ACTIVITY_COLOR.warning, text: "Out of credits" };
	}
	// 连接重试是最显著的「卡住」状态：优先于普通活动文案展示。
	if (summary.connectionRetry?.status === "retrying") {
		const attempts = summary.connectionRetry.retryCount;
		return {
			dotColor: SESSION_ACTIVITY_COLOR.warning,
			text: attempts > 0 ? `重连中…（已续跑 ${attempts} 次）` : "重连中…",
		};
	}
	const hookActivity = summary.latestHookActivity;
	const activityText = hookActivity?.activityText?.trim();
	const toolName = hookActivity?.toolName?.trim() ?? null;
	const toolInputSummary = hookActivity?.toolInputSummary?.trim() ?? null;
	const finalMessage = hookActivity?.finalMessage?.trim();
	const hookEventName = hookActivity?.hookEventName?.trim() ?? null;
	if (isAwaitingUserReviewTurn(facets) && finalMessage) {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: finalMessage };
	}
	if (
		finalMessage &&
		!toolName &&
		(hookEventName === "assistant_delta" || hookEventName === "agent_end" || hookEventName === "turn_start")
	) {
		return {
			dotColor: facets.turnOwner === "agent" ? SESSION_ACTIVITY_COLOR.thinking : SESSION_ACTIVITY_COLOR.success,
			text: finalMessage,
		};
	}
	if (activityText) {
		let dotColor: string =
			facets.turnOwner === "user" && facets.liveness === "failed"
				? SESSION_ACTIVITY_COLOR.error
				: SESSION_ACTIVITY_COLOR.thinking;
		let text = activityText;
		const toolCallLabel = resolveToolCallLabel(activityText, toolName, toolInputSummary);
		if (toolCallLabel) {
			if (text.startsWith("Failed ")) {
				dotColor = SESSION_ACTIVITY_COLOR.error;
			}
			return {
				dotColor,
				text: toolCallLabel,
			};
		}
		if (text.startsWith("Final: ")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
			text = text.slice(7);
		} else if (text.startsWith("Agent: ")) {
			text = text.slice(7);
		} else if (text.startsWith("Waiting for approval")) {
			dotColor = SESSION_ACTIVITY_COLOR.waiting;
		} else if (text.startsWith("Waiting for review")) {
			dotColor = SESSION_ACTIVITY_COLOR.success;
		} else if (text.startsWith("Failed ")) {
			dotColor = SESSION_ACTIVITY_COLOR.error;
		} else if (text === "Agent active" || text === "Working on task" || text.startsWith("Resumed")) {
			return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
		}
		return { dotColor, text };
	}
	if (facets.turnOwner === "user" && facets.liveness === "failed") {
		const failedText = finalMessage ?? activityText ?? "Task failed to start";
		return { dotColor: SESSION_ACTIVITY_COLOR.error, text: failedText };
	}
	if (isAwaitingUserReviewTurn(facets)) {
		return { dotColor: SESSION_ACTIVITY_COLOR.success, text: "Waiting for review" };
	}
	if (facets.turnOwner === "agent") {
		return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
	}
	return null;
}
