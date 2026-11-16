import { useCallback, useEffect, useRef } from "react";
import { useRecoverableForegroundRead } from "@/expanded-foreground-view/use-recoverable-foreground-read";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceChangesResponse,
} from "@/runtime/types";

export type RuntimeWorkspaceChangesQueryPhase =
	| "disabled"
	| "missing_workspace_scope"
	| "initial_loading"
	| "initial_error"
	| "ready"
	| "refreshing"
	| "stale_after_refresh_error";

export interface UseRuntimeWorkspaceChangesResult {
	changes: RuntimeWorkspaceChangesResponse | null;
	error: Error | null;
	queryPhase: RuntimeWorkspaceChangesQueryPhase;
	isRequestInFlight: boolean;
	refresh: () => Promise<void>;
}

// 只比较驱动渲染的 files 内容（忽略每次轮询都变的 generatedAt），内容相同则保留旧引用。
// files 由后端按 path 排序，顺序稳定，可按下标逐项比对。
// ponytail: oldText/newText 用 === 全串比较，最坏 O(payload 字节)/轮询——但仅在长度相等时才逐字节，
// 且远比它省下的整面板 re-render + Prism 重算便宜；瓶颈化再考虑后端下发内容指纹。
function areWorkspaceChangesEqual(
	previous: RuntimeWorkspaceChangesResponse,
	next: RuntimeWorkspaceChangesResponse,
): boolean {
	if (previous.files.length !== next.files.length) {
		return false;
	}
	for (let index = 0; index < previous.files.length; index += 1) {
		const previousFile = previous.files[index];
		const nextFile = next.files[index];
		if (
			previousFile === undefined ||
			nextFile === undefined ||
			previousFile.path !== nextFile.path ||
			previousFile.previousPath !== nextFile.previousPath ||
			previousFile.status !== nextFile.status ||
			previousFile.additions !== nextFile.additions ||
			previousFile.deletions !== nextFile.deletions ||
			previousFile.contentOmittedForSize !== nextFile.contentOmittedForSize ||
			previousFile.oldText !== nextFile.oldText ||
			previousFile.newText !== nextFile.newText
		) {
			return false;
		}
	}
	return true;
}

export function useRuntimeWorkspaceChanges(
	taskId: string | null,
	workspaceId: string | null,
	baseRef: string | null,
	worktreeMode: RuntimeTaskWorktreeMode | null = null,
	mode: RuntimeWorkspaceChangesMode = "working_copy",
	stateVersion = 0,
	pollIntervalMs: number | null = null,
	viewKey: string | null = null,
	clearOnViewTransition = true,
): UseRuntimeWorkspaceChangesResult {
	const hasWorkspaceScope = taskId !== null && workspaceId !== null && baseRef !== null;
	const normalizedViewKey = viewKey ?? "__default__";
	const requestKey = `${workspaceId ?? "__none__"}:${taskId ?? "__none__"}:${baseRef ?? "__none__"}:${worktreeMode ?? "branch"}:${mode}:${normalizedViewKey}`;
	const conditionalChangesCacheRef = useRef<{
		identity: string;
		contentVersion: string;
		changes: RuntimeWorkspaceChangesResponse;
	} | null>(null);
	const queryFn = useCallback(
		async (signal: AbortSignal) => {
			if (!taskId || !workspaceId || !baseRef) {
				throw new Error("Missing workspace scope.");
			}
			void normalizedViewKey;
			const trpcClient = getRuntimeTrpcClient(workspaceId);
			const identity = JSON.stringify([workspaceId, taskId, baseRef, worktreeMode, mode, normalizedViewKey]);
			const cached =
				conditionalChangesCacheRef.current?.identity === identity ? conditionalChangesCacheRef.current : null;
			const response = await trpcClient.workspace.getChangesConditional.query(
				{
					taskId,
					baseRef,
					...(worktreeMode ? { worktreeMode } : {}),
					mode,
					...(cached ? { knownContentVersion: cached.contentVersion } : {}),
				},
				{ signal, context: { sendAsIndependentHttpRequest: true } },
			);
			if (signal.aborted) throw new DOMException("查询已取消", "AbortError");
			if (response.status === "changed") {
				conditionalChangesCacheRef.current = {
					identity,
					contentVersion: response.contentVersion,
					changes: response.changes,
				};
				return response.changes;
			}
			if (!cached || cached.contentVersion !== response.contentVersion)
				throw new Error("diff 缓存缺失，将自动重新读取");
			return cached.changes;
		},
		[baseRef, mode, normalizedViewKey, taskId, workspaceId, worktreeMode],
	);
	const changesQuery = useRecoverableForegroundRead<RuntimeWorkspaceChangesResponse>({
		identity: requestKey,
		enabled: hasWorkspaceScope,
		read: queryFn,
		retainErrorDuringRefetch: true,
		isDataEqual: areWorkspaceChangesEqual,
		retainedValueScopeIdentity: clearOnViewTransition
			? undefined
			: JSON.stringify([workspaceId, taskId, baseRef, worktreeMode, mode]),
		refreshIntervalMs: pollIntervalMs ?? undefined,
		workspaceId: workspaceId ?? undefined,
		pauseWhileDocumentHidden: true,
	});
	const refresh = changesQuery.refresh;
	const previousStateVersionRef = useRef(stateVersion);
	useEffect(() => {
		const changed = previousStateVersionRef.current !== stateVersion;
		previousStateVersionRef.current = stateVersion;
		if (hasWorkspaceScope && changed && !changesQuery.retryBudgetExhausted) void refresh();
	}, [hasWorkspaceScope, refresh, stateVersion, changesQuery.retryBudgetExhausted]);

	if (!taskId) {
		return {
			changes: null,
			error: null,
			queryPhase: "disabled",
			isRequestInFlight: false,
			refresh,
		};
	}

	if (!workspaceId || !baseRef) {
		return {
			changes: null,
			error: null,
			queryPhase: "missing_workspace_scope",
			isRequestInFlight: false,
			refresh,
		};
	}

	const visibleChanges = changesQuery.value;
	const visibleError = changesQuery.failure;
	const isRequestInFlight = changesQuery.loading;
	const queryPhase: RuntimeWorkspaceChangesQueryPhase =
		visibleChanges !== null
			? visibleError
				? "stale_after_refresh_error"
				: isRequestInFlight
					? "refreshing"
					: "ready"
			: visibleError
				? "initial_error"
				: "initial_loading";

	return {
		changes: visibleChanges,
		error: visibleError,
		queryPhase,
		isRequestInFlight,
		refresh,
	};
}
