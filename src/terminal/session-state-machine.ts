import type {
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
} from "../core/api-contract";
import {
	deriveSessionFacetsFromLegacyState,
	isAwaitingUserReviewTurn,
	resolveSessionFacets,
} from "../core/session-activity";

export type SessionTransitionEvent =
	// userTurnKindOverride：harness 采集增强（如 Claude permission）覆写更细人轴；仅 user 回合生效。
	// reviewReason：翻入审查回合的成因，默认 "hook"（agent 自然完成）；用户手动触发时传 "manual_review"。
	// 它既被 stamp 进 summary.reviewReason，又作为 buildFacetPatch 的派生上下文，使 userTurnKind 与成因自洽。
	| {
			type: "hook.to_review";
			reviewReason?: RuntimeTaskSessionReviewReason;
			userTurnKindOverride?: RuntimeTaskSessionUserTurnKind;
	  }
	| { type: "hook.to_in_progress" }
	| { type: "agent.prompt-ready" }
	| { type: "process.exit"; exitCode: number | null; interrupted: boolean };

export interface SessionTransitionResult {
	changed: boolean;
	patch: Partial<RuntimeTaskSessionSummary>;
	clearAttentionBuffer: boolean;
}

// manual_review（「移至 Review」手动钉住）现也可翻回 running：agent 在活跃产出时下一笔
// to_in_progress / prompt-ready 即解锁，卡片回 In Progress。空闲 / 卡死的 manual_review 卡不会被误翻回——
// 它根本不发 hook、且 prompt-ready 探测仅对 reviewReason==="attention" 触发（见 agent-session-adapters.ts），
// 加之看板 Review 列已补活跃度 offset（use-board-interactions.ts），无实质产出者天然留在 review。
function canReturnToRunning(reason: RuntimeTaskSessionReviewReason): boolean {
	return reason === "attention" || reason === "hook" || reason === "error" || reason === "manual_review";
}

// Stage 4 全写侧反转：reducer 的转换补丁不再写 legacy `state`，而是从「目标 state + 当刻上下文」经
// 单源派生规则 deriveSessionFacetsFromLegacyState 产出完整三 facet（facet 是写时主真相源，state 由
// mergeSummaryWithFacets 的 projectLegacyState 投影）。process.exit 必须传 pid:null（后退出值），使
// 终端 agent 的 awaiting → liveness=exited、Cline → live（harness-aware，见 deriveSessionFacetsFromLegacyState）。
// userTurnKindOverride 仅在 user 回合覆写人轴（采集增强），其余沿用单源派生的 userTurnKind。
function buildFacetPatch(
	summary: RuntimeTaskSessionSummary,
	state: RuntimeTaskSessionState,
	context: { reviewReason: RuntimeTaskSessionReviewReason; pid: number | null },
	userTurnKindOverride?: RuntimeTaskSessionUserTurnKind,
): Partial<RuntimeTaskSessionSummary> {
	const facets = deriveSessionFacetsFromLegacyState(state, {
		reviewReason: context.reviewReason,
		pid: context.pid,
		connectionRetryActive: summary.connectionRetry != null,
		agentId: summary.agentId,
	});
	const userTurnKind =
		userTurnKindOverride !== undefined && facets.turnOwner === "user" ? userTurnKindOverride : facets.userTurnKind;
	return {
		turnOwner: facets.turnOwner,
		liveness: facets.liveness,
		userTurnKind,
	};
}

export function reduceSessionTransition(
	summary: RuntimeTaskSessionSummary,
	event: SessionTransitionEvent,
): SessionTransitionResult {
	switch (event.type) {
		case "hook.to_review": {
			// 旧门控 `state !== "running"` → facet 真相源 `turnOwner !== "agent"`（running ⟺ agent 回合）。
			if (resolveSessionFacets(summary).turnOwner !== "agent") {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			// 默认 "hook"（agent 自然完成）；手动「移至 Review」按钮传 "manual_review"。reviewReason 同时
			// stamp 进 summary 并喂给 buildFacetPatch，使 userTurnKind 经 deriveUserTurnKind 与成因自洽。
			const reviewReason: RuntimeTaskSessionReviewReason = event.reviewReason ?? "hook";
			return {
				changed: true,
				patch: {
					reviewReason,
					...buildFacetPatch(
						summary,
						"awaiting_review",
						{ reviewReason, pid: summary.pid },
						event.userTurnKindOverride,
					),
				},
				clearAttentionBuffer: true,
			};
		}
		case "hook.to_in_progress":
		case "agent.prompt-ready": {
			// 旧门控 `state !== "awaiting_review"` → facet 真相源 `!isAwaitingUserReviewTurn`（涵盖
			// live↔exited 折叠、零行为漂移）；canReturnToRunning(reviewReason) 子句不动。
			if (!isAwaitingUserReviewTurn(resolveSessionFacets(summary)) || !canReturnToRunning(summary.reviewReason)) {
				return { changed: false, patch: {}, clearAttentionBuffer: false };
			}
			return {
				changed: true,
				patch: {
					reviewReason: null,
					...buildFacetPatch(summary, "running", { reviewReason: null, pid: summary.pid }),
				},
				clearAttentionBuffer: true,
			};
		}
		case "process.exit": {
			let reason: RuntimeTaskSessionReviewReason = event.exitCode === 0 ? "exit" : "error";
			if (event.interrupted) {
				reason = "interrupted";
			}
			// 退出后 pid 必为 null（非 summary.pid，reducer 此刻 pid 仍非 null）：终端 agent 的 awaiting
			// → liveness=exited 的命门，误用 summary.pid 会把已退进程误标 live、悄毁本重构存在意义的区分。
			const exitState: RuntimeTaskSessionState = reason === "interrupted" ? "interrupted" : "awaiting_review";
			return {
				changed: true,
				patch: {
					reviewReason: reason,
					exitCode: event.exitCode,
					pid: null,
					...buildFacetPatch(summary, exitState, { reviewReason: reason, pid: null }),
				},
				clearAttentionBuffer: false,
			};
		}
		default: {
			return { changed: false, patch: {}, clearAttentionBuffer: false };
		}
	}
}
