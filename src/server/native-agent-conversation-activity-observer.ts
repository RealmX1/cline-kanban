// summary 更新和提交候选仅唤醒原生核验，不构成输入接受证据。
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
	inFlight: Promise<void> | null;
	lastReadStartedAtMs: number;
	candidateExpiresAtMs: number | null;
	retryTimer: ReturnType<typeof setTimeout> | null;
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

	function forgetState(state: NativeConversationObservationState): void {
		state.abortController.abort();
		if (state.retryTimer) clearTimeout(state.retryTimer);
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
			void scheduleRead(state, true);
		}, 250);
		state.retryTimer.unref();
	}
	function scheduleRead(state: NativeConversationObservationState, force = false): Promise<void> {
		if (state.inFlight) return state.inFlight;
		if (!force && nowMs() - state.lastReadStartedAtMs < (options.cooldownMs ?? 250)) return Promise.resolve();
		let resolveScheduledRead: () => void = () => {};
		state.inFlight = new Promise<void>((resolve) => {
			resolveScheduledRead = resolve;
		});
		queuedReads.push(() => {
			if (!isCurrent(state)) {
				state.inFlight = null;
				resolveScheduledRead();
				return;
			}
			concurrentReadCount += 1;
			state.lastReadStartedAtMs = nowMs();
			void Promise.resolve()
				.then(() =>
					readNativeActivity({
						workspaceId: state.workspaceId,
						summary: state.summary,
						cursor: state.cursor,
						observedAtMs: state.lastReadStartedAtMs,
						signal: state.abortController.signal,
					}),
				)
				.then(async (result) => {
					if (!result || !isCurrent(state)) return;
					for (const event of result.events) {
						if (!isCurrent(state)) return;
						const observation = { ...context(state), ...event };
						await options.onActivity?.(observation);
						if (
							event.activityKind === "accepted_user_input" &&
							event.evidenceKind === "native_user_prompt_acceptance"
						) {
							if (!isCurrent(state)) return;
							await options.onAccepted({ ...observation, evidenceKind: "native_user_prompt_acceptance" });
							state.candidateExpiresAtMs = null;
						}
					}
					// 下游写入成功后才提交读取游标；失败可按同一事件身份重试，不丢接受边沿。
					state.cursor = result.cursor;
				})
				.catch((error: unknown) => {
					if (isCurrent(state)) options.onReadFailed?.(error, context(state));
				})
				.finally(() => {
					concurrentReadCount -= 1;
					state.inFlight = null;
					resolveScheduledRead();
					scheduleCandidateRetry(state);
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
			inFlight: null,
			lastReadStartedAtMs: Number.NEGATIVE_INFINITY,
			candidateExpiresAtMs: null,
			retryTimer: null,
			abortController: new AbortController(),
		};
		states.set(key, state);
		return state;
	}
	return {
		observeTaskSessionSummary(workspaceId, summary, getCurrentSummary) {
			const state = stateFor(workspaceId, summary, getCurrentSummary);
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
			for (const state of states.values()) forgetState(state);
			states.clear();
			// 排队任务自检后只结算 promise，不发起新的 IO。
			while (queuedReads.length > 0) queuedReads.shift()?.();
		},
	};
}
