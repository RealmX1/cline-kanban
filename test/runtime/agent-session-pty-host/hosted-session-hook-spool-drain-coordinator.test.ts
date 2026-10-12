// runtime 侧的 spool 排空：按序应用、逐条确认，并守住「spool 先于直投」「spool 先于退出」「注销即取消」
// 「应用失败有界重试、耗尽后留丢投记录再确认」。全部用确定性断言：内存版 host spool + 让出事件循环，重试退避注入。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type HookSpoolDrainTargetHostedSession,
	HostedSessionHookSpoolDrainCoordinator,
	recordSpooledHookEventDroppedToHookDeliveryFailureLog,
	type SpooledHookEventDroppedAfterApplyRetriesExhausted,
} from "../../../src/agent-session-pty-host/runtime-client/hosted-session-hook-spool-drain-coordinator";
import type { HostedSessionHookSpoolEntry } from "../../../src/agent-session-pty-host/wire-protocol/agent-session-pty-host-wire-protocol-messages";
import { recordHookDeliveryFailure } from "../../../src/diagnostics/hook-ingest-delivery-failure-logger";

// 默认丢投记录器会写真实 HOME 下的记录文件：这里换成 spy。
vi.mock("../../../src/diagnostics/hook-ingest-delivery-failure-logger", () => ({
	recordHookDeliveryFailure: vi.fn(async () => {}),
}));

afterEach(() => {
	vi.mocked(recordHookDeliveryFailure).mockClear();
});

// 内存版 host spool（与修复后的 host 同语义）：读返回当前全部条目；确认移除 ≤ 序号的前缀；
// 退出被确认时 spool 非空则保留会话，spool 清空后会话移除、之后的读返回 null。
function createInMemoryHookSpoolDrainTarget(hostedSessionKey: string, taskId: string) {
	let hookSpoolEntries: HostedSessionHookSpoolEntry[] = [];
	let nextHookSpoolEntrySequenceNumber = 1;
	let hostStillKnowsHostedSession = true;
	let exitAcknowledgedWhileHookSpoolEntriesRemain = false;
	let readCount = 0;
	const acknowledgedThroughSequenceNumbers: number[] = [];
	const target: HookSpoolDrainTargetHostedSession = {
		hostedSessionKey,
		workspaceId: "workspace-1",
		taskId,
		readHookSpoolEntries: async () => {
			readCount += 1;
			return hostStillKnowsHostedSession ? [...hookSpoolEntries] : null;
		},
		acknowledgeHookSpoolEntriesThrough: (throughHookSpoolEntrySequenceNumber) => {
			acknowledgedThroughSequenceNumbers.push(throughHookSpoolEntrySequenceNumber);
			hookSpoolEntries = hookSpoolEntries.filter(
				(entry) => entry.hookSpoolEntrySequenceNumber > throughHookSpoolEntrySequenceNumber,
			);
			if (exitAcknowledgedWhileHookSpoolEntriesRemain && hookSpoolEntries.length === 0) {
				hostStillKnowsHostedSession = false;
			}
		},
	};
	return {
		target,
		acknowledgedThroughSequenceNumbers,
		readCount: () => readCount,
		// 存进一条，但不推「有新条目」通知（模拟通知尚未到达 / 登记前已被忽略）。
		spoolWithoutPendingNotification: (spooledHookIngestRequest: unknown) => {
			hookSpoolEntries.push({
				hookSpoolEntrySequenceNumber: nextHookSpoolEntrySequenceNumber,
				spooledAtEpochMs: 0,
				spooledHookIngestRequest,
			});
			nextHookSpoolEntrySequenceNumber += 1;
			return hookSpoolEntries.length;
		},
		acknowledgeExitLikeHost: () => {
			if (hookSpoolEntries.length === 0) {
				hostStillKnowsHostedSession = false;
			} else {
				exitAcknowledgedWhileHookSpoolEntriesRemain = true;
			}
		},
		remainingEntryCount: () => hookSpoolEntries.length,
		hostStillKnowsHostedSession: () => hostStillKnowsHostedSession,
	};
}

