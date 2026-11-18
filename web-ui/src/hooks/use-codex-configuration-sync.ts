import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	getCodexConfigurationSourceObservationRecoveryController,
	runCodexConfigurationSyncRequestWithinBudget,
} from "@/hooks/codex-configuration-source-observation-recovery";
import {
	forgetUnconfirmedCodexConfigurationSettingAction,
	isConfirmedCodexConfigurationProfileMutationRejection,
	notifyUnconfirmedCodexConfigurationSettingActionsChanged,
	readUnconfirmedCodexConfigurationSettingActions,
	recordUnconfirmedCodexConfigurationSettingActionAutomaticResend,
	rememberUnconfirmedCodexConfigurationSettingAction,
	subscribeUnconfirmedCodexConfigurationSettingActions,
	type UnconfirmedCodexConfigurationSettingAction,
} from "@/hooks/codex-configuration-unconfirmed-setting-actions";
import {
	acknowledgeCodexConfigurationChange,
	batchCodexConfigurationAction,
	fetchCodexConfigurationChangeDetails,
	fetchCodexConfigurationMutationReceipt,
	fetchCodexConfigurationSyncState,
	mutateCodexConfigurationProfile,
	notifyCodexConfigurationSyncUpdated,
	resolveCodexConfigurationConflict,
	resolveCodexConfigurationTargetConflict,
	setCodexConfigurationChangeSharingScope,
	subscribeCodexConfigurationSyncUpdated,
	synchronizeCodexConfigurationChange,
} from "@/runtime/codex-configuration-sync-query";
import type {
	CodexConfigurationBatchActionRequest,
	CodexConfigurationBatchActionResult,
	CodexConfigurationChange,
	CodexConfigurationProfileMutationRequest,
	CodexConfigurationPropagationTarget,
	CodexConfigurationSourceObservation,
} from "@/runtime/types";

const subscribeWhenDisabled = () => () => {};

