import { useCallback, useEffect, useRef } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskWorktreeMode,
	RuntimeWorkspaceChangesMode,
	RuntimeWorkspaceChangesResponse,
} from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

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

// 只比较驱动渲染的 files 内容（忽略每次轮询都变的 generatedAt），内容相同则让 useTrpcQuery 保留旧引用。
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
	const previousRequestKeyRef = useRef(requestKey);
	const isRequestTransitioning = hasWorkspaceScope && previousRequestKeyRef.current !== requestKey;
	const queryFn = useCallback(async () => {
		if (!taskId || !workspaceId || !baseRef) {
			throw new Error("Missing workspace scope.");
		}
		void normalizedViewKey;
		const trpcClient = getRuntimeTrpcClient(workspaceId);
		return await trpcClient.workspace.getChanges.query({
			taskId,
			baseRef,
			...(worktreeMode ? { worktreeMode } : {}),
			mode,
		});
	}, [baseRef, mode, normalizedViewKey, taskId, workspaceId, worktreeMode]);
	const changesQuery = useTrpcQuery<RuntimeWorkspaceChangesResponse>({
		enabled: hasWorkspaceScope,
		queryFn,
		retainDataOnError: true,
		retainErrorDuringRefetch: true,
		isDataEqual: areWorkspaceChangesEqual,
	});

	const refresh = useCallback(async () => {
		if (!hasWorkspaceScope) {
			return;
		}
		await changesQuery.refetch();
	}, [changesQuery.refetch, hasWorkspaceScope]);
	const previousStateVersionRef = useRef(stateVersion);

	useEffect(() => {
		if (!isRequestTransitioning) {
			return;
		}
		previousRequestKeyRef.current = requestKey;
		if (clearOnViewTransition) {
			changesQuery.setData(null);
			changesQuery.clearQueryError();
		}
	}, [changesQuery.clearQueryError, changesQuery.setData, clearOnViewTransition, isRequestTransitioning, requestKey]);

	useEffect(() => {
		if (!hasWorkspaceScope) {
			previousRequestKeyRef.current = requestKey;
			previousStateVersionRef.current = stateVersion;
			return;
		}
		if (previousStateVersionRef.current === stateVersion) {
			return;
		}
		previousStateVersionRef.current = stateVersion;
		void changesQuery.refetch();
	}, [changesQuery.refetch, hasWorkspaceScope, requestKey, stateVersion]);

	useEffect(() => {
		if (!hasWorkspaceScope || pollIntervalMs == null) {
			return;
		}
		let cancelled = false;
		let nextPollTimer: number | null = null;
		const scheduleNextPoll = () => {
			nextPollTimer = window.setTimeout(() => {
				void changesQuery.refetch().finally(() => {
					if (!cancelled) {
						scheduleNextPoll();
					}
				});
			}, pollIntervalMs);
		};
		scheduleNextPoll();
		return () => {
			cancelled = true;
			if (nextPollTimer !== null) {
				window.clearTimeout(nextPollTimer);
			}
		};
	}, [changesQuery.refetch, hasWorkspaceScope, pollIntervalMs]);

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

	const shouldHideDuringTransition = clearOnViewTransition && isRequestTransitioning;
	const visibleChanges = shouldHideDuringTransition ? null : changesQuery.data;
	const visibleError = shouldHideDuringTransition ? null : changesQuery.error;
	const isRequestInFlight = shouldHideDuringTransition || changesQuery.isLoading;
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
