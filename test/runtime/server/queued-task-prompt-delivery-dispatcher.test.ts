// 出队引擎的行为网：真实 store（临时 home）+ 假会话摘要 + 假 transport。
//
// 最该钉死的几条：
//   ① 一轮一条——一次停止边沿只出队 head，第二条等下一轮；
//   ② 恢复守卫武装期间的停止边沿**不出队**——`--continue` 恢复重放自己打出的那次 Stop hook 就长这样，
//      放过它 = 用户只是点开一张卡片，几小时前排的 prompt 就发出去了；
//   ③ 可重试失败在同一轮里**不重投**——否则人正在框里打字时，兜底 sweep 会把他一次次让位到超时、三次判死；
//   ④ 重启跨越的条目要等人确认之后才出队。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	QueuedTaskPromptDeliveryMutation,
	RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId,
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
const { createQueuedTaskPromptDeliveryDispatcher, QUEUED_TASK_PROMPT_DELIVERY_CHAT_MESSAGE_SOURCE } = await import(
	"../../../src/server/queued-task-prompt-delivery-dispatcher"
);

const WORKSPACE_ID = "workspace-alpha";
const TASK_ID = "task-1";
const NOW = 1_700_000_000_000;

// ── 会话摘要构造 ────────────────────────────────────────────────────────────

// agent 这一轮刚停下、球在人这边（review）。turnSequence 是「这是第几轮」，observedAtMs 区分两次停止。
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
		lastAgentConversationUserHandoffObservation: {
			observedAtMs: NOW + turnSequence,
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
		lastAgentConversationUserHandoffObservation: null,
	});
}

// ── 假 transport ────────────────────────────────────────────────────────────

interface RecordedSend {
	request: RuntimeTaskChatSendRequest;
	settlePtyDelivery: TaskChatInputDeliveryOutcomeObserver;
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

type DispatcherCustody = Parameters<
	typeof createQueuedTaskPromptDeliveryDispatcher
>[0]["runtimeProcessInstanceCustody"];

function createHarness(
	options: { sendBehavior?: SendBehavior; hasPendingPtyDelivery?: () => boolean; custody?: DispatcherCustody } = {},
) {
	let currentSummary: RuntimeTaskSessionSummary | null = null;
	let sendBehavior = options.sendBehavior ?? deliveredImmediately;
	const sends: RecordedSend[] = [];
	const broadcasts: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId[] = [];
	const cancelCalls: { taskId: string; idempotencyKey: string }[] = [];
	const onBroadcast: Array<(projected: RuntimeQueuedTaskPromptDeliveryProjectionsByTaskId) => void> = [];
	let idempotencyKeyCounter = 0;
	const dispatcher = createQueuedTaskPromptDeliveryDispatcher({
		getTaskSessionSummary: (_workspaceId, taskId) => (taskId === TASK_ID ? currentSummary : null),
		hasPendingProgrammaticTaskChatInputDelivery: () => options.hasPendingPtyDelivery?.() ?? false,
		resolveWorkspaceScope: (workspaceId) => ({ workspaceId, workspacePath: "/repo" }),
		sendThroughTaskChatTransports: async (_scope, request, onProgrammaticTerminalDeliverySettled) => {
			sends.push({ request, settlePtyDelivery: onProgrammaticTerminalDeliverySettled });
			return sendBehavior(request);
		},
		cancelProgrammaticTerminalDelivery: async (_scope, taskId, idempotencyKey) => {
			cancelCalls.push({ taskId, idempotencyKey });
			return "cancelled_before_delivery";
		},
		readPromptLibraryEntryTextSha256ByEntryId: async () => new Map(),
		onProjectedQueueChanged: (_workspaceId, projected) => {
			broadcasts.push(projected);
			for (const listener of onBroadcast) {
				listener(projected);
			}
		},
		createDispatchIdempotencyKey: () => `idem-${++idempotencyKeyCounter}`,
		fallbackSweepIntervalMs: 60_000,
		...(options.custody ? { runtimeProcessInstanceCustody: options.custody } : {}),
	});
	return {
		dispatcher,
		sends,
		broadcasts,
		cancelCalls,
		onBroadcast,
		setSummary(summary: RuntimeTaskSessionSummary | null) {
			currentSummary = summary;
		},
		// 模拟 runtime-state-hub：会话状态变了就喂给观察器。
		observe(summary: RuntimeTaskSessionSummary) {
			currentSummary = summary;
			dispatcher.observeTaskSessionSummary(WORKSPACE_ID, summary);
		},
		setSendBehavior(behavior: SendBehavior) {
			sendBehavior = behavior;
		},
		async enqueue(queueEntryId: string, text: string) {
			await applyMutation({
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: TASK_ID,
				queueEntryId,
				text,
			});
		},
		async applyMutation(mutation: QueuedTaskPromptDeliveryMutation) {
			await applyMutation(mutation);
		},
	};

	async function applyMutation(mutation: QueuedTaskPromptDeliveryMutation) {
		const snapshot = await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, mutation);
		await dispatcher.notifyQueueMutated(WORKSPACE_ID, mutation.taskId, snapshot);
		await dispatcher.whenIdle();
	}
}

