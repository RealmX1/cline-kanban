// 出队引擎 × 程序化排队投递（`kanban task message --deliver-when-agent-idle`）：真实 store + 真实注入账本
// （临时 home）+ 假会话摘要 + 假 transport。入队走 runtime 入口本身，于是账本记录与队列条目成对出现。
//
// 钉住的几条：
//   ① agent 已经闲着 ⇒ 入队当场交出，用的是**调用方的** key 与 source（交出之后的取消 / 回写与立即投递逐字相同）；
//   ② 「parked 等后台工作」恒算忙（RVF 需求 2：无需 flag）——停止边沿到了也不交；
//   ③ 交出之后的可重试失败一次定终身：不回队首、下一轮也不再发，账本拿到真实原因（与 RVF 的分工约定第 3 条）；
//   ④ 截止时刻兑现：agent 一直不闲 ⇒ 过了截止时刻账本落 agent_never_became_idle_before_queued_delivery_deadline。
//      两道收敛各守一条用例：④a 专用截止定时器到点自行写盘收敛（假 setTimeout 与注入时钟同步推进，不调兜底
//      sweep）；④b 兜底 sweep 越过截止时刻后同样收敛（注入时钟 + 手动 sweep）。两条都不依赖真实墙钟——
//      真实 80ms 截止期在高负载下会在「入队后仍待定」的断言之前就到点；
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
import type { CodexNativeConversationTurn } from "../../../src/rvf-automatic-closeout/codex-native-conversation-prefix";
import { NativeIndependentUserTurnDeliveryError } from "../../../src/rvf-automatic-closeout/native-independent-user-turn-delivery-gate";
import type { QueuedTaskPromptDeliveryDispatcherDependencies } from "../../../src/server/queued-task-prompt-delivery-dispatcher";
import type { TaskChatInputDeliveryOutcomeObserver } from "../../../src/terminal/session-manager";

const testRuntimeHome = {
	path: "",
	mainTaskConversationSessionId: "",
	sessions: {} as Record<string, RuntimeTaskSessionSummary>,
	runtimeProcessInstanceId: "isolated-runtime",
};
vi.mock("../../../src/state/runtime-process-instance-heartbeat-registry", () => ({
	getThisRuntimeProcessInstanceId: () => testRuntimeHome.runtimeProcessInstanceId,
}));
function workspaceBoard() {
	return {
		columns: [
			{
				cards: [
					{
						id: TASK_ID,
						mainTaskConversationSessionId: testRuntimeHome.mainTaskConversationSessionId || undefined,
					},
				],
			},
		],
	};
}
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	loadWorkspaceBoardById: async () => workspaceBoard(),
	loadPersistedWorkspaceStateById: async () => ({ board: workspaceBoard(), sessions: testRuntimeHome.sessions }),
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

function nativeStoppedSummary() {
	return stoppedSummary(1, {
		agentId: "codex",
		agentNativeConversationSessionIdentity: {
			sourceAgentId: "codex",
			nativeSessionId: "native",
			observedAt: NOW,
			transcriptPath: "/isolated/transcript",
		},
		codexNativeSessionControlEndpoint: {
			socketPath: "/isolated/socket",
			workspaceId: WORKSPACE_ID,
			conversationSessionId: TASK_ID,
			runtimeSessionIncarnationId: "incarnation-1",
		},
	});
}

function temporaryNativeQueryFailure() {
	return new NativeIndependentUserTurnDeliveryError(
		"native_independent_user_turn_capability_unavailable",
		"原生实时查询超时：thread/turns/list",
		{ retryableQueryFailure: true },
	);
}

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

