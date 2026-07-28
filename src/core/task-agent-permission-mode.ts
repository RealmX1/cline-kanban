// 跨 harness 的「放权档位」域逻辑：默认档、各 agent 的原生表达能力、以及不能原生表达时
// 的降级解析。所有 adapter 与前端都从这里取真源，避免每个 harness 各写一份映射。
//
// 设计前提（与 startInPlanMode 的关系）：这条轴与「plan 起步」是**两条正交轴**。
// plan 起步只表示「开局先只读规划」，不代表放弃权限——一个以 plan 起步的会话仍必须能在
// 会话中途进入这里选定的档位。各 adapter 因此不得再用 startInPlanMode 去覆盖权限档。
import type { RuntimeAgentId, RuntimeTaskAgentPermissionMode } from "./api-contract";

export const DEFAULT_TASK_AGENT_PERMISSION_MODE: RuntimeTaskAgentPermissionMode = "bypass_all_permission_prompts";

// 哪些 agent 能原生表达「改文件放行、执行命令仍询问」这一中间档。
// 不在此集合里的 agent 只有二值放权能力，选中间档只能降级到 ask_for_every_tool_use。
const AGENT_IDS_SUPPORTING_AUTO_APPROVE_FILE_EDITS_ONLY: ReadonlySet<RuntimeAgentId> = new Set<RuntimeAgentId>([
	// --permission-mode acceptEdits
	"claude",
	// --approval-mode write
	"omp",
	// --approval-mode auto_edit（当前未在 launch 列表内，先记录能力）
	"gemini",
]);

// codex 刻意**不在**上面的集合里。它的放权是 sandbox × approval 两个旗标，但没有任何组合
// 能表达「改文件放行、执行命令仍询问」（据 codex --help 0.145 与 codex-rs 的 assess_patch_safety）：
//   --ask-for-approval on-request：「由模型决定何时询问」——普通 shell 命令在沙箱内直接跑，
//     不满足「跑命令仍会询问」，属于静默放宽用户选定的中间档；
//   --ask-for-approval untrusted：连 apply_patch 也一律 AskUser，等于「每次询问」档，
//     给不出「改文件放行」。
// 于是 codex 只能落到「每次询问」——按只收紧不放宽的铁律保守降级，并由 UI 明示。

// 只能全放行的 agent：原生 Cline SDK 走进程内 requestToolApproval，Kanban 目前恒批准，
// 于是「每次询问」与「只放行编辑」两档对它都表达不出来。这必须在 UI 上明示——沉默地把
// 权限放大是安全事故。（后续项：把 Cline SDK 的 requestToolApproval 接到与 ACP 同一条
// 决策通道上，届时从这个集合里移除即可。）
const AGENT_IDS_THAT_CAN_ONLY_BYPASS: ReadonlySet<RuntimeAgentId> = new Set<RuntimeAgentId>(["cline"]);

export function doesAgentNativelySupportTaskAgentPermissionMode(
	agentId: RuntimeAgentId,
	permissionMode: RuntimeTaskAgentPermissionMode,
): boolean {
	if (AGENT_IDS_THAT_CAN_ONLY_BYPASS.has(agentId)) {
		return permissionMode === "bypass_all_permission_prompts";
	}
	if (permissionMode !== "auto_approve_file_edits_only") {
		return true;
	}
	return AGENT_IDS_SUPPORTING_AUTO_APPROVE_FILE_EDITS_ONLY.has(agentId);
}

export interface ResolvedTaskAgentPermissionMode {
	// 实际要施加到该 agent 上的档位。
	effectivePermissionMode: RuntimeTaskAgentPermissionMode;
	// 用户选的原始档位。与 effective 不同即表示发生了降级。
	requestedPermissionMode: RuntimeTaskAgentPermissionMode;
	degradedBecauseAgentCannotExpressRequestedMode: boolean;
}

// 降级方向刻意是「向更保守」而不是「向更放权」：不能表达「只放行编辑」的 agent 回落到
// 每次询问，绝不回落到全放行——静默地把权限放大是安全事故，缩小只是啰嗦。
export function resolveTaskAgentPermissionModeForAgent(
	agentId: RuntimeAgentId,
	requestedPermissionMode: RuntimeTaskAgentPermissionMode | null | undefined,
): ResolvedTaskAgentPermissionMode {
	const requested = requestedPermissionMode ?? DEFAULT_TASK_AGENT_PERMISSION_MODE;
	// 只能全放行的 agent 无从收紧：如实报告「发生了降级」，由 UI 明示，绝不假装生效。
	if (AGENT_IDS_THAT_CAN_ONLY_BYPASS.has(agentId)) {
		return {
			effectivePermissionMode: "bypass_all_permission_prompts",
			requestedPermissionMode: requested,
			degradedBecauseAgentCannotExpressRequestedMode: requested !== "bypass_all_permission_prompts",
		};
	}
	if (doesAgentNativelySupportTaskAgentPermissionMode(agentId, requested)) {
		return {
			effectivePermissionMode: requested,
			requestedPermissionMode: requested,
			degradedBecauseAgentCannotExpressRequestedMode: false,
		};
	}
	return {
		effectivePermissionMode: "ask_for_every_tool_use",
		requestedPermissionMode: requested,
		degradedBecauseAgentCannotExpressRequestedMode: true,
	};
}

// 三档的严格程度序（数值越大越严）。UI 必须能区分「降级是收紧还是放宽」：收紧只需说明，
// 放宽（目前仅 Cline SDK 恒批准这一条）是安全语义上的放大，必须更醒目地警示。
const TASK_AGENT_PERMISSION_MODE_STRICTNESS_RANK: Record<RuntimeTaskAgentPermissionMode, number> = {
	bypass_all_permission_prompts: 0,
	auto_approve_file_edits_only: 1,
	ask_for_every_tool_use: 2,
};

export function doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest(
	resolved: ResolvedTaskAgentPermissionMode,
): boolean {
	return (
		TASK_AGENT_PERMISSION_MODE_STRICTNESS_RANK[resolved.effectivePermissionMode] <
		TASK_AGENT_PERMISSION_MODE_STRICTNESS_RANK[resolved.requestedPermissionMode]
	);
}

// 老看板卡片没有这个字段。读盘时按「当时的全局 agentAutonomousModeEnabled」推出等价档位，
// 使升级前后行为不变；仓库无 migration 框架，一律读时容错。
export function resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(
	agentAutonomousModeEnabled: boolean,
): RuntimeTaskAgentPermissionMode {
	return agentAutonomousModeEnabled ? "bypass_all_permission_prompts" : "ask_for_every_tool_use";
}

// 有些 harness 的「plan 起步」与「权限档」共用同一个单轴设置，无法同时表达。这类 agent 上
// 勾了 plan 起步就必然牺牲权限档，UI 必须明示而不能装作两者都生效。
const AGENT_IDS_WHERE_PLAN_START_OVERRIDES_PERMISSION_MODE: ReadonlySet<RuntimeAgentId> = new Set<RuntimeAgentId>([
	// droid 的 autonomyMode 是单轴：spec(plan) / normal / auto-high 三选一。
	"droid",
]);

export function doesPlanModeStartOverridePermissionModeForAgent(agentId: RuntimeAgentId): boolean {
	return AGENT_IDS_WHERE_PLAN_START_OVERRIDES_PERMISSION_MODE.has(agentId);
}
