import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { runCodexConfigurationSyncRequestWithinBudget } from "@/hooks/codex-configuration-source-observation-recovery";
import { fetchCodexConfigurationSyncHistory } from "@/runtime/codex-configuration-sync-query";
import type { CodexConfigurationSyncHistoryPage, CodexConfigurationSyncState } from "@/runtime/types";

export function useCodexConfigurationSyncHistory(
	workspaceId: string | null,
	enabled: boolean,
	search: string,
	category: "all" | "settings" | "sources",
	activeState: CodexConfigurationSyncState | null,
) {
	const storageIdentity = activeState?.storageIdentity;
	const projectionGeneration = activeState?.historyProjectionGeneration;
	const scope = useMemo(
		() => ({ controller: new AbortController(), pending: false }),
		[workspaceId, enabled, search, category, storageIdentity, projectionGeneration],
	);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const [result, setResult] = useState<{ scope: typeof scope; page: CodexConfigurationSyncHistoryPage } | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const resultRef = useRef(result);
	resultRef.current = result;
	const load = useCallback(
		async (append: boolean) => {
			if (!enabled || scope.pending || scope.controller.signal.aborted) return;
			scope.pending = true;
			setLoading(true);
			setError(null);
			let previous = resultRef.current?.scope === scope ? resultRef.current.page : null;
			let cursor = append ? (previous?.nextCursor ?? undefined) : undefined;
			try {
				for (let attempt = 0; attempt < 2; attempt++) {
					try {
						const page = await runCodexConfigurationSyncRequestWithinBudget(
							(signal) =>
								fetchCodexConfigurationSyncHistory(
									workspaceId,
									{ category, search, limit: 50, cursor },
									signal,
								),
							scope.controller.signal,
						);
						if (currentScope.current !== scope || scope.controller.signal.aborted) return;
						if (storageIdentity && page.storageIdentity !== storageIdentity)
							throw new Error("历史存储已变化，等待连接重新核验。");
						if (append && previous) {
							const changes = new Map(previous.changes.map((entry) => [entry.changeId, entry]));
							const observations = new Map(
								previous.sourceObservations.map((entry) => [entry.observationId, entry]),
							);
							for (const entry of page.changes)
								if ((changes.get(entry.changeId)?.version ?? -1) <= entry.version)
									changes.set(entry.changeId, entry);
							for (const entry of page.sourceObservations)
								if ((observations.get(entry.observationId)?.version ?? -1) <= entry.version)
									observations.set(entry.observationId, entry);
							setResult({
								scope,
								page: {
									...page,
									changes: [...changes.values()],
									sourceObservations: [...observations.values()],
								},
							});
						} else setResult({ scope, page });
						return;
					} catch (failure) {
						if (
							attempt === 0 &&
							cursor &&
							failure instanceof Error &&
							failure.message.includes("CODEX_CONFIGURATION_HISTORY_CURSOR_INVALIDATED")
						) {
							cursor = undefined;
							append = false;
							previous = null;
							continue;
						}
						throw failure;
					}
				}
			} catch {
				if (currentScope.current === scope && !scope.controller.signal.aborted)
					setError("历史暂不可读，请重试加载。");
			} finally {
				scope.pending = false;
				if (currentScope.current === scope) setLoading(false);
			}
		},
		[enabled, scope, workspaceId, category, search, storageIdentity],
	);
	useEffect(() => {
		scope.controller = new AbortController();
		setResult(null);
		setError(null);
		setLoading(false);
		if (enabled) void load(false);
		return () => scope.controller.abort();
	}, [scope, enabled, load]);
	const page = result?.scope === scope ? result.page : null;
	return {
		changes: page?.changes ?? [],
		sourceObservations: page?.sourceObservations ?? [],
		totalCount: page?.totalCount ?? activeState?.historyTotalCount ?? 0,
		loading,
		error,
		hasMore: Boolean(page?.nextCursor),
		hasNewHistory: Boolean(page && (activeState?.historyMaximumSequence ?? 0) > page.historyMaximumSequence),
		loadMore: () => load(true),
		refresh: () => load(false),
	};
}