function createHarness(
	options: {
		sendBehavior?: SendBehavior;
		readNativeConversationTurns?: () => Promise<CodexNativeConversationTurn[]>;
		runtimeProcessInstanceCustody?: QueuedTaskPromptDeliveryDispatcherDependencies["runtimeProcessInstanceCustody"];
	} = {},
) {
	testRuntimeHome.runtimeProcessInstanceId =
		options.runtimeProcessInstanceCustody?.thisRuntimeProcessInstanceId ?? "isolated-runtime";
	let currentSummary: RuntimeTaskSessionSummary | null = null;
	// 入队与出队共用一只可推进的时钟：截止时刻相关的断言不依赖真实时间流逝。
	let injectedClockOffsetMs = 0;
	const readInjectedClockNowEpochMs = () => Date.now() + injectedClockOffsetMs;
	const sendBehavior = options.sendBehavior ?? deliveredImmediately;
	const sends: {
		request: RuntimeTaskChatSendRequest;
		settlePtyDelivery: TaskChatInputDeliveryOutcomeObserver;
		validateBeforeTerminalWrite?: () => Promise<void>;
	}[] = [];
	const dispatcher = createQueuedTaskPromptDeliveryDispatcher({
		getTaskSessionSummary: (_workspaceId, taskId) => (taskId === currentSummary?.taskId ? currentSummary : null),
		readNativeConversationTurns: options.readNativeConversationTurns,
		runtimeProcessInstanceCustody: options.runtimeProcessInstanceCustody,
		hasPendingProgrammaticTaskChatInputDelivery: () => false,
		resolveWorkspaceScope: (workspaceId) => ({ workspaceId, workspacePath: "/repo" }),
		sendThroughTaskChatTransports: async (
			_scope,
			request,
			onProgrammaticTerminalDeliverySettled,
			_ledgerTaskId,
			validateBeforeTerminalWrite,
		) => {
			sends.push({ request, settlePtyDelivery: onProgrammaticTerminalDeliverySettled, validateBeforeTerminalWrite });
			return sendBehavior(request);
		},
		cancelProgrammaticTerminalDelivery: async () => "cancelled_before_delivery",
		readPromptLibraryEntryTextSha256ByEntryId: async () => new Map(),
		onProjectedQueueChanged: () => {},
		createDispatchIdempotencyKey: () => "kanban-generated-key",
		fallbackSweepIntervalMs: 60_000,
		now: readInjectedClockNowEpochMs,
	});
	return {
		dispatcher,
		sends,
		advanceInjectedClockBy(durationMs: number) {
			injectedClockOffsetMs += durationMs;
		},
		// 仅供装了假 setTimeout 的用例：注入时钟与假定时器推进同一段时长，截止定时器到点回调里读到的 now()
		// 才与「定时器已到点」一致（Date 保持真实，被推进的那一段由偏移量承担）。
		async advanceInjectedClockAndFakeTimersTogetherBy(durationMs: number) {
			injectedClockOffsetMs += durationMs;
			await vi.advanceTimersByTimeAsync(durationMs);
		},
		observe(summary: RuntimeTaskSessionSummary) {
			currentSummary = summary;
			testRuntimeHome.sessions[summary.taskId] = summary;
			dispatcher.observeTaskSessionSummary(WORKSPACE_ID, summary);
		},
		// awaitDispatcherIdle=false：PTY 分支的出队尝试会一直等回执，先等它空闲就成了自己等自己。
		async enqueueProgrammatic(
			maxWaitForAgentIdleMs = 10 * 60 * 1000,
			awaitDispatcherIdle = true,
			idempotencyKey = KEY,
			requiredNativeIndependentUserTurnSessionId?: string,
			text = "RVF 决策点边界标记",
		) {
			const response = await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				{
					notifyQueueMutated: dispatcher.notifyQueueMutated,
					now: readInjectedClockNowEpochMs,
					getTaskSessionSummary: () => currentSummary,
				},
				WORKSPACE_ID,
				{
					taskId: TASK_ID,
					text,
					source: "rvf-out-of-band-decision-point",
					idempotencyKey,
					promptSha256: "sha-1",
					maxWaitForAgentIdleMs,
					requiredNativeIndependentUserTurnSessionId,
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
	testRuntimeHome.sessions = { [TASK_ID]: stoppedSummary(1) };
	testRuntimeHome.mainTaskConversationSessionId = "";
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-queued-programmatic-dispatch-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
});

afterEach(async () => {
	// 先 stop 再还原真实定时器：stop 要用（可能是假的）clearTimeout 清掉同一套定时器。
	harnessToStop?.dispatcher.stop();
	harnessToStop = null;
	vi.useRealTimers();
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

	it("原生异步回执的消息身份经队列落盘后完整镜像进注入账本", async () => {
		const subject = harness({ sendBehavior: acceptedPendingPtyConfirmation });
		subject.observe(stoppedSummary(1));
		await subject.enqueueProgrammatic(10 * 60 * 1000, false);
		await vi.waitFor(() => expect(subject.sends).toHaveLength(1));
		const evidence = {
			clientUserMessageId: "client-message-1",
			nativeSessionId: "thread-1",
			nativeTurnId: "turn-2",
			nativeUserMessageId: "user-2",
		};
		subject.sends[0]?.settlePtyDelivery({
			status: "delivered_and_submit_confirmed",
			reason: null,
			codexNativePromptDeliveryEvidence: evidence,
		});
		await subject.dispatcher.whenIdle();
		expect((await readLedgerRecord())?.codex_native_prompt_delivery_evidence).toEqual(evidence);
		const entry = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]?.[0];
		expect(entry?.programmaticInjectionLedgerReceiptLink?.settledTerminalDeliveryReceipt).toMatchObject({
			codexNativePromptDeliveryEvidence: evidence,
		});
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

	for (const terminalDeliveryOutcomeTiming of ["immediate_receipt", "deferred_receipt"] as const) {
		it.each([
			{
				terminalDeliveryFailureReason: "native_independent_user_turn_capability_unavailable",
				expectedDeliveryFailureNoteFragment: "独立回合控制能力",
			},
			{
				terminalDeliveryFailureReason: "native_independent_user_turn_session_replaced",
				expectedDeliveryFailureNoteFragment: "原生会话、代次或回合已改变",
			},
		] as const)(
			`${terminalDeliveryOutcomeTiming}：$terminalDeliveryFailureReason 保留真实回执与明确说明，后续回合不重投`,
			async ({ terminalDeliveryFailureReason, expectedDeliveryFailureNoteFragment }) => {
				const requiredNativeConversationSessionIdentity = {
					sourceAgentId: "codex",
					nativeSessionId: "native",
					observedAt: NOW,
					transcriptPath: "/isolated/transcript",
				};
				const dispatcherHarness = harness({
					readNativeConversationTurns: async () => [{ id: "implementation-turn", status: "completed", items: [] }],
					sendBehavior:
						terminalDeliveryOutcomeTiming === "deferred_receipt"
							? acceptedPendingPtyConfirmation
							: () => ({
									ok: false,
									summary: null,
									terminalDelivery: { status: "delivery_failed", reason: terminalDeliveryFailureReason },
								}),
				});
				dispatcherHarness.observe(
					stoppedSummary(1, {
						agentId: "codex",
						agentNativeConversationSessionIdentity: requiredNativeConversationSessionIdentity,
					}),
				);
				await dispatcherHarness.enqueueProgrammatic(
					60_000,
					terminalDeliveryOutcomeTiming === "immediate_receipt",
					KEY,
					"native",
				);
				if (terminalDeliveryOutcomeTiming === "deferred_receipt") {
					await vi.waitFor(() => expect(dispatcherHarness.sends).toHaveLength(1));
					dispatcherHarness.sends[0]?.settlePtyDelivery({
						status: "delivery_failed",
						reason: terminalDeliveryFailureReason,
					});
				}
				await dispatcherHarness.dispatcher.whenIdle();

				const [settledProgrammaticInjectionQueueEntry] =
					(await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID] ?? [];
				expect(settledProgrammaticInjectionQueueEntry).toMatchObject({
					deliveryState: "settled_failed",
					deliveryAttemptCount: 1,
					programmaticInjectionLedgerReceiptLink: {
						settledTerminalDeliveryReceipt: { status: "delivery_failed", reason: terminalDeliveryFailureReason },
					},
				});
				expect(settledProgrammaticInjectionQueueEntry?.lastDeliveryFailureNote).toContain(
					expectedDeliveryFailureNoteFragment,
				);
				expect(settledProgrammaticInjectionQueueEntry?.lastDeliveryFailureNote).not.toContain(
					"it is unclear whether",
				);
				expect(await readLedgerRecord()).toMatchObject({
					terminal_delivery_status: "delivery_failed",
					terminal_delivery_failure_reason: terminalDeliveryFailureReason,
				});

				dispatcherHarness.observe({
					...generatingSummary(2),
					agentId: "codex",
					agentNativeConversationSessionIdentity: requiredNativeConversationSessionIdentity,
				});
				dispatcherHarness.observe(
					stoppedSummary(2, {
						agentId: "codex",
						agentNativeConversationSessionIdentity: requiredNativeConversationSessionIdentity,
					}),
				);
				await dispatcherHarness.dispatcher.whenIdle();
				await dispatcherHarness.dispatcher.runFallbackSweep();
				await dispatcherHarness.dispatcher.whenIdle();
				await dispatcherHarness.enqueueProgrammatic(60_000, true, KEY, "native");
				expect(dispatcherHarness.sends).toHaveLength(1);
				expect(await readStates()).toEqual(["settled_failed"]);
				expect(await readLedgerRecord()).toMatchObject({
					terminal_delivery_status: "delivery_failed",
					terminal_delivery_failure_reason: terminalDeliveryFailureReason,
				});
			},
		);
	}

	it("④a agent 一直不闲 ⇒ 专用截止定时器到点自行落 agent_never_became_idle_before_queued_delivery_deadline（不靠兜底 sweep）", async () => {
		// 只假 setTimeout / clearTimeout，截止定时器才能被确定性地推到点。shouldAdvanceTime：假时钟仍随真实时间
		// 前进——proper-lockfile 的取锁重试与 mtime 刷新也走 setTimeout，同进程争用同一把文件锁时冻住它们，
		// 写盘就永远等不到锁。Date 保持真实（锁的陈旧判据读 Date.now），被推进的那一段由注入时钟的偏移量承担。
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
		const subject = harness();
		subject.observe(generatingSummary(1));
		const maxWaitForAgentIdleMs = 60_000;
		await subject.enqueueProgrammatic(maxWaitForAgentIdleMs);
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		// 越过截止时刻（定时器在截止后还会多等一小段收敛余量，1s 足以覆盖）。只推进时钟、不调用 runFallbackSweep：
		// 能写盘收敛的只有入队时武装的那只截止定时器的到点回调。
		await subject.advanceInjectedClockAndFakeTimersTogetherBy(maxWaitForAgentIdleMs + 1_000);
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

	it("④b 截止定时器之外的第二道：兜底 sweep 越过截止时刻后同样落 agent_never_became_idle_before_queued_delivery_deadline", async () => {
		const subject = harness();
		subject.observe(generatingSummary(1));
		const maxWaitForAgentIdleMs = 60_000;
		await subject.enqueueProgrammatic(maxWaitForAgentIdleMs);
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		// 截止定时器按真实时间武装（此处约 60s，不会在用例内触发）；推进注入时钟越过截止时刻后，
		// 由兜底 sweep——截止定时器之外的第二道——写盘收敛。定时器自身的到点路径由 ④a 守。
		subject.advanceInjectedClockBy(maxWaitForAgentIdleMs + 1);
		await subject.dispatcher.runFallbackSweep();
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

it("交接前队列固定原 session；新消息固定新主会话，等待用户期间暂停，回执仍记宿主 Task", async () => {
	const harness = createHarness();
	harnessToStop = harness;
	harness.observe(generatingSummary(1));
	await harness.enqueueProgrammatic();
	testRuntimeHome.mainTaskConversationSessionId = "promoted-codex";
	const promoted = stoppedSummary(2, {
		taskId: "promoted-codex",
		agentId: "codex",
		taskConversationSessionMetadata: {
			workspaceTaskId: TASK_ID,
			taskConversationSessionRole: "main",
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
			taskAutomationSuspendedForMainSessionHandover: true,
		},
	});
	harness.observe(promoted);
	await harness.enqueueProgrammatic(10 * 60 * 1000, true, "new-main-message");
	const queued = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
	expect(queued.entriesByTaskId[TASK_ID][0].deliveryState).toBe("queued");
	expect(
		queued.entriesByTaskId["promoted-codex"][0].programmaticInjectionLedgerReceiptLink?.injectionLedgerTaskId,
	).toBe(TASK_ID);
	expect(harness.sends).toHaveLength(0);
	harness.observe({
		...promoted,
		taskConversationSessionMetadata: {
			...(promoted.taskConversationSessionMetadata as NonNullable<
				RuntimeTaskSessionSummary["taskConversationSessionMetadata"]
			>),
			taskAutomationSuspendedForMainSessionHandover: false,
		},
	});
	harness.dispatcher.requestDispatchAttempt(WORKSPACE_ID, "promoted-codex");
	await harness.dispatcher.whenIdle();
	expect(harness.sends[0].request.taskId).toBe("promoted-codex");
	const records = await readTaskMessageInjectionLedger(
		getTaskMessageInjectionLedgerPath(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID)),
	);
	expect(findTaskMessageInjectionRecord(records, TASK_ID, "new-main-message")?.terminal_delivery_status).toBe(
		"delivered_and_submit_confirmed",
	);
	expect(
		(await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID][0].deliveryState,
	).toBe("queued");
});
it("summary 已空闲但原生仍 inProgress 时不认领；完成后才交出，截止不延长", async () => {
	let nativeCompleted = false;
	const readNative = vi.fn(async () => [
		{ id: "implementation-turn", status: nativeCompleted ? "completed" : "inProgress", items: [] },
	]);
	const harness = createHarness({ readNativeConversationTurns: readNative });
	harness.observe(
		stoppedSummary(1, {
			agentId: "codex",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				observedAt: NOW,
				transcriptPath: "/isolated/transcript",
			},
		}),
	);
	await harness.enqueueProgrammatic(60_000, true, KEY, "native");
	const before = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]?.[0];
	expect(before).toMatchObject({
		deliveryState: "queued",
		deliveryAttemptCount: 0,
		requiredNativeIndependentUserTurnSessionId: "native",
		requiredNativeIndependentUserTurnSessionIncarnationId: "incarnation-1",
	});
	expect(harness.sends).toHaveLength(0);
	nativeCompleted = true;
	harness.dispatcher.requestDispatchAttempt(WORKSPACE_ID, TASK_ID);
	await harness.dispatcher.whenIdle();
	expect(harness.sends).toHaveLength(1);
	const after = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]?.[0];
	expect(after?.expiresAt).toBe(before?.expiresAt);
	harness.dispatcher.stop();
});

it("当前 TUI 缺少控制能力时明确失败，绝不退回普通投递", async () => {
	const harness = createHarness({
		readNativeConversationTurns: async () => {
			throw new NativeIndependentUserTurnDeliveryError(
				"native_independent_user_turn_capability_unavailable",
				"测试缺少当前控制面",
			);
		},
	});
	harness.observe(
		stoppedSummary(1, {
			agentId: "codex",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				observedAt: NOW,
				transcriptPath: "/isolated/transcript",
			},
		}),
	);
	await harness.enqueueProgrammatic(60_000, true, KEY, "native");
	expect(harness.sends).toHaveLength(0);
	expect(await readLedgerRecord()).toMatchObject({
		terminal_delivery_status: "delivery_failed",
		terminal_delivery_failure_reason: "native_independent_user_turn_capability_unavailable",
	});
	harness.dispatcher.stop();
});

it("投递前查询超时持久等待；恢复后同 key 只发送一次且不延长 TTL", async () => {
	const readNative = vi
		.fn()
		.mockRejectedValueOnce(temporaryNativeQueryFailure())
		.mockResolvedValue([{ id: "implementation", status: "completed", items: [] }]);
	const subject = harness({ readNativeConversationTurns: readNative });
	subject.observe(nativeStoppedSummary());
	await subject.enqueueProgrammatic(60_000, true, KEY, "native");
	const before = await readWorkspaceQueuedTaskDeliveryEntry();
	expect(before).toMatchObject({
		deliveryState: "queued",
		deliveryAttemptCount: 0,
		nativeIndependentUserTurnPreflightQueryRecovery: {
			consecutiveQueryFailureCount: 1,
			lastQueryFailureReason: "原生实时查询超时：thread/turns/list",
			recoveredAtEpochMs: null,
		},
	});
	expect(subject.sends).toHaveLength(0);
	expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
	const projected = await subject.dispatcher.buildProjectedEntriesByTaskId(WORKSPACE_ID);
	expect(projected[TASK_ID]?.[0].dispatchBlockReason).toBe("awaiting_native_independent_user_turn_query_retry");
	subject.advanceInjectedClockBy(1_001);
	await subject.dispatcher.runFallbackSweep();
	await subject.dispatcher.whenIdle();
	const after = await readWorkspaceQueuedTaskDeliveryEntry();
	expect(after).toMatchObject({
		deliveryState: "settled_delivered",
		deliveryAttemptCount: 1,
		expiresAt: before?.expiresAt,
		nativeIndependentUserTurnPreflightQueryRecovery: { recoveredAtEpochMs: expect.any(Number) },
	});
	await subject.dispatcher.runFallbackSweep();
	await subject.dispatcher.whenIdle();
	expect(subject.sends).toHaveLength(1);
});

it("投递前查询一直超时仍受原 TTL 约束，并保留真实能力查询失败原因", async () => {
	const subject = harness({
		readNativeConversationTurns: async () => {
			throw temporaryNativeQueryFailure();
		},
	});
	subject.observe(nativeStoppedSummary());
	await subject.enqueueProgrammatic(60_000, true, KEY, "native");
	subject.advanceInjectedClockBy(60_001);
	await subject.dispatcher.runFallbackSweep();
	await subject.dispatcher.whenIdle();
	expect(await readWorkspaceQueuedTaskDeliveryEntry()).toMatchObject({
		deliveryState: "expired",
		deliveryAttemptCount: 0,
	});
	expect(await readLedgerRecord()).toMatchObject({
		terminal_delivery_status: "delivery_failed",
		terminal_delivery_failure_reason: "native_independent_user_turn_capability_unavailable",
	});
	expect(subject.sends).toHaveLength(0);
});

it("runtime 重启后同一活体 incarnation 的零投递查询等待可以自动接续", async () => {
	const previous = harness({
		readNativeConversationTurns: async () => {
			throw temporaryNativeQueryFailure();
		},
		runtimeProcessInstanceCustody: {
			thisRuntimeProcessInstanceId: "previous-runtime",
			runtimeProcessStartedAtEpochMs: NOW - 1_000,
			readLiveRuntimeProcessInstanceIds: async () => new Set(["previous-runtime"]),
		},
	});
	previous.observe(nativeStoppedSummary());
	await previous.enqueueProgrammatic(60_000, true, KEY, "native");
	previous.dispatcher.stop();
	const before = await readWorkspaceQueuedTaskDeliveryEntry();
	const current = harness({
		readNativeConversationTurns: async () => [{ id: "implementation", status: "completed", items: [] }],
		runtimeProcessInstanceCustody: {
			thisRuntimeProcessInstanceId: "current-runtime",
			runtimeProcessStartedAtEpochMs: NOW,
			readLiveRuntimeProcessInstanceIds: async () => new Set(["current-runtime"]),
		},
	});
	current.advanceInjectedClockBy(2_000);
	current.observe(nativeStoppedSummary());
	await current.dispatcher.runFallbackSweep();
	await current.dispatcher.whenIdle();
	expect(await readWorkspaceQueuedTaskDeliveryEntry()).toMatchObject({
		deliveryState: "settled_delivered",
		expiresAt: before?.expiresAt,
		custodianRuntimeProcessInstanceId: "current-runtime",
	});
	expect(current.sends).toHaveLength(1);
	expect(previous.sends).toHaveLength(0);
});

it.each([
	{ identityDescription: "null", missingNativeIdentity: null, heartbeatInitiallyReadable: true },
	{ identityDescription: "undefined", missingNativeIdentity: undefined, heartbeatInitiallyReadable: true },
	{ identityDescription: "null", missingNativeIdentity: null, heartbeatInitiallyReadable: false },
	{ identityDescription: "undefined", missingNativeIdentity: undefined, heartbeatInitiallyReadable: false },
])(
	"重启后原生身份暂为 $identityDescription、心跳可读为 $heartbeatInitiallyReadable 时保留等待，补证后仅接续一次",
	async ({ missingNativeIdentity, heartbeatInitiallyReadable }) => {
		const previous = harness({
			readNativeConversationTurns: async () => {
				throw temporaryNativeQueryFailure();
			},
			runtimeProcessInstanceCustody: {
				thisRuntimeProcessInstanceId: "previous-runtime",
				runtimeProcessStartedAtEpochMs: NOW - 1_000,
				readLiveRuntimeProcessInstanceIds: async () => new Set(["previous-runtime"]),
			},
		});
		previous.observe(nativeStoppedSummary());
		await previous.enqueueProgrammatic(60_000, true, KEY, "native");
		previous.dispatcher.stop();
		const before = await readWorkspaceQueuedTaskDeliveryEntry();
		let heartbeatReadable = heartbeatInitiallyReadable;
		const readNative = vi.fn(async () => [{ id: "implementation", status: "completed", items: [] }]);
		const current = harness({
			readNativeConversationTurns: readNative,
			runtimeProcessInstanceCustody: {
				thisRuntimeProcessInstanceId: "current-runtime",
				runtimeProcessStartedAtEpochMs: NOW,
				readLiveRuntimeProcessInstanceIds: async () => {
					if (!heartbeatReadable) throw new Error("心跳暂不可读");
					return new Set(["current-runtime"]);
				},
			},
		});
		current.advanceInjectedClockBy(2_000);
		current.observe({
			...nativeStoppedSummary(),
			agentNativeConversationSessionIdentity: missingNativeIdentity,
		});
		await current.dispatcher.runFallbackSweep();
		await current.dispatcher.whenIdle();
		expect(await readWorkspaceQueuedTaskDeliveryEntry()).toMatchObject({
			deliveryState: "queued",
			deliveryAttemptCount: 0,
			claimedForSessionIncarnationId: null,
			dispatchIdempotencyKey: null,
			expiresAt: before?.expiresAt,
			custodianRuntimeProcessInstanceId: "previous-runtime",
			nativeIndependentUserTurnPreflightQueryRecovery: before?.nativeIndependentUserTurnPreflightQueryRecovery,
		});
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
		expect(readNative).not.toHaveBeenCalled();
		expect(current.sends).toHaveLength(0);
		current.observe(nativeStoppedSummary());
		if (!heartbeatReadable) {
			// 原生身份补齐仍不足以证明旧托管者退出：心跳未知期间不接管、不投递。
			await current.dispatcher.runFallbackSweep();
			await current.dispatcher.whenIdle();
			expect(await readWorkspaceQueuedTaskDeliveryEntry()).toMatchObject({
				deliveryState: "queued",
				deliveryAttemptCount: 0,
				expiresAt: before?.expiresAt,
				custodianRuntimeProcessInstanceId: "previous-runtime",
			});
			expect(readNative).not.toHaveBeenCalled();
			heartbeatReadable = true;
		}
		await current.dispatcher.runFallbackSweep();
		await current.dispatcher.whenIdle();
		expect(await readWorkspaceQueuedTaskDeliveryEntry()).toMatchObject({
			deliveryState: "settled_delivered",
			deliveryAttemptCount: 1,
			expiresAt: before?.expiresAt,
			custodianRuntimeProcessInstanceId: "current-runtime",
		});
		expect(await readLedgerRecord()).toMatchObject({ terminal_delivery_status: "delivered_and_submit_confirmed" });
		await current.dispatcher.runFallbackSweep();
		await current.dispatcher.whenIdle();
		expect(readNative).toHaveBeenCalledTimes(1);
		expect(current.sends).toHaveLength(1);
		expect(previous.sends).toHaveLength(0);
	},
);

async function readWorkspaceQueuedTaskDeliveryEntry() {
	return (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]?.[0];
}

it("查询失败无需新 summary 边沿即可按定时器恢复，取消后不再发送", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
	let healthy = false;
	const subject = harness({
		readNativeConversationTurns: async () => {
			if (!healthy) throw temporaryNativeQueryFailure();
			return [{ id: "implementation", status: "completed", items: [] }];
		},
	});
	subject.observe(nativeStoppedSummary());
	await subject.enqueueProgrammatic(60_000, true, KEY, "native");
	healthy = true;
	await subject.advanceInjectedClockAndFakeTimersTogetherBy(1_100);
	await subject.dispatcher.whenIdle();
	expect(subject.sends).toHaveLength(1);
});

it("查询等待被取消后不重试或写入终端", async () => {
	const subject = harness({
		readNativeConversationTurns: async () => {
			throw temporaryNativeQueryFailure();
		},
	});
	subject.observe(nativeStoppedSummary());
	await subject.enqueueProgrammatic(60_000, true, KEY, "native");
	const waiting = await readWorkspaceQueuedTaskDeliveryEntry();
	if (!waiting) throw new Error("缺少查询等待条目");
	await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
		kind: "cancel_queued_prompt_delivery",
		taskId: TASK_ID,
		queueEntryId: waiting.queueEntryId,
	});
	subject.advanceInjectedClockBy(10_000);
	await subject.dispatcher.runFallbackSweep();
	await subject.dispatcher.whenIdle();
	expect(await readWorkspaceQueuedTaskDeliveryEntry()).toMatchObject({
		deliveryState: "cancelled",
		deliveryAttemptCount: 0,
	});
	expect(subject.sends).toHaveLength(0);
});

it.each(["代次", "原生身份"])("重启接管等待会话证据，%s 明确改变时保留失败且不认领", async (changedEvidence) => {
	const previous = harness({
		readNativeConversationTurns: async () => {
			throw temporaryNativeQueryFailure();
		},
		runtimeProcessInstanceCustody: {
			thisRuntimeProcessInstanceId: "previous-runtime",
			runtimeProcessStartedAtEpochMs: NOW - 1_000,
			readLiveRuntimeProcessInstanceIds: async () => new Set(["previous-runtime"]),
		},
	});
	previous.observe(nativeStoppedSummary());
	await previous.enqueueProgrammatic(60_000, true, KEY, "native");
	previous.dispatcher.stop();
	const readNative = vi.fn(async () => [{ id: "implementation", status: "completed", items: [] }]);
	const current = harness({
		readNativeConversationTurns: readNative,
		runtimeProcessInstanceCustody: {
			thisRuntimeProcessInstanceId: "current-runtime",
			runtimeProcessStartedAtEpochMs: NOW,
			readLiveRuntimeProcessInstanceIds: async () => new Set(["current-runtime"]),
		},
	});
	await current.dispatcher.buildProjectedEntriesByTaskId(WORKSPACE_ID);
	await current.dispatcher.runFallbackSweep();
	await current.dispatcher.whenIdle();
	expect(await readWorkspaceQueuedTaskDeliveryEntry()).toMatchObject({
		deliveryState: "queued",
		custodianRuntimeProcessInstanceId: "previous-runtime",
	});
	current.observe({
		...nativeStoppedSummary(),
		...(changedEvidence === "代次"
			? { runtimeSessionIncarnationId: "replacement-incarnation", agentNativeConversationSessionIdentity: null }
			: {
					agentNativeConversationSessionIdentity: {
						sourceAgentId: "codex",
						nativeSessionId: "replacement-native-session",
						observedAt: NOW,
						transcriptPath: "/isolated/replacement-transcript",
					},
				}),
	});
	await current.dispatcher.runFallbackSweep();
	await current.dispatcher.whenIdle();
	expect(await readLedgerRecord()).toMatchObject({
		terminal_delivery_failure_reason: "native_independent_user_turn_session_replaced",
	});
	expect(current.sends).toHaveLength(0);
	expect(readNative).not.toHaveBeenCalled();
});

it("原生查询期间取消后不认领，不消耗投递次数", async () => {
	let release!: () => void;
	let started!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const begun = new Promise<void>((resolve) => {
		started = resolve;
	});
	const harness = createHarness({
		readNativeConversationTurns: async () => {
			started();
			await waiting;
			return [{ id: "predecessor", status: "completed", items: [] }];
		},
	});
	harness.observe(
		stoppedSummary(1, {
			agentId: "codex",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				observedAt: NOW,
				transcriptPath: "/isolated/transcript",
			},
		}),
	);
	await harness.enqueueProgrammatic(60_000, false, KEY, "native");
	await begun;
	const entry = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]?.[0];
	if (!entry) throw new Error("缺少隔离测试条目");
	await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
		kind: "cancel_queued_prompt_delivery",
		taskId: TASK_ID,
		queueEntryId: entry.queueEntryId,
	});
	release();
	await harness.dispatcher.whenIdle();
	expect(harness.sends).toHaveLength(0);
	expect(
		(await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]?.[0],
	).toMatchObject({ deliveryState: "cancelled", deliveryAttemptCount: 0 });
	harness.dispatcher.stop();
});

