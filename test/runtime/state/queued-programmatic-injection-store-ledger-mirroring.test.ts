// 程序化排队投递在 store 层的行为 + 每条落定路径都把结论镜像进注入账本（真实文件，临时 home）。
//
// 钉住的几条（每一条漏掉，调用方手上那条 pending 就再也没人收敛）：
//   - 取消 / 到点过期 / 任务被删 / 托管实例死掉 / 出队引擎落定，**每一条**路径都写账本；
//   - 交给终端投递后的可重试失败**不回队首**（一次定终身）；
//   - 托管实例死掉时程序化条目直接落定，不盖「等人确认」的章；
//   - 程序化条目永不与别的条目合并；人从 Queue tab 重排它得到的是一条普通的人排条目；
//   - 镜像那一步失败了，兜底对账能补上。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
}));

const {
	claimNextQueuedTaskPromptDeliveryRunForDispatch,
	discardQueuedTaskPromptDeliveriesForTasks,
	markQueuedTaskPromptDeliveryHandedToTransport,
	MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK,
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	settleExpiredQueuedTaskPromptDeliveries,
	settleQueuedTaskPromptDelivery,
	stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart,
} = await import("../../../src/state/queued-task-prompt-delivery-store");
const { enqueueAgentIdleGatedProgrammaticInjectionIntoQueue } = await import(
	"../../../src/state/enqueue-agent-idle-gated-programmatic-injection-into-prompt-delivery-queue"
);
const { reconcileInjectionLedgerWithSettledProgrammaticInjections } = await import(
	"../../../src/state/mirror-queued-programmatic-injection-outcomes-into-injection-ledger"
);
const {
	createPendingTaskMessageInjectionRecord,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	withTaskMessageInjectionLedgerLock,
} = await import("../../../src/core/task-message-injection-ledger");
const { collectQueuedTaskPromptDeliveryChainFromHead } = await import(
	"../../../src/core/queued-task-prompt-delivery-merge"
);
const { getThisRuntimeProcessInstanceId } = await import(
	"../../../src/state/runtime-process-instance-heartbeat-registry"
);

const WORKSPACE_ID = "workspace-alpha";
const TASK_ID = "task-1";
const NOW = 1_700_000_000_000;
const KEY = "rvf-decision-point-1";
const QUEUE_ENTRY_ID = `agent-idle-gated-programmatic-injection:${KEY}`;
const DEADLINE = NOW + 10 * 60 * 1000;

function ledgerPath() {
	return getTaskMessageInjectionLedgerPath(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID));
}

async function seedLedgerPendingRecord(idempotencyKey = KEY) {
	await withTaskMessageInjectionLedgerLock<null>(ledgerPath(), async (records) => ({
		records: [
			...records,
			createPendingTaskMessageInjectionRecord({
				taskId: TASK_ID,
				source: "rvf",
				idempotencyKey,
				promptSha256: "sha",
				nowIso: new Date(NOW).toISOString(),
				agentIdleGate: { waitDeadlineAtIso: new Date(DEADLINE).toISOString(), queueEntryId: QUEUE_ENTRY_ID },
			}),
		],
		result: null,
	}));
}

async function readLedgerRecord(idempotencyKey = KEY) {
	return findTaskMessageInjectionRecord(await readTaskMessageInjectionLedger(ledgerPath()), TASK_ID, idempotencyKey);
}

async function enqueueProgrammatic(overrides: { queueEntryId?: string; key?: string; deadline?: number } = {}) {
	return await enqueueAgentIdleGatedProgrammaticInjectionIntoQueue({
		workspaceId: WORKSPACE_ID,
		enqueue: {
			taskId: TASK_ID,
			queueEntryId: overrides.queueEntryId ?? QUEUE_ENTRY_ID,
			text: "RVF 决策点边界标记",
			injectionLedgerIdempotencyKey: overrides.key ?? KEY,
			injectionSource: "rvf",
			agentIdleWaitDeadlineAtEpochMs: overrides.deadline ?? DEADLINE,
		},
		nowEpochMs: NOW,
	});
}

async function enqueueHuman(queueEntryId: string, text = "人排的") {
	await mutateWorkspaceQueuedTaskPromptDeliveries(
		WORKSPACE_ID,
		{ kind: "enqueue_prompt_for_delivery_after_current_turn", taskId: TASK_ID, queueEntryId, text },
		NOW,
	);
}

async function readEntries() {
	return (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID] ?? [];
}

async function claimAndHandOff(dispatchIdempotencyKey = KEY) {
	const claimed = await claimNextQueuedTaskPromptDeliveryRunForDispatch({
		workspaceId: WORKSPACE_ID,
		taskId: TASK_ID,
		sessionIncarnationId: "incarnation-1",
		turnSequence: 1,
		nowEpochMs: NOW + 1_000,
	});
	await markQueuedTaskPromptDeliveryHandedToTransport({
		workspaceId: WORKSPACE_ID,
		taskId: TASK_ID,
		queueEntryIds: claimed?.claimedEntries.map((entry) => entry.queueEntryId) ?? [],
		dispatchIdempotencyKey,
		nowEpochMs: NOW + 1_000,
	});
	return claimed;
}

