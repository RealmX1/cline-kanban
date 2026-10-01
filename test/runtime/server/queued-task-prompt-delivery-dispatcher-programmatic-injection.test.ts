// 出队引擎 × 程序化排队投递（`kanban task message --deliver-when-agent-idle`）：真实 store + 真实注入账本
// （临时 home）+ 假会话摘要 + 假 transport。入队走 runtime 入口本身，于是账本记录与队列条目成对出现。
//
// 钉住的几条：
//   ① agent 已经闲着 ⇒ 入队当场交出，用的是**调用方的** key 与 source（交出之后的取消 / 回写与立即投递逐字相同）；
//   ② 「parked 等后台工作」恒算忙（RVF 需求 2：无需 flag）——停止边沿到了也不交；
//   ③ 交出之后的可重试失败一次定终身：不回队首、下一轮也不再发，账本拿到真实原因（与 RVF 的分工约定第 3 条）；
//   ④ 截止时刻由定时器兑现：agent 一直不闲 ⇒ 到点账本落 agent_never_became_idle_before_queued_delivery_deadline；
//   ⑤ 先来先发：排在人更早排的 prompt 后面，一轮一条。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	RuntimeTaskChatSendRequest,
	RuntimeTaskChatSendResponse,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import type { TaskChatInputDeliveryOutcomeObserver } from "../../../src/terminal/session-manager";

const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
}));

const { mutateWorkspaceQueuedTaskPromptDeliveries, readWorkspaceQueuedTaskPromptDeliverySnapshot } = await import(
	"../../../src/state/queued-task-prompt-delivery-store"
);
const { createQueuedTaskPromptDeliveryDispatcher } = await import(
	"../../../src/server/queued-task-prompt-delivery-dispatcher"
);
const { enqueueAgentIdleGatedProgrammaticTaskChatMessage } = await import(
	"../../../src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue"
);
const { findTaskMessageInjectionRecord, getTaskMessageInjectionLedgerPath, readTaskMessageInjectionLedger } =
	await import("../../../src/core/task-message-injection-ledger");

const WORKSPACE_ID = "workspace-alpha";
const TASK_ID = "task-1";
const KEY = "rvf-decision-point-1";
const NOW = Date.now();

function stoppedSummary(
	turnSequence: number,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId: TASK_ID,
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: null,
		pid: 4242,
		startedAt: NOW - 10_000,
		updatedAt: NOW + turnSequence,
		lastOutputAt: null,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		turnOwner: "user",
		liveness: "live",
		userTurnKind: "review",
		runtimeSessionIncarnationId: "incarnation-1",
		agentResponseGenerationTurnSequence: turnSequence,
		agentResponseGenerationStopped: {
			stoppedAt: NOW + turnSequence,
			signalConfidence: "harness_turn_complete",
			turnSequence,
		},
		...overrides,
	};
}

function generatingSummary(turnSequence: number): RuntimeTaskSessionSummary {
	return stoppedSummary(turnSequence, {
		state: "running",
		reviewReason: null,
		turnOwner: "agent",
		userTurnKind: null,
		agentResponseGenerationStopped: null,
	});
}

type SendBehavior = (request: RuntimeTaskChatSendRequest) => RuntimeTaskChatSendResponse;

const deliveredImmediately: SendBehavior = () => ({
	ok: true,
	summary: null,
	terminalDelivery: { status: "delivered_and_submit_confirmed", reason: null },
});

const acceptedPendingPtyConfirmation: SendBehavior = () => ({
	ok: true,
	summary: null,
	terminalDelivery: { status: "accepted_pending_submit_confirmation", reason: null },
});

function createHarness(options: { sendBehavior?: SendBehavior } = {}) {
	let currentSummary: RuntimeTaskSessionSummary | null = null;
	const sendBehavior = options.sendBehavior ?? deliveredImmediately;
	const sends: { request: RuntimeTaskChatSendRequest; settlePtyDelivery: TaskChatInputDeliveryOutcomeObserver }[] = [];
	const dispatcher = createQueuedTaskPromptDeliveryDispatcher({
		getTaskSessionSummary: (_workspaceId, taskId) => (taskId === TASK_ID ? currentSummary : null),
		hasPendingProgrammaticTaskChatInputDelivery: () => false,
		resolveWorkspaceScope: (workspaceId) => ({ workspaceId, workspacePath: "/repo" }),
		sendThroughTaskChatTransports: async (_scope, request, onProgrammaticTerminalDeliverySettled) => {
			sends.push({ request, settlePtyDelivery: onProgrammaticTerminalDeliverySettled });
			return sendBehavior(request);
		},
		cancelProgrammaticTerminalDelivery: async () => "cancelled_before_delivery",
		readPromptLibraryEntryTextSha256ByEntryId: async () => new Map(),
		onProjectedQueueChanged: () => {},
		createDispatchIdempotencyKey: () => "kanban-generated-key",
		fallbackSweepIntervalMs: 60_000,
	});
	return {
		dispatcher,
		sends,
		observe(summary: RuntimeTaskSessionSummary) {
			currentSummary = summary;
			dispatcher.observeTaskSessionSummary(WORKSPACE_ID, summary);
		},
		// awaitDispatcherIdle=false：PTY 分支的出队尝试会一直等回执，先等它空闲就成了自己等自己。
		async enqueueProgrammatic(maxWaitForAgentIdleMs = 10 * 60 * 1000, awaitDispatcherIdle = true) {
			const response = await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				{ notifyQueueMutated: dispatcher.notifyQueueMutated },
				WORKSPACE_ID,
				{
					taskId: TASK_ID,
					text: "RVF 决策点边界标记",
					source: "rvf-out-of-band-decision-point",
					idempotencyKey: KEY,
					promptSha256: "sha-1",
					maxWaitForAgentIdleMs,
				},
			);
			expect(response.ok).toBe(true);
			if (awaitDispatcherIdle) {
				await dispatcher.whenIdle();
			}
		},
		async enqueueHuman(queueEntryId: string, text: string) {
			const snapshot = await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: TASK_ID,
				queueEntryId,
				text,
			});
			await dispatcher.notifyQueueMutated(WORKSPACE_ID, TASK_ID, snapshot);
			await dispatcher.whenIdle();
		},
	};
}

