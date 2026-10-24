import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queuedTaskPromptDeliveryEntrySchema } from "../../../src/core/api-contract";
import { applyCodexAutomaticCompactionPhaseObservation } from "../../../src/core/codex-rvf-closeout-compaction-aware-confirmation";
import {
	createPendingTaskMessageInjectionRecord,
	readTaskMessageInjectionLedger,
	recordTaskMessageTerminalDeliveryOutcome,
	withTaskMessageInjectionLedgerLock,
} from "../../../src/core/task-message-injection-ledger";
import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { updateRvfAutomaticCloseoutRecords } from "../../../src/rvf-automatic-closeout/rvf-automatic-closeout-store";
import { resolveRvfCloseoutCompactionConfirmationPersistence } from "../../../src/rvf-automatic-closeout/rvf-closeout-compaction-confirmation-persistence";
import {
	scheduleQueuedTaskPromptDeliverySweepsAfterRuntimeRestart,
	sweepQueuedTaskPromptDeliveriesAfterRuntimeRestartForAllWorkspaces,
} from "../../../src/server/stale-queued-task-prompt-delivery-startup-sweep";
import {
	getWorkspaceQueuedTaskPromptDeliveriesPath,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart,
} from "../../../src/state/queued-task-prompt-delivery-store";
import { createRvfCloseoutCompactionConfirmationIsolatedFixture } from "../rvf-automatic-closeout/rvf-closeout-compaction-confirmation-isolated-fixture";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function prepare(compacting = true) {
	const fixture = await createRvfCloseoutCompactionConfirmationIsolatedFixture();
	const context = await resolveRvfCloseoutCompactionConfirmationPersistence({
		workspaceId: fixture.workspaceId,
		summary: fixture.summary,
		idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
	});
	if (!context) throw new Error("缺少隔离绑定");
	await context.persistSnapshot(fixture.initialSnapshot, null);
	if (compacting)
		await context.persistSnapshot(
			applyCodexAutomaticCompactionPhaseObservation(fixture.initialSnapshot, {
				phase: "started",
				nativeTurnId: "new-turn",
				capturedAtEpochMs: 103_000,
				receivedAtEpochMs: 103_000,
				hookDeliveryId: "pre",
			}),
			0,
		);
	const entry = queuedTaskPromptDeliveryEntrySchema.parse({
		queueEntryId: "closeout-entry",
		taskId: "conversation",
		workspaceTaskId: "card",
		text: fixture.promptText,
		deliverTogetherWithNextQueuedEntry: false,
		sourcePromptLibraryEntryId: null,
		sourcePromptLibraryEntryTextSha256: null,
		deliveryState: "handed_to_transport",
		deliveryAttemptCount: 1,
		lastAttemptedAt: 100_000,
		settledAt: null,
		dispatchIdempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
		claimedForSessionIncarnationId: "original-runtime",
		claimedAtTurnSequence: 1,
		enqueuedAt: 90_000,
		expiresAt: 150_000,
		lastDeliveryFailureNote: null,
		survivedRuntimeRestartAtEpochMs: null,
		humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		custodianRuntimeProcessInstanceId: "dead-runtime",
		programmaticInjectionLedgerReceiptLink: {
			injectionLedgerIdempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
			injectionLedgerTaskId: "card",
			injectionSource: "rvf_automatic_closeout",
			settledTerminalDeliveryReceipt: null,
		},
	});
	await writeFile(
		getWorkspaceQueuedTaskPromptDeliveriesPath(fixture.workspaceId),
		JSON.stringify({ entriesByTaskId: { conversation: [entry] } }),
	);
	const sweep = (time: number) =>
		sweepQueuedTaskPromptDeliveriesAfterRuntimeRestartForAllWorkspaces({
			runtimeProcessStartedAtEpochMs: 300_000,
			sweepingRuntimeProcessInstanceId: "new-runtime",
			stampEntriesThatSurvivedRuntimeRestart: true,
			listWorkspaceIds: async () => [fixture.workspaceId],
			readLiveRuntimeProcessInstanceIds: async () => new Set(["new-runtime"]),
			nowEpochMs: () => time,
		});
	const currentEntry = async () =>
		(await readWorkspaceQueuedTaskPromptDeliverySnapshot(fixture.workspaceId)).entriesByTaskId.conversation?.[0];
	return { ...fixture, sweep, currentEntry, entry, context };
}

