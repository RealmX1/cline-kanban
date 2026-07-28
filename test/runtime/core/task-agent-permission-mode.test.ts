// 跨 harness 权限档位的能力矩阵与降级方向。
// 最要紧的一条不变量：降级只能**收紧**，绝不能悄悄放宽——静默地把权限放大是安全事故。
import { describe, expect, it } from "vitest";

import type { RuntimeAgentId, RuntimeTaskAgentPermissionMode } from "../../../src/core/api-contract";
import {
	DEFAULT_TASK_AGENT_PERMISSION_MODE,
	doesAgentNativelySupportTaskAgentPermissionMode,
	doesPlanModeStartOverridePermissionModeForAgent,
	doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest,
	resolveTaskAgentPermissionModeForAgent,
	resolveTaskAgentPermissionModeFromLegacyAutonomousFlag,
} from "../../../src/core/task-agent-permission-mode";

const LAUNCHABLE_AGENT_IDS: readonly RuntimeAgentId[] = [
	"claude",
	"codex",
	"cursor",
	"droid",
	"kiro",
	"kimi",
	"omp",
	"cline",
];

const PERMISSION_MODE_STRICTNESS: Record<RuntimeTaskAgentPermissionMode, number> = {
	ask_for_every_tool_use: 2,
	auto_approve_file_edits_only: 1,
	bypass_all_permission_prompts: 0,
};

describe("task agent permission mode", () => {
	it("defaults to bypass", () => {
		expect(DEFAULT_TASK_AGENT_PERMISSION_MODE).toBe("bypass_all_permission_prompts");
	});

	it("maps the legacy global autonomous flag onto the two extreme tiers", () => {
		expect(resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(true)).toBe("bypass_all_permission_prompts");
		expect(resolveTaskAgentPermissionModeFromLegacyAutonomousFlag(false)).toBe("ask_for_every_tool_use");
	});

	it("lets every launchable agent express the bypass tier", () => {
		for (const agentId of LAUNCHABLE_AGENT_IDS) {
			expect(
				doesAgentNativelySupportTaskAgentPermissionMode(agentId, "bypass_all_permission_prompts"),
				`${agentId} should express bypass natively`,
			).toBe(true);
		}
	});

	// codex 刻意不算「原生支持」：workspace-write + on-request 会让普通 shell 命令不经询问就跑
	// （on-request 的语义是「由模型决定何时询问」），并不满足本档承诺的「跑命令仍会询问」；
	// 而 untrusted 连改文件也一律询问，给不出「改文件放行」。两头都表达不了，只能降级。
	it("only claims native middle-tier support for harnesses that really have it", () => {
		for (const agentId of ["claude", "omp"] as const) {
			expect(doesAgentNativelySupportTaskAgentPermissionMode(agentId, "auto_approve_file_edits_only")).toBe(true);
		}
		for (const agentId of ["codex", "cursor", "kimi", "kiro", "droid", "cline"] as const) {
			expect(doesAgentNativelySupportTaskAgentPermissionMode(agentId, "auto_approve_file_edits_only")).toBe(false);
		}
	});

	it("degrades the middle tier toward asking, never toward bypassing", () => {
		for (const agentId of ["codex", "cursor", "kimi", "kiro", "droid"] as const) {
			const resolved = resolveTaskAgentPermissionModeForAgent(agentId, "auto_approve_file_edits_only");
			expect(resolved.effectivePermissionMode).toBe("ask_for_every_tool_use");
			expect(resolved.degradedBecauseAgentCannotExpressRequestedMode).toBe(true);
		}
	});

	// 唯一允许「放宽」的方向：Cline SDK 的进程内审批目前恒批准，压根表达不出更严的档位。
	// 它必须如实报告 degraded，好让 UI 明示，而不是假装选中的严格档生效了。
	it("reports Cline SDK as degraded when a stricter tier is requested", () => {
		for (const requested of ["ask_for_every_tool_use", "auto_approve_file_edits_only"] as const) {
			const resolved = resolveTaskAgentPermissionModeForAgent("cline", requested);
			expect(resolved.effectivePermissionMode).toBe("bypass_all_permission_prompts");
			expect(resolved.degradedBecauseAgentCannotExpressRequestedMode).toBe(true);
		}
		expect(
			resolveTaskAgentPermissionModeForAgent("cline", "bypass_all_permission_prompts")
				.degradedBecauseAgentCannotExpressRequestedMode,
		).toBe(false);
	});

	// UI 靠这条谓词区分「降级方向是收紧还是放宽」：收紧只需说明，放宽必须更醒目地警示，
	// 且提示文案必须报出真实生效的那一档（Cline 的更严档位实际落在 Bypass，不是 Ask）。
	it("tells apart a tightening degradation from a widening one", () => {
		expect(
			doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest(
				resolveTaskAgentPermissionModeForAgent("cline", "ask_for_every_tool_use"),
			),
		).toBe(true);
		expect(
			doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest(
				resolveTaskAgentPermissionModeForAgent("cline", "auto_approve_file_edits_only"),
			),
		).toBe(true);
		expect(
			doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest(
				resolveTaskAgentPermissionModeForAgent("droid", "auto_approve_file_edits_only"),
			),
		).toBe(false);
		expect(
			doesResolvedTaskAgentPermissionModeWidenPermissionsBeyondRequest(
				resolveTaskAgentPermissionModeForAgent("claude", "ask_for_every_tool_use"),
			),
		).toBe(false);
	});

	it("never silently widens permissions for agents that can express stricter tiers", () => {
		for (const agentId of LAUNCHABLE_AGENT_IDS.filter((candidate) => candidate !== "cline")) {
			for (const requested of Object.keys(PERMISSION_MODE_STRICTNESS) as RuntimeTaskAgentPermissionMode[]) {
				const resolved = resolveTaskAgentPermissionModeForAgent(agentId, requested);
				expect(
					PERMISSION_MODE_STRICTNESS[resolved.effectivePermissionMode],
					`${agentId} must not loosen ${requested}`,
				).toBeGreaterThanOrEqual(PERMISSION_MODE_STRICTNESS[requested]);
			}
		}
	});

	it("falls back to the default tier when no mode was persisted on the task", () => {
		expect(resolveTaskAgentPermissionModeForAgent("claude", undefined).effectivePermissionMode).toBe(
			DEFAULT_TASK_AGENT_PERMISSION_MODE,
		);
		expect(resolveTaskAgentPermissionModeForAgent("claude", null).effectivePermissionMode).toBe(
			DEFAULT_TASK_AGENT_PERMISSION_MODE,
		);
	});

	// droid 的 autonomyMode 是单轴，plan 起步与权限档无法同时表达；这一点必须能被 UI 查询到。
	it("flags the harnesses where starting in plan mode overrides the permission tier", () => {
		expect(doesPlanModeStartOverridePermissionModeForAgent("droid")).toBe(true);
		for (const agentId of ["claude", "codex", "cursor", "kimi", "kiro", "omp", "cline"] as const) {
			expect(doesPlanModeStartOverridePermissionModeForAgent(agentId)).toBe(false);
		}
	});
});