it("锁外普通队首被取消后，不会以旧核验认领后继的严格原生消息", async () => {
	const readNative = vi.fn(async () => [{ id: "implementation", status: "inProgress", items: [] }]);
	const harness = createHarness({ readNativeConversationTurns: readNative });
	const nativeIdentity = {
		sourceAgentId: "codex",
		nativeSessionId: "native",
		observedAt: NOW,
		transcriptPath: "/isolated/transcript",
	};
	harness.observe({
		...generatingSummary(1),
		agentId: "codex",
		agentNativeConversationSessionIdentity: nativeIdentity,
	});
	await harness.enqueueHuman("ordinary-head", "普通队首");
	await harness.enqueueProgrammatic(60_000, true, KEY, "native");
	await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
		kind: "cancel_queued_prompt_delivery",
		taskId: TASK_ID,
		queueEntryId: "ordinary-head",
	});
	harness.observe(stoppedSummary(1, { agentId: "codex", agentNativeConversationSessionIdentity: nativeIdentity }));
	await harness.dispatcher.whenIdle();
	expect(harness.sends).toHaveLength(0);
	expect(readNative).toHaveBeenCalled();
	const strict = (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]?.find(
		(entry) => entry.requiredNativeIndependentUserTurnSessionId,
	);
	expect(strict).toMatchObject({ deliveryState: "queued", deliveryAttemptCount: 0 });
	harness.dispatcher.stop();
});

