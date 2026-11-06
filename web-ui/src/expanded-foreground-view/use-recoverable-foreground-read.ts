import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeToTaskVisualizationBrowserEvents } from "@/stores/task-visualization-browser-bridge";

export function isTransientForegroundReadFailure(error: unknown): boolean {
	const code =
		error &&
		typeof error === "object" &&
		"data" in error &&
		error.data &&
		typeof error.data === "object" &&
		"code" in error.data
			? error.data.code
			: null;
	return !["NOT_FOUND", "BAD_REQUEST", "CONFLICT", "FORBIDDEN", "UNAUTHORIZED", "METHOD_NOT_SUPPORTED"].includes(
		String(code),
	);
}

async function readWithForegroundDeadline<T>(read: (signal: AbortSignal) => Promise<T>, owner: AbortSignal) {
	const request = new AbortController();
	const cancelRequest = () => request.abort(owner.reason);
	owner.addEventListener("abort", cancelRequest, { once: true });
	const deadline = setTimeout(() => request.abort(new Error("读取超时，请在运行时恢复后重试。")), 8_000);
	let rejectCancelledRead: () => void = () => undefined;
	try {
		// 即使读取方忽略 AbortSignal，也结束本次等待；迟到结果不能重新进入当前视图。
		return await Promise.race([
			new Promise<never>((_, reject) => {
				rejectCancelledRead = () => reject(request.signal.reason);
				request.signal.addEventListener("abort", rejectCancelledRead, { once: true });
			}),
			read(request.signal),
		]);
	} finally {
		clearTimeout(deadline);
		owner.removeEventListener("abort", cancelRequest);
		request.signal.removeEventListener("abort", rejectCancelledRead);
	}
}

export function useRecoverableForegroundRead<T>({
	identity,
	read,
	enabled = true,
	refreshIntervalMs,
	initialReadDebounceMs = 0,
	retainErrorDuringRefetch = false,
	retainedValueScopeIdentity,
	isDataEqual,
	workspaceId,
}: {
	identity: string;
	read: (signal: AbortSignal) => Promise<T>;
	enabled?: boolean;
	refreshIntervalMs?: number;
	initialReadDebounceMs?: number;
	retainErrorDuringRefetch?: boolean;
	retainedValueScopeIdentity?: string;
	isDataEqual?: (previous: T, next: T) => boolean;
	workspaceId?: string;
}) {
	const [result, setResult] = useState<{
		identity: string;
		retainedValueScopeIdentity?: string;
		value: T | null;
		error: string | null;
		failure: Error | null;
		loading: boolean;
		retryBudgetExhausted: boolean;
	}>({
		identity,
		retainedValueScopeIdentity,
		value: null,
		error: null,
		failure: null,
		loading: enabled,
		retryBudgetExhausted: false,
	});
	const requestRefreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
	const refresh = useCallback(() => requestRefreshRef.current(), []);
	useEffect(() => {
		if (!enabled) return;
		const owner = new AbortController();
		let pendingTimer: ReturnType<typeof setTimeout> | undefined;
		let runningRead: Promise<void> | null = null;
		let refreshRequestedDuringRead = false;
		const markReading = () =>
			setResult((current) => {
				const retain =
					current.identity === identity ||
					(retainedValueScopeIdentity !== undefined &&
						current.retainedValueScopeIdentity === retainedValueScopeIdentity);
				return {
					identity,
					retainedValueScopeIdentity,
					value: retain ? current.value : null,
					error: retain && retainErrorDuringRefetch ? current.error : null,
					failure: retain && retainErrorDuringRefetch ? current.failure : null,
					loading: true,
					retryBudgetExhausted: false,
				};
			});
		const attempt = async (attemptNumber: number): Promise<boolean> => {
			markReading();
			try {
				const value = await readWithForegroundDeadline(read, owner.signal);
				if (owner.signal.aborted) return false;
				setResult((current) => ({
					identity,
					retainedValueScopeIdentity,
					value: current.value !== null && isDataEqual?.(current.value, value) ? current.value : value,
					error: null,
					failure: null,
					loading: false,
					retryBudgetExhausted: false,
				}));
				return true;
			} catch (error) {
				if (owner.signal.aborted) return false;
				const failure = error instanceof Error ? error : new Error(String(error));
				const willRetry = attemptNumber < 2 && isTransientForegroundReadFailure(error);
				if (retainErrorDuringRefetch || !willRetry) {
					setResult((current) => ({
						...current,
						error: failure.message,
						failure,
						loading: false,
						retryBudgetExhausted: !willRetry,
					}));
				}
				if (!willRetry) return false;
				await new Promise<void>((resolve) => {
					const finishWait = () => {
						clearTimeout(pendingTimer);
						owner.signal.removeEventListener("abort", finishWait);
						resolve();
					};
					owner.signal.addEventListener("abort", finishWait, { once: true });
					pendingTimer = setTimeout(finishWait, attemptNumber === 0 ? 400 : 1_200);
				});
				return owner.signal.aborted ? false : await attempt(attemptNumber + 1);
			}
		};
		const requestRefresh = (): Promise<void> => {
			if (owner.signal.aborted) return Promise.resolve();
			if (runningRead) {
				refreshRequestedDuringRead = true;
				return runningRead;
			}
			clearTimeout(pendingTimer);
			runningRead = (async () => {
				let succeeded: boolean;
				do {
					refreshRequestedDuringRead = false;
					succeeded = await attempt(0);
				} while (succeeded && refreshRequestedDuringRead && !owner.signal.aborted);
				runningRead = null;
				// 耗尽预算后等待显式恢复事件；轮询不能悄悄开启无界重试。
				if (succeeded && refreshIntervalMs && !owner.signal.aborted) {
					pendingTimer = setTimeout(refreshWhenVisible, refreshIntervalMs);
				}
			})();
			return runningRead;
		};
		const refreshWhenVisible = () => {
			if (document.visibilityState === "visible") void requestRefresh();
		};
		requestRefreshRef.current = requestRefresh;
		window.addEventListener("online", refreshWhenVisible);
		document.addEventListener("visibilitychange", refreshWhenVisible);
		const unsubscribe = subscribeToTaskVisualizationBrowserEvents((message) => {
			if (message.type === "stream_reconnected" && (!workspaceId || workspaceId === message.workspaceId)) {
				refreshWhenVisible();
			}
		});
		markReading();
		if (initialReadDebounceMs > 0) pendingTimer = setTimeout(() => void requestRefresh(), initialReadDebounceMs);
		else void requestRefresh();
		return () => {
			requestRefreshRef.current = () => Promise.resolve();
			owner.abort();
			clearTimeout(pendingTimer);
			window.removeEventListener("online", refreshWhenVisible);
			document.removeEventListener("visibilitychange", refreshWhenVisible);
			unsubscribe();
		};
	}, [
		identity,
		read,
		enabled,
		initialReadDebounceMs,
		refreshIntervalMs,
		retainErrorDuringRefetch,
		retainedValueScopeIdentity,
		isDataEqual,
		workspaceId,
	]);
	const visibleResult =
		result.identity === identity ||
		(retainedValueScopeIdentity !== undefined && result.retainedValueScopeIdentity === retainedValueScopeIdentity)
			? result
			: { identity, value: null, error: null, failure: null, loading: enabled, retryBudgetExhausted: false };
	return { ...visibleResult, loading: enabled && visibleResult.loading, refresh };
}
