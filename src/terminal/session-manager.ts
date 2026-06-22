// PTY-backed runtime for non-Cline task sessions and the workspace shell terminal.
// It owns process lifecycle, terminal protocol filtering, and summary updates
// for command-driven agents such as Claude Code, Codex, Gemini, and shell sessions.
import type {
	RuntimeAgentId,
	RuntimeTaskConnectionRetry,
	RuntimeTaskHookActivity,
	RuntimeTaskImage,
	RuntimeTaskSessionReviewReason,
	RuntimeTaskSessionState,
	RuntimeTaskSessionSummary,
	RuntimeTaskSessionUserTurnKind,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import {
	applySessionFacets,
	deriveSessionFacetsFromLegacyState,
	isAgentOutputQuiet as evaluateAgentOutputQuiet,
	isAwaitingUserReviewTurn,
	isSessionInActiveTurn,
	mergeSummaryWithFacets,
	resolveSessionFacets,
} from "../core/session-activity";
import { logTuiFreezeError, logTuiFreezeWarning } from "../diagnostics/tui-freeze-logger";
import {
	type AgentAdapterLaunchInput,
	type AgentOutputTransitionDetector,
	type AgentOutputTransitionInspectionPredicate,
	prepareAgentLaunch,
	toBracketedPasteSubmission,
} from "./agent-session-adapters";
import {
	CLAUDE_STARTUP_READINESS_TIMEOUT_MS,
	hasClaudeInteractivePrompt,
	hasClaudeStartupUiRendered,
} from "./claude-readiness";
import {
	hasClaudeWorkspaceTrustPrompt,
	shouldAutoConfirmClaudeWorkspaceTrust,
	stopWorkspaceTrustTimers,
	WORKSPACE_TRUST_CONFIRM_DELAY_MS,
} from "./claude-workspace-trust";
import { hasCodexInteractivePrompt, hasCodexStartupUiRendered } from "./codex-readiness";
import { hasCodexWorkspaceTrustPrompt, shouldAutoConfirmCodexWorkspaceTrust } from "./codex-workspace-trust";
import {
	getDefaultOutputReactionEngine,
	type OutputReactionActions,
	type OutputReactionContext,
	type OutputReactionEngine,
	type OutputReactionSessionState,
} from "./output-reactions";
import {
	buildNetworkInterruptionContinuationLine,
	ensureNetworkInterruptionResumeInstructionsFile,
	getNetworkInterruptionResumeInstructionsPath,
} from "./output-reactions/network-interruption-continuation-instructions";
import { PtySession } from "./pty-session";
import { reduceSessionTransition, type SessionTransitionEvent } from "./session-state-machine";
import { stripAnsiAndControl } from "./terminal-output-normalization";
import {
	createTerminalProtocolFilterState,
	disableOscColorQueryIntercept,
	filterTerminalProtocolOutput,
	type TerminalProtocolFilterState,
} from "./terminal-protocol-filter";
import type { TerminalSessionListener, TerminalSessionService } from "./terminal-session-service";
import { TerminalStateMirror } from "./terminal-state-mirror";

const MAX_WORKSPACE_TRUST_BUFFER_CHARS = 16_384;
// 输出反应（output-reactions）扫描缓冲上限：镜像 workspace-trust 缓冲，约 16KB。
const MAX_OUTPUT_REACTION_SCAN_BUFFER_CHARS = 16_384;
// 用户近期手动输入抑制窗口：这段时间内不自动注入续跑，避免打断正在打字的用户。
const OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS = 8_000;
const AUTO_RESTART_WINDOW_MS = 5_000;
const MAX_AUTO_RESTARTS_PER_WINDOW = 3;
const DEFAULT_STALL_THRESHOLD_MS = 45_000;
const STALL_SCAN_INTERVAL_MS = 15_000;

function readStallThresholdMs(): number {
	const raw = process.env.CLINE_TUI_STALL_MS;
	if (!raw) {
		return DEFAULT_STALL_THRESHOLD_MS;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_STALL_THRESHOLD_MS;
	}
	return Math.floor(parsed);
}
// TUI apps (Codex, OpenCode) can query OSC 10/11 before the browser terminal is attached
// and ready to answer. We intercept those startup probes during early PTY output, synthesize
// foreground/background color replies, then disable the filter once a live terminal listener
// has attached.
const OSC_FOREGROUND_QUERY_REPLY = "\u001b]10;rgb:e6e6/eded/f3f3\u001b\\";
const OSC_BACKGROUND_QUERY_REPLY = "\u001b]11;rgb:1717/1717/2121\u001b\\";

type RestartableSessionRequest =
	| { kind: "task"; request: StartTaskSessionRequest }
	| { kind: "shell"; request: StartShellSessionRequest };

interface ActiveProcessState {
	session: PtySession;
	workspaceTrustBuffer: string | null;
	cols: number;
	rows: number;
	terminalProtocolFilter: TerminalProtocolFilterState;
	onSessionCleanup: (() => Promise<void>) | null;
	deferredStartupInput: string | null;
	detectOutputTransition: AgentOutputTransitionDetector | null;
	shouldInspectOutputForTransition: AgentOutputTransitionInspectionPredicate | null;
	awaitingCodexPromptAfterEnter: boolean;
	autoConfirmedWorkspaceTrust: boolean;
	workspaceTrustConfirmTimer: NodeJS.Timeout | null;
	// Claude Code TUI 启动 readiness 兜底时刻：在该时间点之前，session-manager
	// 仅在 readiness predicate（输入框 / 启动横幅）命中时才注入 prompt；
	// 之后回退到"任意 output 即触发"，保留旧行为防止 readiness predicate 漏识别
	// 导致 prompt 永远注不进去。null 表示当前会话不需要 gate（非 Claude 或没有
	// deferred prompt）。
	claudeStartupReadinessDeadlineAt: number | null;
	// 独立的 wall-clock 兜底 timer：当 Claude TUI 在一个 chunk 里渲染完整启动 UI、
	// 而 readiness predicate 漏识别时，后续不会再有新 chunk 触发 deadline 检查，
	// 导致 deferred prompt 永远注不进去。这个一次性 setTimeout 在到点后强制调用
	// trySendDeferredStartupInput；命中 predicate 或 session 退出时由调用方清掉。
	claudeStartupReadinessTimer: NodeJS.Timeout | null;
	// 输出反应框架（连接中断自动续跑等）。仅在开关开启且 agent 适用时非 null。
	outputReactionEngine: OutputReactionEngine | null;
	outputReactionSession: OutputReactionSessionState | null;
	// 滚动的 stripAnsiAndControl 扫描缓冲（保留换行；用于错误检测与提示符就绪判断）。
	outputReactionScanBuffer: string | null;
	// 输出反应的兜底 / 退避 attempt 定时器（同一时刻至多一个待触发）。
	outputReactionAttemptTimer: NodeJS.Timeout | null;
	// 最近一次用户手动输入时刻，用于抑制自动注入打断用户。
	lastUserInputAt: number | null;
}

interface SessionEntry {
	summary: RuntimeTaskSessionSummary;
	active: ActiveProcessState | null;
	terminalStateMirror: TerminalStateMirror | null;
	listenerIdCounter: number;
	listeners: Map<number, TerminalSessionListener>;
	restartRequest: RestartableSessionRequest | null;
	suppressAutoRestartOnExit: boolean;
	autoRestartTimestamps: number[];
	pendingAutoRestart: Promise<void> | null;
	// Reference timestamp for the most recent stall window we have already logged.
	// Reset to null when output advances, so each new silent window gets exactly one log line.
	lastStallLoggedAt: number | null;
}

export interface StartTaskSessionRequest {
	taskId: string;
	agentId: AgentAdapterLaunchInput["agentId"];
	binary: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	autoContinueOnConnectionDropEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	cols?: number;
	rows?: number;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	projectPath?: string;
	parentSessionId?: string;
}

export interface StartShellSessionRequest {
	taskId: string;
	cwd: string;
	cols?: number;
	rows?: number;
	binary: string;
	args?: string[];
	env?: Record<string, string | undefined>;
}

function now(): number {
	return Date.now();
}

function createDefaultSummary(taskId: string): RuntimeTaskSessionSummary {
	// 初始 idle summary 即带上 idle facet，使「直接发出未经 updateSummary 的默认 summary」也自洽。
	return applySessionFacets({
		taskId,
		state: "idle",
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: null,
		updatedAt: now(),
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		connectionRetry: null,
	});
}

function cloneSummary(summary: RuntimeTaskSessionSummary): RuntimeTaskSessionSummary {
	return {
		...summary,
	};
}

function updateSummary(entry: SessionEntry, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	// 单一写侧漏斗：经 mergeSummaryWithFacets 派发（facet 写时主真相源，详见该函数）。
	entry.summary = mergeSummaryWithFacets(entry.summary, { ...patch, updatedAt: now() });
	return entry.summary;
}

// Stage 4 全写侧反转：终端/PTY agent 写点经此从「目标 legacy state + 当刻覆写上下文」产出完整三 facet
// 写侧补丁（facet 写时主真相源；state 由 mergeSummaryWithFacets 投影回填）。connectionRetryActive 取自
// prev（写点不改 connectionRetry，故与 mergeSummaryWithFacets 合并后取值一致），agentId/pid 取本次覆写值
// （launch 设新 pid/agentId、exit/fail 设 pid:null）——使终端 agent awaiting 的 live↔exited 区分正确。
function buildTerminalFacetPatch(
	prev: RuntimeTaskSessionSummary,
	state: RuntimeTaskSessionState,
	overrides: { reviewReason: RuntimeTaskSessionReviewReason; pid: number | null; agentId: RuntimeAgentId | null },
): Partial<RuntimeTaskSessionSummary> {
	const facets = deriveSessionFacetsFromLegacyState(state, {
		reviewReason: overrides.reviewReason,
		pid: overrides.pid,
		connectionRetryActive: prev.connectionRetry != null,
		agentId: overrides.agentId,
	});
	return { turnOwner: facets.turnOwner, liveness: facets.liveness, userTurnKind: facets.userTurnKind };
}

// 「会话处于活跃回合」判据（Stage 3 余区：legacy `state` 读 → 双轴 facet 真相源）。
// 经 resolveSessionFacets 读 facet、复用共享 isSessionInActiveTurn，严格等价旧
// `state ∈ {running, awaiting_review}`（全表等价见 session-facets.test.ts），且对 live↔exited
// 折叠不敏感（exited 仍判活跃）——故迁移为纯重构、零行为漂移，不偷渡 distinction ②。
function isSummaryInActiveTurn(summary: RuntimeTaskSessionSummary): boolean {
	return isSessionInActiveTurn(resolveSessionFacets(summary));
}

function cloneStartTaskSessionRequest(request: StartTaskSessionRequest): StartTaskSessionRequest {
	return {
		...request,
		args: [...request.args],
		images: request.images ? request.images.map((image) => ({ ...image })) : undefined,
		env: request.env ? { ...request.env } : undefined,
		projectPath: request.projectPath,
	};
}

function cloneStartShellSessionRequest(request: StartShellSessionRequest): StartShellSessionRequest {
	return {
		...request,
		args: request.args ? [...request.args] : undefined,
		env: request.env ? { ...request.env } : undefined,
	};
}

function formatSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found. Install a supported agent CLI and select it in Settings.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

function formatShellSpawnFailure(binary: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("posix_spawnp failed") || normalized.includes("enoent")) {
		return `Failed to launch "${binary}". Command not found on this system.`;
	}
	return `Failed to launch "${binary}": ${message}`;
}

