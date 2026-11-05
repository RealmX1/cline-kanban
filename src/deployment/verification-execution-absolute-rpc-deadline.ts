// 绝对截止覆盖启动、I/O、观察和结果应用；超界只交回已知恢复快照，后台工作仍受持久身份及 deadline 门禁。
export async function waitWithinVerificationExecutionAbsoluteRpcDeadline<TResult>(input: {
	deadlineAtEpochMs: number;
	operation: Promise<TResult>;
	recoverySnapshot: () => TResult;
}): Promise<TResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			input.operation,
			new Promise<TResult>((resolve) => {
				timeout = setTimeout(
					() => resolve(input.recoverySnapshot()),
					Math.max(0, input.deadlineAtEpochMs + 5_000 - Date.now()),
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