it("pending严格消息遇同native会话新incarnation时失败，保留首次绑定不重排", async () => {
	const harness = createHarness();
	const nativeIdentity = {
		sourceAgentId: "codex",
		nativeSessionId: "native",
		observedAt: NOW,
		transcriptPath: "/isolated/transcript",
	};
	harness.observe({
		...generatingSummary(1),
		agentId: "codex",
		agentNativeConversationSessionIdentity: nativeIdentity,
	});
	await harness.enqueueProgrammatic(60_000, true, KEY, "native");
	harness.observe(
		stoppedSummary(1, {
			agentId: "codex",
			runtimeSessionIncarnationId: "replacement-incarnation",
			agentNativeConversationSessionIdentity: nativeIdentity,
		}),
	);
	await harness.dispatcher.whenIdle();
	expect(harness.sends).toHaveLength(0);
	expect(await readLedgerRecord()).toMatchObject({
		terminal_delivery_status: "delivery_failed",
		terminal_delivery_failure_reason: "native_independent_user_turn_session_replaced",
		required_native_independent_user_turn_session_incarnation_id: "incarnation-1",
	});
	await harness.enqueueProgrammatic(60_000, true, KEY, "native");
	expect((await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID]).toHaveLength(1);
	expect(harness.sends).toHaveLength(0);
	harness.dispatcher.stop();
});

