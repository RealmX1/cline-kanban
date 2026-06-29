/**
 * 隔离探针：last agent response 在 terminal refresh 后误推进问题的修复原型。
 * 仅用于 test/runtime/terminal/last-agent-response-refresh-fix-probes.test.ts 对比 trade-off；
 * 未接入生产路径。
 */

import type { RuntimeTaskSessionReviewReason, RuntimeTaskSessionSummary } from "../../../src/core/api-contract.js";
import {
	isAwaitingUserReviewTurn,
	resolveSessionFacets,
	type SessionFacets,
} from "../../../src/core/session-activity.js";
import {
	type AgentOutputSubstanceMemory,
	createAgentOutputSubstanceMemory,
	detectFreshSubstantiveAgentOutput,
	extractAgentOutputContentSignatures,
} from "../../../src/terminal/agent-output-substance.js";
import { hasClaudeInteractivePrompt, hasClaudeStartupUiRendered } from "../../../src/terminal/claude-readiness.js";

// ── 场景夹具 ────────────────────────────────────────────────────────────────

/** refresh 前 agent 已产出过实质正文的时刻（两小时前）。 */
export const PRE_REFRESH_SUBSTANTIVE_AT = 1_700_000_000_000;

/** refresh 发生时刻。 */
export const REFRESH_AT = PRE_REFRESH_SUBSTANTIVE_AT + 2 * 60 * 60 * 1000;

/** Claude Code cache hit past due 三选一（代表性 TUI 帧）。 */
export const CLAUDE_CACHE_PAST_DUE_MENU_CHUNK = [
	"╭────────────────────────────────────────────────╮",
	"│ Cache hit is past due                          │",
	"│                                                │",
	"│  1. Continue from summary                      │",
	"│  2. Continue as is (full session context)      │",
	"│  3. Start a new session                        │",
	"╰────────────────────────────────────────────────╯",
].join("\r\n");

/** 用户选完选项后 agent 真正开始工作的产出。 */
export const CLAUDE_REAL_AGENT_RESPONSE_CHUNK = "⏺ I'll continue from the summary and resume the task.";

/** refresh 后、菜单出现前的纯启动横幅（也会触发 prompt-ready）。 */
export const CLAUDE_STARTUP_BANNER_CHUNK = "Claude Code v1.2.3\nHow can I help you today?";

// ── 当前生产路径的简化仿真 ──────────────────────────────────────────────────

export interface TimestampProbeSummary {
	lastSubstantiveOutputAt: number | null;
	lastOutputAt: number | null;
	reviewReason: RuntimeTaskSessionReviewReason;
	turnOwner: SessionFacets["turnOwner"];
	liveness: SessionFacets["liveness"];
	userTurnKind: SessionFacets["userTurnKind"];
	agentId: "claude" | null;
}

export function makePreRefreshSummary(): TimestampProbeSummary {
	return {
		lastSubstantiveOutputAt: PRE_REFRESH_SUBSTANTIVE_AT,
		lastOutputAt: PRE_REFRESH_SUBSTANTIVE_AT + 500,
		reviewReason: "hook",
		turnOwner: "user",
		liveness: "exited",
		userTurnKind: "review",
		agentId: "claude",
	};
}

export function makePostRefreshStartSummary(_nowMs: number): TimestampProbeSummary {
	return {
		lastSubstantiveOutputAt: PRE_REFRESH_SUBSTANTIVE_AT,
		lastOutputAt: null,
		reviewReason: "attention",
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "needs_input",
		agentId: "claude",
	};
}

function toRuntimeSummary(probe: TimestampProbeSummary): RuntimeTaskSessionSummary {
	return {
		taskId: "probe-task",
		state: probe.turnOwner === "agent" ? "running" : "awaiting_review",
		agentId: probe.agentId,
		workspacePath: "/tmp",
		pid: 12345,
		startedAt: REFRESH_AT,
		updatedAt: REFRESH_AT,
		lastOutputAt: probe.lastOutputAt,
		lastSubstantiveOutputAt: probe.lastSubstantiveOutputAt,
		reviewReason: probe.reviewReason,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		turnOwner: probe.turnOwner,
		liveness: probe.liveness,
		userTurnKind: probe.userTurnKind,
	};
}

/** 生产 claudePromptDetector 的等价逻辑（从 agent-session-adapters 抽出）。 */
export function productionClaudePromptDetector(
	data: string,
	summary: TimestampProbeSummary,
): "agent.prompt-ready" | null {
	const runtime = toRuntimeSummary(summary);
	if (!isAwaitingUserReviewTurn(resolveSessionFacets(runtime))) {
		return null;
	}
	if (summary.reviewReason !== "attention") {
		return null;
	}
	if (hasClaudeInteractivePrompt(data) || hasClaudeStartupUiRendered(data)) {
		return "agent.prompt-ready";
	}
	return null;
}

function applyPromptReady(summary: TimestampProbeSummary): TimestampProbeSummary {
	return {
		...summary,
		reviewReason: null,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
	};
}

