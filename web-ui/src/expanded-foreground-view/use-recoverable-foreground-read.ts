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

export function useRecoverableForegroundRead<T>({
	identity,
	read,
	enabled = true,
	refreshIntervalMs,
	initialReadDebounceMs = 0,
}: {
	identity: string;
	read: (signal: AbortSignal) => Promise<T>;
	enabled?: boolean;
	refreshIntervalMs?: number;
	initialReadDebounceMs?: number;
}) {
	const [refreshSequence, setRefreshSequence] = useState(0);
	const [result, setResult] = useState<{ identity: string; value: T | null; error: string | null; loading: boolean }>({
		identity,
		value: null,
		error: null,
		loading: enabled,
	});
	const loadingRef = useRef(false);
	const refresh = useCallback(() => setRefreshSequence((current) => current + 1), []);
	useEffect(() => {
		if (!enabled) return;
		const abort = new AbortController();
		let pendingRetry: ReturnType<typeof setTimeout> | undefined;
		let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
		loadingRef.current = true;
		setResult((current) => ({
			identity,
			value: current.identity === identity ? current.value : null,
			error: null,
			loading: true,
		}));
		const attempt = async (attemptNumber: number) => {
			const requestAbort = new AbortController();
			const cancelRequest = () => requestAbort.abort();
			abort.signal.addEventListener("abort", cancelRequest, { once: true });
			pendingTimeout = setTimeout(cancelRequest, 8_000);
			try {
				const value = await read(requestAbort.signal);
				if (abort.signal.aborted) return;
				setResult({ identity, value, error: null, loading: false });
				loadingRef.current = false;
			} catch (error) {
				if (abort.signal.aborted) return;
				if (attemptNumber < 2 && isTransientForegroundReadFailure(error)) {
					pendingRetry = setTimeout(() => void attempt(attemptNumber + 1), attemptNumber === 0 ? 400 : 1_200);
				} else {
					setResult((current) => ({
						...current,
						error: error instanceof Error ? error.message : String(error),
						loading: false,
					}));
					loadingRef.current = false;
				}
			} finally {
				clearTimeout(pendingTimeout);
				abort.signal.removeEventListener("abort", cancelRequest);
			}
		};
		// 归属切换和旧请求取消仍立即生效，只将首次读取推迟到输入安静窗口后。
		const pendingInitialRead =
			initialReadDebounceMs > 0 ? setTimeout(() => void attempt(0), initialReadDebounceMs) : undefined;
		if (initialReadDebounceMs <= 0) void attempt(0);
		return () => {
			abort.abort();
			clearTimeout(pendingInitialRead);
			clearTimeout(pendingRetry);
			clearTimeout(pendingTimeout);
			loadingRef.current = false;
		};
	}, [identity, read, enabled, refreshSequence, initialReadDebounceMs]);
	useEffect(() => {
		if (!enabled) return;
		const refreshWhenVisible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("online", refreshWhenVisible);
		document.addEventListener("visibilitychange", refreshWhenVisible);
		const unsubscribe = subscribeToTaskVisualizationBrowserEvents((message) => {
			if (message.type === "stream_reconnected") refreshWhenVisible();
		});
		const interval = refreshIntervalMs
			? setInterval(() => {
					if (!loadingRef.current) refreshWhenVisible();
				}, refreshIntervalMs)
			: undefined;
		return () => {
			window.removeEventListener("online", refreshWhenVisible);
			document.removeEventListener("visibilitychange", refreshWhenVisible);
			unsubscribe();
			clearInterval(interval);
		};
	}, [enabled, refresh, refreshIntervalMs]);
	return {
		...(result.identity === identity ? result : { identity, value: null, error: null, loading: enabled }),
		refresh,
	};
}