interface TerminalEnvironmentOptions {
	forceColor: boolean;
}

export function buildTerminalEnvironment(
	options: TerminalEnvironmentOptions,
	...sources: Array<Record<string, string | undefined> | undefined>
): Record<string, string | undefined> {
	const env = {
		...process.env,
		...Object.assign({}, ...sources),
		COLORTERM: "truecolor",
		TERM: "xterm-256color",
		TERM_PROGRAM: "kanban",
	};
	if (options.forceColor) {
		env.CLICOLOR = "1";
		env.CLICOLOR_FORCE = "1";
		env.FORCE_COLOR = "3";
		delete env.NO_COLOR;
		delete env.NODE_DISABLE_COLORS;
	}
	return env;
}

function clearClaudeStartupReadinessTimer(state: { claudeStartupReadinessTimer: NodeJS.Timeout | null }): void {
	if (state.claudeStartupReadinessTimer) {
		clearTimeout(state.claudeStartupReadinessTimer);
		state.claudeStartupReadinessTimer = null;
	}
}

function clearOutputReactionTimer(state: { outputReactionAttemptTimer: NodeJS.Timeout | null }): void {
	if (state.outputReactionAttemptTimer) {
		clearTimeout(state.outputReactionAttemptTimer);
		state.outputReactionAttemptTimer = null;
	}
}

export class TerminalSessionManager implements TerminalSessionService {
	private readonly entries = new Map<string, SessionEntry>();
	private readonly summaryListeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	private readonly stallThresholdMs = readStallThresholdMs();
	private stallScanInterval: NodeJS.Timeout | null = null;

