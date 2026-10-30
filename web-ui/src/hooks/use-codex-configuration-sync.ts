import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	getCodexConfigurationSourceObservationRecoveryController,
	runCodexConfigurationSyncRequestWithinBudget,
} from "@/hooks/codex-configuration-source-observation-recovery";
import {
	acknowledgeCodexConfigurationChange,
	batchCodexConfigurationAction,
	fetchCodexConfigurationSyncState,
	mutateCodexConfigurationProfile,
	notifyCodexConfigurationSyncUpdated,
	resolveCodexConfigurationConflict,
	resolveCodexConfigurationTargetConflict,
	subscribeCodexConfigurationSyncUpdated,
	synchronizeCodexConfigurationChange,
} from "@/runtime/codex-configuration-sync-query";
import type {
	CodexConfigurationBatchActionRequest,
	CodexConfigurationBatchActionResult,
	CodexConfigurationChange,
	CodexConfigurationProfileMutationRequest,
	CodexConfigurationPropagationTarget,
} from "@/runtime/types";

const subscribeWhenDisabled = () => () => {};

export function useCodexConfigurationSync(workspaceId: string | null, enabled = true) {
	const recoveryController = useMemo(
		() => getCodexConfigurationSourceObservationRecoveryController(workspaceId),
		[workspaceId],
	);
	const { state, sourceOperations, sourceActionMessages } = useSyncExternalStore(
		enabled ? recoveryController.subscribe : subscribeWhenDisabled,
		recoveryController.getSnapshot,
	);
	const [error, setError] = useState<string | null>(null);
	const [pendingChangeId, setPendingChangeId] = useState<string | null>(null);
	const [batchResults, setBatchResults] = useState<CodexConfigurationBatchActionResult["results"]>([]);
	const scope = useMemo(
		() => ({
			pending: false,
			active: true,
			requestAbortController: new AbortController(),
			operationIdentities: new Map<string, string>(),
			unconfirmedProfileMutation: null as { requestIdentity: string; idempotencyKey: string } | null,
		}),
		[recoveryController, enabled],
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
		void refresh();
		const unsubscribe = subscribeCodexConfigurationSyncUpdated((reason) => {
			void refresh();
			if (reason === "runtime_reconnected") recoveryController.resumeUnconfirmedActions();
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
	const profileAction = useCallback(
		async (input: CodexConfigurationProfileMutationRequest) => {
			if (scope.pending) return;
			scope.pending = true;
			setPendingChangeId("profile");
			setError(null);
			try {
				const requestIdentity = JSON.stringify([workspaceId, { ...input, idempotencyKey: undefined }]);
				const idempotencyKey =
					scope.unconfirmedProfileMutation?.requestIdentity === requestIdentity
						? scope.unconfirmedProfileMutation.idempotencyKey
						: input.idempotencyKey;
				scope.unconfirmedProfileMutation = { requestIdentity, idempotencyKey };
				acceptState(await mutateCodexConfigurationProfile(workspaceId, { ...input, idempotencyKey }));
				if (!isCurrentScope()) return;
				scope.unconfirmedProfileMutation = null;
				notifyCodexConfigurationSyncUpdated();
				return true;
			} catch (error) {
				if (!isCurrentScope()) return;
				setError(error instanceof Error ? error.message : "profile 操作未确认，请刷新后重试。");
				void refresh();
				return false;
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
			}
		},
		[workspaceId, refresh, scope, acceptState, isCurrentScope],
	);
	const act = useCallback(
		async (
			change: CodexConfigurationChange,
			action: "synchronize" | "acknowledge" | "use_session_value" | "keep_shared_value",
			synchronizeExistingSessions = false,
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
							: await resolveCodexConfigurationConflict(workspaceId, { ...input, resolution: action });
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
					const result = await batchCodexConfigurationAction(workspaceId, { action, items });
					results.push(...result.results);
					acceptState(result.state);
					if (!isCurrentScope()) return;
				}
				setBatchResults(results);
				notifyCodexConfigurationSyncUpdated();
				return results;
			} catch {
				if (!isCurrentScope()) return;
				setError("操作回执未确认，已保留操作身份。连接恢复后可重试，已完成项不会重复执行。");
				void refresh();
			} finally {
				scope.pending = false;
				if (isCurrentScope()) setPendingChangeId(null);
			}
		},
		[workspaceId, refresh, scope, acceptState, isCurrentScope, recoveryController],
	);
	return {
		state,
		error,
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
