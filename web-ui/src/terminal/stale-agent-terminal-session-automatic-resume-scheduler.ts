import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { decideStaleAgentTerminalSessionAutomaticResumeEligibility } from "@/terminal/stale-agent-terminal-session-automatic-resume-eligibility";

// 「何时」替用户按下续跑：资格判定（stale-agent-terminal-session-automatic-resume-eligibility.ts）回答「该不该」，
// 本模块回答「什么时候发、发几次」，并把进行中的状态报给面板。
//
// 只在「用户打开 / 回到这个任务」的信号上评估（restore 落屏、可见挂载、标签页回到可见、焦点点进终端），
// 刻意不随 summary 变化评估：用户把一个任务一直开在屏幕上、人离开了，回收发生的那一刻若立刻续跑，
// 回收就白做了。

// EXPERIMENT_NODE: 自动续跑前要求终端连续可见挂载的时长；初值 1000ms，权衡「alt+↑/↓ 快速翻卡不批量拉起 agent」与「停下来后多快接回会话」。
export const STALE_AGENT_TERMINAL_SESSION_AUTOMATIC_RESUME_VISIBLE_DWELL_MS = 1_000;

// 陈旧会话自动续跑的**跨实例**冷却。
//
// 本模块的按活体闩是 per-终端实例的，它拦不住真正的重复触发：切一张卡、被 MAX_PARKED_TERMINALS 的 LRU
// 驱逐后重挂、关掉面板再打开，每一次都是一份新实例、都重新放一次电。于是「服务端起不来」这种持续故障
// 会被前端反复叫醒，一次故障变成一串创建请求。
//
// 用冷却而不是永久闩：服务器如果真的第二次重启，这条会话仍然应该允许再续一次。
//
// 作用域诚实说明：模块级 = **同一个标签页内**跨实例。多标签页各有各的 JS realm，这里拦不住；
// 那一层归服务端（per-task 启动互斥 + 「自动续跑遇到活会话即 no-op」，见 session-manager 的 refreshTaskTerminal）。
const MINIMUM_INTERVAL_BETWEEN_STALE_SESSION_AUTO_RESUME_ATTEMPTS_PER_TASK_MS = 60_000;
const staleSessionAutoResumeAttemptedAtEpochMsByWorkspaceAndTask = new Map<string, number>();

function buildStaleSessionAutoResumeCooldownKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function hasStaleSessionAutoResumeCooledDownForTask(workspaceAndTaskKey: string): boolean {
	const lastAttemptedAtEpochMs = staleSessionAutoResumeAttemptedAtEpochMsByWorkspaceAndTask.get(workspaceAndTaskKey);
	return (
		lastAttemptedAtEpochMs === undefined ||
		Date.now() - lastAttemptedAtEpochMs >= MINIMUM_INTERVAL_BETWEEN_STALE_SESSION_AUTO_RESUME_ATTEMPTS_PER_TASK_MS
	);
}

function recordStaleSessionAutoResumeAttemptForTask(workspaceAndTaskKey: string): void {
	const attemptedAtEpochMs = Date.now();
	// 顺手丢掉已经过期的键，免得这张表随会话数单调增长——它记的是「最近一分钟内续跑过谁」，不是一份历史账。
	for (const [key, recordedAtEpochMs] of staleSessionAutoResumeAttemptedAtEpochMsByWorkspaceAndTask) {
		if (
			attemptedAtEpochMs - recordedAtEpochMs >=
			MINIMUM_INTERVAL_BETWEEN_STALE_SESSION_AUTO_RESUME_ATTEMPTS_PER_TASK_MS
		) {
			staleSessionAutoResumeAttemptedAtEpochMsByWorkspaceAndTask.delete(key);
		}
	}
	staleSessionAutoResumeAttemptedAtEpochMsByWorkspaceAndTask.set(workspaceAndTaskKey, attemptedAtEpochMs);
}

// 整个 workspace 的终端被拆掉时一并作废它的冷却：冷却拦的是「实例 churn 导致重复放电」，而整体拆除是一条
// 粗粒度的、由外部显式触发的边界。注意**不要**在单个终端 dispose 时调用——那恰恰是切卡片时的实例 churn 本身。
export function forgetStaleSessionAutoResumeCooldownsForWorkspace(workspaceId: string): void {
	for (const key of [...staleSessionAutoResumeAttemptedAtEpochMsByWorkspaceAndTask.keys()]) {
		if (key.startsWith(`${workspaceId}:`)) {
			staleSessionAutoResumeAttemptedAtEpochMsByWorkspaceAndTask.delete(key);
		}
	}
}

// 面板据此在续跑进行中禁用「重启」按钮并给出说明：日志里有过「自动续跑 6 秒后用户点重启，把刚起的进程
// 杀掉重来」的实例，原因就是那几秒里屏幕上没有任何迹象表明续跑已经在路上。
export type StaleAgentTerminalSessionAutomaticResumePhase = "waiting_for_visible_dwell" | "resume_request_in_flight";

// summary 缺 incarnation id（旧盘数据）时所有死活体共用这一个键，退化为「每实例一次」的旧语义。
const UNKNOWN_RUNTIME_SESSION_INCARNATION_KEY = "runtime_session_incarnation_unknown";