beforeEach(async () => {
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-queued-programmatic-injection-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
});

afterEach(async () => {
	await rm(testRuntimeHome.path, { recursive: true, force: true });
});

describe("程序化入队", () => {
	it("条目带账本链接、expiresAt 就是调用方的截止、托管者是本实例", async () => {
		const { outcome } = await enqueueProgrammatic();
		expect(outcome).toBe("enqueued");
		expect(await readEntries()).toMatchObject([
			{
				queueEntryId: QUEUE_ENTRY_ID,
				deliveryState: "queued",
				expiresAt: DEADLINE,
				deliverTogetherWithNextQueuedEntry: false,
				custodianRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
				programmaticInjectionLedgerReceiptLink: {
					injectionLedgerIdempotencyKey: KEY,
					injectionSource: "rvf",
					settledTerminalDeliveryReceipt: null,
				},
			},
		]);
	});

	it("同一个条目 id 重发 ⇒ already_present，不排第二条", async () => {
		await enqueueProgrammatic();
		expect((await enqueueProgrammatic()).outcome).toBe("already_present");
		expect(await readEntries()).toHaveLength(1);
	});

	it("该 task 非终态条目已满 ⇒ refused_queue_capacity_exhausted，队列不变", async () => {
		for (let index = 0; index < MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK; index += 1) {
			await enqueueHuman(`human-${index}`);
		}
		expect((await enqueueProgrammatic()).outcome).toBe("refused_queue_capacity_exhausted");
		expect((await readEntries()).some((entry) => entry.queueEntryId === QUEUE_ENTRY_ID)).toBe(false);
	});
});

describe("每一条落定路径都镜像进账本", () => {
	it("Queue tab / message-cancel 取消（store 的 cancel 意图）⇒ cancelled_before_delivery", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "cancel_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: QUEUE_ENTRY_ID },
			NOW + 1,
		);
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "cancelled_before_delivery",
		});
	});

	it("到截止时刻写盘收敛 ⇒ agent_never_became_idle_before_queued_delivery_deadline", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		await settleExpiredQueuedTaskPromptDeliveries({ workspaceId: WORKSPACE_ID, nowEpochMs: DEADLINE - 1 });
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		await settleExpiredQueuedTaskPromptDeliveries({ workspaceId: WORKSPACE_ID, nowEpochMs: DEADLINE });
		expect((await readEntries())[0]?.deliveryState).toBe("expired");
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "agent_never_became_idle_before_queued_delivery_deadline",
		});
	});

	it("任务被删出看板 ⇒ session_ended_before_delivery", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		await discardQueuedTaskPromptDeliveriesForTasks({ workspaceId: WORKSPACE_ID, taskIds: [TASK_ID] });
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "session_ended_before_delivery",
		});
	});

	it("交给终端投递 ⇒ 账本记下通过空闲门的时刻，仍 pending", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		await claimAndHandOff();
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "accepted_pending_submit_confirmation",
			agent_idle_gate_passed_at: new Date(NOW + 1_000).toISOString(),
		});
	});

	it("出队引擎落定送达（排在回合后面）⇒ 原样镜像那份回执", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		await claimAndHandOff();
		await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: [QUEUE_ENTRY_ID],
			settlement: {
				outcome: "delivered",
				failureNote: null,
				terminalDeliveryReceiptForInjectionLedger: {
					status: "delivered_queued_behind_active_agent_turn",
					reason: null,
				},
			},
			nowEpochMs: NOW + 2_000,
		});
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivered_queued_behind_active_agent_turn",
		});
	});

	// 与 RVF 的分工约定第 3 条：已出队、在终端门那边失败的，不回头再等 agent。
	it("交出之后的可重试失败**不回队首**：落 settled_failed，账本拿到真实原因", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		await claimAndHandOff();
		await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: [QUEUE_ENTRY_ID],
			settlement: {
				outcome: "retryable_failure",
				failureNote: "Someone was typing",
				terminalDeliveryReceiptForInjectionLedger: {
					status: "delivery_failed",
					reason: "human_terminal_contention_timeout",
				},
			},
			nowEpochMs: NOW + 2_000,
		});
		expect((await readEntries())[0]).toMatchObject({ deliveryState: "settled_failed", deliveryAttemptCount: 1 });
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "human_terminal_contention_timeout",
		});
	});

	it("人排的条目遇到同样的可重试失败照旧回队首（行为不变）", async () => {
		await enqueueHuman("human-1");
		await claimAndHandOff("idem-human");
		await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["human-1"],
			settlement: { outcome: "retryable_failure", failureNote: "Someone was typing" },
			nowEpochMs: NOW + 2_000,
		});
		expect((await readEntries())[0]?.deliveryState).toBe("queued");
	});

	it("托管实例已死 ⇒ 程序化条目直接落定（不盖等人确认的章），账本 runtime_restarted_before_confirmation", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		await enqueueHuman("human-1");
		const swept = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			runtimeProcessStartedAtEpochMs: NOW + 5_000,
			sweepingRuntimeProcessInstanceId: "instance-after-restart",
			liveRuntimeProcessInstanceIds: new Set(["instance-after-restart"]),
			nowEpochMs: NOW + 6_000,
		});
		expect(swept).toMatchObject({ stampedCount: 1, settledProgrammaticInjectionCount: 1 });
		const [programmatic, human] = await readEntries();
		expect(programmatic).toMatchObject({ deliveryState: "settled_failed", survivedRuntimeRestartAtEpochMs: null });
		expect(human).toMatchObject({ deliveryState: "queued", survivedRuntimeRestartAtEpochMs: NOW + 6_000 });
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "runtime_restarted_before_confirmation",
		});
	});

	it("托管实例还活着（并存实例的清扫）⇒ 程序化条目原样不动", async () => {
		await seedLedgerPendingRecord();
		await enqueueProgrammatic();
		const swept = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			runtimeProcessStartedAtEpochMs: NOW + 5_000,
			sweepingRuntimeProcessInstanceId: "coexisting-instance",
			liveRuntimeProcessInstanceIds: new Set(["coexisting-instance", getThisRuntimeProcessInstanceId()]),
			nowEpochMs: NOW + 6_000,
		});
		expect(swept.settledProgrammaticInjectionCount).toBe(0);
		expect((await readEntries())[0]?.deliveryState).toBe("queued");
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
	});

	it("镜像那一步漏了（账本记录是后补的）⇒ 兜底对账补写；已落定的不重复写", async () => {
		await enqueueProgrammatic();
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "cancel_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: QUEUE_ENTRY_ID },
			NOW + 1,
		);
		// 取消那一刻账本里还没有记录 ⇒ 镜像写不进去（unknown key）。模拟「镜像失败、记录仍 pending」。
		await seedLedgerPendingRecord();
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
		expect(
			await reconcileInjectionLedgerWithSettledProgrammaticInjections({ workspaceId: WORKSPACE_ID, snapshot }),
		).toBe(1);
		expect((await readLedgerRecord())?.terminal_delivery_failure_reason).toBe("cancelled_before_delivery");
		expect(
			await reconcileInjectionLedgerWithSettledProgrammaticInjections({ workspaceId: WORKSPACE_ID, snapshot }),
		).toBe(0);
	});
});