function createCloseoutSweepSynchronizationBarrier() {
	let resolveBarrier: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		resolveBarrier = resolve;
	});
	return { promise, resolve: resolveBarrier };
}

// 持有真实队列锁，让清扫在申请队列锁处等待，再推进另一份存储；不用墙钟猜测竞态窗口。
async function advanceQueueOrLedgerWhileSweepAwaitsQueueLock(
	workspaceId: string,
	sweep: () => Promise<unknown>,
	advanceQueueOrLedger: () => Promise<unknown>,
): Promise<void> {
	const queuePath = getWorkspaceQueuedTaskPromptDeliveriesPath(workspaceId);
	const queueLockHeld = createCloseoutSweepSynchronizationBarrier();
	const releaseQueueLock = createCloseoutSweepSynchronizationBarrier();
	const sweepRequestedQueueLock = createCloseoutSweepSynchronizationBarrier();
	const queueLockHolder = lockedFileSystem.withLock({ path: queuePath }, async () => {
		queueLockHeld.resolve();
		await releaseQueueLock.promise;
	});
	await queueLockHeld.promise;
	const acquireLocks = lockedFileSystem.withLocks.bind(lockedFileSystem);
	const acquisitionObserver = vi.spyOn(lockedFileSystem, "withLocks").mockImplementation((requests, operation) => {
		if (requests.some((request) => request.path === queuePath)) sweepRequestedQueueLock.resolve();
		return acquireLocks(requests, operation);
	});
	const sweeping = sweep();
	try {
		try {
			await sweepRequestedQueueLock.promise;
			await advanceQueueOrLedger();
		} finally {
			releaseQueueLock.resolve();
			await queueLockHolder;
		}
		await sweeping;
	} finally {
		acquisitionObserver.mockRestore();
	}
}