export function useCodexConfigurationSync(workspaceId: string | null, enabled = true) {
	const [historicalDefaultEditRequest, setHistoricalDefaultEditRequest] = useState<{
		profileId: string;
		changeId: string;
		fields: Array<{ fieldKey: string; value: unknown; delete?: boolean }>;
	} | null>(null);
	const recoveryController = useMemo(
		() => getCodexConfigurationSourceObservationRecoveryController(workspaceId),
		[workspaceId],
	);
	const { state, sourceOperations, sourceActionMessages } = useSyncExternalStore(
		enabled ? recoveryController.subscribe : subscribeWhenDisabled,
		recoveryController.getSnapshot,
	);
	const [runtimeConnectionGeneration, setRuntimeConnectionGeneration] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [pendingChangeId, setPendingChangeId] = useState<string | null>(null);
	const [batchResults, setBatchResults] = useState<CodexConfigurationBatchActionResult["results"]>([]);
	const scope = useMemo(
		() => ({
			pending: false,
			active: true,
			requestAbortController: new AbortController(),
			operationIdentities: new Map<string, string>(),
		}),
		[recoveryController, enabled, runtimeConnectionGeneration],
	);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const isCurrentScope = useCallback(() => currentScope.current === scope && scope.active, [scope]);
	const acceptState = useCallback(
		(next: NonNullable<typeof state>) => {
			if (isCurrentScope()) recoveryController.acceptState(next);
		},
		[isCurrentScope, recoveryController],
	);
	const refreshSequence = useRef(0);
	const [feedbackOpportunityNowMs, setFeedbackOpportunityNowMs] = useState(Date.now);
	const refresh = useCallback(async () => {
		const sequence = ++refreshSequence.current;
		try {
			const next = await runCodexConfigurationSyncRequestWithinBudget(
				(signal) => fetchCodexConfigurationSyncState(workspaceId, signal),
				scope.requestAbortController.signal,
			);
			acceptState(next);
			if (isCurrentScope() && sequence === refreshSequence.current) {
				setError((current) => (current?.startsWith("暂时无法读取") ? null : current));
			}
		} catch {
			if (isCurrentScope() && sequence === refreshSequence.current)
				setError("暂时无法读取 Codex 配置同步状态，连接恢复后自动重试。");
		}
	}, [workspaceId, scope, acceptState, isCurrentScope]);
	useEffect(() => {
		scope.active = true;
		scope.requestAbortController = new AbortController();
		setPendingChangeId(null);
		setError(null);
		setBatchResults([]);
		if (!enabled) return;
		void refresh().then(() => recoveryController.resumeUnconfirmedActions());
		const unsubscribe = subscribeCodexConfigurationSyncUpdated((reason) => {
			if (reason === "runtime_reconnected") {
				scope.active = false;
				scope.requestAbortController.abort();
				recoveryController.resetForRuntimeReconnect();
				setRuntimeConnectionGeneration((generation) => generation + 1);
				return;
			}
			void refresh();
		});
		return () => {
			scope.active = false;
			scope.requestAbortController.abort();
			unsubscribe();
			refreshSequence.current++;
		};
	}, [enabled, refresh, scope, recoveryController]);
	useEffect(() => {
		const deadlines =
			state?.changes
				.filter(
					(change) =>
						change.approvalStatus === "pending" &&
						change.feedbackExpiresAtMs !== undefined &&
						change.feedbackExpiresAtMs > feedbackOpportunityNowMs,
				)
				.flatMap((change) => (change.feedbackExpiresAtMs === undefined ? [] : [change.feedbackExpiresAtMs])) ?? [];
		if (!enabled || !deadlines.length) return;
		const timer = setTimeout(
			() => {
				setFeedbackOpportunityNowMs(Date.now());
				void refresh();
			},
			Math.max(0, Math.min(...deadlines) - Date.now() + 1),
		);
		return () => clearTimeout(timer);
	}, [enabled, feedbackOpportunityNowMs, refresh, state?.changes]);
	const recoverSettingAction = useCallback(
		async (action: UnconfirmedCodexConfigurationSettingAction, automatic = false) => {
			const recoveredResults: CodexConfigurationBatchActionResult["results"] = [];
			if (action.kind === "sharing_scope") {
				const receipt = await runCodexConfigurationSyncRequestWithinBudget(
					(signal) =>
						fetchCodexConfigurationMutationReceipt(
							workspaceId,
							{ idempotencyKey: action.input.idempotencyKey, expectedSharingScopeMutation: action.input },
							signal,
						),
					scope.requestAbortController.signal,
				);
				if (!receipt) {
					if (automatic) recordUnconfirmedCodexConfigurationSettingActionAutomaticResend(action.identity);
					try {
						acceptState(
							await runCodexConfigurationSyncRequestWithinBudget(
								(signal) => setCodexConfigurationChangeSharingScope(workspaceId, action.input, signal),
								scope.requestAbortController.signal,
							),
						);
					} catch (error) {
						if (isConfirmedCodexConfigurationProfileMutationRejection(error))
							forgetUnconfirmedCodexConfigurationSettingAction(action.identity);
						throw error;
					}
				} else await refresh();
			} else if (action.kind === "profile") {
				const receipt = await runCodexConfigurationSyncRequestWithinBudget(
					(signal) =>
						fetchCodexConfigurationMutationReceipt(
							workspaceId,
							{ idempotencyKey: action.input.idempotencyKey, expectedProfileMutation: action.input },
							signal,
						),
					scope.requestAbortController.signal,
				);
				if (!receipt) {
					if (automatic) recordUnconfirmedCodexConfigurationSettingActionAutomaticResend(action.identity);
					try {
						acceptState(
							await runCodexConfigurationSyncRequestWithinBudget(
								(signal) => mutateCodexConfigurationProfile(workspaceId, action.input, signal),
								scope.requestAbortController.signal,
							),
						);
					} catch (error) {
						if (isConfirmedCodexConfigurationProfileMutationRejection(error))
							forgetUnconfirmedCodexConfigurationSettingAction(action.identity);
						throw error;
					}
				} else await refresh();
			} else {
				const remaining: CodexConfigurationBatchActionRequest["items"] = [];
				for (const item of action.input.items) {
					const receipt = await runCodexConfigurationSyncRequestWithinBudget(
						(signal) =>
							fetchCodexConfigurationMutationReceipt(
								workspaceId,
								{
									idempotencyKey: item.idempotencyKey,
									expectedAction: action.input.action,
									expectedEntry: item,
								},
								signal,
							),
						scope.requestAbortController.signal,
					);
					if (!receipt) remaining.push(item);
					else
						recoveredResults.push({
							changeId: item.changeId,
							status: "replayed",
							message: "已按原幂等身份核验回执。",
						});
				}
				if (remaining.length) {
					if (automatic) recordUnconfirmedCodexConfigurationSettingActionAutomaticResend(action.identity);
					const result = await runCodexConfigurationSyncRequestWithinBudget(
						(signal) => batchCodexConfigurationAction(workspaceId, { ...action.input, items: remaining }, signal),
						scope.requestAbortController.signal,
					);
					acceptState(result.state);
					recoveredResults.push(...result.results);
				} else await refresh();
				if (isCurrentScope()) setBatchResults(recoveredResults);
			}
			forgetUnconfirmedCodexConfigurationSettingAction(action.identity);
			return recoveredResults;
		},
		[workspaceId, scope, acceptState, refresh, isCurrentScope],
	);
	useEffect(() => {
		if (!enabled || !state) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;
		const recover = async () => {
			if (!active || !isCurrentScope()) return;
			if (scope.pending) {
				timer = setTimeout(() => void recover(), 1000);
				return;
			}
			const actions = readUnconfirmedCodexConfigurationSettingActions().filter(
				(entry) => entry.workspaceId === workspaceId && entry.storageIdentity === (state.storageIdentity ?? null),
			);
			if (!actions.length) {
				setError((current) => (current?.startsWith("原操作回执") ? null : current));
				return;
			}
			scope.pending = true;
			setPendingChangeId("recovery");
			try {
				for (const action of actions) {
					if (!active || !isCurrentScope()) return;
					await recoverSettingAction(action, true);
					notifyCodexConfigurationSyncUpdated();
				}
				if (isCurrentScope()) setError(null);
			} catch {
				if (isCurrentScope()) setError("原操作回执待核验，保留原幂等身份；连接恢复后自动重验。");
				if (++attempt < 3 && active) timer = setTimeout(() => void recover(), attempt * 5000);
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
			}
		};
		const onRecoveryConditionChanged = () => {
			attempt = 0;
			clearTimeout(timer);
			void recover();
		};
		void recover();
		window.addEventListener("online", onRecoveryConditionChanged);
		const unsubscribe = subscribeUnconfirmedCodexConfigurationSettingActions(onRecoveryConditionChanged);
		return () => {
			active = false;
			clearTimeout(timer);
			window.removeEventListener("online", onRecoveryConditionChanged);
			unsubscribe();
		};
	}, [enabled, scope, workspaceId, state?.storageIdentity, recoverSettingAction, isCurrentScope]);
	const profileAction = useCallback(
		async (input: CodexConfigurationProfileMutationRequest) => {
			if (scope.pending) return;
			scope.pending = true;
			setPendingChangeId("profile");
			setError(null);
			let attemptedActionIdentity: string | null = null;
			let shouldRecoverPersistedAction = false;
			try {
				for (const previous of readUnconfirmedCodexConfigurationSettingActions()) {
					if (
						previous.workspaceId !== workspaceId ||
						previous.storageIdentity !== (state?.storageIdentity ?? null) ||
						previous.kind !== "profile" ||
						previous.input.action !== input.action
					)
						continue;
					const sameSelection =
						input.action === "set_default" ||
						(input.action === "update" &&
							previous.input.action === "update" &&
							input.profileId === previous.input.profileId) ||
						(input.action === "bind_session" &&
							previous.input.action === "bind_session" &&
							input.workspaceId === previous.input.workspaceId &&
							input.conversationSessionId === previous.input.conversationSessionId);
					if (sameSelection) {
						const identity = JSON.stringify([
							workspaceId,
							state?.storageIdentity ?? null,
							"profile",
							{ ...input, idempotencyKey: undefined, stateResponseScope: undefined },
						]);
						try {
							await recoverSettingAction(previous);
						} catch (error) {
							if (
								readUnconfirmedCodexConfigurationSettingActions().some(
									(entry) => entry.identity === previous.identity,
								)
							)
								throw error;
							continue;
						}
						if (previous.identity === identity) {
							if (!isCurrentScope()) return;
							notifyCodexConfigurationSyncUpdated();
							return true;
						}
					}
				}
				const pending = rememberUnconfirmedCodexConfigurationSettingAction(
					workspaceId,
					state?.storageIdentity ?? null,
					{ kind: "profile", input },
				);
				attemptedActionIdentity = pending.action.identity;
				if (pending.requiresReceiptCheck) await recoverSettingAction(pending.action);
				else {
					if (pending.action.kind !== "profile") throw new Error("配置操作身份不符。");
					const profileInput = pending.action.input;
					acceptState(
						await runCodexConfigurationSyncRequestWithinBudget(
							(signal) => mutateCodexConfigurationProfile(workspaceId, profileInput, signal),
							scope.requestAbortController.signal,
						),
					);
					forgetUnconfirmedCodexConfigurationSettingAction(pending.action.identity);
				}
				if (!isCurrentScope()) return;
				notifyCodexConfigurationSyncUpdated();
				return true;
			} catch (error) {
				if (!isCurrentScope()) return;
				if (attemptedActionIdentity && isConfirmedCodexConfigurationProfileMutationRejection(error))
					forgetUnconfirmedCodexConfigurationSettingAction(attemptedActionIdentity);
				else shouldRecoverPersistedAction = true;
				setError(error instanceof Error ? error.message : "配置操作未确认，保留原身份并等待自动核验。");
				void refresh();
				return false;
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
				if (shouldRecoverPersistedAction) notifyUnconfirmedCodexConfigurationSettingActionsChanged();
			}
		},
		[workspaceId, refresh, scope, acceptState, isCurrentScope, state?.storageIdentity, recoverSettingAction],
	);
	const act = useCallback(
		async (
			change: CodexConfigurationChange,
			action: "synchronize" | "acknowledge" | "use_session_value" | "keep_shared_value",
			synchronizeExistingSessions = false,
			expectedSharedValueDigest = change.comparison?.expectedSharedValueDigest,
		) => {
			if (scope.pending) return;
			scope.pending = true;
			setPendingChangeId(change.changeId);
			setError(null);
			const input = {
				changeId: change.changeId,
				expectedVersion: change.version,
				idempotencyKey: crypto.randomUUID(),
			};
			try {
				const next =
					action === "synchronize"
						? await synchronizeCodexConfigurationChange(workspaceId, { ...input, synchronizeExistingSessions })
						: action === "acknowledge"
							? await acknowledgeCodexConfigurationChange(workspaceId, input)
							: await resolveCodexConfigurationConflict(workspaceId, {
									...input,
									resolution: action,
									expectedSharedValueDigest,
								});
				acceptState(next);
				if (!isCurrentScope()) return;
				notifyCodexConfigurationSyncUpdated();
			} catch {
				if (!isCurrentScope()) return;
				setError("操作未确认。请检查最新版本与目标状态后重试，原决定已保留。");
				void refresh();
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
			}
		},
		[workspaceId, refresh, scope, acceptState, isCurrentScope],
	);
	const setChangeSharingScope = useCallback(
		async (change: CodexConfigurationChange, targetScope: "session_only" | "profile") => {
			if (scope.pending) return false;
			scope.pending = true;
			setPendingChangeId(change.changeId);
			setError(null);
			let pendingAction: UnconfirmedCodexConfigurationSettingAction | undefined;
			let confirmedChange: CodexConfigurationChange | undefined;
			try {
				const pending = rememberUnconfirmedCodexConfigurationSettingAction(
					workspaceId,
					state?.storageIdentity ?? null,
					{
						kind: "sharing_scope",
						input: {
							changeId: change.changeId,
							expectedVersion: change.version,
							targetScope,
							idempotencyKey: crypto.randomUUID(),
						},
					},
				);
				pendingAction = pending.action;
				if (pending.requiresReceiptCheck) await recoverSettingAction(pending.action);
				else if (pending.action.kind === "sharing_scope") {
					const input = pending.action.input;
					const next = await runCodexConfigurationSyncRequestWithinBudget(
						(signal) => setCodexConfigurationChangeSharingScope(workspaceId, input, signal),
						scope.requestAbortController.signal,
					);
					confirmedChange = next.changes.find((entry) => entry.changeId === change.changeId);
					acceptState(next);
					forgetUnconfirmedCodexConfigurationSettingAction(pending.action.identity);
				}
				if (isCurrentScope()) notifyCodexConfigurationSyncUpdated();
				return confirmedChange;
			} catch (error) {
				if (pendingAction && isConfirmedCodexConfigurationProfileMutationRejection(error))
					forgetUnconfirmedCodexConfigurationSettingAction(pendingAction.identity);
				if (isCurrentScope())
					setError(error instanceof Error ? error.message : "范围切换回执未确认，已保留原身份并等待自动核验。");
				void refresh();
				return false;
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
				notifyUnconfirmedCodexConfigurationSettingActionsChanged();
			}
		},
		[scope, workspaceId, state?.storageIdentity, acceptState, refresh, recoverSettingAction, isCurrentScope],
	);
	const markNoticePresented = useCallback(
		async (changes: CodexConfigurationChange[]) => {
			for (const change of changes)
				if (
					change.changeSharingScope &&
					change.approvalStatus !== "pending" &&
					change.noticePresentedAtMs === undefined
				)
					await act(change, "acknowledge");
		},
		[act],
	);
	const resolveTarget = useCallback(
		async (
			change: CodexConfigurationChange,
			target: CodexConfigurationPropagationTarget,
			resolution: "use_source_change" | "keep_target_value",
		) => {
			if (scope.pending || !target.conflictingTargetValueDigest) return;
			scope.pending = true;
			setPendingChangeId(change.changeId);
			setError(null);
			try {
				acceptState(
					await resolveCodexConfigurationTargetConflict(workspaceId, {
						changeId: change.changeId,
						expectedVersion: change.version,
						idempotencyKey: crypto.randomUUID(),
						targetWriterId: target.writerId,
						expectedTargetValueDigest: target.conflictingTargetValueDigest,
						resolution,
					}),
				);
				if (!isCurrentScope()) return;
				notifyCodexConfigurationSyncUpdated();
			} catch {
				if (!isCurrentScope()) return;
				setError("目标冲突版本已变化或操作未确认，双方决定已保留。");
				void refresh();
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
			}
		},
		[workspaceId, refresh, scope, acceptState, isCurrentScope],
	);
	const batch = useCallback(
		async (
			action: CodexConfigurationBatchActionRequest["action"],
			entries: Array<{
				entryKind: "settings_proposal" | "source_observation";
				changeId: string;
				expectedVersion: number;
				expectedSharedValueDigest?: string;
				observation?: CodexConfigurationSourceObservation;
			}>,
		) => {
			if (!entries.length) return;
			if (
				(action === "confirm_source" || action === "defer") &&
				entries.every((entry) => entry.entryKind === "source_observation")
			)
				return recoveryController.batch(action, entries);
			if (scope.pending) return;
			scope.pending = true;
			setPendingChangeId(entries.length === 1 ? entries[0]!.changeId : "batch");
			setError(null);
			const results: CodexConfigurationBatchActionResult["results"] = [];
			let shouldRecoverPersistedAction = false;
			try {
				for (let offset = 0; offset < entries.length; offset += 200) {
					const items = entries.slice(offset, offset + 200).map((entry) => {
						const identity = JSON.stringify([action, entry]);
						let idempotencyKey = scope.operationIdentities.get(identity);
						if (!idempotencyKey) {
							idempotencyKey = crypto.randomUUID();
							scope.operationIdentities.set(identity, idempotencyKey);
						}
						return { ...entry, idempotencyKey };
					});
					const pending = rememberUnconfirmedCodexConfigurationSettingAction(
						workspaceId,
						state?.storageIdentity ?? null,
						{ kind: "feedback", input: { action, items } },
					);
					if (pending.requiresReceiptCheck) {
						results.push(...(await recoverSettingAction(pending.action)));
						continue;
					}
					const result = await runCodexConfigurationSyncRequestWithinBudget(
						(signal) => batchCodexConfigurationAction(workspaceId, { action, items }, signal),
						scope.requestAbortController.signal,
					);
					forgetUnconfirmedCodexConfigurationSettingAction(pending.action.identity);
					results.push(...result.results);
					acceptState(result.state);
					if (!isCurrentScope()) return;
				}
				setBatchResults(results);
				notifyCodexConfigurationSyncUpdated();
				return results;
			} catch (error) {
				if (!isCurrentScope()) return;
				shouldRecoverPersistedAction = true;
				setError(
					error instanceof Error && error.message.includes("未能持久保存")
						? error.message
						: "操作回执未确认，已保留操作身份。连接恢复后可重试，已完成项不会重复执行。",
				);
				void refresh();
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
				if (shouldRecoverPersistedAction) notifyUnconfirmedCodexConfigurationSettingActionsChanged();
			}
		},
		[
			workspaceId,
			refresh,
			scope,
			acceptState,
			isCurrentScope,
			recoveryController,
			state?.storageIdentity,
			recoverSettingAction,
		],
	);
	const adoptCandidate = useCallback(
		async (displayedMembers: CodexConfigurationChange[], expectedSharedValueDigest?: string) => {
			const first = displayedMembers[0];
			if (!first) return;
			const equivalents = displayedMembers
				.filter(
					(change) =>
						change === first ||
						(first.completeCandidateValueDigest &&
							first.candidateFieldGroupKey &&
							change.completeCandidateValueDigest === first.completeCandidateValueDigest &&
							change.candidateFieldGroupKey === first.candidateFieldGroupKey),
				)
				.slice(0, 3);
			for (const change of equivalents) {
				if (!isCurrentScope()) return;
				const results = await batch("approve", [
					{
						entryKind: "settings_proposal",
						changeId: change.changeId,
						expectedVersion: change.version,
						expectedSharedValueDigest: expectedSharedValueDigest ?? change.comparison?.expectedSharedValueDigest,
					},
				]);
				if (results?.[0]?.status !== "source_unverifiable") {
					if (results?.[0]?.status !== "applied" && results?.[0]?.status !== "replayed") void refresh();
					return results;
				}
			}
			void refresh();
		},
		[batch, refresh, isCurrentScope],
	);
	return {
		setChangeSharingScope,
		markNoticePresented,
		historicalDefaultEditRequest,
		clearHistoricalDefaultEditRequest: () => setHistoricalDefaultEditRequest(null),
		beginHistoricalDefaultEdit: async (change: CodexConfigurationChange) => {
			try {
				const details = await fetchCodexConfigurationChangeDetails(workspaceId, {
					changeId: change.changeId,
					expectedVersion: change.version,
				});
				await refresh();
				if (!isCurrentScope() || !change.codexConfigurationProfileId || !details.profileEditFields?.length)
					throw new Error("此历史字段已退出共享或尚不可核验，只供查看。");
				setHistoricalDefaultEditRequest({
					profileId: change.codexConfigurationProfileId,
					changeId: change.changeId,
					fields: details.profileEditFields.map((field) => ({ ...field, value: field.value })),
				});
			} catch (error) {
				if (isCurrentScope()) setError(error instanceof Error ? error.message : "历史值暂不可读，请重试。");
			}
		},
		adoptCandidate,
		workspaceId,
		state,
		error,
		errorIsConfirmed: Boolean(
			error && ["不支持", "不属于", "必须是", "格式无效", "幂等凭证与"].some((text) => error.includes(text)),
		),
		pendingChangeId,
		sourceOperations,
		sourceActionMessages,
		retryUnconfirmedSourceActions: recoveryController.resumeUnconfirmedActions,
		act,
		resolveTarget,
		refresh,
		batch,
		batchResults,
		profileAction,
		feedbackOpportunityNowMs,
	};
}