it("没有summary新边沿也轮询原生完成；停止后清理轮询", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
	let completed = false;
	const readNative = vi.fn(async () => [
		{ id: "implementation", status: completed ? "completed" : "inProgress", items: [] },
	]);
	const harness = createHarness({ readNativeConversationTurns: readNative });
	harness.observe(
		stoppedSummary(1, {
			agentId: "codex",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				observedAt: NOW,
				transcriptPath: "/isolated/transcript",
			},
		}),
	);
	await harness.enqueueProgrammatic(60_000, true, KEY, "native");
	expect(harness.sends).toHaveLength(0);
	completed = true;
	await harness.advanceInjectedClockAndFakeTimersTogetherBy(550);
	await harness.dispatcher.whenIdle();
	expect(harness.sends).toHaveLength(1);
	harness.dispatcher.stop();
	const calls = readNative.mock.calls.length;
	await harness.advanceInjectedClockAndFakeTimersTogetherBy(1000);
	expect(readNative).toHaveBeenCalledTimes(calls);
});

it("文件尾换行与首尾空白的投递，用实际发送正文识别已摄入消息", async () => {
	let turns: CodexNativeConversationTurn[] = [{ id: "implementation", status: "completed", items: [] }];
	const harness = createHarness({
		sendBehavior: acceptedPendingPtyConfirmation,
		readNativeConversationTurns: async () => turns,
	});
	harness.observe(
		stoppedSummary(1, {
			agentId: "codex",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native",
				observedAt: NOW,
				transcriptPath: "/isolated/transcript",
			},
		}),
	);
	await harness.enqueueProgrammatic(60_000, false, KEY, "native", "  \n边界正文\n  ");
	await vi.waitFor(() => expect(harness.sends).toHaveLength(1));
	const sent = harness.sends[0];
	expect(sent.request.text).toBe("边界正文");
	turns = [
		...turns,
		{
			id: "boundary",
			status: "inProgress",
			items: [
				{ id: "native-message", type: "userMessage", content: [{ type: "input_text", text: sent.request.text }] },
			],
		},
	];
	await expect(sent.validateBeforeTerminalWrite?.()).rejects.toMatchObject({
		message: "本条消息已进入后继原生回合，停止补发回车。",
	});
	sent.settlePtyDelivery({ status: "delivered_and_submit_confirmed", reason: null });
	await harness.dispatcher.whenIdle();
	harness.dispatcher.stop();
});