describe.each(["启动清扫", "持续属主清扫"] as const)("%s 的跨存储提交一致性", (sweepPath) => {
	function sweep(fixture: Awaited<ReturnType<typeof prepare>>, nowEpochMs: number): Promise<unknown> {
		return sweepPath === "启动清扫"
			? fixture.sweep(nowEpochMs)
			: stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
					workspaceId: fixture.workspaceId,
					runtimeProcessStartedAtEpochMs: 300_000,
					sweepingRuntimeProcessInstanceId: "new-runtime",
					liveRuntimeProcessInstanceIds: new Set(["new-runtime"]),
					nowEpochMs,
				});
	}

	it("取得队列锁之前已确认接受，必须从最新账本结算送达", async () => {
		const fixture = await prepare();
		await advanceQueueOrLedgerWhileSweepAwaitsQueueLock(
			fixture.workspaceId,
			() => sweep(fixture, 408_001),
			() =>
				recordTaskMessageTerminalDeliveryOutcome({
					ledgerPath: fixture.ledgerPath,
					taskId: "card",
					idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
					status: "delivered_and_submit_confirmed",
					nowIso: new Date(408_000).toISOString(),
				}),
		);
		expect((await fixture.currentEntry())?.deliveryState).toBe("settled_delivered");
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"delivered_and_submit_confirmed",
		);
	});

	it("取得队列锁之前压缩已合法延长截止，不能沿用旧截止写失败", async () => {
		const fixture = await prepare(false);
		await advanceQueueOrLedgerWhileSweepAwaitsQueueLock(
			fixture.workspaceId,
			() => sweep(fixture, 125_000),
			() =>
				fixture.context.persistSnapshot(
					applyCodexAutomaticCompactionPhaseObservation(fixture.initialSnapshot, {
						phase: "started",
						nativeTurnId: "new-turn",
						capturedAtEpochMs: 111_000,
						receivedAtEpochMs: 111_000,
						hookDeliveryId: "pre-during-lock-wait",
					}),
					0,
				),
		);
		expect((await fixture.currentEntry())?.deliveryState).toBe("handed_to_transport");
		expect((await fixture.currentEntry())?.survivedRuntimeRestartAtEpochMs).toBeNull();
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"accepted_pending_submit_confirmation",
		);
	});

	it("等待队列锁期间新加入已提交条目，仍须发现其账本与合法截止", async () => {
		const fixture = await prepare();
		const queuePath = getWorkspaceQueuedTaskPromptDeliveriesPath(fixture.workspaceId);
		await writeFile(
			queuePath,
			JSON.stringify({
				entriesByTaskId: { conversation: [{ ...fixture.entry, deliveryState: "claimed_for_dispatch" }] },
			}),
		);
		await advanceQueueOrLedgerWhileSweepAwaitsQueueLock(
			fixture.workspaceId,
			() => sweep(fixture, 350_000),
			() => writeFile(queuePath, JSON.stringify({ entriesByTaskId: { conversation: [fixture.entry] } })),
		);
		expect((await fixture.currentEntry())?.deliveryState).toBe("handed_to_transport");
		expect((await fixture.currentEntry())?.deliveryAttemptCount).toBe(1);
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"accepted_pending_submit_confirmation",
		);
	});

	it("等待后账本变为不可读时保留未知，修复存储后下一趟自动收敛", async () => {
		const fixture = await prepare();
		const originalLedgerText = await readFile(fixture.ledgerPath, "utf8");
		await advanceQueueOrLedgerWhileSweepAwaitsQueueLock(
			fixture.workspaceId,
			() => sweep(fixture, 408_001).catch(() => undefined),
			() => writeFile(fixture.ledgerPath, "{"),
		);
		expect((await fixture.currentEntry())?.deliveryState).toBe("handed_to_transport");
		await writeFile(fixture.ledgerPath, originalLedgerText);
		await sweep(fixture, 408_001);
		expect((await fixture.currentEntry())?.deliveryState).toBe("settled_failed");
	});

	it("清扫提交期间并行写另一条账本记录，双方及锁后镜像均可完成", async () => {
		const fixture = await prepare();
		await withTaskMessageInjectionLedgerLock(fixture.ledgerPath, async (records) => ({
			records: [
				...records,
				createPendingTaskMessageInjectionRecord({
					taskId: "another-card",
					source: "isolated-parallel-write",
					idempotencyKey: "another-delivery",
					promptSha256: "a".repeat(64),
					nowIso: new Date(100_000).toISOString(),
				}),
			],
			result: null,
		}));
		const ledgerWriteRequested = createCloseoutSweepSynchronizationBarrier();
		const acquireLocks = lockedFileSystem.withLocks.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "withLocks").mockImplementation((requests, operation) => {
			if (requests.length === 1 && requests[0]?.path === fixture.ledgerPath) ledgerWriteRequested.resolve();
			return acquireLocks(requests, operation);
		});
		const writeJsonFileAtomic = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
		let parallelLedgerWrite: ReturnType<typeof recordTaskMessageTerminalDeliveryOutcome> | undefined;
		vi.spyOn(lockedFileSystem, "writeJsonFileAtomic").mockImplementation(async (path, payload, options) => {
			if (path === getWorkspaceQueuedTaskPromptDeliveriesPath(fixture.workspaceId) && !parallelLedgerWrite) {
				parallelLedgerWrite = recordTaskMessageTerminalDeliveryOutcome({
					ledgerPath: fixture.ledgerPath,
					taskId: "another-card",
					idempotencyKey: "another-delivery",
					status: "delivered_and_submit_confirmed",
					nowIso: new Date(408_001).toISOString(),
				});
				await ledgerWriteRequested.promise;
			}
			await writeJsonFileAtomic(path, payload, options);
		});
		await sweep(fixture, 408_001);
		expect((await parallelLedgerWrite)?.outcome).toBe("settled");
		const records = await readTaskMessageInjectionLedger(fixture.ledgerPath);
		expect(records.find((record) => record.task_id === "card")?.terminal_delivery_status).toBe("delivery_failed");
		expect(records.find((record) => record.task_id === "another-card")?.terminal_delivery_status).toBe(
			"delivered_and_submit_confirmed",
		);
	});

	it("普通队列不获取账本锁，也不因无关账本损坏停止收敛", async () => {
		const fixture = await prepare();
		await writeFile(
			getWorkspaceQueuedTaskPromptDeliveriesPath(fixture.workspaceId),
			JSON.stringify({
				entriesByTaskId: { conversation: [{ ...fixture.entry, programmaticInjectionLedgerReceiptLink: null }] },
			}),
		);
		await writeFile(fixture.ledgerPath, "{");
		const acquireLocks = lockedFileSystem.withLocks.bind(lockedFileSystem);
		const ledgerLockRequests: string[] = [];
		vi.spyOn(lockedFileSystem, "withLocks").mockImplementation((requests, operation) => {
			for (const request of requests) if (request.path === fixture.ledgerPath) ledgerLockRequests.push(request.path);
			return acquireLocks(requests, operation);
		});
		await sweep(fixture, 350_000);
		expect((await fixture.currentEntry())?.deliveryState).toBe(
			sweepPath === "启动清扫" ? "settled_failed" : "handed_to_transport",
		);
		if (sweepPath === "持续属主清扫")
			expect((await fixture.currentEntry())?.survivedRuntimeRestartAtEpochMs).toBe(350_000);
		expect(ledgerLockRequests).toEqual([]);
	});
});

