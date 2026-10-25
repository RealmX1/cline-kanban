// 卡片副本共用同一个只读缓存；过期重读与显式重试都复用同键在途请求。
export function createTaskRelatedPreviewReadCache(now: () => number = Date.now) {
	const values = new Map<string, { value: unknown; loadedAt: number }>();
	const inFlight = new Map<string, Promise<unknown>>();
	const lastFreshnessTokenByKey = new Map<string, string>();
	return {
		invalidateIfFreshnessTokenChanged(key: string, token: string): void {
			if (lastFreshnessTokenByKey.get(key) === token) return;
			lastFreshnessTokenByKey.delete(key);
			lastFreshnessTokenByKey.set(key, token);
			values.delete(key);
			inFlight.delete(key);
			while (lastFreshnessTokenByKey.size > 100) {
				const oldestKey = lastFreshnessTokenByKey.keys().next().value;
				if (oldestKey !== undefined) lastFreshnessTokenByKey.delete(oldestKey);
			}
		},
		async read<T>(key: string, load: () => Promise<T>, forceReload = false): Promise<T> {
			const pending = inFlight.get(key);
			if (pending) return pending as Promise<T>;
			const cached = values.get(key);
			if (!forceReload && cached && now() - cached.loadedAt < 30_000) {
				values.delete(key);
				values.set(key, cached);
				return cached.value as T;
			}
			const request = load()
				.then((value) => {
					// 动作后的新读取已经接管这个键时，旧请求仍可结算原调用方，但不能回灌共享缓存。
					if (inFlight.get(key) !== request) return value;
					values.delete(key);
					values.set(key, { value, loadedAt: now() });
					while (values.size > 100) {
						const oldestKey = values.keys().next().value;
						if (oldestKey !== undefined) values.delete(oldestKey);
					}
					return value;
				})
				.finally(() => {
					if (inFlight.get(key) === request) inFlight.delete(key);
				});
			inFlight.set(key, request);
			return request;
		},
	};
}