async function readLedgerRecord() {
	return findTaskMessageInjectionRecord(
		await readTaskMessageInjectionLedger(
			getTaskMessageInjectionLedgerPath(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID)),
		),
		TASK_ID,
		KEY,
	);
}

async function readStates() {
	return ((await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID] ?? []).map(
		(entry) => entry.deliveryState,
	);
}

let harnessToStop: ReturnType<typeof createHarness> | null = null;

beforeEach(async () => {
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-queued-programmatic-dispatch-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
});

afterEach(async () => {
	harnessToStop?.dispatcher.stop();
	harnessToStop = null;
	await rm(testRuntimeHome.path, { recursive: true, force: true });
});

function harness(options?: Parameters<typeof createHarness>[0]) {
	harnessToStop = createHarness(options);
	return harnessToStop;
}

describe("出队引擎 × 程序化排队投递", () => {
	it("① agent 已经闲着 ⇒ 入队当场交出，用调用方的 key 与 source；账本记下通过空闲门、落定送达", async () => {
		const subject = harness();
		subject.observe(stoppedSummary(1));
		await subject.enqueueProgrammatic();
		expect(subject.sends.map((send) => send.request)).toEqual([
			{
				taskId: TASK_ID,
				text: "RVF 决策点边界标记",
				source: "rvf-out-of-band-decision-point",
				idempotencyKey: KEY,
			},
		]);
		expect(await readStates()).toEqual(["settled_delivered"]);
		const record = await readLedgerRecord();
		expect(record?.terminal_delivery_status).toBe("delivered_and_submit_confirmed");
		expect(record?.agent_idle_gate_passed_at).toEqual(expect.any(String));
	});

	it("agent 在生成 ⇒ 不交；停止边沿到了才交", async () => {
		const subject = harness();
		subject.observe(generatingSummary(1));
		await subject.enqueueProgrammatic();
		expect(subject.sends).toHaveLength(0);
		expect((await readLedgerRecord())?.agent_idle_gate_passed_at).toBeUndefined();
		subject.observe(stoppedSummary(1));
		await subject.dispatcher.whenIdle();
		expect(subject.sends).toHaveLength(1);
	});

	it("② parked 等后台工作 ⇒ 停止边沿到了也不交，账本仍 pending、仍卡在空闲门", async () => {
		const subject = harness();
		subject.observe(
			stoppedSummary(1, { awaitingDispatchedBackgroundWork: { sinceMs: NOW, label: "background reviewers" } }),
		);
		await subject.enqueueProgrammatic();
		await subject.dispatcher.runFallbackSweep();
		await subject.dispatcher.whenIdle();
		expect(subject.sends).toHaveLength(0);
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "accepted_pending_submit_confirmation",
		});
		expect((await readLedgerRecord())?.agent_idle_gate_passed_at).toBeUndefined();
	});

	it("③ 交出之后终端门判了可重试失败 ⇒ 一次定终身：不回队首、下一轮不再发，账本拿到真实原因", async () => {
		const subject = harness({ sendBehavior: acceptedPendingPtyConfirmation });
		subject.observe(stoppedSummary(1));
		await subject.enqueueProgrammatic(10 * 60 * 1000, false);
		await vi.waitFor(() => expect(subject.sends).toHaveLength(1));
		subject.sends[0]?.settlePtyDelivery({ status: "delivery_failed", reason: "human_terminal_contention_timeout" });
		await subject.dispatcher.whenIdle();
		expect(await readStates()).toEqual(["settled_failed"]);
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "human_terminal_contention_timeout",
		});

		subject.observe(generatingSummary(2));
		subject.observe(stoppedSummary(2));
		await subject.dispatcher.whenIdle();
		await subject.dispatcher.runFallbackSweep();
		await subject.dispatcher.whenIdle();
		expect(subject.sends).toHaveLength(1);
	});

	it("④ agent 一直不闲 ⇒ 截止定时器到点落 agent_never_became_idle_before_queued_delivery_deadline", async () => {
		const subject = harness();
		subject.observe(generatingSummary(1));
		await subject.enqueueProgrammatic(80);
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await subject.dispatcher.whenIdle();
		expect(await readStates()).toEqual(["expired"]);
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "agent_never_became_idle_before_queued_delivery_deadline",
		});
		// 过期之后 agent 再停下也不会发——不是「到点照粘」。
		subject.observe(stoppedSummary(1));
		await subject.dispatcher.whenIdle();
		expect(subject.sends).toHaveLength(0);
	});

	it("⑤ 先来先发：排在人更早排的 prompt 后面，一轮一条", async () => {
		const subject = harness();
		subject.observe(generatingSummary(1));
		await subject.enqueueHuman("human-1", "人排的下一步");
		await subject.enqueueProgrammatic();
		subject.observe(stoppedSummary(1));
		await subject.dispatcher.whenIdle();
		expect(subject.sends.map((send) => send.request.text)).toEqual(["人排的下一步"]);
		subject.observe(generatingSummary(2));
		subject.observe(stoppedSummary(2));
		await subject.dispatcher.whenIdle();
		expect(subject.sends.map((send) => send.request.text)).toEqual(["人排的下一步", "RVF 决策点边界标记"]);
	});
});
