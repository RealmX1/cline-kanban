// exploration thread graph 维护作业的 hook 短路判定。
//
// 背景：独立包 agent-conversation-exploration-thread-graph 的 work-branch 作业用
// `claude -p --resume <主会话 id> --fork-session --settings <与主会话相同的 settings.json>` 起一个
// 分身来判定话题归属。分身与主会话共用同一份 hooks 配置（cache 命中的前提之一），于是它的每个
// hook 事件都会打到 `kanban hooks`。若照常摄入，分身事件会被当成主任务事件：Stop 抓 checkpoint、
// PostToolUse 翻 facet、activity 推「对话上次推进」——全是假信号。
//
// 契约（新仓库 handoff A.13-3）：作业进程 env 恒含 AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB=1，
// Claude Code 会把进程 env 原样传给 hook 命令。本模块据此：
//   - PreToolUse → 回 permissionDecision: deny（分身只应输出 JSON，任何工具调用都是越权）；
//   - 其余全部事件 → 静默短路，不摄入、不联系运行时。
// 判定放在读 stdin 之后、解析 KANBAN_HOOK_* env 之前：作业进程未必带任务身份 env，不能让
// parseHookRuntimeContextFromEnv 先抛。

export const AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV = "AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB";

export type ExplorationWorkBranchJobHookDisposition =
	| { kind: "ingest_normally" }
	| { kind: "short_circuit_silently" }
	| { kind: "short_circuit_with_pre_tool_use_deny"; stdoutJson: string };

export function isRunningInsideExplorationWorkBranchJob(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[AGENT_CONVERSATION_EXPLORATION_WORK_BRANCH_JOB_ENV];
	if (raw === undefined) {
		return false;
	}
	const normalized = raw.trim().toLowerCase();
	return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

// Claude Code PreToolUse hook 的结构化拒绝输出（退出码 0 + stdout JSON）。
export function renderExplorationWorkBranchJobPreToolUseDenyJson(): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason:
				"This is a Kanban exploration thread graph maintenance work branch: it must only emit the structured JSON verdict and never run tools.",
		},
	});
}

export function resolveExplorationWorkBranchJobHookDisposition(input: {
	env?: NodeJS.ProcessEnv;
	hookEventName: string | null;
}): ExplorationWorkBranchJobHookDisposition {
	if (!isRunningInsideExplorationWorkBranchJob(input.env ?? process.env)) {
		return { kind: "ingest_normally" };
	}
	if (input.hookEventName?.trim().toLowerCase() === "pretooluse") {
		return {
			kind: "short_circuit_with_pre_tool_use_deny",
			stdoutJson: renderExplorationWorkBranchJobPreToolUseDenyJson(),
		};
	}
	return { kind: "short_circuit_silently" };
}
