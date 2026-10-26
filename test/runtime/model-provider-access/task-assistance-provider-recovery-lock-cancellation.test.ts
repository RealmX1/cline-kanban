import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { type LockRequest, lockedFileSystem } from "../../../src/fs/locked-file-system";
import { requestTaskAssistanceJsonObject } from "../../../src/model-provider-access/task-assistance-model-provider-routing";
import { createTempDir } from "../../utilities/temp-dir";

afterEach(() => {
	vi.restoreAllMocks();
});

function createRecoveryLockCancellationSynchronizationBarrier() {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const testCases = (["completed", "unavailable"] as const).flatMap((providerOutcome) =>
	[false, true].flatMap((hasPreviousRecoveryState) =>
		[false, true].map((hasFallbackProvider) => ({ providerOutcome, hasPreviousRecoveryState, hasFallbackProvider })),
	),
);

it.each(testCases)(
	"锁等待取消保持 execution_cancelled 且不改恢复状态：$providerOutcome，已有状态 $hasPreviousRecoveryState，备用 $hasFallbackProvider",
	async ({ providerOutcome, hasPreviousRecoveryState, hasFallbackProvider }) => {
		const directory = createTempDir("task-assistance-recovery-lock-cancellation-");
		const recoveryPath = join(directory.path, "provider-recovery-state.json");
		const controller = new AbortController();
		const heldRecoveryFileLock = createRecoveryLockCancellationSynchronizationBarrier();
		const releaseRecoveryFileLock = createRecoveryLockCancellationSynchronizationBarrier();
		const requestWaitingForRecoveryFileLock = createRecoveryLockCancellationSynchronizationBarrier();
		const withLock = lockedFileSystem.withLock.bind(lockedFileSystem);
		const previousRecoveryText = JSON.stringify({
			deepseek: {
				configurationFingerprint: "previous-provider-configuration",
				cooldownUntilEpochMs: 19,
				lastFailure: { occurredAtEpochMs: 9, operationId: "previous-operation", stage: "recall", reason: "旧失败" },
			},
			minimax: { configurationFingerprint: "unrelated-provider-configuration", cooldownUntilEpochMs: 29 },
		});
		if (hasPreviousRecoveryState) await writeFile(recoveryPath, previousRecoveryText);
		const holdingLock = withLock({ path: recoveryPath }, async () => {
			heldRecoveryFileLock.resolve();
			await releaseRecoveryFileLock.promise;
		});
		let pendingRequest: Promise<unknown> | undefined;
		try {
			await heldRecoveryFileLock.promise;
			vi.spyOn(lockedFileSystem, "withLock").mockImplementation(
				<T>(lockRequest: LockRequest, operation: () => Promise<T>): Promise<T> => {
					const lockedOperation = withLock(lockRequest, operation);
					if (lockRequest.path === recoveryPath) requestWaitingForRecoveryFileLock.resolve();
					return lockedOperation;
				},
			);
			const fetchImplementation = vi
				.fn()
				.mockImplementation(async () =>
					providerOutcome === "completed"
						? new Response(JSON.stringify({ choices: [{ message: { content: '{"accepted":true}' } }] }))
						: new Response("", { status: 503 }),
				);
			const modelRequest = requestTaskAssistanceJsonObject(
				{
					modelUsagePurpose: "task_lookup_candidate_recall",
					operationId: "cancelled-operation",
					stage: "candidate_recall",
					systemPrompt: "输出 JSON",
					userPrompt: "查找任务",
					abortSignal: controller.signal,
				},
				z.object({ accepted: z.boolean() }),
				{
					storageDirectoryPath: directory.path,
					routingSettings: {
						preferredModelProviderId: "deepseek",
						fallbackModelProviderId: hasFallbackProvider ? "minimax" : null,
					},
					environmentVariables: {
						KANBAN_MODEL_PROVIDER_DEEPSEEK_API_KEY: "fixture-deepseek",
						KANBAN_MODEL_PROVIDER_MINIMAX_API_KEY: "fixture-minimax",
						KANBAN_MODEL_PROVIDER_MINIMAX_BASE_URL: "https://minimax.invalid/v1",
						KANBAN_MODEL_PROVIDER_MINIMAX_MODEL_ID: "fixture-minimax-model",
					},
					now: () => 1000,
					fetchImplementation,
				},
			);
			pendingRequest = modelRequest;
			// 已持有真实文件锁，且首选响应已到达写恢复状态的取锁入口；取消和解锁顺序完全受控。
			await requestWaitingForRecoveryFileLock.promise;
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			controller.abort(new Error("用户在恢复状态锁等待期间取消。"));
			releaseRecoveryFileLock.resolve();
			await holdingLock;
			const result = await modelRequest;
			expect.soft(result).toMatchObject({
				status: "unavailable",
				unavailableReason: "execution_cancelled",
				attempts: [{ modelProviderId: "deepseek", outcome: providerOutcome }],
			});
			expect(fetchImplementation).toHaveBeenCalledTimes(1);
			if (hasPreviousRecoveryState) expect(await readFile(recoveryPath, "utf8")).toBe(previousRecoveryText);
			else await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			controller.abort();
			releaseRecoveryFileLock.resolve();
			await Promise.allSettled([holdingLock, pendingRequest]);
			directory.cleanup();
		}
	},
);
