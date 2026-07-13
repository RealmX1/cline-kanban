import { useCallback, useEffect, useRef, useState } from "react";

interface UseTrpcQueryOptions<TData> {
	enabled: boolean;
	queryFn: () => Promise<TData>;
	retainDataOnError?: boolean;
	/**
	 * 当新结果与当前 data 语义相等时返回 true：此时保留旧引用、跳过 setData，
	 * 避免轮询在内容未变时空转触发下游 memo 重算与整棵 re-render（大 diff 每秒轮询的主要开销）。
	 */
	isDataEqual?: (previous: TData, next: TData) => boolean;
}

export interface UseTrpcQueryResult<TData> {
	data: TData | null;
	isLoading: boolean;
	isError: boolean;
	error: Error | null;
	refetch: () => Promise<TData | null>;
	setData: (nextData: TData | null) => void;
}

function toError(value: unknown): Error {
	if (value instanceof Error) {
		return value;
	}
	return new Error(String(value));
}

// We intentionally use this small hook instead of @trpc/react-query.
// This app talks to a local runtime process, so persistent query caching is not a priority.
// What we still need is safe async lifecycle plumbing: loading and error state,
// request race protection when inputs change, and unmount safety so stale responses
// do not overwrite newer state. This hook provides that minimal behavior with no cache layer.
export function useTrpcQuery<TData>(options: UseTrpcQueryOptions<TData>): UseTrpcQueryResult<TData> {
	const { enabled, queryFn, retainDataOnError = false, isDataEqual } = options;
	const [data, setDataState] = useState<TData | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isError, setIsError] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const requestIdRef = useRef(0);
	const isMountedRef = useRef(true);
	// 与 data 同步的引用镜像，供 runQuery 在不把 data 列入依赖（否则每次结果都会重建 queryFn）的前提下读取当前值做去重。
	const dataRef = useRef<TData | null>(null);
	const setData = useCallback((nextData: TData | null) => {
		dataRef.current = nextData;
		setDataState(nextData);
	}, []);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const runQuery = useCallback(async (): Promise<TData | null> => {
		if (!enabled) {
			setIsLoading(false);
			setIsError(false);
			setError(null);
			return null;
		}
		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		setIsLoading(true);
		setIsError(false);
		setError(null);
		try {
			const nextData = await queryFn();
			if (!isMountedRef.current || requestIdRef.current !== requestId) {
				return null;
			}
			const previousData = dataRef.current;
			if (previousData != null && isDataEqual?.(previousData, nextData)) {
				// 内容语义未变：保留旧引用，不触发下游 re-render。
				setIsLoading(false);
				return previousData;
			}
			setData(nextData);
			setIsLoading(false);
			return nextData;
		} catch (queryError) {
			if (!isMountedRef.current || requestIdRef.current !== requestId) {
				return null;
			}
			if (!retainDataOnError) {
				setData(null);
			}
			setIsLoading(false);
			setIsError(true);
			setError(toError(queryError));
			return null;
		}
	}, [enabled, isDataEqual, queryFn, retainDataOnError, setData]);

	useEffect(() => {
		if (!enabled) {
			requestIdRef.current += 1;
			setIsLoading(false);
			return;
		}
		void runQuery();
	}, [enabled, runQuery]);

	const refetch = useCallback(async () => await runQuery(), [runQuery]);

	return {
		data,
		isLoading,
		isError,
		error,
		refetch,
		setData,
	};
}
