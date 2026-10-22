// `kanban task message --deliver-when-agent-idle` 的 runtime 入口：账本 pending 记录与队列条目成对出现，
// 幂等规则与立即投递一致（同 key 重发绝不重新入队，哪怕队列里已经没有它的条目），排队期间的 message-cancel
// 真的把它撤下。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type RuntimeBoardData,
	type RuntimeTaskSessionSummary,
	runtimeTaskSessionSummarySchema,
	type WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../../../src/core/api-contract";

const testRuntimeHome = { path: "" };
const testWorkspaceState: { board: RuntimeBoardData; sessions: Record<string, RuntimeTaskSessionSummary> } = {
	board: { columns: [] },
	sessions: {},
};
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
	loadWorkspaceBoardById: async () => testWorkspaceState.board,
	loadPersistedWorkspaceStateById: async () => testWorkspaceState,
}));

const {
	cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle,
	enqueueAgentIdleGatedProgrammaticTaskChatMessage,
	MAX_WAIT_FOR_AGENT_IDLE_UPPER_BOUND_MS,
} = await import("../../../src/trpc/agent-idle-gated-programmatic-task-chat-message-enqueue");
const {
	claimNextQueuedTaskPromptDeliveryRunForDispatch,
	markQueuedTaskPromptDeliveryHandedToTransport,
	MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK,
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	settleQueuedTaskPromptDelivery,
} = await import("../../../src/state/queued-task-prompt-delivery-store");
const {
	createPendingTaskMessageInjectionRecord,
	recordTaskMessageTerminalDeliveryOutcome,
	findTaskMessageInjectionRecord,
	getTaskMessageInjectionLedgerPath,
	readTaskMessageInjectionLedger,
	withTaskMessageInjectionLedgerLock,
} = await import("../../../src/core/task-message-injection-ledger");

const WORKSPACE_ID = "workspace-alpha";
const TASK_ID = "task-1";
const NOW = Date.parse("2026-10-01T10:00:00.000Z");
const KEY = "rvf-decision-point-1";
const QUEUE_ENTRY_ID = `agent-idle-gated-programmatic-injection:${KEY}`;
const TEN_MINUTES_MS = 10 * 60 * 1000;

function ledgerPath() {
	return getTaskMessageInjectionLedgerPath(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID));
}

async function readLedgerRecord(idempotencyKey = KEY) {
	return findTaskMessageInjectionRecord(await readTaskMessageInjectionLedger(ledgerPath()), TASK_ID, idempotencyKey);
}

