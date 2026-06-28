import { describe, expect, it, vi } from "vitest";
import { deliverHookIngestWithRetry } from "../../../src/commands/hooks";
import type { RuntimeHookIngestResponse } from "../../../src/core/api-contract";

// F2 有界重试核心的行为锁测。用永不 resolve 的 mutate + 极小 timeoutMs 模拟「传输层超时」，
// 用立即 resolve 的 mutate 模拟「业务结果」。backoffMs=0 保持测试快。
const FAST_OPTIONS = { timeoutMs: 5, maxAttempts: 2, backoffMs: 0 } as const;

function neverResolves(): Promise<RuntimeHookIngestResponse> {
	return new Promise<RuntimeHookIngestResponse>(() => {
		// 永不 resolve → withTimeout 在 timeoutMs 后 reject（模拟传输层超时）。
	});
}

describe("deliverHookIngestWithRetry", () => {
	it("retries transport timeouts up to maxAttempts, then reports a single transport final failure", async () => {
		const mutate = vi.fn(neverResolves);
		const onFinalFailure = vi.fn();

		await expect(deliverHookIngestWithRetry(mutate, { ...FAST_OPTIONS, onFinalFailure })).rejects.toThrow(
			/timed out/,
		);

		expect(mutate).toHaveBeenCalledTimes(2);
		expect(onFinalFailure).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, failureKind: "transport" }));
	});

	it("succeeds on a retry after a transient transport timeout (no final failure recorded)", async () => {
		let attempt = 0;
		const mutate = vi.fn((): Promise<RuntimeHookIngestResponse> => {
			attempt += 1;
			return attempt === 1 ? neverResolves() : Promise.resolve({ ok: true });
		});
		const onFinalFailure = vi.fn();

		await expect(deliverHookIngestWithRetry(mutate, { ...FAST_OPTIONS, onFinalFailure })).resolves.toBeUndefined();

		expect(mutate).toHaveBeenCalledTimes(2);
		expect(onFinalFailure).not.toHaveBeenCalled();
	});

	it("does NOT retry a business {ok:false} rejection — throws immediately and reports it as rejected", async () => {
		const mutate = vi.fn(
			(): Promise<RuntimeHookIngestResponse> => Promise.resolve({ ok: false, error: "Workspace not found" }),
		);
		const onFinalFailure = vi.fn();

		await expect(deliverHookIngestWithRetry(mutate, { ...FAST_OPTIONS, onFinalFailure })).rejects.toThrow(
			"Workspace not found",
		);

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, failureKind: "rejected" }));
	});

	it("returns on first-try success without invoking the final-failure callback", async () => {
		const mutate = vi.fn((): Promise<RuntimeHookIngestResponse> => Promise.resolve({ ok: true }));
		const onFinalFailure = vi.fn();

		await expect(deliverHookIngestWithRetry(mutate, { ...FAST_OPTIONS, onFinalFailure })).resolves.toBeUndefined();

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(onFinalFailure).not.toHaveBeenCalled();
	});
});
