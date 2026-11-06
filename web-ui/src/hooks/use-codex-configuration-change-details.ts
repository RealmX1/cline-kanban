import { useEffect, useState } from "react";
import { runCodexConfigurationSyncRequestWithinBudget } from "@/hooks/codex-configuration-source-observation-recovery";
import {
	fetchCodexConfigurationChangeDetails,
	subscribeCodexConfigurationSyncUpdated,
} from "@/runtime/codex-configuration-sync-query";
import type { CodexConfigurationChange, CodexConfigurationChangeDetails } from "@/runtime/types";

export function useCodexConfigurationChangeDetails(
	workspaceId: string | null,
	change: CodexConfigurationChange,
	targetWriterId?: string,
) {
	const [expanded, setExpanded] = useState(false);
	const [retryGeneration, setRetryGeneration] = useState(0);
	const preview = targetWriterId ? change.targetComparisons?.[targetWriterId] : change.comparison;
	const identity = JSON.stringify([
		workspaceId,
		change.changeId,
		change.version,
		targetWriterId,
		preview?.expectedSharedValueDigest,
		preview?.expectedTargetValueDigest,
		change.sourceEvidence,
		preview?.targetSourceEvidence,
		(preview?.rows ?? []).map((row) => [
			row.sharedOrigin?.sourceEvidence,
			row.sharedAtConflictOrigin?.sourceEvidence,
		]),
	]);
	const [result, setResult] = useState<{
		identity: string;
		details?: CodexConfigurationChangeDetails;
		error?: string;
	} | null>(null);
	useEffect(() => {
		if (!expanded) return;
		const controller = new AbortController();
		let active = true;
		setResult(null);
		void runCodexConfigurationSyncRequestWithinBudget(
			(signal) =>
				fetchCodexConfigurationChangeDetails(
					workspaceId,
					{
						changeId: change.changeId,
						expectedVersion: change.version,
						includePropagationHistory: true,
						...(targetWriterId ? { targetWriterId } : {}),
					},
					signal,
				),
			controller.signal,
		).then(
			(details) => {
				if (active) setResult({ identity, details });
			},
			(error: unknown) => {
				if (active) setResult({ identity, error: error instanceof Error ? error.message : "完整比较暂不可读。" });
			},
		);
		return () => {
			active = false;
			controller.abort();
		};
	}, [identity, expanded, retryGeneration, workspaceId, change.changeId, change.version, targetWriterId]);
	useEffect(() => {
		if (!expanded || !result?.error) return;
		const retry = () => setRetryGeneration((value) => value + 1);
		const visible = () => {
			if (document.visibilityState === "visible") retry();
		};
		window.addEventListener("online", retry);
		document.addEventListener("visibilitychange", visible);
		const unsubscribe = subscribeCodexConfigurationSyncUpdated((reason) => {
			if (reason === "runtime_reconnected") retry();
		});
		return () => {
			window.removeEventListener("online", retry);
			document.removeEventListener("visibilitychange", visible);
			unsubscribe();
		};
	}, [expanded, result?.error]);
	const currentResult = expanded && result?.identity === identity ? result : null;
	return {
		expanded,
		setExpanded,
		comparison: currentResult?.details ?? preview,
		propagationTargets: currentResult?.details?.propagationTargets,
		sourceEvidence: currentResult?.details?.sourceEvidence ?? change.sourceEvidence,
		loading: expanded && !currentResult,
		error: currentResult?.error,
		retry: () => setRetryGeneration((value) => value + 1),
	};
}