function createCoordinatorRecordingSideEffects() {
	const warnings: string[] = [];
	const droppedSpooledHookEvents: SpooledHookEventDroppedAfterApplyRetriesExhausted[] = [];
	const retryBackoffDelaysMilliseconds: number[] = [];
	const onDroppedSpooledHookEventRecorded: Array<() => void> = [];
	const coordinator = new HostedSessionHookSpoolDrainCoordinator({
		warn: (message) => warnings.push(message),
		recordSpooledHookEventDroppedAfterApplyRetriesExhausted: async (dropped) => {
			droppedSpooledHookEvents.push(dropped);
			for (const observe of onDroppedSpooledHookEventRecorded) {
				observe();
			}
		},
		waitBeforeRetryingSpooledHookEventApply: async (delayMilliseconds) => {
			retryBackoffDelaysMilliseconds.push(delayMilliseconds);
		},
	});
	return {
		coordinator,
		warnings,
		droppedSpooledHookEvents,
		retryBackoffDelaysMilliseconds,
		onDroppedSpooledHookEventRecorded,
	};
}

// 内存 spool 的读 / 应用都只走 microtask：让出一轮事件循环即可让在途排空跑完。
function yieldToNextEventLoopTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("HostedSessionHookSpoolDrainCoordinator", () => {
	it("waits for the ingest applier, then applies spooled events in order and acknowledges each only after applying it", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: 1 });
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_in_progress", n: 2 });
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		const appliedEventsWithAcknowledgementsSeenAtApplyTime: Array<{ event: unknown; acknowledged: number[] }> = [];

		// 直投先到、applier 尚未绑定：直投必须等 spool 排空。
		let directIngestMayProceed = false;
		const directIngestGate = coordinator
			.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1")
			.then(() => {
				directIngestMayProceed = true;
			});
		await yieldToNextEventLoopTurn();
		expect(directIngestMayProceed).toBe(false);
		// 读不等应用函数；读到了条目，但应用函数绑定之前一条都不应用、不确认。
		expect(inMemoryTarget.readCount()).toBe(1);
		expect(inMemoryTarget.acknowledgedThroughSequenceNumbers).toEqual([]);
		expect(inMemoryTarget.remainingEntryCount()).toBe(2);

		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEventsWithAcknowledgementsSeenAtApplyTime.push({
				event: spooledHookIngestRequest,
				acknowledged: [...inMemoryTarget.acknowledgedThroughSequenceNumbers],
			});
			return { ok: true };
		});
		await directIngestGate;

		expect(appliedEventsWithAcknowledgementsSeenAtApplyTime).toEqual([
			{ event: { event: "to_review", n: 1 }, acknowledged: [] },
			{ event: { event: "to_in_progress", n: 2 }, acknowledged: [1] },
		]);
		expect(inMemoryTarget.acknowledgedThroughSequenceNumbers).toEqual([1, 2]);
		expect(inMemoryTarget.remainingEntryCount()).toBe(0);
	});

	it("reads the spool right after registration, even though no pending notification ever arrived", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const appliedEvents: unknown[] = [];
		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		// listing 之后、登记之前存进来：此时的通知因会话尚未登记被忽略。
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: "before-registration" });
		coordinator.noteHookSpoolEntriesPending("hosted-session-1", 1);

		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		await yieldToNextEventLoopTurn();

		expect(appliedEvents).toEqual([{ event: "to_review", n: "before-registration" }]);
		expect(inMemoryTarget.remainingEntryCount()).toBe(0);
	});

	it("reads every registered spool again once the applier is bound, picking up events spooled after the registration read without a notification", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		await yieldToNextEventLoopTurn();
		expect(inMemoryTarget.readCount()).toBe(1);
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: "after-registration-read" });
		const appliedEvents: unknown[] = [];

		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		await yieldToNextEventLoopTurn();

		expect(appliedEvents).toEqual([{ event: "to_review", n: "after-registration-read" }]);
		expect(inMemoryTarget.remainingEntryCount()).toBe(0);
	});

	it("applies an event spooled after the last read came back empty before a direct ingest proceeds, without waiting for the pending notification", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const observedOrder: unknown[] = [];
		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			observedOrder.push(spooledHookIngestRequest);
			return { ok: true };
		});
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		await yieldToNextEventLoopTurn();
		expect(inMemoryTarget.readCount()).toBe(1);

		// 读回空之后 host 才收到追加；通知（UDS）还没到，直投（TCP）先到。
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: "spooled-after-empty-read" });
		await coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1");
		observedOrder.push("direct-ingest-proceeds");

		expect(observedOrder).toEqual([{ event: "to_review", n: "spooled-after-empty-read" }, "direct-ingest-proceeds"]);
	});

	it("reads again for a direct ingest requested while an older read is in flight, even if that read comes back empty", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const appliedEvents: unknown[] = [];
		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		const firstReadResponse = createDeferred<HostedSessionHookSpoolEntry[] | null>();
		let readCount = 0;
		coordinator.registerHookSpoolDrainTargetHostedSession({
			...inMemoryTarget.target,
			readHookSpoolEntries: () => {
				readCount += 1;
				return readCount === 1 ? firstReadResponse.promise : inMemoryTarget.target.readHookSpoolEntries();
			},
		});
		await yieldToNextEventLoopTurn();
		expect(readCount).toBe(1);

		// 登记时的读已经发出（host 当时 spool 为空）；之后才存进一条，随后直投到达。
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: "spooled-while-read-in-flight" });
		let directIngestMayProceed = false;
		const directIngestGate = coordinator
			.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1")
			.then(() => {
				directIngestMayProceed = true;
			});
		firstReadResponse.resolve([]);
		await yieldToNextEventLoopTurn();
		await directIngestGate;

		// 旧读（空）→ 为直投补发的新鲜读（取到那一条）→ 应用完再读一次确认已空。
		expect(readCount).toBe(3);
		expect(appliedEvents).toEqual([{ event: "to_review", n: "spooled-while-read-in-flight" }]);
		expect(directIngestMayProceed).toBe(true);
	});

	it("shares one spool read among direct ingests requested at the same time", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		coordinator.bindSpooledHookIngestRequestApplier(async () => ({ ok: true }));
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		await yieldToNextEventLoopTurn();
		const readCountBeforeDirectIngests = inMemoryTarget.readCount();

		await Promise.all([
			coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1"),
			coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1"),
			coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1"),
		]);

		expect(inMemoryTarget.readCount() - readCountBeforeDirectIngests).toBe(1);
	});

	it("does not touch any host for a direct ingest of a task without a registered drain target", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		coordinator.bindSpooledHookIngestRequestApplier(async () => ({ ok: true }));
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		await yieldToNextEventLoopTurn();
		const readCountBeforeDirectIngest = inMemoryTarget.readCount();

		await coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-not-hosted");

		expect(inMemoryTarget.readCount()).toBe(readCountBeforeDirectIngest);
	});

	it("neither applies nor acknowledges a drain queued before the applier was bound once its target is forgotten", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: 1 });
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_in_progress", n: 2 });
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		const exitDrainGate = coordinator.drainHookSpoolBeforeDeliveringExit("hosted-session-1");
		// 排空已读到两条，正排队等应用函数绑定。
		await yieldToNextEventLoopTurn();
		expect(inMemoryTarget.readCount()).toBe(1);

		// 接管失败：facade 注销目标（等它的退出交付随即放行）。之后 runtime server 才绑定应用函数。
		coordinator.forgetHookSpoolDrainTargetHostedSession("hosted-session-1");
		await exitDrainGate;
		const appliedEvents: unknown[] = [];
		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		await yieldToNextEventLoopTurn();
		await coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1");

		expect(appliedEvents).toEqual([]);
		expect(inMemoryTarget.readCount()).toBe(1);
		expect(inMemoryTarget.acknowledgedThroughSequenceNumbers).toEqual([]);
		expect(inMemoryTarget.remainingEntryCount()).toBe(2);
		expect(coordinator.isHostedSessionRegisteredAsHookSpoolDrainTarget("hosted-session-1")).toBe(false);
	});

	it("stops without acknowledging when its target is forgotten while an event is being applied", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: 1 });
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_in_progress", n: 2 });
		const firstApplyResponse = createDeferred<{ ok: boolean }>();
		const appliedEvents: unknown[] = [];
		coordinator.bindSpooledHookIngestRequestApplier((spooledHookIngestRequest) => {
			appliedEvents.push(spooledHookIngestRequest);
			return appliedEvents.length === 1 ? firstApplyResponse.promise : Promise.resolve({ ok: true });
		});
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);
		await yieldToNextEventLoopTurn();
		expect(appliedEvents).toHaveLength(1);

		coordinator.forgetHookSpoolDrainTargetHostedSession("hosted-session-1");
		firstApplyResponse.resolve({ ok: true });
		await yieldToNextEventLoopTurn();

		expect(appliedEvents).toEqual([{ event: "to_review", n: 1 }]);
		expect(inMemoryTarget.acknowledgedThroughSequenceNumbers).toEqual([]);
		expect(inMemoryTarget.remainingEntryCount()).toBe(2);
	});

	it("retries a failed apply with backoff and acknowledges the event once it is applied", async () => {
		const { coordinator, droppedSpooledHookEvents, retryBackoffDelaysMilliseconds } =
			createCoordinatorRecordingSideEffects();
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review" });
		let applyAttemptCount = 0;
		coordinator.bindSpooledHookIngestRequestApplier(async () => {
			applyAttemptCount += 1;
			if (applyAttemptCount === 1) {
				throw new Error("EBUSY: workspace state lock is busy");
			}
			if (applyAttemptCount === 2) {
				return { ok: false, error: "terminal manager is not initialized yet" };
			}
			return { ok: true };
		});
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);

		await coordinator.drainHookSpoolBeforeDeliveringExit("hosted-session-1");

		expect(applyAttemptCount).toBe(3);
		expect(retryBackoffDelaysMilliseconds).toEqual([100, 400]);
		expect(droppedSpooledHookEvents).toEqual([]);
		expect(inMemoryTarget.acknowledgedThroughSequenceNumbers).toEqual([1]);
	});

	it("records an event as dropped after the apply retries are exhausted, warns, then acknowledges it and moves on", async () => {
		const { coordinator, warnings, droppedSpooledHookEvents, onDroppedSpooledHookEventRecorded } =
			createCoordinatorRecordingSideEffects();
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: "always-rejected" });
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_in_progress", n: "applied" });
		const acknowledgementsSeenWhenDropWasRecorded: number[][] = [];
		onDroppedSpooledHookEventRecorded.push(() => {
			acknowledgementsSeenWhenDropWasRecorded.push([...inMemoryTarget.acknowledgedThroughSequenceNumbers]);
		});
		let rejectedApplyAttemptCount = 0;
		const appliedEvents: unknown[] = [];
		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			if ((spooledHookIngestRequest as { n: string }).n === "always-rejected") {
				rejectedApplyAttemptCount += 1;
				return { ok: false, error: "task not found" };
			}
			appliedEvents.push(spooledHookIngestRequest);
			return { ok: true };
		});
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);

		await coordinator.drainHookSpoolBeforeDeliveringExit("hosted-session-1");

		expect(rejectedApplyAttemptCount).toBe(3);
		expect(droppedSpooledHookEvents).toEqual([
			{
				workspaceId: "workspace-1",
				taskId: "task-1",
				hookSpoolEntrySequenceNumber: 1,
				spooledHookIngestRequest: { event: "to_review", n: "always-rejected" },
				applyAttemptCount: 3,
				lastApplyFailureMessage: "rejected: task not found",
			},
		]);
		// 先落丢投记录，再确认。
		expect(acknowledgementsSeenWhenDropWasRecorded).toEqual([[]]);
		expect(warnings.some((warning) => warning.includes("task not found"))).toBe(true);
		expect(appliedEvents).toEqual([{ event: "to_in_progress", n: "applied" }]);
		expect(inMemoryTarget.acknowledgedThroughSequenceNumbers).toEqual([1, 2]);
	});

	it("drains events the host kept after the exit acknowledgement and forgets the target once the host no longer knows the session", async () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();
		const observedOrder: unknown[] = [];
		coordinator.bindSpooledHookIngestRequestApplier(async (spooledHookIngestRequest) => {
			observedOrder.push(spooledHookIngestRequest);
			return { ok: true };
		});
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: "before-exit" });
		coordinator.registerHookSpoolDrainTargetHostedSession(inMemoryTarget.target);

		await coordinator.drainHookSpoolBeforeDeliveringExit("hosted-session-1");
		observedOrder.push("exit-delivered");
		// 排空之后、退出确认之前才存进来的最后一个 Stop：host 确认退出时保留会话。
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review", n: "final-stop" });
		inMemoryTarget.acknowledgeExitLikeHost();
		expect(inMemoryTarget.hostStillKnowsHostedSession()).toBe(true);
		await coordinator.drainHookSpoolAfterExitAcknowledgedUntilHostForgetsHostedSessionThenForgetTarget(
			"hosted-session-1",
		);

		expect(observedOrder).toEqual([
			{ event: "to_review", n: "before-exit" },
			"exit-delivered",
			{ event: "to_review", n: "final-stop" },
		]);
		expect(inMemoryTarget.hostStillKnowsHostedSession()).toBe(false);
		expect(coordinator.isHostedSessionRegisteredAsHookSpoolDrainTarget("hosted-session-1")).toBe(false);
	});

	it("fails open with a warning when the spool read fails, keeping the entries in the host", async () => {
		const { coordinator, warnings } = createCoordinatorRecordingSideEffects();
		coordinator.bindSpooledHookIngestRequestApplier(async () => ({ ok: true }));
		const inMemoryTarget = createInMemoryHookSpoolDrainTarget("hosted-session-1", "task-1");
		inMemoryTarget.spoolWithoutPendingNotification({ event: "to_review" });
		coordinator.registerHookSpoolDrainTargetHostedSession({
			...inMemoryTarget.target,
			readHookSpoolEntries: async () => {
				throw new Error("agent session pty host request timed out");
			},
		});

		await coordinator.drainPendingHookSpoolEntriesBeforeDirectHookIngest("workspace-1", "task-1");

		expect(warnings.some((warning) => warning.includes("request timed out"))).toBe(true);
		expect(inMemoryTarget.acknowledgedThroughSequenceNumbers).toEqual([]);
		expect(coordinator.isHostedSessionRegisteredAsHookSpoolDrainTarget("hosted-session-1")).toBe(true);
	});

	it("ignores pending notifications for sessions this runtime neither spawned nor adopted", () => {
		const { coordinator } = createCoordinatorRecordingSideEffects();

		coordinator.noteHookSpoolEntriesPending("hosted-session-of-unadopted-task", 3);

		expect(coordinator.isHostedSessionRegisteredAsHookSpoolDrainTarget("hosted-session-of-unadopted-task")).toBe(
			false,
		);
	});
});

