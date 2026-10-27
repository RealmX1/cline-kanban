import { useCallback, useEffect, useRef, useState } from "react";
import {
	acknowledgeCodexConfigurationChange,
	batchCodexConfigurationAction,
	fetchCodexConfigurationSyncState,
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
	CodexConfigurationPropagationTarget,
	CodexConfigurationSyncState,
} from "@/runtime/types";

export function useCodexConfigurationSync(workspaceId: string | null, enabled = true) {
	const [state, setState] = useState<CodexConfigurationSyncState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pendingChangeId, setPendingChangeId] = useState<string | null>(null);
	const pending = useRef(false);
	const [batchResults, setBatchResults] = useState<CodexConfigurationBatchActionResult["results"]>([]);
	const operationIdentities = useRef(new Map<string, string>());
	const refreshSequence = useRef(0);
	const refresh = useCallback(async () => {
		const sequence = ++refreshSequence.current;
		try {
			const next = await fetchCodexConfigurationSyncState(workspaceId);
			if (sequence === refreshSequence.current) {
				setState(next);
				setError((current) => (current?.startsWith("暂时无法读取") ? null : current));
			}
		} catch {
			if (sequence === refreshSequence.current) setError("暂时无法读取 Codex 配置同步状态，连接恢复后自动重试。");
		}
	}, [workspaceId]);
	useEffect(() => {
		if (!enabled) return;
		void refresh();
		const unsubscribe = subscribeCodexConfigurationSyncUpdated(() => {
			void refresh();
		});
		return () => {
			unsubscribe();
			refreshSequence.current++;
		};
	}, [enabled, refresh]);
	const act = useCallback(
		async (
			change: CodexConfigurationChange,
			action: "synchronize" | "acknowledge" | "use_session_value" | "keep_shared_value",
			synchronizeExistingSessions = false,
		) => {
			if (pending.current) return;
			pending.current = true;
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
				setState(next);
				notifyCodexConfigurationSyncUpdated();
			} catch {
				setError("操作未确认。请检查最新版本与目标状态后重试，原决定已保留。");
				void refresh();
			} finally {
				pending.current = false;
				setPendingChangeId(null);
			}
		},
		[workspaceId, refresh],
	);
	const resolveTarget = useCallback(
		async (
			change: CodexConfigurationChange,
			target: CodexConfigurationPropagationTarget,
			resolution: "use_source_change" | "keep_target_value",
		) => {
			if (pending.current || !target.conflictingTargetValueDigest) return;
			pending.current = true;
			setPendingChangeId(change.changeId);
			setError(null);
			try {
				setState(
					await resolveCodexConfigurationTargetConflict(workspaceId, {
						changeId: change.changeId,
						expectedVersion: change.version,
						idempotencyKey: crypto.randomUUID(),
						targetWriterId: target.writerId,
						expectedTargetValueDigest: target.conflictingTargetValueDigest,
						resolution,
					}),
				);
				notifyCodexConfigurationSyncUpdated();
			} catch {
				setError("目标冲突版本已变化或操作未确认，双方决定已保留。");
				void refresh();
			} finally {
				pending.current = false;
				setPendingChangeId(null);
			}
		},
		[workspaceId, refresh],
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
			if (pending.current || !entries.length) return;
			pending.current = true;
			setPendingChangeId(entries.length === 1 ? entries[0]!.changeId : "batch");
			setError(null);
			const results: CodexConfigurationBatchActionResult["results"] = [];
			try {
				for (let offset = 0; offset < entries.length; offset += 200) {
					const items = entries.slice(offset, offset + 200).map((entry) => {
						const identity = JSON.stringify([action, entry]);
						let idempotencyKey = operationIdentities.current.get(identity);
						if (!idempotencyKey) {
							idempotencyKey = crypto.randomUUID();
							operationIdentities.current.set(identity, idempotencyKey);
						}
						return { ...entry, idempotencyKey };
					});
					const result = await batchCodexConfigurationAction(workspaceId, { action, items });
					results.push(...result.results);
					setState(result.state);
				}
				setBatchResults(results);
				notifyCodexConfigurationSyncUpdated();
				return results;
			} catch {
				setError("操作回执未确认，已保留操作身份。连接恢复后可重试，已完成项不会重复执行。");
				void refresh();
			} finally {
				pending.current = false;
				setPendingChangeId(null);
			}
		},
		[workspaceId, refresh],
	);
	return { state, error, pendingChangeId, act, resolveTarget, refresh, batch, batchResults };
}
