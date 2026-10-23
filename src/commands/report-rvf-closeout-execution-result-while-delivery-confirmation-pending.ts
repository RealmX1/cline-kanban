import { TRPCClientError } from "@trpc/client";

export async function reportRvfCloseoutExecutionResultWhileDeliveryConfirmationPending<Result>(
	report: () => Promise<Result>,
	dependencies = {
		now: Date.now,
		sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
	},
): Promise<Result> {
	const deadline = dependencies.now() + 30_000;
	while (true) {
		try {
			return await report();
		} catch (error) {
			// 只重试服务端明确的“等待投递确认”；失败、撤销和证据不符仍直接返回。
			if (
				!(error instanceof TRPCClientError) ||
				error.data?.code !== "PRECONDITION_FAILED" ||
				dependencies.now() >= deadline
			)
				throw error;
			await dependencies.sleep(250);
		}
	}
}