async function readTaskEntries() {
	return (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID] ?? [];
}

async function readStates() {
	return (await readTaskEntries()).map((entry) => `${entry.queueEntryId}:${entry.deliveryState}`);
}

beforeEach(async () => {
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-queued-prompt-dispatcher-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
});

afterEach(async () => {
	await rm(testRuntimeHome.path, { recursive: true, force: true });
});

describe("queued-task-prompt-delivery-dispatcher — 一轮一条", () => {
	it("agent 干活时排两条 → 停下只发第一条 → 下一轮停下再发第二条", async () => {
		const harness = createHarness();
		harness.observe(generatingSummary(1));
		await harness.enqueue("q1", "第一条");
		await harness.enqueue("q2", "第二条");
		expect(harness.sends).toHaveLength(0);

		harness.observe(stoppedSummary(1));
		await harness.dispatcher.whenIdle();
		expect(harness.sends.map((send) => send.request.text)).toEqual(["第一条"]);
		expect(await readStates()).toEqual(["q1:settled_delivered", "q2:queued"]);

		// 投出去的那条自己开启了新一轮，第二条的自然触发点是**下一个**停止边沿。
		harness.observe(generatingSummary(2));
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(1);
		harness.observe(stoppedSummary(2));
		await harness.dispatcher.whenIdle();
		expect(harness.sends.map((send) => send.request.text)).toEqual(["第一条", "第二条"]);
		expect(await readStates()).toEqual(["q1:settled_delivered", "q2:settled_delivered"]);
	});

	it("投递带 source（享用 deferWhileUserTurn 的模态让位）与 idempotencyKey（取消的句柄）", async () => {
		const harness = createHarness();
		harness.observe(stoppedSummary(1));
		await harness.enqueue("q1", "跑测试");
		expect(harness.sends[0].request).toMatchObject({
			taskId: TASK_ID,
			text: "跑测试",
			source: QUEUED_TASK_PROMPT_DELIVERY_CHAT_MESSAGE_SOURCE,
			idempotencyKey: "idem-1",
		});
	});

	// 同步确认的 transport（Cline SDK / ACP）确认之后 summary 翻成 generating 之前有空档；
	// 这期间的兜底 sweep 不得把第二条也塞进同一轮。
	it("同一轮内兜底 sweep 不会再出第二条", async () => {
		const harness = createHarness();
		harness.observe(stoppedSummary(1));
		await harness.enqueue("q1", "第一条");
		await harness.enqueue("q2", "第二条");
		expect(harness.sends).toHaveLength(1);
		await harness.dispatcher.runFallbackSweep();
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(1);
	});

	it("打开合并开关的相邻条目在一次投递里发出，正文以空行拼接", async () => {
		const harness = createHarness();
		harness.observe(generatingSummary(1));
		await harness.enqueue("q1", "先跑测试");
		await harness.enqueue("q2", "再修 lint");
		await harness.enqueue("q3", "最后提交");
		await harness.applyMutation({
			kind: "set_queued_prompt_delivery_merge_with_next",
			taskId: TASK_ID,
			queueEntryId: "q1",
			deliverTogetherWithNextQueuedEntry: true,
		});
		harness.observe(stoppedSummary(1));
		await harness.dispatcher.whenIdle();
		expect(harness.sends.map((send) => send.request.text)).toEqual(["先跑测试\n\n再修 lint"]);
		expect(await readStates()).toEqual(["q1:settled_delivered", "q2:settled_delivered", "q3:queued"]);
	});
});