async function readEntries() {
	return (await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId[TASK_ID] ?? [];
}

function createDeps(nowEpochMs = NOW) {
	const notified: { taskId: string; snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot }[] = [];
	return {
		notified,
		deps: {
			now: () => nowEpochMs,
			notifyQueueMutated: async (
				_workspaceId: string,
				taskId: string,
				snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot,
			) => {
				notified.push({ taskId, snapshot });
			},
		},
	};
}

function request(overrides: Partial<Parameters<typeof enqueueAgentIdleGatedProgrammaticTaskChatMessage>[2]> = {}) {
	return {
		taskId: TASK_ID,
		text: "RVF 决策点边界标记",
		source: "rvf",
		idempotencyKey: KEY,
		promptSha256: "sha-1",
		maxWaitForAgentIdleMs: TEN_MINUTES_MS,
		...overrides,
	};
}

function createSessionSummary(taskId: string, workspaceTaskId?: string) {
	return runtimeTaskSessionSummarySchema.parse({
		taskId,
		state: "idle",
		agentId: "codex",
		workspacePath: "/isolated/task",
		pid: null,
		startedAt: null,
		updatedAt: NOW,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...(workspaceTaskId
			? {
					taskConversationSessionMetadata: {
						workspaceTaskId,
						taskConversationSessionRole: "task_collaborator",
						taskConversationSessionContextSource: "started_from_scratch",
						parentTaskConversationSessionId: null,
						mainSessionOriginTurnNumber: null,
						mainSessionOriginUserMessagePreview: null,
						latestUserMessagePreview: null,
					},
				}
			: {}),
	});
}

function selectIndependentMain(sessionId: string) {
	testWorkspaceState.board.columns[0].cards[0].mainTaskConversationSessionId = sessionId;
	testWorkspaceState.sessions[sessionId] = createSessionSummary(sessionId, TASK_ID);
}

beforeEach(async () => {
	testWorkspaceState.board = {
		columns: [
			{
				id: "in_progress",
				title: "进行中",
				cards: [
					{
						id: TASK_ID,
						title: "任务",
						prompt: "实现",
						baseRef: "main",
						startInPlanMode: false,
						createdAt: NOW,
						updatedAt: NOW,
					},
				],
			},
		],
	};
	testWorkspaceState.sessions = { [TASK_ID]: createSessionSummary(TASK_ID) };
	testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-agent-idle-gated-enqueue-"));
	await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
});

afterEach(async () => {
	await rm(testRuntimeHome.path, { recursive: true, force: true });
});

describe("enqueueAgentIdleGatedProgrammaticTaskChatMessage", () => {
	it.each([undefined, TASK_ID])("legacy 主会话未落盘时仍可排队，显式目标为 %s", async (attemptId) => {
		testWorkspaceState.sessions = {};
		const summary = createSessionSummary(TASK_ID);
		const deps = { ...createDeps().deps, getTaskSessionSummary: (id: string) => (id === TASK_ID ? summary : null) };
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request({ attemptId })),
		).toMatchObject({ ok: true });
		expect(await readLedgerRecord()).toMatchObject({ task_id: TASK_ID, attempt_id: TASK_ID });
		expect(await readEntries()).toHaveLength(1);
	});

	it.each(["foreign-owner", "inconsistent-id"])("当前摘要 %s 不回退旧持久摘要，不建账本或队列", async (scenario) => {
		const summary = createSessionSummary(scenario === "inconsistent-id" ? "other-session" : TASK_ID, "other-task");
		const deps = { ...createDeps().deps, getTaskSessionSummary: () => summary };
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request({ attemptId: TASK_ID })),
		).toMatchObject({ ok: false });
		expect(await readLedgerRecord()).toBeNull();
		expect(await readEntries()).toEqual([]);
	});

	it("当前摘要归属正确时不被陈旧的异属持久摘要误拒绝", async () => {
		testWorkspaceState.sessions[TASK_ID] = createSessionSummary(TASK_ID, "other-task");
		const summary = createSessionSummary(TASK_ID);
		const deps = { ...createDeps().deps, getTaskSessionSummary: () => summary };
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request())).toMatchObject({
			ok: true,
		});
	});

	it.each(["persisted", "live"])(
		"内部自动收尾按 %s 所属会话寻址时保持原有账本键和真实宿主卡片",
		async (summarySource) => {
			selectIndependentMain("independent-main");
			const summary = testWorkspaceState.sessions["independent-main"];
			if (summarySource === "live") testWorkspaceState.sessions = {};
			const deps = {
				...createDeps().deps,
				getTaskSessionSummary: (id: string) => (summarySource === "live" && id === summary.taskId ? summary : null),
			};
			expect(
				await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
					deps,
					WORKSPACE_ID,
					request({ taskId: "independent-main", source: "rvf_automatic_closeout" }),
				),
			).toMatchObject({ ok: true });
			expect(
				findTaskMessageInjectionRecord(await readTaskMessageInjectionLedger(ledgerPath()), "independent-main", KEY),
			).toMatchObject({ task_id: "independent-main", attempt_id: "independent-main" });
			const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
			expect(snapshot.entriesByTaskId["independent-main"]).toMatchObject([
				{
					taskId: "independent-main",
					workspaceTaskId: TASK_ID,
					programmaticInjectionLedgerReceiptLink: { injectionLedgerTaskId: "independent-main" },
				},
			]);
		},
	);

	it.each(["missing-incarnation", "wrong-native", "non-codex"])(
		"未落盘的活动会话仍拒绝原生要求 %s",
		async (scenario) => {
			testWorkspaceState.sessions = {};
			const summary: RuntimeTaskSessionSummary = {
				...createSessionSummary(TASK_ID),
				agentId: scenario === "non-codex" ? "claude" : "codex",
				runtimeSessionIncarnationId: scenario === "missing-incarnation" ? undefined : "current-incarnation",
				agentNativeConversationSessionIdentity: {
					sourceAgentId: "codex",
					nativeSessionId: scenario === "wrong-native" ? "other-native" : "required-native",
					transcriptPath: null,
					observedAt: NOW,
				},
			};
			const deps = { ...createDeps().deps, getTaskSessionSummary: () => summary };
			expect(
				await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
					deps,
					WORKSPACE_ID,
					request({ requiredNativeIndependentUserTurnSessionId: "required-native" }),
				),
			).toMatchObject({ ok: false });
			expect(await readLedgerRecord()).toBeNull();
			expect(await readEntries()).toEqual([]);
		},
	);

	it("内部会话寻址不能绕过宿主卡片存在性校验", async () => {
		selectIndependentMain("independent-main");
		testWorkspaceState.board.columns[0].cards = [];
		const { deps } = createDeps();
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				deps,
				WORKSPACE_ID,
				request({ taskId: "independent-main", source: "rvf_automatic_closeout" }),
			),
		).toMatchObject({ ok: false });
		expect(await readTaskMessageInjectionLedger(ledgerPath())).toEqual([]);
	});

	it.each([undefined, "independent-main", TASK_ID])(
		"交接后按目标 %s 投递，记录卡片与实际会话两个身份",
		async (attemptId) => {
			selectIndependentMain("independent-main");
			const target = attemptId ?? "independent-main";
			const { deps, notified } = createDeps();
			expect(
				await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request({ attemptId })),
			).toMatchObject({ ok: true });
			expect(await readLedgerRecord()).toMatchObject({ task_id: TASK_ID, attempt_id: target });
			const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
			expect(snapshot.entriesByTaskId[target]).toMatchObject([
				{
					taskId: target,
					workspaceTaskId: TASK_ID,
					programmaticInjectionLedgerReceiptLink: { injectionLedgerTaskId: TASK_ID },
				},
			]);
			expect(notified.map((entry) => entry.taskId)).toEqual([target]);
		},
	);

	it.each(["unknown-session", "foreign-session"])("拒绝目标 %s，不建账本或队列", async (attemptId) => {
		testWorkspaceState.sessions["foreign-session"] = createSessionSummary("foreign-session", "other-task");
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				createDeps().deps,
				WORKSPACE_ID,
				request({ attemptId }),
			),
		).toMatchObject({ ok: false });
		expect(await readLedgerRecord()).toBeNull();
		expect((await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId).toEqual({});
	});

	it("缺少卡片或默认主会话时拒绝，不回退原会话", async () => {
		selectIndependentMain("missing-main");
		delete testWorkspaceState.sessions["missing-main"];
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(createDeps().deps, WORKSPACE_ID, request()),
		).toMatchObject({ ok: false });
		testWorkspaceState.board.columns = [];
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(createDeps().deps, WORKSPACE_ID, request()),
		).toMatchObject({ ok: false });
		expect(await readLedgerRecord()).toBeNull();
	});

	it("受理后换主会话：重试不重绑，显式改目标冲突，取消仍按卡片寻址", async () => {
		selectIndependentMain("original-main");
		const { deps } = createDeps();
		await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request());
		const originalRecord = await readLedgerRecord();
		selectIndependentMain("replacement-main");
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request())).toMatchObject({
			injectionLedgerRecordDisposition: "already_existed",
		});
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				deps,
				WORKSPACE_ID,
				request({ attemptId: "replacement-main" }),
			),
		).toMatchObject({ ok: false, idempotencyConflict: true });
		expect(await readLedgerRecord()).toEqual(originalRecord);
		expect(
			(await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).entriesByTaskId["replacement-main"],
		).toBeUndefined();
		expect(await cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle(deps, WORKSPACE_ID, TASK_ID, KEY)).toBe(
			"cancelled_before_delivery",
		);
		expect(await readLedgerRecord()).toMatchObject({
			attempt_id: "original-main",
			terminal_delivery_failure_reason: "cancelled_before_delivery",
		});
	});

	it("原生身份与 incarnation 校验针对显式目标，不跟随另一条主会话", async () => {
		selectIndependentMain("current-main");
		const target = {
			...createSessionSummary("explicit-target", TASK_ID),
			runtimeSessionIncarnationId: "target-incarnation",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native-target",
				transcriptPath: null,
				observedAt: NOW,
			},
		};
		testWorkspaceState.sessions[target.taskId] = target;
		const deps = {
			...createDeps().deps,
			getTaskSessionSummary: (id: string) => (id === target.taskId ? target : null),
		};
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				deps,
				WORKSPACE_ID,
				request({ attemptId: target.taskId, requiredNativeIndependentUserTurnSessionId: "native-target" }),
			),
		).toMatchObject({ ok: true });
		expect(await readLedgerRecord()).toMatchObject({
			attempt_id: target.taskId,
			required_native_independent_user_turn_session_incarnation_id: "target-incarnation",
		});
	});

	it("一次调用里建 pending 门控记录 + 排进队列，并通知出队引擎", async () => {
		const { deps, notified } = createDeps();
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request())).toEqual({
			ok: true,
			injectionLedgerRecordDisposition: "created",
		});
		expect(await readLedgerRecord()).toMatchObject({
			source: "rvf",
			prompt_sha256: "sha-1",
			message_id: `terminal:${TASK_ID}:${KEY}`,
			terminal_delivery_status: "accepted_pending_submit_confirmation",
			agent_idle_wait_deadline_at: new Date(NOW + TEN_MINUTES_MS).toISOString(),
			agent_idle_gated_queue_entry_id: QUEUE_ENTRY_ID,
		});
		expect(await readEntries()).toMatchObject([
			{ queueEntryId: QUEUE_ENTRY_ID, deliveryState: "queued", expiresAt: NOW + TEN_MINUTES_MS },
		]);
		expect(notified.map((notification) => notification.taskId)).toEqual([TASK_ID]);
	});

	it("入队已 durable 之后通知出队引擎抛错 ⇒ 仍 ok:true，账本保持 pending、队列条目在（兜底 sweep 会捡起）", async () => {
		const depsWhoseQueueMutationNotificationThrows = {
			now: () => NOW,
			notifyQueueMutated: async () => {
				throw new Error("projection broadcast failed");
			},
		};
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				depsWhoseQueueMutationNotificationThrows,
				WORKSPACE_ID,
				request(),
			),
		).toEqual({ ok: true, injectionLedgerRecordDisposition: "created" });
		const ledgerRecordAfterNotificationFailure = await readLedgerRecord();
		expect(ledgerRecordAfterNotificationFailure?.terminal_delivery_status).toBe(
			"accepted_pending_submit_confirmation",
		);
		expect(ledgerRecordAfterNotificationFailure?.terminal_delivery_failure_reason).toBeUndefined();
		expect(await readEntries()).toMatchObject([{ queueEntryId: QUEUE_ENTRY_ID, deliveryState: "queued" }]);
	});

	it("同 key 同正文重发 ⇒ already_existed，不排第二条、截止时刻不续命", async () => {
		await enqueueAgentIdleGatedProgrammaticTaskChatMessage(createDeps().deps, WORKSPACE_ID, request());
		const later = createDeps(NOW + 5 * 60 * 1000);
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				later.deps,
				WORKSPACE_ID,
				request({ maxWaitForAgentIdleMs: TEN_MINUTES_MS * 6 }),
			),
		).toEqual({ ok: true, injectionLedgerRecordDisposition: "already_existed" });
		expect(await readEntries()).toHaveLength(1);
		expect((await readEntries())[0]?.expiresAt).toBe(NOW + TEN_MINUTES_MS);
		expect((await readLedgerRecord())?.agent_idle_wait_deadline_at).toBe(
			new Date(NOW + TEN_MINUTES_MS).toISOString(),
		);
	});

	it("上一次在「建记录」与「入队」之间被打断 ⇒ 重发不补排（入口分不清这与「已送达、条目已被裁掉」），记录留给账本清扫收敛", async () => {
		await withTaskMessageInjectionLedgerLock<null>(ledgerPath(), async (records) => ({
			records: [
				...records,
				createPendingTaskMessageInjectionRecord({
					taskId: TASK_ID,
					source: "rvf",
					idempotencyKey: KEY,
					promptSha256: "sha-1",
					nowIso: new Date(NOW).toISOString(),
					agentIdleGate: {
						waitDeadlineAtIso: new Date(NOW + TEN_MINUTES_MS).toISOString(),
						queueEntryId: QUEUE_ENTRY_ID,
					},
				}),
			],
			result: null,
		}));
		const { deps, notified } = createDeps(NOW + 1_000);
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request())).toEqual({
			ok: true,
			injectionLedgerRecordDisposition: "already_existed",
		});
		expect(await readEntries()).toEqual([]);
		expect(notified).toEqual([]);
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
	});

	it("已送达、落定镜像写账本丢了、终态条目又被 Dismiss ⇒ 同 key 重发不重新入队（否则同一段话送两遍）", async () => {
		await enqueueAgentIdleGatedProgrammaticTaskChatMessage(createDeps().deps, WORKSPACE_ID, request());
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 1,
		});
		await markQueuedTaskPromptDeliveryHandedToTransport({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: [QUEUE_ENTRY_ID],
			dispatchIdempotencyKey: KEY,
			nowEpochMs: NOW + 2,
		});
		await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: [QUEUE_ENTRY_ID],
			settlement: {
				outcome: "delivered",
				failureNote: null,
				terminalDeliveryReceiptForInjectionLedger: { status: "delivered_and_submit_confirmed", reason: null },
			},
			nowEpochMs: NOW + 3,
		});
		// 模拟「落定镜像写账本失败」：把账本那条改回 pending（镜像写成功时它已是 delivered_and_submit_confirmed）。
		await withTaskMessageInjectionLedgerLock<null>(ledgerPath(), async (records) => ({
			records: records.map((record) =>
				record.idempotency_key === KEY
					? createPendingTaskMessageInjectionRecord({
							taskId: TASK_ID,
							source: "rvf",
							idempotencyKey: KEY,
							promptSha256: "sha-1",
							nowIso: new Date(NOW).toISOString(),
							agentIdleGate: {
								waitDeadlineAtIso: new Date(NOW + TEN_MINUTES_MS).toISOString(),
								queueEntryId: QUEUE_ENTRY_ID,
							},
						})
					: record,
			),
			result: null,
		}));
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "dismiss_settled_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: QUEUE_ENTRY_ID },
			NOW + 4,
		);
		expect(await readEntries()).toEqual([]);

		const { deps, notified } = createDeps(NOW + 5);
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request())).toEqual({
			ok: true,
			injectionLedgerRecordDisposition: "already_existed",
		});
		expect(await readEntries()).toEqual([]);
		expect(notified).toEqual([]);
	});

	it("同 key 不同正文 ⇒ 幂等冲突，什么都不动", async () => {
		await enqueueAgentIdleGatedProgrammaticTaskChatMessage(createDeps().deps, WORKSPACE_ID, request());
		const conflict = await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
			createDeps().deps,
			WORKSPACE_ID,
			request({ promptSha256: "sha-2" }),
		);
		expect(conflict).toMatchObject({ ok: false, idempotencyConflict: true });
		expect(await readEntries()).toHaveLength(1);
	});

	it("同 key 早先是一条立即投递 ⇒ 幂等返回，不排队", async () => {
		await withTaskMessageInjectionLedgerLock<null>(ledgerPath(), async (records) => ({
			records: [
				...records,
				createPendingTaskMessageInjectionRecord({
					taskId: TASK_ID,
					source: "rvf",
					idempotencyKey: KEY,
					promptSha256: "sha-1",
					nowIso: new Date(NOW).toISOString(),
				}),
			],
			result: null,
		}));
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(createDeps().deps, WORKSPACE_ID, request()),
		).toEqual({
			ok: true,
			injectionLedgerRecordDisposition: "already_existed",
		});
		expect(await readEntries()).toEqual([]);
	});

	it.each([
		["空正文", { text: "  " }],
		["等待上限超过 24h", { maxWaitForAgentIdleMs: MAX_WAIT_FOR_AGENT_IDLE_UPPER_BOUND_MS + 1 }],
		["缺 source", { source: " " }],
	])("%s ⇒ ok:false，不留账本记录", async (_label, overrides) => {
		const response = await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
			createDeps().deps,
			WORKSPACE_ID,
			request(overrides),
		);
		expect(response.ok).toBe(false);
		expect(await readLedgerRecord()).toBeNull();
	});

	it("队列满 ⇒ ok（记录已建），账本当场落 agent_idle_gated_delivery_queue_capacity_exhausted", async () => {
		for (let index = 0; index < MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK; index += 1) {
			await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, {
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: TASK_ID,
				queueEntryId: `human-${index}`,
				text: "人排的",
			});
		}
		expect(
			(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(createDeps().deps, WORKSPACE_ID, request())).ok,
		).toBe(true);
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "agent_idle_gated_delivery_queue_capacity_exhausted",
		});
	});
});