describe("重启队列不能覆盖压缩确认的合法在途状态", () => {
	it("跨旧清扫预算且旧属主已退出，仍按单条持久截止等待，不盖人工确认章", async () => {
		const fixture = await prepare();
		const result = await fixture.sweep(350_000);
		expect(result.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs).toBe(408_000);
		expect((await fixture.currentEntry())?.deliveryState).toBe("handed_to_transport");
		expect((await fixture.currentEntry())?.survivedRuntimeRestartAtEpochMs).toBeNull();
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"accepted_pending_submit_confirmation",
		);
	});
	it("接管确认已写账本后，队列从该真实终态收敛，不能反向镜像成失败", async () => {
		const fixture = await prepare();
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath: fixture.ledgerPath,
			taskId: "card",
			idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
			status: "delivered_and_submit_confirmed",
			nowIso: new Date(350_000).toISOString(),
		});
		await fixture.sweep(350_000);
		expect((await fixture.currentEntry())?.deliveryState).toBe("settled_delivered");
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"delivered_and_submit_confirmed",
		);
	});
	it("补读账本失败终态时保留 base 新增的具体诊断", async () => {
		const fixture = await prepare();
		const failureDetail = "原生提交前二次查询超时，保留精确诊断。";
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath: fixture.ledgerPath,
			taskId: "card",
			idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
			status: "delivery_failed",
			failureReason: "codex_native_prompt_delivery_unconfirmed",
			failureDetail,
			nowIso: new Date(350_000).toISOString(),
		});
		await fixture.sweep(350_000);
		expect(await fixture.currentEntry()).toMatchObject({
			deliveryState: "settled_failed",
			lastDeliveryFailureNote: failureDetail,
			programmaticInjectionLedgerReceiptLink: {
				settledTerminalDeliveryReceipt: { failureNote: failureDetail },
			},
		});
	});
	it("固定截止后无接受证据才结算失败，条目永远不回队首重投", async () => {
		const fixture = await prepare();
		await fixture.sweep(408_001);
		expect((await fixture.currentEntry())?.deliveryState).toBe("settled_failed");
		expect((await readTaskMessageInjectionLedger(fixture.ledgerPath))[0]?.terminal_delivery_status).toBe(
			"delivery_failed",
		);
	});
	it("持续属主巡检也保留原提交；相同正文模板后来变化可从冻结队列只读恢复", async () => {
		const fixture = await prepare();
		await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: fixture.workspaceId,
			runtimeProcessStartedAtEpochMs: 300_000,
			sweepingRuntimeProcessInstanceId: "new-runtime",
			liveRuntimeProcessInstanceIds: new Set(["new-runtime"]),
			nowEpochMs: 350_000,
		});
		expect((await fixture.currentEntry())?.deliveryState).toBe("handed_to_transport");
		await updateRvfAutomaticCloseoutRecords(fixture.storePath, () => ({
			records: [{ ...fixture.record, handoffPath: `${fixture.record.handoffPath}.moved` }],
			value: null,
		}));
		const context = await resolveRvfCloseoutCompactionConfirmationPersistence({
			workspaceId: fixture.workspaceId,
			summary: fixture.summary,
			idempotencyKey: fixture.record.promptDeliveryIdempotencyKey,
			resumeExistingSubmissionOnly: true,
		});
		expect(context?.promptText).toBe(fixture.promptText);
		expect(context?.binding.promptSha256).toBe(fixture.initialSnapshot.binding.promptSha256);
	});
	it("正文哈希错绑不能借用另一条在途确认的压缩预算", async () => {
		const fixture = await prepare();
		await writeFile(
			getWorkspaceQueuedTaskPromptDeliveriesPath(fixture.workspaceId),
			JSON.stringify({
				entriesByTaskId: {
					conversation: [{ ...fixture.entry, text: `${fixture.promptText}非原正文` }],
				},
			}),
		);
		await fixture.sweep(350_000);
		expect((await fixture.currentEntry())?.deliveryState).toBe("settled_failed");
	});
	it("账本读取失败保持机器未知，下一次可核验后自动接续，不写虚假的失败或成功", async () => {
		const fixture = await prepare();
		const original = await readFile(fixture.ledgerPath, "utf8");
		await writeFile(fixture.ledgerPath, "{");
		await fixture.sweep(350_000);
		expect((await fixture.currentEntry())?.deliveryState).toBe("handed_to_transport");
		await writeFile(fixture.ledgerPath, original);
		await fixture.sweep(408_001);
		expect((await fixture.currentEntry())?.deliveryState).toBe("settled_failed");
	});
	it("启动后才进入压缩，早期复扫会续排到新截止，无属主也会有界收口", async () => {
		const fixture = await prepare(false);
		vi.useFakeTimers();
		vi.setSystemTime(110_000);
		const listWorkspaceIds = vi.fn(async () => [fixture.workspaceId]);
		const initialSweep = await scheduleQueuedTaskPromptDeliverySweepsAfterRuntimeRestart({
			runtimeProcessStartedAtEpochMs: 110_000,
			sweepingRuntimeProcessInstanceId: "new-runtime",
			listWorkspaceIds,
			readLiveRuntimeProcessInstanceIds: async () => new Set(["new-runtime"]),
		});
		expect(initialSweep.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs).toBe(120_000);
		vi.setSystemTime(111_000);
		await fixture.context.persistSnapshot(
			applyCodexAutomaticCompactionPhaseObservation(fixture.initialSnapshot, {
				phase: "started",
				nativeTurnId: "new-turn",
				capturedAtEpochMs: 111_000,
				receivedAtEpochMs: 111_000,
				hookDeliveryId: "pre-after-startup",
			}),
			0,
		);
		await vi.advanceTimersByTimeAsync(15_000);
		await vi.waitFor(() => expect(listWorkspaceIds).toHaveBeenCalledTimes(2));
		expect((await fixture.currentEntry())?.deliveryState).toBe("handed_to_transport");
		// 等待异步清扫排完下一次定时器，再越过持久截止；不能只有第一次延迟复扫。
		await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
		await vi.advanceTimersByTimeAsync(300_000);
		await vi.waitFor(async () => expect((await fixture.currentEntry())?.deliveryState).toBe("settled_failed"));
		expect(listWorkspaceIds).toHaveBeenCalledTimes(3);
	});
	it("尚未写入的查询等待保留更晚的原 TTL，不能被压缩复扫上界截断", async () => {
		const fixture = await prepare(false);
		await writeFile(
			getWorkspaceQueuedTaskPromptDeliveriesPath(fixture.workspaceId),
			JSON.stringify({
				entriesByTaskId: {
					conversation: [
						{
							...fixture.entry,
							programmaticInjectionLedgerReceiptLink: {
								injectionLedgerIdempotencyKey: "isolated-before-submission-query-key",
								injectionSource: "isolated-before-submission-query",
								settledTerminalDeliveryReceipt: null,
							},
							custodianRuntimeProcessInstanceId: "new-runtime",
							expiresAt: 700_000,
							requiredNativeIndependentUserTurnSessionId: "native-session",
							requiredNativeIndependentUserTurnSessionIncarnationId: "original-runtime",
							nativeIndependentUserTurnSubmissionProgress: {
								predecessorNativeTurnId: "prior-turn",
								submissionMayHaveStartedAtEpochMs: null,
							},
						},
					],
				},
			}),
		);
		vi.useFakeTimers();
		vi.setSystemTime(110_000);
		const listWorkspaceIds = vi.fn(async () => [fixture.workspaceId]);
		const initialSweep = await scheduleQueuedTaskPromptDeliverySweepsAfterRuntimeRestart({
			runtimeProcessStartedAtEpochMs: 110_000,
			sweepingRuntimeProcessInstanceId: "new-runtime",
			listWorkspaceIds,
			readLiveRuntimeProcessInstanceIds: async () => new Set(["new-runtime"]),
		});
		expect(initialSweep.earliestYoungInFlightDeliveryBecomesStaleAtEpochMs).toBe(700_000);
		await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
		await vi.advanceTimersByTimeAsync(600_000);
		await vi.waitFor(async () => expect((await fixture.currentEntry())?.deliveryState).toBe("expired"));
		expect(listWorkspaceIds).toHaveBeenCalledTimes(2);
	});
});