describe("queued-task-prompt-delivery-dispatcher — 三条触发源", () => {
	// (b)：agent 已经闲着时排的那一条，不存在未来的边沿——只靠 (a) 会永远躺着。
	it("入队时 agent 已经停下 ⇒ 立刻出队", async () => {
		const harness = createHarness();
		harness.observe(stoppedSummary(3));
		await harness.dispatcher.whenIdle();
		await harness.enqueue("q1", "现在就发");
		expect(harness.sends.map((send) => send.request.text)).toEqual(["现在就发"]);
	});

	// (c)：阻塞条件自己解除了（例：PTY 单飞槽里那条 RVF 投递失败、没有开启新一轮），却没有新边沿。
	it("兜底 sweep 捡起「阻塞解除却没有新边沿」的条目", async () => {
		let rvfDeliveryInFlight = true;
		const harness = createHarness({ hasPendingPtyDelivery: () => rvfDeliveryInFlight });
		harness.observe(stoppedSummary(1));
		await harness.enqueue("q1", "等 RVF 让出来");
		expect(harness.sends).toHaveLength(0);
		rvfDeliveryInFlight = false;
		await harness.dispatcher.runFallbackSweep();
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(1);
	});
});

describe("queued-task-prompt-delivery-dispatcher — 门控", () => {
	it("agent 还在生成时不出队，投影里写明原因", async () => {
		const harness = createHarness();
		harness.observe(generatingSummary(1));
		await harness.enqueue("q1", "等等再发");
		expect(harness.sends).toHaveLength(0);
		expect(harness.broadcasts.at(-1)?.[TASK_ID]?.[0]).toMatchObject({
			deliveryState: "queued",
			dispatchBlockReason: "agent_still_generating",
		});
	});

	it("agent 停在模态待答（问问题）时不出队", async () => {
		const harness = createHarness();
		await harness.enqueue("q1", "别替我回答");
		harness.observe(stoppedSummary(1, { userTurnKind: "question" }));
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(0);
	});

	// 本特性初稿的真实缺陷：门控 5 只比较了第一个守卫值，恢复重放打出的 Stop hook 落在第二个值上。
	it.each([
		"restoring_agent_conversation_without_starting_new_turn",
		"restored_agent_conversation_waiting_for_explicit_user_input",
	] as const)("恢复守卫武装（%s）期间的停止边沿不出队", async (restorationContinuationGuardState) => {
		const harness = createHarness();
		await harness.enqueue("q1", "几小时前排的");
		harness.observe(
			stoppedSummary(1, {
				restorationContinuationGuardState,
				// 守卫 30 分钟兜底过期锚 startedAt：刚恢复的会话。
				startedAt: Date.now(),
			}),
		);
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(0);
		expect(await readStates()).toEqual(["q1:queued"]);
	});

	it("park 等待后台工作期间不出队（否则会把 RVF 派发的后台等待直接 unpark 掉）", async () => {
		const harness = createHarness();
		await harness.enqueue("q1", "等后台回来");
		harness.observe(
			stoppedSummary(1, { awaitingDispatchedBackgroundWork: { sinceMs: NOW, label: "rvf dispatched reviewers" } }),
		);
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(0);
	});
});