	private trySendDeferredStartupInput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return false;
		}
		if (active.deferredStartupInput === null) {
			return false;
		}
		const trustPromptVisible =
			active.workspaceTrustBuffer !== null &&
			((entry.summary.agentId === "codex" && hasCodexWorkspaceTrustPrompt(active.workspaceTrustBuffer)) ||
				(entry.summary.agentId === "claude" && hasClaudeWorkspaceTrustPrompt(active.workspaceTrustBuffer)));
		if (trustPromptVisible) {
			return false;
		}
		const deferredInput = active.deferredStartupInput;
		active.deferredStartupInput = null;
		// Deferred input 已经注入，wall-clock 兜底 timer 不再需要，立即清除以避免
		// 在已经 idle 的 session 上空跑回调。
		clearClaudeStartupReadinessTimer(active);
		active.session.write(deferredInput);
		logTuiFreezeWarning(
			`[tui-freeze] startup-prompt-flushed taskId=${taskId} agentId=${entry.summary.agentId} chars=${deferredInput.length}`,
		);
		return true;
	}

	// 是否为该任务挂载输出反应引擎：开关开启（默认开）且有 reaction 适用于该 agent。
	private resolveOutputReactionEngine(request: StartTaskSessionRequest): OutputReactionEngine | null {
		if (request.autoContinueOnConnectionDropEnabled === false) {
			return null;
		}
		const engine = getDefaultOutputReactionEngine();
		return engine.isActiveFor(request.agentId) ? engine : null;
	}

	private buildOutputReactionContext(entry: SessionEntry, chunkText: string): OutputReactionContext | null {
		const active = entry.active;
		if (!active) {
			return null;
		}
		const agentId = entry.summary.agentId;
		if (agentId === null) {
			return null;
		}
		return {
			agentId,
			now: now(),
			chunkText,
			scanText: active.outputReactionScanBuffer ?? "",
		};
	}

	// 每个新 chunk：维护滚动扫描缓冲（stripAnsiAndControl，保留换行），并驱动引擎。
	private processOutputReactionChunk(taskId: string, entry: SessionEntry, decodedChunk: string): void {
		const active = entry.active;
		if (!active || active.outputReactionEngine === null || active.outputReactionSession === null) {
			return;
		}
		const chunkText = stripAnsiAndControl(decodedChunk);
		const previousBuffer = active.outputReactionScanBuffer ?? "";
		let nextBuffer = previousBuffer + chunkText;
		if (nextBuffer.length > MAX_OUTPUT_REACTION_SCAN_BUFFER_CHARS) {
			nextBuffer = nextBuffer.slice(-MAX_OUTPUT_REACTION_SCAN_BUFFER_CHARS);
		}
		active.outputReactionScanBuffer = nextBuffer;

		const ctx = this.buildOutputReactionContext(entry, chunkText);
		if (ctx === null) {
			return;
		}
		active.outputReactionEngine.onOutput(ctx, active.outputReactionSession, this.buildOutputReactionActions(taskId));
	}

	// 退避 / 兜底定时器触发：让引擎尝试注入续跑（或判定已恢复）。
	private runOutputReactionAttempt(taskId: string): void {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active || active.outputReactionEngine === null || active.outputReactionSession === null) {
			return;
		}
		active.outputReactionAttemptTimer = null;
		const ctx = this.buildOutputReactionContext(entry, "");
		if (ctx === null) {
			return;
		}
		active.outputReactionEngine.onAttempt(ctx, active.outputReactionSession, this.buildOutputReactionActions(taskId));
	}

	// 判断当前输出是否停在可注入的交互提示符（按 agent 选预测函数）。
	private isAtInteractivePromptForReaction(entry: SessionEntry): boolean {
		const active = entry.active;
		if (!active || active.outputReactionScanBuffer === null) {
			return false;
		}
		const scan = active.outputReactionScanBuffer;
		if (entry.summary.agentId === "codex") {
			return hasCodexInteractivePrompt(scan);
		}
		if (entry.summary.agentId === "claude") {
			return hasClaudeInteractivePrompt(scan);
		}
		return false;
	}

	// 构造注入 / 调度 / 状态更新等副作用入口，交给 reaction 调用。
	private buildOutputReactionActions(taskId: string): OutputReactionActions {
		return {
			submitContinuationReference: () => {
				this.submitConnectionDropContinuation(taskId);
			},
			schedule: (delayMs: number) => {
				const active = this.entries.get(taskId)?.active;
				if (!active) {
					return;
				}
				clearOutputReactionTimer(active);
				const timer = setTimeout(
					() => {
						this.runOutputReactionAttempt(taskId);
					},
					Math.max(0, Math.floor(delayMs)),
				);
				timer.unref?.();
				active.outputReactionAttemptTimer = timer;
			},
			clearScheduledAttempts: () => {
				const active = this.entries.get(taskId)?.active;
				if (active) {
					clearOutputReactionTimer(active);
				}
			},
			setConnectionRetryState: (patch: RuntimeTaskConnectionRetry) => {
				this.applyConnectionRetryState(taskId, patch);
			},
			clearConnectionRetryState: () => {
				this.applyConnectionRetryState(taskId, null);
			},
			isAtInteractivePrompt: () => {
				const entry = this.entries.get(taskId);
				return entry ? this.isAtInteractivePromptForReaction(entry) : false;
			},
			canInjectNow: () => {
				const active = this.entries.get(taskId)?.active;
				if (!active) {
					return false;
				}
				if (active.deferredStartupInput !== null) {
					return false;
				}
				if (
					active.lastUserInputAt !== null &&
					now() - active.lastUserInputAt < OUTPUT_REACTION_USER_INPUT_SUPPRESS_MS
				) {
					return false;
				}
				return true;
			},
			isAgentOutputQuiet: () => {
				const entry = this.entries.get(taskId);
				// 静默判定（含「从未产出 → 视为静默」）统一走 src/core/session-activity.ts 的共享原语，
				// 默认阈值 AGENT_OUTPUT_QUIET_THRESHOLD_MS（2s）。
				return evaluateAgentOutputQuiet(entry?.summary.lastOutputAt ?? null, now());
			},
			log: (message: string) => {
				logTuiFreezeWarning(`${message} taskId=${taskId}`);
			},
		};
	}

	// 实际把续跑指令注入 PTY：bracketed paste 引用续跑指令文件；Codex 追加回车。
	private submitConnectionDropContinuation(taskId: string): void {
		const entry = this.entries.get(taskId);
		const active = entry?.active;
		if (!entry || !active) {
			return;
		}
		void ensureNetworkInterruptionResumeInstructionsFile().catch(() => {
			// 落盘失败不阻断注入：路径确定，文件稍后可补写。
		});
		const instructionsPath = getNetworkInterruptionResumeInstructionsPath();
		const line = buildNetworkInterruptionContinuationLine(instructionsPath);
		// toBracketedPasteSubmission 结尾已含单个 `\r`（回车），与 Codex deferred-startup
		// （/plan）路径一致；不再额外补写 `\r`，避免双回车 / 空提交。
		// 仍标记 awaitingCodexPromptAfterEnter：bracketed paste 末尾的 CR 已构成回车，
		// 与 writeInput「输入含 CR 即视为回车」的语义一致。
		active.session.write(toBracketedPasteSubmission(line));
		if (entry.summary.agentId === "codex") {
			active.awaitingCodexPromptAfterEnter = true;
		}
	}

	// 更新 summary.connectionRetry 并广播（驱动看板徽标 / 顶栏重试列表）。
	private applyConnectionRetryState(taskId: string, patch: RuntimeTaskConnectionRetry | null): void {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return;
		}
		const current = entry.summary.connectionRetry ?? null;
		if (current === null && patch === null) {
			return;
		}
		const summary = updateSummary(entry, { connectionRetry: patch });
		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
	}

	// 手动「立即续跑」：对指定任务（若仍在连接重试）强制注入一次续跑。
	// 返回实际触发的任务 id（命中且正在重试的）。
	continueConnectionRetrySessions(taskIds: readonly string[]): string[] {
		const triggered: string[] = [];
		for (const taskId of taskIds) {
			const entry = this.entries.get(taskId);
			const active = entry?.active;
			if (!entry || !active || active.outputReactionEngine === null || active.outputReactionSession === null) {
				continue;
			}
			if ((entry.summary.connectionRetry ?? null) === null) {
				continue;
			}
			const ctx = this.buildOutputReactionContext(entry, "");
			if (ctx === null) {
				continue;
			}
			active.outputReactionEngine.triggerContinueNow(
				ctx,
				active.outputReactionSession,
				this.buildOutputReactionActions(taskId),
			);
			triggered.push(taskId);
		}
		return triggered;
	}

	// 手动「移出列表 / 停止重试」：对指定任务（若仍在连接重试）结束 episode、清除重连状态。
	// 软移除——之后若再检测到新的瞬时连接错误，仍会重新进入一次新 episode。
	// 返回实际被移出的任务 id（命中且正在重试的）。
	dismissConnectionRetrySessions(taskIds: readonly string[]): string[] {
		const dismissed: string[] = [];
		for (const taskId of taskIds) {
			const entry = this.entries.get(taskId);
			const active = entry?.active;
			if (!entry || !active || active.outputReactionEngine === null || active.outputReactionSession === null) {
				continue;
			}
			if ((entry.summary.connectionRetry ?? null) === null) {
				continue;
			}
			const ctx = this.buildOutputReactionContext(entry, "");
			if (ctx === null) {
				continue;
			}
			active.outputReactionEngine.triggerDismiss(
				ctx,
				active.outputReactionSession,
				this.buildOutputReactionActions(taskId),
			);
			dismissed.push(taskId);
		}
		return dismissed;
	}

	// 当前正处于连接重试的任务 id 列表（summary.connectionRetry 非空）。
	listConnectionRetryTaskIds(): string[] {
		const ids: string[] = [];
		for (const [taskId, entry] of this.entries.entries()) {
			if ((entry.summary.connectionRetry ?? null) !== null) {
				ids.push(taskId);
			}
		}
		return ids;
	}

	private hasLiveOutputListener(entry: SessionEntry): boolean {
		for (const listener of entry.listeners.values()) {
			if (listener.onOutput) {
				return true;
			}
		}
		return false;
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		this.summaryListeners.add(listener);
		return () => {
			this.summaryListeners.delete(listener);
		};
	}

	hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
		for (const [taskId, summary] of Object.entries(record)) {
			this.entries.set(taskId, {
				summary: cloneSummary(summary),
				active: null,
				terminalStateMirror: null,
				listenerIdCounter: 1,
				listeners: new Map(),
				restartRequest: null,
				suppressAutoRestartOnExit: false,
				autoRestartTimestamps: [],
				pendingAutoRestart: null,
				lastStallLoggedAt: null,
			});
		}
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		return entry ? cloneSummary(entry.summary) : null;
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return Array.from(this.entries.values()).map((entry) => cloneSummary(entry.summary));
	}

	attach(taskId: string, listener: TerminalSessionListener): (() => void) | null {
		const entry = this.ensureEntry(taskId);

		listener.onState?.(cloneSummary(entry.summary));
		if (entry.active && listener.onOutput) {
			disableOscColorQueryIntercept(entry.active.terminalProtocolFilter);
		}

		const listenerId = entry.listenerIdCounter;
		entry.listenerIdCounter += 1;
		entry.listeners.set(listenerId, listener);

		return () => {
			entry.listeners.delete(listenerId);
		};
	}

	async getRestoreSnapshot(taskId: string) {
		const entry = this.entries.get(taskId);
		if (!entry?.terminalStateMirror) {
			return null;
		}
		return await entry.terminalStateMirror.getSnapshot();
	}

	async startTaskSession(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "task",
			request: cloneStartTaskSessionRequest(request),
		};
		if (entry.active && isSummaryInActiveTurn(entry.summary)) {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			clearClaudeStartupReadinessTimer(entry.active);
			clearOutputReactionTimer(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});

		const launch = await prepareAgentLaunch({
			taskId: request.taskId,
			agentId: request.agentId,
			binary: request.binary,
			args: request.args,
			autonomousModeEnabled: request.autonomousModeEnabled,
			cwd: request.cwd,
			prompt: request.prompt,
			images: request.images,
			startInPlanMode: request.startInPlanMode,
			resumeFromTrash: request.resumeFromTrash,
			env: request.env,
			workspaceId: request.workspaceId,
			parentSessionId: request.parentSessionId,
		});

		const taskContextEnv = {
			KANBAN_TASK_ID: request.taskId,
			KANBAN_ATTEMPT_ID: request.taskId,
			CLINE_KANBAN_TASK_ID: request.taskId,
			CLINE_KANBAN_ATTEMPT_ID: request.taskId,
			KANBAN_PROJECT_PATH: request.projectPath ?? request.cwd,
			CLINE_KANBAN_PROJECT_PATH: request.projectPath ?? request.cwd,
		};
		const env = buildTerminalEnvironment({ forceColor: true }, request.env, launch.env, taskContextEnv);

		// Adapters can wrap the configured agent binary when they need extra runtime wiring
		// (for example, Codex uses a wrapper script to watch session logs for hook transitions).
		const commandBinary = launch.binary ?? request.binary;
		const commandArgs = [...launch.args];
		const hasCodexLaunchSignature = [commandBinary, ...commandArgs].some((part) =>
			part.toLowerCase().includes("codex"),
		);
		const preActiveOutputChunks: Buffer[] = [];
		const handleTaskOutput = (chunk: Buffer): void => {
			if (!entry.active) {
				preActiveOutputChunks.push(chunk);
				return;
			}

			const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
				onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
				onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
			});
			if (filteredChunk.byteLength === 0) {
				return;
			}
			entry.terminalStateMirror?.applyOutput(filteredChunk);

			const needsDecodedOutput =
				entry.active.workspaceTrustBuffer !== null ||
				entry.active.deferredStartupInput !== null ||
				entry.active.outputReactionEngine !== null ||
				(entry.active.detectOutputTransition !== null &&
					(entry.active.shouldInspectOutputForTransition?.(entry.summary) ?? true));
			const data = needsDecodedOutput ? filteredChunk.toString("utf8") : "";

			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer += data;
				if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
					entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
						-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
					);
				}
				if (!entry.active.autoConfirmedWorkspaceTrust && entry.active.workspaceTrustConfirmTimer === null) {
					const hasClaudePrompt = hasClaudeWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
					const hasCodexPrompt = hasCodexWorkspaceTrustPrompt(entry.active.workspaceTrustBuffer);
					if (hasClaudePrompt || hasCodexPrompt) {
						entry.active.autoConfirmedWorkspaceTrust = true;
						const trustConfirmDelayMs = WORKSPACE_TRUST_CONFIRM_DELAY_MS;
						entry.active.workspaceTrustConfirmTimer = setTimeout(() => {
							const activeEntry = this.entries.get(request.taskId)?.active;
							if (!activeEntry || !activeEntry.autoConfirmedWorkspaceTrust) {
								return;
							}
							activeEntry.session.write("\r");
							// Trust text can remain in the rolling buffer after we auto-confirm.
							// Clear it so later startup/prompt checks do not match stale trust output.
							if (activeEntry.workspaceTrustBuffer !== null) {
								activeEntry.workspaceTrustBuffer = "";
							}
							activeEntry.workspaceTrustConfirmTimer = null;
						}, trustConfirmDelayMs);
					}
				}
			}
			updateSummary(entry, { lastOutputAt: now() });

			// Startup input is deferred until the TUI is alive so the task prompt creates a
			// persisted interactive session instead of a short-lived argv prompt run.
			//
			// Claude 路径在 readiness predicate 命中之前保持等待；超过
			// claudeStartupReadinessDeadlineAt 后回退到"任意 output 即触发"，
			// 兜底 predicate 漏识别的极端 TUI 渲染，避免回归到 prompt 永远注不进去。
			if (entry.active.deferredStartupInput !== null && data.length > 0) {
				const claudeBuffer = entry.active.workspaceTrustBuffer ?? "";
				const codexReady =
					entry.summary.agentId === "codex" &&
					(hasCodexInteractivePrompt(data) ||
						hasCodexStartupUiRendered(data) ||
						(entry.active.workspaceTrustBuffer !== null &&
							(hasCodexInteractivePrompt(entry.active.workspaceTrustBuffer) ||
								hasCodexStartupUiRendered(entry.active.workspaceTrustBuffer))));
				const claudeReadyBySignal =
					entry.summary.agentId === "claude" &&
					(hasClaudeInteractivePrompt(data) ||
						hasClaudeStartupUiRendered(data) ||
						hasClaudeInteractivePrompt(claudeBuffer) ||
						hasClaudeStartupUiRendered(claudeBuffer));
				const claudeReadyByDeadline =
					entry.summary.agentId === "claude" &&
					entry.active.claudeStartupReadinessDeadlineAt !== null &&
					now() >= entry.active.claudeStartupReadinessDeadlineAt;
				if (codexReady || claudeReadyBySignal || claudeReadyByDeadline) {
					this.trySendDeferredStartupInput(request.taskId);
				}
			}

			const adapterEvent = entry.active.detectOutputTransition?.(data, entry.summary) ?? null;
			if (adapterEvent) {
				const requiresEnterForCodex =
					adapterEvent.type === "agent.prompt-ready" &&
					entry.summary.agentId === "codex" &&
					!entry.active.awaitingCodexPromptAfterEnter;
				if (!requiresEnterForCodex) {
					const summary = this.applySessionEvent(entry, adapterEvent);
					if (adapterEvent.type === "agent.prompt-ready" && entry.summary.agentId === "codex") {
						entry.active.awaitingCodexPromptAfterEnter = false;
					}
					for (const taskListener of entry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
					}
					this.emitSummary(summary);
				}
			}

			if (entry.active.outputReactionEngine !== null && data.length > 0) {
				this.processOutputReactionChunk(request.taskId, entry, data);
			}

			for (const taskListener of entry.listeners.values()) {
				taskListener.onOutput?.(filteredChunk);
			}
		};
		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: commandBinary,
				args: commandArgs,
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					handleTaskOutput(chunk);
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);
					clearClaudeStartupReadinessTimer(currentActive);
					clearOutputReactionTimer(currentActive);

					const summary = this.applySessionEvent(currentEntry, {
						type: "process.exit",
						exitCode: event.exitCode,
						interrupted: currentActive.session.wasInterrupted(),
					});
					const shouldAutoRestart = this.shouldAutoRestart(currentEntry);

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
					// 进程退出即结束任何「连接重试」状态，避免顶栏 / 看板把已死的 session 仍标为重连中。
					this.applyConnectionRetryState(request.taskId, null);
					if (shouldAutoRestart) {
						this.scheduleAutoRestart(currentEntry);
					}

					const cleanupFn = currentActive.onSessionCleanup;
					currentActive.onSessionCleanup = null;
					if (cleanupFn) {
						cleanupFn().catch(() => {
							// Best effort: cleanup failure is non-critical.
						});
					}
				},
			});
		} catch (error) {
			if (launch.cleanup) {
				void launch.cleanup().catch(() => {
					// Best effort: cleanup failure is non-critical.
				});
			}
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				...buildTerminalFacetPatch(entry.summary, "failed", {
					reviewReason: "error",
					pid: null,
					agentId: request.agentId,
				}),
				agentId: request.agentId,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatSpawnFailure(commandBinary, error));
		}

		// 输出反应框架：仅当「连接中断自动续跑」开关开启、且有 reaction 适用于该 agent
		// （第一版为 Claude / Codex）时才挂载。挂载即异步幂等落盘续跑指令文件，确保
		// 注入时文件已存在可被 agent 读取。
		const outputReactionEngine = this.resolveOutputReactionEngine(request);
		const outputReactionSession = outputReactionEngine?.createSessionState(request.agentId) ?? null;
		if (outputReactionEngine !== null) {
			void ensureNetworkInterruptionResumeInstructionsFile().catch(() => {
				// 落盘失败不阻断续跑：注入体仍引用确定性路径，文件稍后可补写。
			});
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer:
				shouldAutoConfirmClaudeWorkspaceTrust(request.agentId, request.cwd) ||
				shouldAutoConfirmCodexWorkspaceTrust(request.agentId, request.cwd) ||
				hasCodexLaunchSignature
					? ""
					: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
				suppressScrollbackErasure: true,
				suppressDeviceAttributeQueries: request.agentId === "droid",
			}),
			onSessionCleanup: launch.cleanup ?? null,
			deferredStartupInput: launch.deferredStartupInput ?? null,
			detectOutputTransition: launch.detectOutputTransition ?? null,
			shouldInspectOutputForTransition: launch.shouldInspectOutputForTransition ?? null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
			claudeStartupReadinessDeadlineAt:
				request.agentId === "claude" && launch.deferredStartupInput
					? now() + CLAUDE_STARTUP_READINESS_TIMEOUT_MS
					: null,
			claudeStartupReadinessTimer: null,
			outputReactionEngine,
			outputReactionSession,
			outputReactionScanBuffer: outputReactionEngine !== null ? "" : null,
			outputReactionAttemptTimer: null,
			lastUserInputAt: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;
		entry.lastStallLoggedAt = null;
		this.ensureStallScanRunning();

		// 独立的 wall-clock 兜底：Claude 可能在一个 chunk 里渲染完启动 UI，而 readiness
		// predicate 漏识别（例如 TUI 文案改写、边框被切分到两块 chunk 里），此后不会
		// 再有 output 触发 handleTaskOutput 里的 deadline 检查。注册一次性 timer 强制
		// 在 timeout 时调用 trySendDeferredStartupInput，避免 prompt 永远注不进去。
		if (request.agentId === "claude" && launch.deferredStartupInput) {
			active.claudeStartupReadinessTimer = setTimeout(() => {
				const entryAtTimeout = this.entries.get(request.taskId);
				const activeAtTimeout = entryAtTimeout?.active;
				if (!activeAtTimeout) {
					return;
				}
				activeAtTimeout.claudeStartupReadinessTimer = null;
				this.trySendDeferredStartupInput(request.taskId);
			}, CLAUDE_STARTUP_READINESS_TIMEOUT_MS);
		}

		const startedAt = now();
		updateSummary(entry, {
			...buildTerminalFacetPatch(entry.summary, request.resumeFromTrash ? "awaiting_review" : "running", {
				reviewReason: request.resumeFromTrash ? "attention" : null,
				pid: session.pid,
				agentId: request.agentId,
			}),
			agentId: request.agentId,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt,
			lastOutputAt: null,
			reviewReason: request.resumeFromTrash ? "attention" : null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);
		for (const chunk of preActiveOutputChunks) {
			handleTaskOutput(chunk);
		}

		return cloneSummary(entry.summary);
	}

	async startShellSession(request: StartShellSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const entry = this.ensureEntry(request.taskId);
		entry.restartRequest = {
			kind: "shell",
			request: cloneStartShellSessionRequest(request),
		};
		if (entry.active && resolveSessionFacets(entry.summary).turnOwner === "agent") {
			return cloneSummary(entry.summary);
		}

		if (entry.active) {
			stopWorkspaceTrustTimers(entry.active);
			clearClaudeStartupReadinessTimer(entry.active);
			clearOutputReactionTimer(entry.active);
			entry.active.session.stop();
			entry.active = null;
		}
		entry.terminalStateMirror?.dispose();
		entry.terminalStateMirror = null;

		const cols = Number.isFinite(request.cols) && (request.cols ?? 0) > 0 ? Math.floor(request.cols ?? 0) : 120;
		const rows = Number.isFinite(request.rows) && (request.rows ?? 0) > 0 ? Math.floor(request.rows ?? 0) : 40;
		const terminalStateMirror = new TerminalStateMirror(cols, rows, {
			onInputResponse: (data) => {
				if (!entry.active || this.hasLiveOutputListener(entry)) {
					return;
				}
				entry.active.session.write(data);
			},
		});
		const env = buildTerminalEnvironment({ forceColor: false }, request.env);

		let session: PtySession;
		try {
			session = PtySession.spawn({
				binary: request.binary,
				args: request.args ?? [],
				cwd: request.cwd,
				env,
				cols,
				rows,
				onData: (chunk) => {
					if (!entry.active) {
						return;
					}

					const filteredChunk = filterTerminalProtocolOutput(entry.active.terminalProtocolFilter, chunk, {
						onOsc10ForegroundQuery: () => entry.active?.session.write(OSC_FOREGROUND_QUERY_REPLY),
						onOsc11BackgroundQuery: () => entry.active?.session.write(OSC_BACKGROUND_QUERY_REPLY),
					});
					if (filteredChunk.byteLength === 0) {
						return;
					}
					entry.terminalStateMirror?.applyOutput(filteredChunk);

					if (entry.active.workspaceTrustBuffer !== null) {
						entry.active.workspaceTrustBuffer += filteredChunk.toString("utf8");
						if (entry.active.workspaceTrustBuffer.length > MAX_WORKSPACE_TRUST_BUFFER_CHARS) {
							entry.active.workspaceTrustBuffer = entry.active.workspaceTrustBuffer.slice(
								-MAX_WORKSPACE_TRUST_BUFFER_CHARS,
							);
						}
					}
					updateSummary(entry, { lastOutputAt: now() });

					for (const taskListener of entry.listeners.values()) {
						taskListener.onOutput?.(filteredChunk);
					}
				},
				onExit: (event) => {
					const currentEntry = this.entries.get(request.taskId);
					if (!currentEntry) {
						return;
					}
					const currentActive = currentEntry.active;
					if (!currentActive) {
						return;
					}
					stopWorkspaceTrustTimers(currentActive);
					clearClaudeStartupReadinessTimer(currentActive);
					clearOutputReactionTimer(currentActive);

					const shellExitInterrupted = currentActive.session.wasInterrupted();
					const summary = updateSummary(currentEntry, {
						...buildTerminalFacetPatch(currentEntry.summary, shellExitInterrupted ? "interrupted" : "idle", {
							reviewReason: shellExitInterrupted ? "interrupted" : null,
							pid: null,
							agentId: currentEntry.summary.agentId,
						}),
						reviewReason: shellExitInterrupted ? "interrupted" : null,
						exitCode: event.exitCode,
						pid: null,
					});

					for (const taskListener of currentEntry.listeners.values()) {
						taskListener.onState?.(cloneSummary(summary));
						taskListener.onExit?.(event.exitCode);
					}
					currentEntry.active = null;
					this.emitSummary(summary);
				},
			});
		} catch (error) {
			terminalStateMirror.dispose();
			const summary = updateSummary(entry, {
				...buildTerminalFacetPatch(entry.summary, "failed", {
					reviewReason: "error",
					pid: null,
					agentId: null,
				}),
				agentId: null,
				workspacePath: request.cwd,
				pid: null,
				startedAt: null,
				lastOutputAt: null,
				reviewReason: "error",
				exitCode: null,
				lastHookAt: null,
				latestHookActivity: null,
				latestTurnCheckpoint: null,
				previousTurnCheckpoint: null,
			});
			this.emitSummary(summary);
			throw new Error(formatShellSpawnFailure(request.binary, error));
		}

		const active: ActiveProcessState = {
			session,
			workspaceTrustBuffer: null,
			cols,
			rows,
			terminalProtocolFilter: createTerminalProtocolFilterState({
				interceptOscColorQueries: true,
			}),
			onSessionCleanup: null,
			deferredStartupInput: null,
			detectOutputTransition: null,
			shouldInspectOutputForTransition: null,
			awaitingCodexPromptAfterEnter: false,
			autoConfirmedWorkspaceTrust: false,
			workspaceTrustConfirmTimer: null,
			claudeStartupReadinessDeadlineAt: null,
			claudeStartupReadinessTimer: null,
			outputReactionEngine: null,
			outputReactionSession: null,
			outputReactionScanBuffer: null,
			outputReactionAttemptTimer: null,
			lastUserInputAt: null,
		};
		entry.active = active;
		entry.terminalStateMirror = terminalStateMirror;

		updateSummary(entry, {
			...buildTerminalFacetPatch(entry.summary, "running", {
				reviewReason: null,
				pid: session.pid,
				agentId: null,
			}),
			agentId: null,
			workspacePath: request.cwd,
			pid: session.pid,
			startedAt: now(),
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			warningMessage: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});
		this.emitSummary(entry.summary);

		return cloneSummary(entry.summary);
	}

	recoverStaleSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (entry.active || !isSummaryInActiveTurn(entry.summary)) {
			return cloneSummary(entry.summary);
		}

		// Preserve agentId so the server can route to the correct agent type
		// (Cline SDK vs terminal PTY) when a task is restored from trash.
		const summary = updateSummary(entry, {
			...buildTerminalFacetPatch(entry.summary, "idle", {
				reviewReason: null,
				pid: null,
				agentId: entry.summary.agentId,
			}),
			workspacePath: null,
			pid: null,
			startedAt: null,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		});

		for (const listener of entry.listeners.values()) {
			listener.onState?.(cloneSummary(summary));
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	writeInput(taskId: string, data: Buffer): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return null;
		}
		// 记录用户手动输入时刻，用于抑制自动续跑注入打断正在打字的用户。
		entry.active.lastUserInputAt = now();
		// 旧门控 `state==="awaiting_review"` → facet 真相源 isAwaitingUserReviewTurn（涵盖 live↔exited
		// 折叠、零行为漂移）。reviewReason∈{hook,attention,error} 读保留——deriveUserTurnKind 非 1:1
		// （attention→needs_input 而 needs_input 亦覆盖 null），换 userTurnKind 会改行为，留 channel-C 批次。
		if (
			entry.summary.agentId === "codex" &&
			isAwaitingUserReviewTurn(resolveSessionFacets(entry.summary)) &&
			(entry.summary.reviewReason === "hook" ||
				entry.summary.reviewReason === "attention" ||
				entry.summary.reviewReason === "error") &&
			(data.includes(13) || data.includes(10))
		) {
			entry.active.awaitingCodexPromptAfterEnter = true;
		}
		entry.active.session.write(data);
		return cloneSummary(entry.summary);
	}

	resize(taskId: string, cols: number, rows: number, pixelWidth?: number, pixelHeight?: number): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		const safeCols = Math.max(1, Math.floor(cols));
		const safeRows = Math.max(1, Math.floor(rows));
		const safePixelWidth = Number.isFinite(pixelWidth ?? Number.NaN) ? Math.floor(pixelWidth as number) : undefined;
		const safePixelHeight = Number.isFinite(pixelHeight ?? Number.NaN)
			? Math.floor(pixelHeight as number)
			: undefined;
		const normalizedPixelWidth = safePixelWidth !== undefined && safePixelWidth > 0 ? safePixelWidth : undefined;
		const normalizedPixelHeight = safePixelHeight !== undefined && safePixelHeight > 0 ? safePixelHeight : undefined;
		entry.active.session.resize(safeCols, safeRows, normalizedPixelWidth, normalizedPixelHeight);
		entry.terminalStateMirror?.resize(safeCols, safeRows);
		entry.active.cols = safeCols;
		entry.active.rows = safeRows;
		return true;
	}

	pauseOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.pause();
		return true;
	}

	resumeOutput(taskId: string): boolean {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return false;
		}
		entry.active.session.resume();
		return true;
	}

	transitionToReview(
		taskId: string,
		reason: RuntimeTaskSessionReviewReason,
		userTurnKindOverride?: RuntimeTaskSessionUserTurnKind,
	): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		if (reason !== "hook") {
			return cloneSummary(entry.summary);
		}
		const before = entry.summary;
		// userTurnKindOverride（B3 Claude permission 采集）随 hook.to_review 事件下发，由 reducer 在 user 回合
		// 覆写人轴（经完整 facet 三元组，不裸写单字段）。
		const summary = this.applySessionEvent(entry, { type: "hook.to_review", userTurnKindOverride });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyHookActivity(taskId: string, activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const hasActivityUpdate =
			typeof activity.activityText === "string" ||
			typeof activity.toolName === "string" ||
			typeof activity.toolInputSummary === "string" ||
			typeof activity.finalMessage === "string" ||
			typeof activity.hookEventName === "string" ||
			typeof activity.notificationType === "string" ||
			typeof activity.source === "string";
		if (!hasActivityUpdate) {
			return cloneSummary(entry.summary);
		}

		const previous = entry.summary.latestHookActivity;
		const next: RuntimeTaskHookActivity = {
			activityText:
				typeof activity.activityText === "string" ? activity.activityText : (previous?.activityText ?? null),
			toolName: typeof activity.toolName === "string" ? activity.toolName : (previous?.toolName ?? null),
			toolInputSummary:
				typeof activity.toolInputSummary === "string"
					? activity.toolInputSummary
					: (previous?.toolInputSummary ?? null),
			finalMessage:
				typeof activity.finalMessage === "string" ? activity.finalMessage : (previous?.finalMessage ?? null),
			hookEventName:
				typeof activity.hookEventName === "string" ? activity.hookEventName : (previous?.hookEventName ?? null),
			notificationType:
				typeof activity.notificationType === "string"
					? activity.notificationType
					: (previous?.notificationType ?? null),
			source: typeof activity.source === "string" ? activity.source : (previous?.source ?? null),
		};

		const didChange =
			next.activityText !== (previous?.activityText ?? null) ||
			next.toolName !== (previous?.toolName ?? null) ||
			next.toolInputSummary !== (previous?.toolInputSummary ?? null) ||
			next.finalMessage !== (previous?.finalMessage ?? null) ||
			next.hookEventName !== (previous?.hookEventName ?? null) ||
			next.notificationType !== (previous?.notificationType ?? null) ||
			next.source !== (previous?.source ?? null);
		if (!didChange) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			lastHookAt: now(),
			latestHookActivity: next,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	transitionToRunning(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}
		const before = entry.summary;
		const summary = this.applySessionEvent(entry, { type: "hook.to_in_progress" });
		if (summary !== before && entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
			this.emitSummary(summary);
		}
		return cloneSummary(summary);
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry) {
			return null;
		}

		const latestCheckpoint = entry.summary.latestTurnCheckpoint ?? null;
		if (latestCheckpoint?.ref === checkpoint.ref && latestCheckpoint.commit === checkpoint.commit) {
			return cloneSummary(entry.summary);
		}

		const summary = updateSummary(entry, {
			previousTurnCheckpoint: latestCheckpoint,
			latestTurnCheckpoint: checkpoint,
		});
		if (entry.active) {
			for (const listener of entry.listeners.values()) {
				listener.onState?.(cloneSummary(summary));
			}
		}
		this.emitSummary(summary);
		return cloneSummary(summary);
	}

	stopTaskSession(taskId: string): RuntimeTaskSessionSummary | null {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return entry ? cloneSummary(entry.summary) : null;
		}
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = entry.active.onSessionCleanup;
		entry.active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(entry.active);
		clearClaudeStartupReadinessTimer(entry.active);
		clearOutputReactionTimer(entry.active);
		entry.active.session.stop();
		if (cleanupFn) {
			cleanupFn().catch(() => {
				// Best effort: cleanup failure is non-critical.
			});
		}
		return cloneSummary(entry.summary);
	}

	// Stop the PTY and wait until the process group has actually exited.
	// Tries SIGTERM first; escalates to SIGKILL after the graceful window so
	// a wedged TUI cannot block a user-initiated refresh.
	async forceStopTaskSession(taskId: string, gracefulTimeoutMs = 2_000): Promise<void> {
		const entry = this.entries.get(taskId);
		if (!entry?.active) {
			return;
		}
		const active = entry.active;
		entry.suppressAutoRestartOnExit = true;
		const cleanupFn = active.onSessionCleanup;
		active.onSessionCleanup = null;
		stopWorkspaceTrustTimers(active);
		clearClaudeStartupReadinessTimer(active);
		clearOutputReactionTimer(active);
		active.session.stop();
		const gracefulDeadline = now() + gracefulTimeoutMs;
		while (now() < gracefulDeadline) {
			if (active.session.hasExited()) {
				if (cleanupFn) {
					cleanupFn().catch(() => undefined);
				}
				return;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		if (!active.session.hasExited()) {
			active.session.stop({ force: true });
			const forceDeadline = now() + 500;
			while (now() < forceDeadline && !active.session.hasExited()) {
				await new Promise<void>((resolve) => setTimeout(resolve, 25));
			}
		}
		if (!active.session.hasExited()) {
			// PTY 在 SIGKILL + 500ms 轮询后仍未退出（zombie / 容器 PID 1 等罕见场景）。
			// 记录 tui-freeze 错误，并显式释放 entry.active，让后续 startTaskSession
			// 进入 fresh-spawn 分支恢复任务，旧 PTY 进程交由 OS 回收。
			logTuiFreezeError(
				`[tui-freeze] force-kill-timeout taskId=${taskId} agentId=${entry.summary.agentId ?? "(none)"} pid=${entry.summary.pid ?? "(none)"}`,
			);
			entry.active = null;
			this.applyConnectionRetryState(taskId, null);
		}
		if (cleanupFn) {
			cleanupFn().catch(() => undefined);
		}
	}

	// User-initiated terminal refresh. Caller resolves the agent command, cwd, and
	// the card-derived prompt; we handle the stop/wait/respawn dance and emit a
	// visible scrollback banner so the user can see the refresh moment.
	async refreshTaskTerminal(request: StartTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		await this.forceStopTaskSession(request.taskId, 2_000);
		const summary = await this.startTaskSession(request);
		// startTaskSession disposes the old terminal state mirror and creates a fresh one,
		// so the banner must be written AFTER the new mirror exists. Otherwise late-attach
		// viewers reattaching via the control socket would receive a restore snapshot from
		// the new mirror that never saw the banner.
		const entry = this.entries.get(request.taskId);
		if (entry) {
			const banner = Buffer.from("\r\n[kanban] Refreshing terminal session...\r\n", "utf8");
			entry.terminalStateMirror?.applyOutput(banner);
			for (const listener of entry.listeners.values()) {
				listener.onOutput?.(banner);
			}
		}
		return summary;
	}

	markInterruptedAndStopAll(): RuntimeTaskSessionSummary[] {
		const activeEntries = Array.from(this.entries.values()).filter((entry) => entry.active != null);
		for (const entry of activeEntries) {
			if (!entry.active) {
				continue;
			}
			stopWorkspaceTrustTimers(entry.active);
			clearClaudeStartupReadinessTimer(entry.active);
			clearOutputReactionTimer(entry.active);
			entry.active.session.stop({ interrupted: true });
		}
		return activeEntries.map((entry) => cloneSummary(entry.summary));
	}

	private applySessionEvent(entry: SessionEntry, event: SessionTransitionEvent): RuntimeTaskSessionSummary {
		const transition = reduceSessionTransition(entry.summary, event);
		if (!transition.changed) {
			return entry.summary;
		}
		if (transition.clearAttentionBuffer && entry.active) {
			if (entry.active.workspaceTrustBuffer !== null) {
				entry.active.workspaceTrustBuffer = "";
			}
		}
		// Stage 4 反转后 reducer patch 直接携带 facet（不再写 legacy state）→ 解阻塞此处旧的瞬态 patch.state
		// 读。改读 patch 的 facet：`isAwaitingUserReviewTurn(patchFacets)` 与旧 `patch.state==="awaiting_review"`
		// 逐项等价（hook.to_review + 非中断 exit → true；prompt-ready/to_in_progress 回 running 与中断 exit → false）。
		if (
			entry.active &&
			transition.changed &&
			isAwaitingUserReviewTurn({
				turnOwner: transition.patch.turnOwner ?? null,
				liveness: transition.patch.liveness ?? "none",
				userTurnKind: transition.patch.userTurnKind ?? null,
			})
		) {
			entry.active.awaitingCodexPromptAfterEnter = false;
		}
		return updateSummary(entry, transition.patch);
	}

	private ensureStallScanRunning(): void {
		if (this.stallScanInterval !== null) {
			return;
		}
		const interval = setInterval(() => {
			this.scanForStalls();
		}, STALL_SCAN_INTERVAL_MS);
		// Don't keep Node alive just for this probe; production has other refs.
		interval.unref?.();
		this.stallScanInterval = interval;
	}

	private scanForStalls(): void {
		const currentTime = now();
		for (const [taskId, entry] of this.entries.entries()) {
			if (!entry.active || !isSummaryInActiveTurn(entry.summary)) {
				entry.lastStallLoggedAt = null;
				continue;
			}
			if (entry.summary.agentId === null) {
				// Skip raw shell sessions; the stall probe is scoped to agent TUIs.
				continue;
			}
			const baseline = entry.summary.lastOutputAt ?? entry.summary.startedAt;
			if (!baseline) {
				continue;
			}
			const elapsed = currentTime - baseline;
			if (elapsed < this.stallThresholdMs) {
				entry.lastStallLoggedAt = null;
				continue;
			}
			if (entry.lastStallLoggedAt !== null && entry.lastStallLoggedAt >= baseline) {
				continue;
			}
			logTuiFreezeWarning(
				`[tui-freeze] stall-detected taskId=${taskId} agentId=${entry.summary.agentId} pid=${entry.summary.pid ?? "(none)"} state=${entry.summary.state} elapsedMs=${elapsed} thresholdMs=${this.stallThresholdMs}`,
			);
			entry.lastStallLoggedAt = baseline;
		}
	}

	dispose(): void {
		if (this.stallScanInterval !== null) {
			clearInterval(this.stallScanInterval);
			this.stallScanInterval = null;
		}
	}

	private ensureEntry(taskId: string): SessionEntry {
		const existing = this.entries.get(taskId);
		if (existing) {
			return existing;
		}
		const created: SessionEntry = {
			summary: createDefaultSummary(taskId),
			active: null,
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
			restartRequest: null,
			suppressAutoRestartOnExit: false,
			autoRestartTimestamps: [],
			pendingAutoRestart: null,
			lastStallLoggedAt: null,
		};
		this.entries.set(taskId, created);
		return created;
	}

	private shouldAutoRestart(entry: SessionEntry): boolean {
		const wasSuppressed = entry.suppressAutoRestartOnExit;
		entry.suppressAutoRestartOnExit = false;
		if (wasSuppressed) {
			return false;
		}
		if (entry.listeners.size === 0 || entry.restartRequest?.kind !== "task") {
			return false;
		}
		const currentTime = now();
		entry.autoRestartTimestamps = entry.autoRestartTimestamps.filter(
			(timestamp) => currentTime - timestamp < AUTO_RESTART_WINDOW_MS,
		);
		if (entry.autoRestartTimestamps.length >= MAX_AUTO_RESTARTS_PER_WINDOW) {
			return false;
		}
		entry.autoRestartTimestamps.push(currentTime);
		return true;
	}

	private scheduleAutoRestart(entry: SessionEntry): void {
		if (entry.pendingAutoRestart) {
			return;
		}
		const restartRequest = entry.restartRequest;
		if (!restartRequest || restartRequest.kind !== "task") {
			return;
		}
		let pendingAutoRestart: Promise<void> | null = null;
		pendingAutoRestart = (async () => {
			try {
				await this.startTaskSession(cloneStartTaskSessionRequest(restartRequest.request));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const summary = updateSummary(entry, {
					warningMessage: message,
				});
				const output = Buffer.from(`\r\n[kanban] ${message}\r\n`, "utf8");
				for (const listener of entry.listeners.values()) {
					listener.onOutput?.(output);
					listener.onState?.(cloneSummary(summary));
				}
				this.emitSummary(summary);
			} finally {
				if (entry.pendingAutoRestart === pendingAutoRestart) {
					entry.pendingAutoRestart = null;
				}
			}
		})();
		entry.pendingAutoRestart = pendingAutoRestart;
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		const snapshot = cloneSummary(summary);
		for (const listener of this.summaryListeners) {
			listener(snapshot);
		}
	}
}
