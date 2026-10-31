export interface AgentSessionPtyHostResponseDeadlineObservation {
	responseDeadlineMilliseconds: number;
	elapsedMilliseconds: number;
	responseDeadlineCallbackDelayMilliseconds: number;
}

export function scheduleAgentSessionPtyHostResponseDeadlineAfterPendingSocketIo(
	responseDeadlineMilliseconds: number,
	onResponseDeadlineExceeded: (observation: AgentSessionPtyHostResponseDeadlineObservation) => void,
): () => void {
	const startedAtMonotonicMilliseconds = performance.now();
	let responseDeadlineWasCancelled = false;
	let pendingSocketIoRecheck: NodeJS.Immediate | undefined;
	const responseDeadlineTimer = setTimeout(() => {
		// runtime 长阻塞后，到期计时器可能先于已就绪的 socket 回应执行；先给 I/O 一次处理机会。
		pendingSocketIoRecheck = setImmediate(() => {
			if (responseDeadlineWasCancelled) return;
			const elapsedMilliseconds = Math.round(performance.now() - startedAtMonotonicMilliseconds);
			onResponseDeadlineExceeded({
				responseDeadlineMilliseconds,
				elapsedMilliseconds,
				responseDeadlineCallbackDelayMilliseconds: Math.max(0, elapsedMilliseconds - responseDeadlineMilliseconds),
			});
		});
	}, responseDeadlineMilliseconds);
	return () => {
		responseDeadlineWasCancelled = true;
		clearTimeout(responseDeadlineTimer);
		if (pendingSocketIoRecheck) clearImmediate(pendingSocketIoRecheck);
	};
}

export function describeAgentSessionPtyHostResponseDeadlineExceeded(
	requestType: string,
	observation: AgentSessionPtyHostResponseDeadlineObservation,
): string {
	return `PTY host 请求超时：${requestType}（期限 ${observation.responseDeadlineMilliseconds}ms，实际耗时 ${observation.elapsedMilliseconds}ms，超时回调延迟 ${observation.responseDeadlineCallbackDelayMilliseconds}ms）`;
}
