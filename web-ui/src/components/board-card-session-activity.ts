// 看板卡片「会话活性预览」（状态点颜色 + 单行预览文案）的纯派生逻辑——从 board-card.tsx 抽出为
// 独立、零 React 依赖、可直接单测的模块（双轴会话状态重构 Stage 3 首步抽取，零行为变更）。
//
// 真相源：Stage 3 余区已把本派生的全部 legacy 一维 `summary.state` 读迁到双轴 facet
// （resolveSessionFacets + isAwaitingUserReviewTurn，叠加 connectionRetry / latestHookActivity）。
// Channel C（人轴文案，普适四种）已在此落地：等人审回合按 userTurnKind 细分状态点颜色 + 无内容占位
// CTA——review=完成待审(绿) / needs_input=待你输入(金) / error=运行出错(红)。question/plan_review/
// permission 在当前采集下不产出（普适四种折叠进 review/needs_input），待 Stage 4 可选采集增强再细分。

import { formatClineToolCallLabel } from "@runtime-cline-tool-call-display";
import { isAwaitingUserReviewTurn, resolveSessionFacets } from "@runtime-session-activity";
import type { RuntimeTaskSessionSummary, RuntimeTaskSessionUserTurnKind } from "@/runtime/types";

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

// Channel C（人轴文案，普适四种）：把「等人审查回合」的 userTurnKind 映射为状态点颜色 + 无内容时的
// 占位 CTA。review（完成/exit/hook）=完成待审(绿)；needs_input（attention/兜底）=待你输入(金 CTA)；
// error（运行错，区别于 spawn failed liveness）=运行出错(红)。interrupted 不经此（liveness=interrupted
// 非等人审回合）。占位文案沿用同族英文风格（"Waiting for review" / "Task failed to start"）。
function resolveAwaitingUserTurnPresentation(userTurnKind: RuntimeTaskSessionUserTurnKind | null): {
	dotColor: string;
	placeholder: string;
} {
	switch (userTurnKind) {
		case "error":
			return { dotColor: SESSION_ACTIVITY_COLOR.error, placeholder: "Encountered an error" };
		case "needs_input":
			return { dotColor: SESSION_ACTIVITY_COLOR.waiting, placeholder: "Needs your input" };
		default:
			return { dotColor: SESSION_ACTIVITY_COLOR.success, placeholder: "Waiting for review" };
	}
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
		// 仍逐字显示 finalMessage，状态点颜色随人轴 userTurnKind（review 绿 / needs_input 金 / error 红）。
		return { dotColor: resolveAwaitingUserTurnPresentation(facets.userTurnKind).dotColor, text: finalMessage };
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
		// Channel C 终端占位：按 userTurnKind 给出 完成待审 / 待你输入 / 运行出错 的颜色 + CTA。
		const { dotColor, placeholder } = resolveAwaitingUserTurnPresentation(facets.userTurnKind);
		return { dotColor, text: placeholder };
	}
	if (facets.turnOwner === "agent") {
		return { dotColor: SESSION_ACTIVITY_COLOR.thinking, text: "Thinking..." };
	}
	return null;
}