describe("程序化条目永不合并、重排后变回人排条目", () => {
	it("它自己的合并开关点不亮", async () => {
		await enqueueProgrammatic();
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
			kind: "set_queued_prompt_delivery_merge_with_next",
			taskId: TASK_ID,
			queueEntryId: QUEUE_ENTRY_ID,
			deliverTogetherWithNextQueuedEntry: true,
		});
		expect((await readEntries())[0]?.deliverTogetherWithNextQueuedEntry).toBe(false);
	});

	it("前一条人排的开关点亮了，链也在它前面断开；它在队首时链长恒为 1", async () => {
		await enqueueHuman("human-1");
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
			kind: "set_queued_prompt_delivery_merge_with_next",
			taskId: TASK_ID,
			queueEntryId: "human-1",
			deliverTogetherWithNextQueuedEntry: true,
		});
		await enqueueProgrammatic();
		await enqueueHuman("human-2");
		const entries = await readEntries();
		expect(collectQueuedTaskPromptDeliveryChainFromHead(entries).map((entry) => entry.queueEntryId)).toEqual([
			"human-1",
		]);
		expect(collectQueuedTaskPromptDeliveryChainFromHead(entries.slice(1)).map((entry) => entry.queueEntryId)).toEqual(
			[QUEUE_ENTRY_ID],
		);
	});

	it("人从 Queue tab 重排一条失败的程序化条目 ⇒ 新条目不带账本链接、保质期回到默认", async () => {
		await enqueueProgrammatic();
		await claimAndHandOff();
		await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: [QUEUE_ENTRY_ID],
			settlement: { outcome: "terminal_failure", failureNote: "x" },
			nowEpochMs: NOW + 2_000,
		});
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{
				kind: "retry_settled_failed_queued_prompt_delivery",
				taskId: TASK_ID,
				queueEntryId: QUEUE_ENTRY_ID,
				replacementQueueEntryId: "requeued-by-human",
			},
			NOW + 3_000,
		);
		const requeued = (await readEntries()).find((entry) => entry.queueEntryId === "requeued-by-human");
		expect(requeued).toMatchObject({ deliveryState: "queued", programmaticInjectionLedgerReceiptLink: null });
		expect(requeued?.expiresAt).toBeGreaterThan(DEADLINE);
	});
});