function _productionProcessChunk(
	summary: TimestampProbeSummary,
	memory: AgentOutputSubstanceMemory,
	chunk: string,
	nowMs: number,
): { summary: TimestampProbeSummary; memory: AgentOutputSubstanceMemory } {
	let next = { ...summary };
	const inAgentTurn = next.agentId !== null && next.turnOwner === "agent";
	const hasFreshSubstantive = inAgentTurn && detectFreshSubstantiveAgentOutput(memory, chunk);
	next = {
		...next,
		lastOutputAt: nowMs,
		lastSubstantiveOutputAt: hasFreshSubstantive ? nowMs : next.lastSubstantiveOutputAt,
	};
	const promptEvent = productionClaudePromptDetector(chunk, next);
	if (promptEvent) {
		next = applyPromptReady(next);
	}
	return { summary: next, memory };
}

/** 卡片展示层：lastSubstantiveOutputAt ?? lastOutputAt */
export function resolveCardLastAgentResponseAt(summary: TimestampProbeSummary): number | null {
	return summary.lastSubstantiveOutputAt ?? summary.lastOutputAt ?? null;
}

// ── 修复原型 ────────────────────────────────────────────────────────────────

export type RefreshFixId =
	| "baseline"
	| "preserve-substance-memory"
	| "resume-ui-chrome-mask"
	| "defer-prompt-ready-on-resume"
	| "display-substantive-only"
	| "freeze-until-user-continues"
	| "combo-chrome-and-defer-prompt"
	| "suppress-substantive-while-attention";

const RESUME_MENU_LINE_REGEX = /\b(continue from summary|continue as is|start a new|cache hit is past due|past due)\b/u;

function isClaudeResumeMenuLine(trimmedLine: string): boolean {
	const lower = trimmedLine.toLowerCase();
	return RESUME_MENU_LINE_REGEX.test(lower);
}

function isResumeUiChromeLine(trimmedLine: string): boolean {
	return isClaudeResumeMenuLine(trimmedLine) || isClaudeStartupBannerLine(trimmedLine);
}

const STARTUP_BANNER_LINE_REGEX = /\b(claude code|how can i help|tips for getting started|welcome to claude)\b/u;

function isClaudeStartupBannerLine(trimmedLine: string): boolean {
	return STARTUP_BANNER_LINE_REGEX.test(trimmedLine.toLowerCase());
}

/** Fix B：把 Claude resume / cache-past-due 菜单行当 chrome，不推进实质戳。 */
export function detectFreshSubstantiveWithResumeChromeMask(
	memory: AgentOutputSubstanceMemory,
	decodedChunk: string,
): boolean {
	const signatures = extractAgentOutputContentSignatures(decodedChunk).filter((signature) => {
		return !isResumeUiChromeLine(signature);
	});
	if (signatures.length === 0) {
		return false;
	}
	const rebuilt = signatures.join("\n");
	if (rebuilt.length === 0) {
		return false;
	}
	return detectFreshSubstantiveAgentOutput(memory, rebuilt);
}

/** Fix C：resume 菜单帧不触发 prompt-ready（仍允许纯启动横幅触发，模拟「更窄」门控）。 */
export function deferPromptReadyClaudePromptDetector(
	data: string,
	summary: TimestampProbeSummary,
): "agent.prompt-ready" | null {
	if (isClaudeResumeMenuChunk(data)) {
		return null;
	}
	return productionClaudePromptDetector(data, summary);
}

export function isClaudeResumeMenuChunk(data: string): boolean {
	const lower = data.toLowerCase();
	return (
		lower.includes("cache hit is past due") ||
		lower.includes("continue from summary") ||
		(lower.includes("continue as is") && lower.includes("context"))
	);
}

interface ProbeRunOptions {
	fix: RefreshFixId;
	/** refresh 前已积累的 substance memory（Fix A 会带入 refresh 后）。 */
	preRefreshMemory?: AgentOutputSubstanceMemory;
	chunks: Array<{ chunk: string; atMs: number }>;
}

export interface ProbeRunResult {
	fix: RefreshFixId;
	finalSummary: TimestampProbeSummary;
	cardDisplayAt: number | null;
	substantiveAdvanced: boolean;
	turnOwnerAfterMenu: SessionFacets["turnOwner"];
	substantiveAfterRealResponse: boolean;
}

