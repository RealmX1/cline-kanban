import { describe, expect, it } from "vitest";
import {
	AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV,
	isRunningInsideExplorationWorkBranchJob,
	resolveExplorationWorkBranchJobHookDisposition,
} from "../../../../src/commands/hook-events/exploration-work-branch-job-hook-short-circuit";

// exploration thread graph 维护作业分身与主会话共用 hooks 配置：分身的 hook 事件必须在
// `kanban hooks` 层整体短路（否则被当成主任务事件），PreToolUse 额外回 deny。

describe("isRunningInsideExplorationWorkBranchJob", () => {
	it("env 变量缺省 / 空白 / 0 / false → 不是作业进程", () => {
		expect(isRunningInsideExplorationWorkBranchJob({})).toBe(false);
		expect(
			isRunningInsideExplorationWorkBranchJob({ [AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV]: "" }),
		).toBe(false);
		expect(
			isRunningInsideExplorationWorkBranchJob({ [AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV]: "  " }),
		).toBe(false);
		expect(
			isRunningInsideExplorationWorkBranchJob({ [AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV]: "0" }),
		).toBe(false);
		expect(
			isRunningInsideExplorationWorkBranchJob({ [AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV]: "false" }),
		).toBe(false);
	});

	it("契约值 1（及任意非否定值）→ 是作业进程", () => {
		expect(
			isRunningInsideExplorationWorkBranchJob({ [AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV]: "1" }),
		).toBe(true);
		expect(
			isRunningInsideExplorationWorkBranchJob({ [AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV]: "true" }),
		).toBe(true);
	});

	it("env 变量名与新仓库契约（handoff A.13-3）字面一致", () => {
		expect(AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV).toBe("AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB");
	});
});

describe("resolveExplorationWorkBranchJobHookDisposition", () => {
	const jobEnv = { [AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV]: "1" };

	it("非作业进程 → 照常摄入（不看事件名）", () => {
		expect(resolveExplorationWorkBranchJobHookDisposition({ env: {}, hookEventName: "PreToolUse" })).toEqual({
			kind: "ingest_normally",
		});
		expect(resolveExplorationWorkBranchJobHookDisposition({ env: {}, hookEventName: null })).toEqual({
			kind: "ingest_normally",
		});
	});

	it("作业进程的 PreToolUse → 结构化 deny（退出码 0 + stdout JSON），大小写不敏感", () => {
		for (const hookEventName of ["PreToolUse", "pretooluse", " PRETOOLUSE "]) {
			const disposition = resolveExplorationWorkBranchJobHookDisposition({ env: jobEnv, hookEventName });
			expect(disposition.kind).toBe("short_circuit_with_pre_tool_use_deny");
			if (disposition.kind !== "short_circuit_with_pre_tool_use_deny") {
				throw new Error("unreachable");
			}
			expect(JSON.parse(disposition.stdoutJson)).toEqual({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: expect.stringContaining("maintenance work branch"),
				},
			});
		}
	});

	it("作业进程的其余事件（Stop / PostToolUse / UserPromptSubmit / 未知）→ 静默短路", () => {
		for (const hookEventName of ["Stop", "PostToolUse", "UserPromptSubmit", "Notification", null]) {
			expect(resolveExplorationWorkBranchJobHookDisposition({ env: jobEnv, hookEventName })).toEqual({
				kind: "short_circuit_silently",
			});
		}
	});
});
