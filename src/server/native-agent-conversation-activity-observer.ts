import { type FSWatcher, type Stats, unwatchFile, watch, watchFile } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { CodexPromptSubmissionAcceptanceReconciliation } from "../agent-session-history/codex-prompt-submission-acceptance-reconciliation";
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
		observedSubmissionAttemptedAtMs?: number | null;
		observedSubmissionId?: string;
	};
export interface CreateNativeAgentConversationActivityObserverOptions {
	onPromptSubmissionAcceptanceReconciliation?: (
		conversationSessionId: string,
		workspaceId: string,
		result: CodexPromptSubmissionAcceptanceReconciliation,
	) => Promise<void> | void;
	// false 表示接受边沿尚未应用，observer 必须保留读取位置并自动重试。
	onAccepted: (
		observation: NativeAgentConversationAcceptedUserPromptObservation,
	) => Promise<boolean> | Promise<void> | boolean | void;
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
	codexFullMessageReadContinuation:
		| NativeAgentConversationActivityReadResult["codexFullMessageReadContinuation"]
		| null;
	codexFullMessageReadContinuationRetryTimer: ReturnType<typeof setTimeout> | null;
	consecutiveUnchangedCodexFullMessageReadCount: number;
	acceptanceReconciliationRetryTimer: ReturnType<typeof setTimeout> | null;
	transcriptWatcher: Pick<FSWatcher, "close"> | null;
	forceAcceptanceReconciliation: boolean;
	successfullyAppliedAcceptedUserInputEventIds: Set<string>;
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
		if (state.acceptanceReconciliationRetryTimer) clearTimeout(state.acceptanceReconciliationRetryTimer);
		state.transcriptWatcher?.close();
		if (state.retryTimer) clearTimeout(state.retryTimer);
		if (state.transcriptBacklogRetryTimer) clearTimeout(state.transcriptBacklogRetryTimer);
		if (state.codexFullMessageReadContinuationRetryTimer)
			clearTimeout(state.codexFullMessageReadContinuationRetryTimer);
		state.codexFullMessageReadContinuationRetryTimer = null;
		state.codexFullMessageReadContinuation = null;
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
	function scheduleAcceptanceReconciliation(state: NativeConversationObservationState): void {
		if (!isCurrent(state)) return;
		const summary = state.getCurrentSummary();
		const pending = summary?.agentConversationPromptSubmissionAcceptance;
		if (
			summary?.agentId !== "codex" ||
			!pending ||
			pending.status === "accepted" ||
			pending.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId
		) {
			state.transcriptWatcher?.close();
			state.transcriptWatcher = null;
			if (state.acceptanceReconciliationRetryTimer) clearTimeout(state.acceptanceReconciliationRetryTimer);
			state.acceptanceReconciliationRetryTimer = null;
			return;
		}
		if (!state.transcriptWatcher && summary.agentNativeConversationSessionIdentity?.transcriptPath)
			observeTranscriptFileChanges(state, summary.agentNativeConversationSessionIdentity.transcriptPath);
		if (state.acceptanceReconciliationRetryTimer) return;
		const next = pending.verification?.nextCheckAtMs;
		if (next === null) return;
		state.acceptanceReconciliationRetryTimer = setTimeout(
			() => {
				state.acceptanceReconciliationRetryTimer = null;
				if (isCurrent(state)) void scheduleRead(state);
			},
			Math.max(250, (next ?? nowMs() + 15_000) - nowMs()),
		);
		state.acceptanceReconciliationRetryTimer.unref();
	}
	function scheduleCodexFullMessageReadContinuation(state: NativeConversationObservationState): void {
		if (
			!isCurrent(state) ||
			!state.codexFullMessageReadContinuation ||
			state.codexFullMessageReadContinuationRetryTimer ||
			state.consecutiveUnchangedCodexFullMessageReadCount > 3
		)
			return;
		const delayMs =
			state.consecutiveUnchangedCodexFullMessageReadCount === 0
				? Math.max(options.cooldownMs ?? 250, 250)
				: [15_000, 30_000, 60_000][state.consecutiveUnchangedCodexFullMessageReadCount - 1];
		state.codexFullMessageReadContinuationRetryTimer = setTimeout(() => {
			state.codexFullMessageReadContinuationRetryTimer = null;
			if (isCurrent(state)) void scheduleRead(state);
		}, delayMs);
		state.codexFullMessageReadContinuationRetryTimer.unref();
	}
	function observeTranscriptFileChanges(state: NativeConversationObservationState, transcriptPath: string): void {
		let directoryWatcher: FSWatcher | null = null;
		let observationWasClosed = false;
		let lastObservedTranscriptMetadataFingerprint: string | null = null;
		const closeObservation = () => {
			observationWasClosed = true;
			directoryWatcher?.close();
			directoryWatcher = null;
			unwatchFile(transcriptPath, onTranscriptMetadataChanged);
		};
		const wakeForTranscriptChange = () => {
			if (observationWasClosed) return;
			if (!isCurrent(state)) {
				closeObservation();
				return;
			}
			state.forceAcceptanceReconciliation = true;
			state.candidateExpiresAtMs = nowMs() + 5_000;
			void scheduleRead(state);
		};
		const recordTranscriptMetadataAndWakeWhenChanged = (metadata: Stats | null) => {
			if (observationWasClosed) return;
			const fingerprint = metadata
				? JSON.stringify([
						metadata.dev,
						metadata.ino,
						metadata.size,
						metadata.mtimeMs,
						metadata.ctimeMs,
						metadata.nlink,
					])
				: "missing";
			if (fingerprint === lastObservedTranscriptMetadataFingerprint) return;
			const isInitialMetadataObservation = lastObservedTranscriptMetadataFingerprint === null;
			lastObservedTranscriptMetadataFingerprint = fingerprint;
			if (isInitialMetadataObservation) {
				const cursor =
					state.getCurrentSummary()?.agentConversationPromptSubmissionAcceptance?.verification?.transcriptCursor;
				// 挂载前刚读过的内容不因迟到的创建通知重读；读后出现或替换的文件仍须唤醒。
				if (
					!metadata ||
					(cursor?.fileIdentity === `${metadata.dev}:${metadata.ino}` &&
						cursor.lastObservedFileSize === metadata.size)
				)
					return;
			}
			wakeForTranscriptChange();
		};
		const inspectCurrentTranscriptMetadata = async () => {
			let metadata: Stats | null = null;
			try {
				metadata = await stat(transcriptPath);
			} catch {
				// 文件暂不可读仍保留观察；元数据恢复后再核验原生归属。
			}
			recordTranscriptMetadataAndWakeWhenChanged(metadata);
		};
		const attachDirectoryWatcher = () => {
			if (observationWasClosed || directoryWatcher) return;
			try {
				// 监听目录项，不绑定旧 inode；文件尚未出现或被原子替换时也能唤醒。
				const watcher = watch(dirname(transcriptPath), { persistent: false }, (_event, filename) => {
					if (filename !== null && filename.toString() !== basename(transcriptPath)) return;
					void inspectCurrentTranscriptMetadata();
				});
				directoryWatcher = watcher;
				watcher.on("error", () => {
					watcher.close();
					if (directoryWatcher === watcher) directoryWatcher = null;
				});
			} catch {
				// 目录也缺失时只保留低频元数据观察，出现后自动恢复目录监听。
			}
		};
		function onTranscriptMetadataChanged(metadata: Stats, previous: Stats): void {
			if (
				metadata.dev === previous.dev &&
				metadata.ino === previous.ino &&
				metadata.size === previous.size &&
				metadata.mtimeMs === previous.mtimeMs &&
				metadata.ctimeMs === previous.ctimeMs &&
				metadata.nlink === previous.nlink
			)
				return;
			// 只比较 stat；未变化时不重新读取转录。目录观察失效也由此自动修复。
			directoryWatcher?.close();
			directoryWatcher = null;
			attachDirectoryWatcher();
			recordTranscriptMetadataAndWakeWhenChanged(metadata.nlink === 0 ? null : metadata);
		}
		state.transcriptWatcher = { close: closeObservation };
		attachDirectoryWatcher();
		watchFile(transcriptPath, { persistent: false, interval: 15_000 }, onTranscriptMetadataChanged);
		void inspectCurrentTranscriptMetadata();
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
			if (state.codexFullMessageReadContinuationRetryTimer)
				clearTimeout(state.codexFullMessageReadContinuationRetryTimer);
			state.codexFullMessageReadContinuationRetryTimer = null;
			state.lastReadStartedAtMs = nowMs();
			const summaryBeforeRead = state.getCurrentSummary() ?? state.summary;
			const hasReplacementSubmissionCandidate = () => {
				const candidate = state.getCurrentSummary()?.agentConversationPromptSubmissionAcceptance;
				const before = summaryBeforeRead.agentConversationPromptSubmissionAcceptance;
				return (
					candidate &&
					candidate.status !== "accepted" &&
					(candidate.attemptedAtMs !== before?.attemptedAtMs || candidate.submissionId !== before?.submissionId)
				);
			};
			const preserveUnappliedAcceptanceForRetry = () => {
				state.candidateExpiresAtMs ??= nowMs() + 5_000;
				state.forceAcceptanceReconciliation = true;
			};
			const forceAcceptanceReconciliation = state.forceAcceptanceReconciliation;
			state.forceAcceptanceReconciliation = false;
			const pendingVerification = summaryBeforeRead.agentConversationPromptSubmissionAcceptance?.verification;
			const shouldReconcilePromptSubmissionAcceptance =
				forceAcceptanceReconciliation ||
				!pendingVerification ||
				(pendingVerification.nextCheckAtMs !== null && nowMs() >= pendingVerification.nextCheckAtMs);
			// 状态未知只退避独立执行查询；消息活动和接受证据仍按自身冷却期读取。
			const shouldReadCodexNativeAgentTurnExecution =
				force ||
				state.consecutiveUnknownNativeExecutionReadCount === 0 ||
				!shouldContinuouslyObserveCodexNativeTurnExecution(summaryBeforeRead) ||
				nowMs() >= state.nextNativeExecutionReadAtMs;
			const rewindSignalBeforeRead = state.lastCodexNativeConversationRewindSignalKey;
			const isReadStillCurrent = () =>
				isCurrent(state) && state.lastCodexNativeConversationRewindSignalKey === rewindSignalBeforeRead;
			const recordUnavailableAcceptanceEvidence = async () => {
				const candidate = summaryBeforeRead.agentConversationPromptSubmissionAcceptance;
				if (
					!shouldReconcilePromptSubmissionAcceptance ||
					summaryBeforeRead.agentId !== "codex" ||
					!candidate ||
					candidate.status === "accepted" ||
					!isReadStillCurrent()
				)
					return;
				const count = (candidate.verification?.consecutiveUnchangedCheckCount ?? 0) + 1;
				await options.onPromptSubmissionAcceptanceReconciliation?.(summaryBeforeRead.taskId, state.workspaceId, {
					attemptedAtMs: candidate.attemptedAtMs,
					submissionId: candidate.submissionId,
					nativeSessionId: context(state).nativeSessionId,
					runtimeSessionIncarnationId: candidate.runtimeSessionIncarnationId,
					verification: {
						...candidate.verification,
						checkedAtMs: nowMs(),
						reason: "native_evidence_unavailable",
						consecutiveUnchangedCheckCount: count,
						nextCheckAtMs: count <= 3 ? nowMs() + [15_000, 30_000, 60_000][count - 1] : null,
					},
				});
			};
			let hasKnownNativeExecution = false;
			let readFailureWasReported = false;
			let shouldReadMoreTranscriptBacklog = false;
			void Promise.resolve()
				.then(() =>
					readNativeActivity({
						workspaceId: state.workspaceId,
						summary: summaryBeforeRead,
						shouldReadCodexNativeAgentTurnExecution,
						shouldReconcilePromptSubmissionAcceptance,
						forcePromptSubmissionAcceptanceReconciliation: forceAcceptanceReconciliation,
						cursor: state.cursor,
						codexToolTranscriptCursor: state.codexToolTranscriptCursor,
						observedAtMs: state.lastReadStartedAtMs,
						signal: state.abortController.signal,
					}),
				)
				.then(async (result) => {
					if (!isReadStillCurrent()) return;
					if (!result) {
						if (state.codexFullMessageReadContinuation) state.consecutiveUnchangedCodexFullMessageReadCount += 1;
						await recordUnavailableAcceptanceEvidence();
						return;
					}
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
					const reconciliation = result.promptSubmissionAcceptanceReconciliation;
					const acceptedInputWillBeProcessedAsLiveEvent =
						reconciliation?.accepted &&
						result.events.some(
							(event) =>
								event.activityKind === "accepted_user_input" &&
								event.eventId === reconciliation.accepted?.eventId,
						);
					// 同一次读取已取得新输入边沿时走正常回执/交接；只有历史记录走事实补证出口。
					if (reconciliation && !acceptedInputWillBeProcessedAsLiveEvent) {
						await options.onPromptSubmissionAcceptanceReconciliation?.(
							summaryBeforeRead.taskId,
							state.workspaceId,
							reconciliation,
						);
						if (state.getCurrentSummary()?.agentConversationPromptSubmissionAcceptance?.status === "accepted")
							state.candidateExpiresAtMs = null;
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
							if (event.eventId && state.successfullyAppliedAcceptedUserInputEventIds.has(event.eventId))
								continue;
							// 新候选可能在 IO 或活动回调期间出现；旧读取不能消费它的原生接受边沿。
							if (hasReplacementSubmissionCandidate()) {
								preserveUnappliedAcceptanceForRetry();
								return;
							}
							const acceptanceWasApplied = await options.onAccepted({
								...observation,
								evidenceKind: "native_user_prompt_acceptance",
								observedSubmissionAttemptedAtMs:
									summaryBeforeRead.agentConversationPromptSubmissionAcceptance?.attemptedAtMs ?? null,
								observedSubmissionId:
									summaryBeforeRead.agentConversationPromptSubmissionAcceptance?.submissionId,
							});
							if (acceptanceWasApplied === false) {
								preserveUnappliedAcceptanceForRetry();
								return;
							}
							if (event.eventId) state.successfullyAppliedAcceptedUserInputEventIds.add(event.eventId);
							if (!hasReplacementSubmissionCandidate()) state.candidateExpiresAtMs = null;
						}
					}
					// 下游写入成功后才提交读取游标；失败可按同一事件身份重试，不丢接受边沿。
					state.cursor = result.cursor;
					const continuation = result.codexFullMessageReadContinuation;
					const fullMessageReadMadeProgress =
						continuation?.madeProgress === true &&
						continuation.progressToken !== state.codexFullMessageReadContinuation?.progressToken;
					state.consecutiveUnchangedCodexFullMessageReadCount =
						!continuation || fullMessageReadMadeProgress
							? 0
							: state.consecutiveUnchangedCodexFullMessageReadCount + 1;
					state.codexFullMessageReadContinuation = continuation ?? null;
					state.successfullyAppliedAcceptedUserInputEventIds.clear();
					if (result.codexToolTranscriptCursor) state.codexToolTranscriptCursor = result.codexToolTranscriptCursor;
					shouldReadMoreTranscriptBacklog = result.moreAppendedTranscriptBytesRemain === true;
					if (!shouldReadMoreTranscriptBacklog) state.transcriptBacklogReadWindowExpiresAtMs = null;
					else if (state.transcriptBacklogReadWindowExpiresAtMs === null)
						state.transcriptBacklogReadWindowExpiresAtMs = nowMs() + 5_000;
				})
				.catch(async (error: unknown) => {
					if (state.codexFullMessageReadContinuation) state.consecutiveUnchangedCodexFullMessageReadCount += 1;
					await recordUnavailableAcceptanceEvidence().catch(() => {});
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
					if (state.acceptanceReconciliationRetryTimer) clearTimeout(state.acceptanceReconciliationRetryTimer);
					state.acceptanceReconciliationRetryTimer = null;
					scheduleAcceptanceReconciliation(state);
					// 已知未完分页独立续读；idle、已接受标记及五秒候选窗口都不能吞掉恢复进度。
					scheduleCodexFullMessageReadContinuation(state);
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
			codexFullMessageReadContinuation: null,
			codexFullMessageReadContinuationRetryTimer: null,
			consecutiveUnchangedCodexFullMessageReadCount: 0,
			acceptanceReconciliationRetryTimer: null,
			transcriptWatcher: null,
			forceAcceptanceReconciliation: Boolean(
				summary.agentConversationPromptSubmissionAcceptance &&
					summary.agentConversationPromptSubmissionAcceptance.status !== "accepted",
			),
			successfullyAppliedAcceptedUserInputEventIds: new Set(),
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
				if (rewindSignalKey !== null && rewindSignalKey !== state.lastCodexNativeConversationRewindSignalKey) {
					if (state.codexFullMessageReadContinuationRetryTimer)
						clearTimeout(state.codexFullMessageReadContinuationRetryTimer);
					state.codexFullMessageReadContinuationRetryTimer = null;
					state.codexFullMessageReadContinuation = null;
					state.consecutiveUnchangedCodexFullMessageReadCount = 0;
					if (state.cursor?.transport === "codex_control")
						state.cursor = { ...state.cursor, fullMessagePageReadRecovery: undefined };
				}
				if (rewindSignalKey !== null) state.lastCodexNativeConversationRewindSignalKey = rewindSignalKey;
			}
			return state ? scheduleRead(state) : Promise.resolve();
		},
		wakeForPotentialUserPromptSubmission(workspaceId, summary, getCurrentSummary) {
			const state = stateFor(workspaceId, summary, getCurrentSummary);
			if (!state) return;
			state.candidateExpiresAtMs = nowMs() + 5_000;
			state.forceAcceptanceReconciliation = true;
			state.consecutiveUnchangedCodexFullMessageReadCount = 0;
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