describe("queued-task-prompt-delivery-dispatcher — 重启跨越", () => {
	it("盖了 restart-crossing 章的条目等人确认之后才出队", async () => {
		const harness = createHarness();
		harness.observe(generatingSummary(1));
		await harness.enqueue("q1", "重启前排的");
		// 模拟启动清扫盖章（store 的盖章函数有自己的表格测试，这里只关心门控 0 的接线）。
		const { stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart } = await import(
			"../../../src/state/queued-task-prompt-delivery-store"
		);
		const stamped = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			runtimeProcessStartedAtEpochMs: Date.now() + 1,
			sweepingRuntimeProcessInstanceId: "sweeper",
			liveRuntimeProcessInstanceIds: new Set(),
		});
		expect(stamped.stampedCount).toBe(1);
		await harness.dispatcher.notifyQueueRewrittenOutsideDispatcher(WORKSPACE_ID, stamped.snapshot);

		harness.observe(stoppedSummary(1));
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(0);
		expect(harness.broadcasts.at(-1)?.[TASK_ID]?.[0]).toMatchObject({
			dispatchBlockReason: "awaiting_human_reconfirmation_after_runtime_restart",
			awaitsHumanReconfirmationAfterRuntimeRestart: true,
		});

		// 聚焦时的 5 秒高亮会同时发这条确认。用户要的是「确认，然后在**下一次** stop hook 注入」：
		// 确认那一刻 agent 停在重启前留下的那个停止事件上，这时发出去 = 高亮还没播完 prompt 已经走了。
		await harness.applyMutation({
			kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart",
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
		});
		await harness.dispatcher.runFallbackSweep();
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(0);
		expect(harness.broadcasts.at(-1)?.[TASK_ID]?.[0]?.dispatchBlockReason).toBe(
			"awaiting_first_agent_turn_end_after_restart_reconfirmation",
		);

		// 确认之后 agent 真的跑完一轮、停下来：这才是「下一次 stop」。
		harness.observe(generatingSummary(2));
		harness.observe(
			stoppedSummary(2, {
				lastAgentConversationUserHandoffObservation: {
					observedAtMs: Date.now() + 1_000,
					signalConfidence: "harness_turn_complete",
					turnSequence: 2,
				},
			}),
		);
		await harness.dispatcher.whenIdle();
		expect(harness.sends.map((send) => send.request.text)).toEqual(["重启前排的"]);
	});
});

