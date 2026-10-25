// summary 更新和提交候选仅唤醒原生核验，不构成输入接受证据。

import type { CodexCurrentNativeTurnToolActivityReadCursor } from "../agent-session-history/codex-current-native-turn-tool-activity-reader";
import type {
	NativeAgentConversationActivityReadCursor,
	NativeAgentConversationActivityReadResult,
	ReadNativeAgentConversationActivityInput,
} from "../agent-session-history/native-agent-conversation-activity-reader";
import { readNativeAgentConversationActivity } from "../agent-session-history/native-agent-conversation-activity-reader";
import type { NativeAgentConversationTranscriptActivityObservation } from "../agent-session-history/native-agent-conversation-transcript-activity";
import type {
	RuntimeLastEffectiveAgentConversationActivityObservation,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import {
	type CodexNativeAgentTurnExecutionObservation,
	shouldContinuouslyObserveCodexNativeTurnExecution,
} from "../core/codex-native-agent-turn-execution-observation";
import {
	type CodexNativeDirectInputReadinessObservation,
	isCodexNativeConversationRewindSignal,
	isCodexNeedsInputNativeReconciliationCandidate,
} from "../core/codex-native-direct-input-readiness";

export interface NativeAgentConversationActivityObservationContext {
	workspaceId: string;
	conversationSessionId: string;
	runtimeSessionIncarnationId: string | null;
	nativeSessionId: string;
}
export type NativeAgentConversationAcceptedUserPromptObservation = NativeAgentConversationActivityObservationContext &
	RuntimeLastEffectiveAgentConversationActivityObservation & {
		evidenceKind: "native_user_prompt_acceptance";
		submittedPromptText?: string;
		acceptedNativeAgentTurnIsInProgress?: boolean;
		acceptedNativeAgentTurnHasModelResponse?: boolean;
	};
export interface CreateNativeAgentConversationActivityObserverOptions {
	onAccepted: (observation: NativeAgentConversationAcceptedUserPromptObservation) => Promise<void> | void;
	onCodexNativeAgentTurnExecution?: (
		observation: CodexNativeAgentTurnExecutionObservation,
		summaryBeforeRead: RuntimeTaskSessionSummary,
	) => Promise<void> | void;
	onCodexNativeDirectInputReadiness?: (
		observation: NativeAgentConversationActivityObservationContext & CodexNativeDirectInputReadinessObservation,
		summaryBeforeRead: RuntimeTaskSessionSummary,
	) => Promise<void> | void;
	onActivity?: (
		observation: NativeAgentConversationActivityObservationContext &
			NativeAgentConversationTranscriptActivityObservation,
	) => Promise<void> | void;
	onReadFailed?: (error: unknown, context: NativeAgentConversationActivityObservationContext) => void;
	readNativeActivity?: (
		input: ReadNativeAgentConversationActivityInput,
	) => Promise<NativeAgentConversationActivityReadResult | null>;
	nowMs?: () => number;
	cooldownMs?: number;
	maxConcurrentReads?: number;
}
export interface NativeAgentConversationActivityObserver {
	observeTaskSessionSummary(
		workspaceId: string,
		summary: RuntimeTaskSessionSummary,
		getCurrentSummary: () => RuntimeTaskSessionSummary | null,
	): Promise<void>;
	wakeForPotentialUserPromptSubmission(
		workspaceId: string,
		summary: RuntimeTaskSessionSummary,
		getCurrentSummary: () => RuntimeTaskSessionSummary | null,
	): void;
	forgetWorkspace(workspaceId: string): void;
	dispose(): void;
}
interface NativeConversationObservationState {
	workspaceId: string;
	key: string;
	identityKey: string;
	summary: RuntimeTaskSessionSummary;
	getCurrentSummary: () => RuntimeTaskSessionSummary | null;
	cursor: NativeAgentConversationActivityReadCursor | null;
	codexToolTranscriptCursor: CodexCurrentNativeTurnToolActivityReadCursor | null;
	inFlight: Promise<void> | null;
	lastReadStartedAtMs: number;
	consecutiveUnknownNativeExecutionReadCount: number;
	nextNativeExecutionReadAtMs: number;
	candidateExpiresAtMs: number | null;
	wasCodexNeedsInputNativeReconciliationCandidate: boolean;
	lastCodexNativeConversationRewindSignalKey: string | null;
	retryTimer: ReturnType<typeof setTimeout> | null;
	transcriptBacklogRetryTimer: ReturnType<typeof setTimeout> | null;
	transcriptBacklogReadWindowExpiresAtMs: number | null;
	abortController: AbortController;
}
function observationIdentityKey(summary: RuntimeTaskSessionSummary): string {
	const identity = summary.agentNativeConversationSessionIdentity;
	return JSON.stringify([
		summary.agentId,
		summary.startedAt,
		summary.runtimeSessionIncarnationId,
		identity?.sourceAgentId,
		identity?.nativeSessionId,
		identity?.transcriptPath,
		summary.codexNativeSessionControlEndpoint?.socketPath,
	]);
}

export function createNativeAgentConversationActivityObserver(
	options: CreateNativeAgentConversationActivityObserverOptions,
): NativeAgentConversationActivityObserver {
	const nowMs = options.nowMs ?? Date.now;
	const readNativeActivity = options.readNativeActivity ?? readNativeAgentConversationActivity;
	const maxConcurrentReads = Math.max(1, options.maxConcurrentReads ?? 4);
	const states = new Map<string, NativeConversationObservationState>();
	const queuedReads: Array<() => void> = [];
	let concurrentReadCount = 0;
	let disposed = false;
	let nativeExecutionSweepTimer: ReturnType<typeof setInterval> | null = null;

	function ensureNativeExecutionSweepRunning(): void {
		if (nativeExecutionSweepTimer !== null) return;
		nativeExecutionSweepTimer = setInterval(() => {
			for (const state of states.values()) {
				const summary = state.getCurrentSummary();
				if (
					isCurrent(state) &&
					summary &&
					shouldContinuouslyObserveCodexNativeTurnExecution(summary) &&
					summary.codexNativeSessionControlEndpoint &&
					nowMs() >= state.nextNativeExecutionReadAtMs
				)
					void scheduleRead(state);
			}
		}, 15_000);
		nativeExecutionSweepTimer.unref();
	}

	function forgetState(state: NativeConversationObservationState): void {
		state.abortController.abort();
		if (state.retryTimer) clearTimeout(state.retryTimer);
		if (state.transcriptBacklogRetryTimer) clearTimeout(state.transcriptBacklogRetryTimer);
		state.retryTimer = null;
	}
	function isCurrent(state: NativeConversationObservationState): boolean {
		const latest = state.getCurrentSummary();
		return (
			!disposed &&
			states.get(state.key) === state &&
			latest !== null &&
			observationIdentityKey(latest) === state.identityKey
		);
	}
	function context(state: NativeConversationObservationState): NativeAgentConversationActivityObservationContext {
		return {
			workspaceId: state.workspaceId,
			conversationSessionId: state.summary.taskId,
			runtimeSessionIncarnationId: state.summary.runtimeSessionIncarnationId ?? null,
			nativeSessionId: state.summary.agentNativeConversationSessionIdentity?.nativeSessionId ?? "",
		};
	}
	function dispatchReads(): void {
		while (!disposed && concurrentReadCount < maxConcurrentReads) {
			const dispatch = queuedReads.shift();
			if (!dispatch) return;
			dispatch();
		}
	}
	function reportReadFailure(error: unknown, state: NativeConversationObservationState): void {
		try {
			options.onReadFailed?.(error, context(state));
		} catch {
			// 诊断出口故障也不能占住读取槽或阻断其他会话继续补证。
		}
	}
	function scheduleCandidateRetry(state: NativeConversationObservationState): void {
		if (
			!isCurrent(state) ||
			state.retryTimer ||
			state.candidateExpiresAtMs === null ||
			nowMs() >= state.candidateExpiresAtMs
		)
			return;
		state.retryTimer = setTimeout(() => {
			state.retryTimer = null;
			if (state.candidateExpiresAtMs === null || nowMs() >= state.candidateExpiresAtMs) return;
			void scheduleRead(state, true);
		}, 250);
		state.retryTimer.unref();
	}
	function scheduleRead(state: NativeConversationObservationState, force = false): Promise<void> {
		if (state.inFlight) return state.inFlight;
		if (!force && nowMs() - state.lastReadStartedAtMs < (options.cooldownMs ?? 250)) {
			// 新触发即使落在冷却期，也必须在自己的固定窗口内得到补读。
			scheduleCandidateRetry(state);
			return Promise.resolve();
		}
		let resolveScheduledRead: () => void = () => {};
		state.inFlight = new Promise<void>((resolve) => {
			resolveScheduledRead = resolve;
		});
		queuedReads.push(() => {
			if (
				!isCurrent(state) ||
				(force && (state.candidateExpiresAtMs === null || nowMs() >= state.candidateExpiresAtMs))
			) {
				state.inFlight = null;
				resolveScheduledRead();
				return;
			}
			concurrentReadCount += 1;
			state.lastReadStartedAtMs = nowMs();
			const summaryBeforeRead = state.getCurrentSummary() ?? state.summary;
			// 状态未知只退避独立执行查询；消息活动和接受证据仍按自身冷却期读取。
			const shouldReadCodexNativeAgentTurnExecution =
				force ||
				state.consecutiveUnknownNativeExecutionReadCount === 0 ||
				!shouldContinuouslyObserveCodexNativeTurnExecution(summaryBeforeRead) ||
				nowMs() >= state.nextNativeExecutionReadAtMs;
			const rewindSignalBeforeRead = state.lastCodexNativeConversationRewindSignalKey;
			const isReadStillCurrent = () =>
				isCurrent(state) && state.lastCodexNativeConversationRewindSignalKey === rewindSignalBeforeRead;
			let hasKnownNativeExecution = false;
			let readFailureWasReported = false;
			let shouldReadMoreTranscriptBacklog = false;
			void Promise.resolve()
				.then(() =>
					readNativeActivity({
						workspaceId: state.workspaceId,
						summary: summaryBeforeRead,
						shouldReadCodexNativeAgentTurnExecution,
						cursor: state.cursor,
						codexToolTranscriptCursor: state.codexToolTranscriptCursor,
						observedAtMs: state.lastReadStartedAtMs,
						signal: state.abortController.signal,
					}),
				)
				.then(async (result) => {
					if (!result || !isReadStillCurrent()) return;
					if (result.codexNativeAgentTurnExecution) {
						hasKnownNativeExecution = result.codexNativeAgentTurnExecution.executionStatus !== "unknown";
						await options.onCodexNativeAgentTurnExecution?.(
							result.codexNativeAgentTurnExecution,
							summaryBeforeRead,
						);
						if (!isReadStillCurrent()) return;
					}
					const readFailure =
						result.codexNativeAgentTurnExecutionReadFailure ?? result.nativeActivityProjectionReadFailure;
					if (readFailure) {
						readFailureWasReported = true;
						reportReadFailure(new Error(readFailure), state);
					}
					// 首次基线与 rewind 后没有新增消息时，也必须消费独立的状态证明。
					if (result.codexNativeDirectInputReadiness) {
						await options.onCodexNativeDirectInputReadiness?.(
							{ ...context(state), ...result.codexNativeDirectInputReadiness },
							summaryBeforeRead,
						);
					}
					for (const event of result.events) {
						if (!isReadStillCurrent()) return;
						const observation = { ...context(state), ...event };
						await options.onActivity?.(observation);
						if (
							event.activityKind === "accepted_user_input" &&
							event.evidenceKind === "native_user_prompt_acceptance"
						) {
							if (!isReadStillCurrent()) return;
							await options.onAccepted({ ...observation, evidenceKind: "native_user_prompt_acceptance" });
							state.candidateExpiresAtMs = null;
						}
					}
					// 下游写入成功后才提交读取游标；失败可按同一事件身份重试，不丢接受边沿。
					state.cursor = result.cursor;
					if (result.codexToolTranscriptCursor) state.codexToolTranscriptCursor = result.codexToolTranscriptCursor;
					shouldReadMoreTranscriptBacklog = result.moreAppendedTranscriptBytesRemain === true;
					if (!shouldReadMoreTranscriptBacklog) state.transcriptBacklogReadWindowExpiresAtMs = null;
					else if (state.transcriptBacklogReadWindowExpiresAtMs === null)
						state.transcriptBacklogReadWindowExpiresAtMs = nowMs() + 5_000;
				})
				.catch((error: unknown) => {
					readFailureWasReported = true;
					if (isCurrent(state)) reportReadFailure(error, state);
				})
				.finally(() => {
					// 未尝试状态查询的活动补读不能累计未知次数，也不能推迟静默补证。
					if (
						shouldReadCodexNativeAgentTurnExecution &&
						shouldContinuouslyObserveCodexNativeTurnExecution(summaryBeforeRead)
					) {
						state.consecutiveUnknownNativeExecutionReadCount = hasKnownNativeExecution
							? 0
							: state.consecutiveUnknownNativeExecutionReadCount + 1;
						state.nextNativeExecutionReadAtMs =
							nowMs() +
							Math.min(15_000 * 2 ** Math.max(0, state.consecutiveUnknownNativeExecutionReadCount - 1), 60_000);
						if (
							!hasKnownNativeExecution &&
							!readFailureWasReported &&
							isReadStillCurrent() &&
							summaryBeforeRead.codexNativeSessionControlEndpoint
						) {
							reportReadFailure(
								new Error(
									`原生执行状态未知，已保留待核验；连续未知次数=${state.consecutiveUnknownNativeExecutionReadCount} nextReadAtMs=${state.nextNativeExecutionReadAtMs}`,
								),
								state,
							);
						}
					}
					concurrentReadCount -= 1;
					state.inFlight = null;
					resolveScheduledRead();
					scheduleCandidateRetry(state);
					if (
						shouldReadMoreTranscriptBacklog &&
						isReadStillCurrent() &&
						!state.transcriptBacklogRetryTimer &&
						state.transcriptBacklogReadWindowExpiresAtMs !== null &&
						nowMs() < state.transcriptBacklogReadWindowExpiresAtMs
					) {
						state.transcriptBacklogRetryTimer = setTimeout(
							() => {
								state.transcriptBacklogRetryTimer = null;
								if (isReadStillCurrent()) void scheduleRead(state);
							},
							Math.max(options.cooldownMs ?? 250, 250),
						);
						state.transcriptBacklogRetryTimer.unref();
					}
					dispatchReads();
				});
		});
		const inFlight = state.inFlight;
		dispatchReads();
		return inFlight;
	}
	function stateFor(
		workspaceId: string,
		summary: RuntimeTaskSessionSummary,
		getCurrentSummary: () => RuntimeTaskSessionSummary | null,
	): NativeConversationObservationState | null {
		const identity = summary.agentNativeConversationSessionIdentity;
		if (
			disposed ||
			!identity?.nativeSessionId ||
			identity.sourceAgentId !== summary.agentId ||
			!["claude", "omp", "codex", "kimi"].includes(identity.sourceAgentId)
		)
			return null;
		const key = `${workspaceId}::${summary.taskId}`;
		const identityKey = observationIdentityKey(summary);
		const previous = states.get(key);
		if (previous?.identityKey === identityKey) {
			previous.getCurrentSummary = getCurrentSummary;
			// Kimi 的首次接受可能先于 observer 建基线，回查须使用本代最新的提交候选。
			if (summary.agentId === "kimi") previous.summary = { ...summary };
			return previous;
		}
		if (previous) forgetState(previous);
		const state: NativeConversationObservationState = {
			workspaceId,
			key,
			identityKey,
			summary: {
				...summary,
				agentNativeConversationSessionIdentity: { ...identity },
				codexNativeSessionControlEndpoint: summary.codexNativeSessionControlEndpoint
					? { ...summary.codexNativeSessionControlEndpoint }
					: summary.codexNativeSessionControlEndpoint,
			},
			getCurrentSummary,
			cursor: null,
			codexToolTranscriptCursor: null,
			inFlight: null,
			lastReadStartedAtMs: Number.NEGATIVE_INFINITY,
			consecutiveUnknownNativeExecutionReadCount: 0,
			nextNativeExecutionReadAtMs: 0,
			candidateExpiresAtMs: null,
			wasCodexNeedsInputNativeReconciliationCandidate: false,
			lastCodexNativeConversationRewindSignalKey: null,
			retryTimer: null,
			transcriptBacklogRetryTimer: null,
			transcriptBacklogReadWindowExpiresAtMs: null,
			abortController: new AbortController(),
		};
		states.set(key, state);
		if (summary.agentId === "codex") ensureNativeExecutionSweepRunning();
		return state;
	}
	return {
		observeTaskSessionSummary(workspaceId, summary, getCurrentSummary) {
			const state = stateFor(workspaceId, summary, getCurrentSummary);
			if (state) {
				const isCandidate = isCodexNeedsInputNativeReconciliationCandidate(summary);
				const rewindSignalKey = isCodexNativeConversationRewindSignal(summary.latestHookActivity ?? undefined)
					? JSON.stringify([summary.lastHookAt, summary.latestHookActivity?.hookEventName])
					: null;
				// 只认待输入进入边沿或新的 rewind；重绘、重复摘要与补读不能续期。
				if (
					isCandidate &&
					(!state.wasCodexNeedsInputNativeReconciliationCandidate ||
						(rewindSignalKey !== null && rewindSignalKey !== state.lastCodexNativeConversationRewindSignalKey))
				)
					state.candidateExpiresAtMs = nowMs() + 5_000;
				state.wasCodexNeedsInputNativeReconciliationCandidate = isCandidate;
				if (rewindSignalKey !== null) state.lastCodexNativeConversationRewindSignalKey = rewindSignalKey;
			}
			return state ? scheduleRead(state) : Promise.resolve();
		},
		wakeForPotentialUserPromptSubmission(workspaceId, summary, getCurrentSummary) {
			const state = stateFor(workspaceId, summary, getCurrentSummary);
			if (!state) return;
			state.candidateExpiresAtMs = nowMs() + 5_000;
			void scheduleRead(state, true);
		},
		forgetWorkspace(workspaceId) {
			for (const [key, state] of states)
				if (state.workspaceId === workspaceId) {
					forgetState(state);
					states.delete(key);
				}
		},
		dispose() {
			disposed = true;
			if (nativeExecutionSweepTimer !== null) clearInterval(nativeExecutionSweepTimer);
			nativeExecutionSweepTimer = null;
			for (const state of states.values()) forgetState(state);
			states.clear();
			// 排队任务自检后只结算 promise，不发起新的 IO。
			while (queuedReads.length > 0) queuedReads.shift()?.();
		},
	};
}