export interface StaleAgentTerminalSessionAutomaticResumeSchedulerOptions {
	workspaceId: string;
	taskId: string;
	// 此刻是否允许评估：终端可见挂载、标签页可见、已有一份落屏的 restore、且没有被预热延迟 / 进行中的画面重同步抑制。
	isAllowedToEvaluateAutomaticResumeNow: () => boolean;
	readLatestSummary: () => RuntimeTaskSessionSummary | null;
	// 语义见资格判定的同名输入字段：只有可信的空快照才算「服务端 mirror 已丢」。
	readLatestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss: () => boolean;
	requestAutomaticResume: () => Promise<unknown>;
	onPhaseChange: (phase: StaleAgentTerminalSessionAutomaticResumePhase | null) => void;
}

export class StaleAgentTerminalSessionAutomaticResumeScheduler {
	private phase: StaleAgentTerminalSessionAutomaticResumePhase | null = null;
	private visibleDwellTimer: ReturnType<typeof setTimeout> | null = null;
	// 同一个死活体在本实例里只试一次；续跑成功后又被回收（换了 incarnation）则可再试。
	// 取代旧的一生一次 boolean：那一版让活过两次 runtime 重启的实例第二次不再续跑。
	private automaticResumeAttemptedForRuntimeSessionIncarnationKey: string | null = null;
	private disposed = false;

	constructor(private readonly options: StaleAgentTerminalSessionAutomaticResumeSchedulerOptions) {}

	getPhase(): StaleAgentTerminalSessionAutomaticResumePhase | null {
		return this.phase;
	}

	// 「用户打开 / 回到这个任务」的信号到达。符合资格就开始计停留时长；已在等待或请求在途时什么都不做。
	evaluateOnUserOpenSignal(): void {
		if (this.disposed || this.phase !== null) {
			return;
		}
		if (this.resolveIncarnationKeyIfAutomaticResumeWarrantedNow() === null) {
			return;
		}
		this.setPhase("waiting_for_visible_dwell");
		this.visibleDwellTimer = setTimeout(() => {
			this.visibleDwellTimer = null;
			void this.sendAutomaticResumeAfterVisibleDwell();
		}, STALE_AGENT_TERMINAL_SESSION_AUTOMATIC_RESUME_VISIBLE_DWELL_MS);
	}

	// 终端离开可见挂载（切卡 / 泊车 / 关面板）：还在等停留时长的那一次作废。请求已发出则不受影响。
	cancelPendingVisibleDwell(): void {
		if (this.visibleDwellTimer === null) {
			return;
		}
		clearTimeout(this.visibleDwellTimer);
		this.visibleDwellTimer = null;
		this.setPhase(null);
	}

	dispose(): void {
		this.cancelPendingVisibleDwell();
		this.disposed = true;
	}

	private resolveIncarnationKeyIfAutomaticResumeWarrantedNow(): string | null {
		if (!this.options.isAllowedToEvaluateAutomaticResumeNow()) {
			return null;
		}
		const summary = this.options.readLatestSummary();
		const eligibility = decideStaleAgentTerminalSessionAutomaticResumeEligibility({
			summary,
			latestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss:
				this.options.readLatestRestoreSnapshotTrustedAsEvidenceOfServerTerminalMirrorLoss(),
		});
		if (eligibility.kind !== "eligible") {
			return null;
		}
		const incarnationKey = summary?.runtimeSessionIncarnationId ?? UNKNOWN_RUNTIME_SESSION_INCARNATION_KEY;
		if (incarnationKey === this.automaticResumeAttemptedForRuntimeSessionIncarnationKey) {
			return null;
		}
		if (
			!hasStaleSessionAutoResumeCooledDownForTask(
				buildStaleSessionAutoResumeCooldownKey(this.options.workspaceId, this.options.taskId),
			)
		) {
			return null;
		}
		return incarnationKey;
	}

	private async sendAutomaticResumeAfterVisibleDwell(): Promise<void> {
		// 停留期间 summary 可能已变（别的标签页先续上了、会话被挪进 Done），按最新状态重判一次。
		const incarnationKey = this.disposed ? null : this.resolveIncarnationKeyIfAutomaticResumeWarrantedNow();
		if (incarnationKey === null) {
			this.setPhase(null);
			return;
		}
		this.automaticResumeAttemptedForRuntimeSessionIncarnationKey = incarnationKey;
		recordStaleSessionAutoResumeAttemptForTask(
			buildStaleSessionAutoResumeCooldownKey(this.options.workspaceId, this.options.taskId),
		);
		this.setPhase("resume_request_in_flight");
		try {
			await this.options.requestAutomaticResume();
		} catch {
			// 续跑失败不打断终端；面板上的重启按钮仍可手动重试。
		} finally {
			this.setPhase(null);
		}
	}

	private setPhase(phase: StaleAgentTerminalSessionAutomaticResumePhase | null): void {
		if (this.phase === phase) {
			return;
		}
		this.phase = phase;
		if (!this.disposed) {
			this.options.onPhaseChange(phase);
		}
	}
}