describe("queued-task-prompt-delivery-dispatcher — 托管者与持续盖章屏障", () => {
	// 条目由本测试进程入队，托管者 = 本进程的实例 id；dispatcher 扮演「另一个实例」。
	async function enqueueUnderThisTestProcess(queueEntryId: string, text: string) {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
			kind: "enqueue_prompt_for_delivery_after_current_turn",
			taskId: TASK_ID,
			queueEntryId,
			text,
		});
	}

	it("托管者还活着：本实例不发，投影写明归别的实例", async () => {
		const { getThisRuntimeProcessInstanceId } = await import(
			"../../../src/state/runtime-process-instance-heartbeat-registry"
		);
		const harness = createHarness({
			custody: {
				thisRuntimeProcessInstanceId: "instance-dispatching",
				runtimeProcessStartedAtEpochMs: Date.now() - 1_000,
				readLiveRuntimeProcessInstanceIds: async () => new Set([getThisRuntimeProcessInstanceId()]),
			},
		});
		harness.observe(stoppedSummary(1));
		await enqueueUnderThisTestProcess("q1", "别的实例排的");
		await harness.dispatcher.runFallbackSweep();
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(0);
		expect(harness.broadcasts.at(-1)?.[TASK_ID]?.[0]?.dispatchBlockReason).toBe(
			"queued_under_another_live_kanban_runtime_instance",
		);
	});

	// 崩溃后心跳还在宽限期内时新实例就起来了：启动清扫以为托管者还活着而跳过盖章。之后托管者判死，
	// 必须有人盖章，否则旧 prompt 会在下一次恢复会话后不经提醒直接发出。
	it("托管者判死之后：出队前先盖章并接管，等人确认而不是直接发", async () => {
		let liveRuntimeProcessInstanceIds: ReadonlySet<string> = new Set();
		const { getThisRuntimeProcessInstanceId } = await import(
			"../../../src/state/runtime-process-instance-heartbeat-registry"
		);
		liveRuntimeProcessInstanceIds = new Set([getThisRuntimeProcessInstanceId()]);
		const harness = createHarness({
			custody: {
				thisRuntimeProcessInstanceId: "instance-dispatching",
				runtimeProcessStartedAtEpochMs: Date.now() - 1_000,
				readLiveRuntimeProcessInstanceIds: async () => liveRuntimeProcessInstanceIds,
			},
		});
		await enqueueUnderThisTestProcess("q1", "崩溃前排的");
		// 托管者（旧实例）的心跳过了宽限期。
		liveRuntimeProcessInstanceIds = new Set();
		harness.observe(stoppedSummary(1));
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(0);
		const [entry] = await readTaskEntries();
		expect(entry).toMatchObject({
			custodianRuntimeProcessInstanceId: "instance-dispatching",
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		});
		expect(entry?.survivedRuntimeRestartAtEpochMs).not.toBeNull();
	});

	it("本实例托管的条目照常出队（自己的心跳读不到也不把自己当成残骸）", async () => {
		const harness = createHarness({
			custody: {
				thisRuntimeProcessInstanceId: "instance-dispatching",
				runtimeProcessStartedAtEpochMs: Date.now() - 1_000,
				readLiveRuntimeProcessInstanceIds: async () => new Set(),
			},
		});
		harness.observe(stoppedSummary(1));
		const snapshot = await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
			kind: "enqueue_prompt_for_delivery_after_current_turn",
			taskId: TASK_ID,
			queueEntryId: "q1",
			text: "本实例排的",
		});
		// 入队由服务端盖托管者；这里模拟「由本实例入队」：把托管者改成本实例。
		const { writeFile } = await import("node:fs/promises");
		const { getWorkspaceQueuedTaskPromptDeliveriesPath } = await import(
			"../../../src/state/queued-task-prompt-delivery-store"
		);
		const ownedSnapshot = {
			entriesByTaskId: {
				[TASK_ID]: (snapshot.entriesByTaskId[TASK_ID] ?? []).map((entry) => ({
					...entry,
					custodianRuntimeProcessInstanceId: "instance-dispatching",
				})),
			},
		};
		await writeFile(getWorkspaceQueuedTaskPromptDeliveriesPath(WORKSPACE_ID), JSON.stringify(ownedSnapshot), "utf8");
		await harness.dispatcher.notifyQueueMutated(WORKSPACE_ID, TASK_ID, ownedSnapshot);
		await harness.dispatcher.whenIdle();
		expect(harness.sends.map((send) => send.request.text)).toEqual(["本实例排的"]);
	});
});