describe("recordSpooledHookEventDroppedToHookDeliveryFailureLog", () => {
	const droppedSpooledHookEventTemplate: SpooledHookEventDroppedAfterApplyRetriesExhausted = {
		workspaceId: "workspace-1",
		taskId: "task-1",
		hookSpoolEntrySequenceNumber: 7,
		spooledHookIngestRequest: { event: "to_review", metadata: { source: "claude" } },
		applyAttemptCount: 3,
		lastApplyFailureMessage: "rejected: task not found",
	};

	it("writes a rejected hook delivery failure record for a lifecycle event", async () => {
		await recordSpooledHookEventDroppedToHookDeliveryFailureLog(droppedSpooledHookEventTemplate);

		expect(vi.mocked(recordHookDeliveryFailure)).toHaveBeenCalledWith({
			event: "to_review",
			taskId: "task-1",
			workspaceId: "workspace-1",
			source: "claude",
			attempts: 3,
			failureKind: "rejected",
			error: "spooled in agent session pty host (spool entry #7): rejected: task not found",
		});
	});

	it("only warns for activity, like the hooks CLI", async () => {
		await recordSpooledHookEventDroppedToHookDeliveryFailureLog({
			...droppedSpooledHookEventTemplate,
			spooledHookIngestRequest: { event: "activity" },
		});

		expect(vi.mocked(recordHookDeliveryFailure)).not.toHaveBeenCalled();
	});
});