describe("cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle", () => {
	it("还在等空闲 ⇒ 撤下、账本 cancelled_before_delivery", async () => {
		const { deps } = createDeps();
		await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request());
		expect(await cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle(deps, WORKSPACE_ID, TASK_ID, KEY)).toBe(
			"cancelled_before_delivery",
		);
		expect((await readEntries())[0]?.deliveryState).toBe("cancelled");
		expect(await readLedgerRecord()).toMatchObject({
			terminal_delivery_status: "delivery_failed",
			terminal_delivery_failure_reason: "cancelled_before_delivery",
		});
	});

	it("已交给终端投递 ⇒ null（交给 PTY 取消），队列与账本都不动", async () => {
		const { deps } = createDeps();
		await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request());
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 1,
		});
		await markQueuedTaskPromptDeliveryHandedToTransport({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: [QUEUE_ENTRY_ID],
			dispatchIdempotencyKey: KEY,
			nowEpochMs: NOW + 2,
		});
		expect(
			await cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle(deps, WORKSPACE_ID, TASK_ID, KEY),
		).toBeNull();
		expect((await readEntries())[0]?.deliveryState).toBe("handed_to_transport");
		expect((await readLedgerRecord())?.terminal_delivery_status).toBe("accepted_pending_submit_confirmation");
	});

	it("队列里没有这个 key（立即投递）⇒ null", async () => {
		expect(
			await cancelProgrammaticTaskChatMessageStillAwaitingAgentIdle(
				createDeps().deps,
				WORKSPACE_ID,
				TASK_ID,
				"other",
			),
		).toBeNull();
	});
	it("严格要求持久绑定session和incarnation，同key不能去掉或改写要求；重启后同key不重新投递", async () => {
		let summary: RuntimeTaskSessionSummary | null = {
			...createSessionSummary(TASK_ID),
			runtimeSessionIncarnationId: "original-incarnation",
			agentNativeConversationSessionIdentity: {
				nativeSessionId: "native",
				sourceAgentId: "codex",
				transcriptPath: null,
				observedAt: NOW,
			},
		};
		const deps = { ...createDeps().deps, getTaskSessionSummary: () => summary };
		const strict = request({ requiredNativeIndependentUserTurnSessionId: "native" });
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, strict)).toMatchObject({
			ok: true,
			injectionLedgerRecordDisposition: "created",
		});
		expect(await readLedgerRecord()).toMatchObject({
			required_native_independent_user_turn_session_id: "native",
			required_native_independent_user_turn_session_incarnation_id: "original-incarnation",
		});
		expect((await readEntries())[0]).toMatchObject({
			requiredNativeIndependentUserTurnSessionId: "native",
			requiredNativeIndependentUserTurnSessionIncarnationId: "original-incarnation",
		});
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, request())).toMatchObject({
			ok: false,
			idempotencyConflict: true,
		});
		expect(
			await enqueueAgentIdleGatedProgrammaticTaskChatMessage(
				deps,
				WORKSPACE_ID,
				request({ requiredNativeIndependentUserTurnSessionId: "other" }),
			),
		).toMatchObject({ ok: false, idempotencyConflict: true });
		summary = null;
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, strict)).toMatchObject({
			ok: true,
			injectionLedgerRecordDisposition: "already_existed",
		});
		expect(await readEntries()).toHaveLength(1);
		await recordTaskMessageTerminalDeliveryOutcome({
			ledgerPath: ledgerPath(),
			taskId: TASK_ID,
			idempotencyKey: KEY,
			status: "delivered_and_submit_confirmed",
			nowIso: new Date(NOW + 1000).toISOString(),
		});
		const terminalBefore = await readLedgerRecord();
		expect(await enqueueAgentIdleGatedProgrammaticTaskChatMessage(deps, WORKSPACE_ID, strict)).toMatchObject({
			ok: true,
			injectionLedgerRecordDisposition: "already_existed",
		});
		expect(await readLedgerRecord()).toEqual(terminalBefore);
		expect(await readEntries()).toHaveLength(1);
	});
});