describe("queued-task-prompt-delivery-dispatcher — PTY 回执与失败路由", () => {
	it("PTY 受理之后等真实终态：确认送达才落 settled_delivered", async () => {
		const harness = createHarness({ sendBehavior: acceptedPendingPtyConfirmation });
		harness.observe(stoppedSummary(1));
		const enqueueing = harness.enqueue("q1", "跑测试");
		await vi.waitFor(() => expect(harness.sends).toHaveLength(1));
		await vi.waitFor(async () => expect(await readStates()).toEqual(["q1:handed_to_transport"]));
		harness.sends[0].settlePtyDelivery({ status: "delivered_and_submit_confirmed", reason: null });
		await enqueueing;
		await harness.dispatcher.whenIdle();
		expect(await readStates()).toEqual(["q1:settled_delivered"]);
	});

	// 人正在框里打字：让位到超时是对的，但同一轮里绝不能再试——否则三次之后把一条正常的排队意图判死。
	it("可重试失败回队首，同一轮内不重投，下一轮再投", async () => {
		const harness = createHarness({ sendBehavior: acceptedPendingPtyConfirmation });
		harness.observe(stoppedSummary(1));
		const enqueueing = harness.enqueue("q1", "跑测试");
		await vi.waitFor(() => expect(harness.sends).toHaveLength(1));
		harness.sends[0].settlePtyDelivery({ status: "delivery_failed", reason: "human_terminal_contention_timeout" });
		await enqueueing;
		await harness.dispatcher.whenIdle();
		const [entry] = await readTaskEntries();
		expect(entry).toMatchObject({ deliveryState: "queued", deliveryAttemptCount: 1 });
		expect(entry.lastDeliveryFailureNote).toContain("typing");

		await harness.dispatcher.runFallbackSweep();
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(1);

		harness.setSendBehavior(deliveredImmediately);
		harness.observe(generatingSummary(2));
		harness.observe(stoppedSummary(2));
		await harness.dispatcher.whenIdle();
		expect(harness.sends).toHaveLength(2);
		expect(await readStates()).toEqual(["q1:settled_delivered"]);
	});

	// 契约明说文本可能还躺在输入框里；自动重投 = 把同一段话送两次。
	it("「可能已经送到了」落 settled_failed，交给人决定", async () => {
		const harness = createHarness({ sendBehavior: acceptedPendingPtyConfirmation });
		harness.observe(stoppedSummary(1));
		const enqueueing = harness.enqueue("q1", "跑测试");
		await vi.waitFor(() => expect(harness.sends).toHaveLength(1));
		harness.sends[0].settlePtyDelivery({ status: "delivery_failed", reason: "submit_confirmation_budget_exhausted" });
		await enqueueing;
		await harness.dispatcher.whenIdle();
		expect(await readStates()).toEqual(["q1:settled_failed"]);
	});

	it("transport 受理之前就拒绝（会话没在跑）⇒ 可重试", async () => {
		const harness = createHarness({
			sendBehavior: () => ({
				ok: false,
				summary: null,
				error: "Task chat session is not running.",
				terminalDelivery: { status: "delivery_failed", reason: "no_active_terminal_session" },
			}),
		});
		harness.observe(stoppedSummary(1));
		await harness.enqueue("q1", "跑测试");
		expect(await readStates()).toEqual(["q1:queued"]);
	});

	it("PTY 回执迟迟不来 ⇒ 超过等待预算落终态，而不是永远挂着堵死整条队列", async () => {
		// 独立实例：只为把等待预算压到 20ms。
		const sends: RuntimeTaskChatSendRequest[] = [];
		const dispatcher = createQueuedTaskPromptDeliveryDispatcher({
			getTaskSessionSummary: () => stoppedSummary(1),
			hasPendingProgrammaticTaskChatInputDelivery: () => false,
			resolveWorkspaceScope: (workspaceId) => ({ workspaceId, workspacePath: "/repo" }),
			sendThroughTaskChatTransports: async (_scope, request) => {
				sends.push(request);
				return acceptedPendingPtyConfirmation(request);
			},
			cancelProgrammaticTerminalDelivery: async () => "no_pending_delivery",
			readPromptLibraryEntryTextSha256ByEntryId: async () => null,
			onProjectedQueueChanged: () => {},
			programmaticTerminalDeliveryOutcomeWaitBudgetMs: 20,
		});
		const snapshot = await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
			kind: "enqueue_prompt_for_delivery_after_current_turn",
			taskId: TASK_ID,
			queueEntryId: "q1",
			text: "跑测试",
		});
		await dispatcher.notifyQueueMutated(WORKSPACE_ID, TASK_ID, snapshot);
		await dispatcher.whenIdle();
		expect(sends).toHaveLength(1);
		const [entry] = await readTaskEntries();
		expect(entry.deliveryState).toBe("settled_failed");
		expect(entry.lastDeliveryFailureNote).toContain("may or may not have been sent");
	});
});