function processChunkWithFix(
	summary: TimestampProbeSummary,
	memory: AgentOutputSubstanceMemory,
	chunk: string,
	nowMs: number,
	fix: RefreshFixId,
	frozenSubstantiveAt: number | null,
	substantiveGuardActive: boolean,
): {
	summary: TimestampProbeSummary;
	memory: AgentOutputSubstanceMemory;
	frozenSubstantiveAt: number | null;
	substantiveGuardActive: boolean;
} {
	let next = { ...summary };
	const nextMemory = memory;
	let nextFrozen = frozenSubstantiveAt;
	let nextGuard = substantiveGuardActive;

	if (fix === "freeze-until-user-continues" && chunk.includes("⏺")) {
		nextFrozen = null;
	}
	if (fix === "suppress-substantive-while-attention" && chunk.includes("⏺")) {
		nextGuard = false;
	}

	const promptDetector =
		fix === "defer-prompt-ready-on-resume" || fix === "combo-chrome-and-defer-prompt"
			? deferPromptReadyClaudePromptDetector
			: productionClaudePromptDetector;

	const inAgentTurn = next.agentId !== null && next.turnOwner === "agent";
	let hasFreshSubstantive = false;
	if (inAgentTurn) {
		if (fix === "resume-ui-chrome-mask" || fix === "combo-chrome-and-defer-prompt") {
			hasFreshSubstantive = detectFreshSubstantiveWithResumeChromeMask(nextMemory, chunk);
		} else {
			hasFreshSubstantive = detectFreshSubstantiveAgentOutput(nextMemory, chunk);
		}
	}

	if (fix === "freeze-until-user-continues" && nextFrozen !== null) {
		hasFreshSubstantive = false;
	}

	if (fix === "suppress-substantive-while-attention" && nextGuard) {
		hasFreshSubstantive = false;
	}

	next = {
		...next,
		lastOutputAt: nowMs,
		lastSubstantiveOutputAt: hasFreshSubstantive ? nowMs : next.lastSubstantiveOutputAt,
	};

	const promptEvent = promptDetector(chunk, next);
	if (promptEvent) {
		next = applyPromptReady(next);
	}

	return { summary: next, memory: nextMemory, frozenSubstantiveAt: nextFrozen, substantiveGuardActive: nextGuard };
}

export function runRefreshTimestampProbe(options: ProbeRunOptions): ProbeRunResult {
	const { fix, chunks } = options;
	let summary = makePostRefreshStartSummary(REFRESH_AT);
	let memory =
		fix === "preserve-substance-memory" && options.preRefreshMemory
			? options.preRefreshMemory
			: createAgentOutputSubstanceMemory();
	let frozenSubstantiveAt: number | null =
		fix === "freeze-until-user-continues" ? summary.lastSubstantiveOutputAt : null;
	let substantiveGuardActive = fix === "suppress-substantive-while-attention";

	let turnOwnerAfterMenu: SessionFacets["turnOwner"] = summary.turnOwner;

	for (const { chunk, atMs } of chunks) {
		const result = processChunkWithFix(
			summary,
			memory,
			chunk,
			atMs,
			fix,
			frozenSubstantiveAt,
			substantiveGuardActive,
		);
		summary = result.summary;
		memory = result.memory;
		frozenSubstantiveAt = result.frozenSubstantiveAt;
		substantiveGuardActive = result.substantiveGuardActive;
		if (chunk === CLAUDE_CACHE_PAST_DUE_MENU_CHUNK) {
			turnOwnerAfterMenu = summary.turnOwner;
		}
	}

	const substantiveAdvanced = summary.lastSubstantiveOutputAt !== PRE_REFRESH_SUBSTANTIVE_AT;

	const realResponseResult = processChunkWithFix(
		{ ...summary, reviewReason: null, turnOwner: "agent", userTurnKind: null },
		memory,
		CLAUDE_REAL_AGENT_RESPONSE_CHUNK,
		REFRESH_AT + 60_000,
		fix,
		frozenSubstantiveAt,
		substantiveGuardActive,
	);
	const substantiveAfterRealResponse =
		realResponseResult.summary.lastSubstantiveOutputAt !== PRE_REFRESH_SUBSTANTIVE_AT;

	const displaySummary = fix === "display-substantive-only" ? summary : summary;
	const cardDisplayAt =
		fix === "display-substantive-only"
			? (summary.lastSubstantiveOutputAt ?? null)
			: resolveCardLastAgentResponseAt(displaySummary);

	return {
		fix,
		finalSummary: summary,
		cardDisplayAt,
		substantiveAdvanced,
		turnOwnerAfterMenu,
		substantiveAfterRealResponse,
	};
}

/** 典型 refresh 序列：启动横幅 → cache past due 菜单。 */
export function defaultRefreshChunkSequence(): Array<{ chunk: string; atMs: number }> {
	return [
		{ chunk: CLAUDE_STARTUP_BANNER_CHUNK, atMs: REFRESH_AT + 1_000 },
		{ chunk: CLAUDE_CACHE_PAST_DUE_MENU_CHUNK, atMs: REFRESH_AT + 2_000 },
	];
}

/** refresh 前 agent 已说过的话（用于 Fix A memory 预填）。 */
export function seedPreRefreshMemory(): AgentOutputSubstanceMemory {
	const memory = createAgentOutputSubstanceMemory();
	detectFreshSubstantiveAgentOutput(memory, "⏺ Earlier real agent response before refresh.");
	return memory;
}