describe("queued-task-prompt-delivery-dispatcher — 陈旧认领与取消", () => {
	// 认领与 send 之间会话换了活体（例：用户恰好重启了终端）：认领说的已经不是「这个活体的这一轮」。
	it("认领之后会话换了活体 ⇒ 释放认领回 queued、什么都不发、不计尝试", async () => {
		const harness = createHarness();
		harness.observe(stoppedSummary(1));
		await harness.dispatcher.whenIdle();
		// 认领落盘后的那次投影广播里条目是 claimed_for_dispatch——就在这一刻换活体，正好卡在认领与 send 之间。
		harness.onBroadcast.push((projected) => {
			if (projected[TASK_ID]?.[0]?.deliveryState === "claimed_for_dispatch") {
				harness.setSummary(stoppedSummary(1, { runtimeSessionIncarnationId: "incarnation-2" }));
			}
		});
		await harness.enqueue("q1", "跑测试");
		expect(harness.sends).toHaveLength(0);
		const [entry] = await readTaskEntries();
		expect(entry).toMatchObject({ deliveryState: "queued", deliveryAttemptCount: 0 });
	});

	it("取消一条已经交给 PTY 的条目：走既有 cancelTaskChatDelivery，拦下后落 cancelled", async () => {
		const harness = createHarness({ sendBehavior: acceptedPendingPtyConfirmation });
		harness.observe(stoppedSummary(1));
		const enqueueing = harness.enqueue("q1", "跑测试");
		await vi.waitFor(async () => expect(await readStates()).toEqual(["q1:handed_to_transport"]));
		const cancelResult = await harness.dispatcher.cancelInFlightQueuedPromptDelivery(WORKSPACE_ID, TASK_ID, "q1");
		expect(cancelResult).toBe("cancelled_before_delivery");
		expect(harness.cancelCalls).toEqual([{ taskId: TASK_ID, idempotencyKey: "idem-1" }]);
		// PTY 侧拦下时经投递登记的 observer 回报 cancelled_before_delivery。
		harness.sends[0].settlePtyDelivery({ status: "delivery_failed", reason: "cancelled_before_delivery" });
		await enqueueing;
		await harness.dispatcher.whenIdle();
		expect(await readStates()).toEqual(["q1:cancelled"]);
	});

	it("取消一条还在排队的条目不经 transport（返回 null，由 store 意图处理）", async () => {
		const harness = createHarness();
		harness.observe(generatingSummary(1));
		await harness.enqueue("q1", "跑测试");
		expect(await harness.dispatcher.cancelInFlightQueuedPromptDelivery(WORKSPACE_ID, TASK_ID, "q1")).toBeNull();
		expect(harness.cancelCalls).toHaveLength(0);
	});
});

describe("queued-task-prompt-delivery-dispatcher — 投影随会话状态刷新", () => {
	it("agent 从干活到停在问问题，队首的阻塞原因跟着重发", async () => {
		const harness = createHarness();
		harness.observe(generatingSummary(1));
		await harness.enqueue("q1", "跑测试");
		expect(harness.broadcasts.at(-1)?.[TASK_ID]?.[0].dispatchBlockReason).toBe("agent_still_generating");
		harness.observe(stoppedSummary(1, { userTurnKind: "question" }));
		await harness.dispatcher.whenIdle();
		expect(harness.broadcasts.at(-1)?.[TASK_ID]?.[0].dispatchBlockReason).toBe("agent_awaiting_modal_user_decision");
	});

	it("投影没变就不重发", async () => {
		const harness = createHarness();
		harness.observe(generatingSummary(1));
		await harness.enqueue("q1", "跑测试");
		const broadcastCount = harness.broadcasts.length;
		harness.observe(generatingSummary(1));
		harness.observe(generatingSummary(1));
		await harness.dispatcher.whenIdle();
		expect(harness.broadcasts).toHaveLength(broadcastCount);
	});
});
