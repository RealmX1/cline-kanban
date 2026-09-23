import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	QueuedTaskPromptDeliveryEntry,
	QueuedTaskPromptDeliveryMutation,
	WorkspaceQueuedTaskPromptDeliverySnapshot,
} from "../../../src/core/api-contract";
import { QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS } from "../../../src/core/queued-task-prompt-delivery-dispatch-eligibility";
import { getThisRuntimeProcessInstanceId } from "../../../src/state/runtime-process-instance-heartbeat-registry";

// 队列文件落在 ~/.cline/kanban/workspaces/<id>/ 之下，路径由 workspace-state 解析。测试把这两个解析点
// 重定向到临时目录，而不是去动 homedir()——后者会让本套件在用户真实排着的队列上跑。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
	getWorkspaceDirectoryPath: (workspaceId: string) => join(testRuntimeHome.path, "workspaces", workspaceId),
	getWorkspacesRootPath: () => join(testRuntimeHome.path, "workspaces"),
}));

const {
	applyQueuedTaskPromptDeliveryMutation,
	claimNextQueuedTaskPromptDeliveryRunForDispatch,
	computeQueuedTaskPromptDeliveryTextSha256,
	discardQueuedTaskPromptDeliveriesForTasks,
	getWorkspaceQueuedTaskPromptDeliveriesPath,
	isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask,
	isQueuedTaskPromptDeliveryQueueFullForTask,
	isQueuedTaskPromptDeliveryWorkspaceQueueFull,
	MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK,
	MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_WORKSPACE,
	MAX_QUEUED_TASK_PROMPT_DELIVERY_ATTEMPTS,
	markQueuedTaskPromptDeliveryHandedToTransport,
	mutateWorkspaceQueuedTaskPromptDeliveries,
	readWorkspaceQueuedTaskPromptDeliverySnapshot,
	releaseQueuedTaskPromptDeliveryClaim,
	settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart,
	settleQueuedTaskPromptDelivery,
	stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart,
} = await import("../../../src/state/queued-task-prompt-delivery-store");

const WORKSPACE_ID = "workspace-alpha";
const TASK_ID = "task-1";
const NOW = 1_700_000_000_000;

// 「排下这些队的那个实例已经不在了」= 一次真实重启。绝大多数盖章用例要的都是这个前提。
const NO_LIVE_RUNTIME_PROCESS_INSTANCES: ReadonlySet<string> = new Set<string>();

function emptySnapshot(): WorkspaceQueuedTaskPromptDeliverySnapshot {
	return { entriesByTaskId: {} };
}

function enqueue(queueEntryId: string, text: string): QueuedTaskPromptDeliveryMutation {
	return { kind: "enqueue_prompt_for_delivery_after_current_turn", taskId: TASK_ID, queueEntryId, text };
}

function seedSnapshot(
	specs: { queueEntryId: string; text: string }[],
	nowEpochMs = NOW,
): WorkspaceQueuedTaskPromptDeliverySnapshot {
	let snapshot = emptySnapshot();
	for (const spec of specs) {
		snapshot = applyQueuedTaskPromptDeliveryMutation(snapshot, enqueue(spec.queueEntryId, spec.text), nowEpochMs);
	}
	return snapshot;
}

function taskEntries(snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot): QueuedTaskPromptDeliveryEntry[] {
	return snapshot.entriesByTaskId[TASK_ID] ?? [];
}

function queueEntryIds(snapshot: WorkspaceQueuedTaskPromptDeliverySnapshot): string[] {
	return taskEntries(snapshot).map((entry) => entry.queueEntryId);
}

// ────────────────────────────────────────────────────────────────────────────
// 纯意图应用
// ────────────────────────────────────────────────────────────────────────────

describe("queued-task-prompt-delivery-store — 入队", () => {
	it("入队落在队尾，状态 queued，保质期从入队起算", () => {
		const snapshot = seedSnapshot([{ queueEntryId: "q1", text: "跑测试" }]);
		expect(taskEntries(snapshot)).toHaveLength(1);
		expect(taskEntries(snapshot)[0]).toMatchObject({
			queueEntryId: "q1",
			text: "跑测试",
			deliveryState: "queued",
			deliverTogetherWithNextQueuedEntry: false,
			enqueuedAt: NOW,
			expiresAt: NOW + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
			survivedRuntimeRestartAtEpochMs: null,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		});
	});

	// 网络重试 / 双击不该排出两条。
	it("同一个 queueEntryId 重复入队是幂等的", () => {
		const once = seedSnapshot([{ queueEntryId: "q1", text: "跑测试" }]);
		const twice = applyQueuedTaskPromptDeliveryMutation(once, enqueue("q1", "改过的文"), NOW + 1_000);
		expect(twice).toBe(once);
	});

	// 正文入队即冻结：库里那条随后被改，队列里发出去的仍是用户当初排的那份。
	it("正文是快照，不随后续 mutation 变化", () => {
		let snapshot = seedSnapshot([{ queueEntryId: "q1", text: "原始正文" }]);
		snapshot = applyQueuedTaskPromptDeliveryMutation(snapshot, enqueue("q2", "另一条"), NOW + 1);
		expect(taskEntries(snapshot)[0].text).toBe("原始正文");
	});
});

describe("queued-task-prompt-delivery-store — 来源 prompt 的 sha", () => {
	// 「库里那条后来被改过没有」比对的是入队这一刻的冻结正文。让浏览器去做 SHA 只是多一处可能算错的地方。
	it("带来源条目、客户端没给 sha 时，由服务端按冻结正文算", () => {
		const snapshot = applyQueuedTaskPromptDeliveryMutation(
			emptySnapshot(),
			{
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: TASK_ID,
				queueEntryId: "q1",
				text: "跑测试",
				sourcePromptLibraryEntryId: "prompt-7",
			},
			NOW,
		);
		expect(taskEntries(snapshot)[0].sourcePromptLibraryEntryTextSha256).toBe(
			computeQueuedTaskPromptDeliveryTextSha256("跑测试"),
		);
	});

	it("客户端给了 sha 就原样采用", () => {
		const snapshot = applyQueuedTaskPromptDeliveryMutation(
			emptySnapshot(),
			{
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: TASK_ID,
				queueEntryId: "q1",
				text: "跑测试",
				sourcePromptLibraryEntryId: "prompt-7",
				sourcePromptLibraryEntryTextSha256: "client-sha",
			},
			NOW,
		);
		expect(taskEntries(snapshot)[0].sourcePromptLibraryEntryTextSha256).toBe("client-sha");
	});

	it("没有来源条目时不算——没有东西可比", () => {
		const snapshot = applyQueuedTaskPromptDeliveryMutation(emptySnapshot(), enqueue("q1", "跑测试"), NOW);
		expect(taskEntries(snapshot)[0].sourcePromptLibraryEntryTextSha256).toBeNull();
	});

	// 与 `kanban task message` 的 promptSha256 同一口径（utf8 字节的 sha256 hex）。
	it("口径是 utf8 字节的 sha256 hex", () => {
		expect(computeQueuedTaskPromptDeliveryTextSha256("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("queued-task-prompt-delivery-store — 取消", () => {
	it("取消 queued 条目落 cancelled 并盖 settledAt", () => {
		const seeded = seedSnapshot([{ queueEntryId: "q1", text: "A" }]);
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{ kind: "cancel_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "q1" },
			NOW + 5_000,
		);
		expect(taskEntries(next)[0]).toMatchObject({ deliveryState: "cancelled", settledAt: NOW + 5_000 });
	});

	// 已经交给 transport 的条目由 dispatcher 走既有 cancelTaskChatDelivery，回执可能是 already_delivered。
	// 在这里就地翻成 cancelled 等于对用户撒谎：那段话可能已经发出去了。
	it("已 handed_to_transport 的条目不被就地取消", () => {
		const seeded = seedSnapshot([{ queueEntryId: "q1", text: "A" }]);
		const handed = {
			entriesByTaskId: {
				[TASK_ID]: [{ ...taskEntries(seeded)[0], deliveryState: "handed_to_transport" as const }],
			},
		};
		const next = applyQueuedTaskPromptDeliveryMutation(
			handed,
			{ kind: "cancel_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "q1" },
			NOW + 5_000,
		);
		expect(taskEntries(next)[0].deliveryState).toBe("handed_to_transport");
	});
});

describe("queued-task-prompt-delivery-store — 重排", () => {
	it("按给定顺序重排", () => {
		const seeded = seedSnapshot([
			{ queueEntryId: "q1", text: "A" },
			{ queueEntryId: "q2", text: "B" },
			{ queueEntryId: "q3", text: "C" },
		]);
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{ kind: "reorder_queued_prompt_deliveries", taskId: TASK_ID, orderedQueueEntryIds: ["q3", "q1", "q2"] },
			NOW + 1_000,
		);
		expect(queueEntryIds(next)).toEqual(["q3", "q1", "q2"]);
	});

	// 客户端算这份顺序时看到的列表可能已被另一个标签页改过：不凭空造条目，也不吞掉没见过的新条目。
	it("列表里的未知 id 被忽略，服务端有而列表没有的追加到尾", () => {
		const seeded = seedSnapshot([
			{ queueEntryId: "q1", text: "A" },
			{ queueEntryId: "q2", text: "B" },
			{ queueEntryId: "q3", text: "C" },
		]);
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{
				kind: "reorder_queued_prompt_deliveries",
				taskId: TASK_ID,
				orderedQueueEntryIds: ["q2", "已被别人删掉的 id", "q1"],
			},
			NOW + 1_000,
		);
		expect(queueEntryIds(next)).toEqual(["q2", "q1", "q3"]);
	});

	it("列表里重复的 id 只取第一次出现", () => {
		const seeded = seedSnapshot([
			{ queueEntryId: "q1", text: "A" },
			{ queueEntryId: "q2", text: "B" },
		]);
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{ kind: "reorder_queued_prompt_deliveries", taskId: TASK_ID, orderedQueueEntryIds: ["q2", "q2", "q1"] },
			NOW + 1_000,
		);
		expect(queueEntryIds(next)).toEqual(["q2", "q1"]);
	});
});

describe("queued-task-prompt-delivery-store — 合并开关", () => {
	it("点亮与熄灭都只动目标条目", () => {
		const seeded = seedSnapshot([
			{ queueEntryId: "q1", text: "A" },
			{ queueEntryId: "q2", text: "B" },
		]);
		const on = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{
				kind: "set_queued_prompt_delivery_merge_with_next",
				taskId: TASK_ID,
				queueEntryId: "q1",
				deliverTogetherWithNextQueuedEntry: true,
			},
			NOW + 1_000,
		);
		expect(taskEntries(on).map((entry) => entry.deliverTogetherWithNextQueuedEntry)).toEqual([true, false]);
		const off = applyQueuedTaskPromptDeliveryMutation(
			on,
			{
				kind: "set_queued_prompt_delivery_merge_with_next",
				taskId: TASK_ID,
				queueEntryId: "q1",
				deliverTogetherWithNextQueuedEntry: false,
			},
			NOW + 2_000,
		);
		expect(taskEntries(off).map((entry) => entry.deliverTogetherWithNextQueuedEntry)).toEqual([false, false]);
	});
});

describe("queued-task-prompt-delivery-store — 终态条目的 dismiss / retry", () => {
	function withFailedEntry(): WorkspaceQueuedTaskPromptDeliverySnapshot {
		const seeded = seedSnapshot([{ queueEntryId: "q1", text: "A" }]);
		return {
			entriesByTaskId: {
				[TASK_ID]: [
					{
						...taskEntries(seeded)[0],
						deliveryState: "settled_failed" as const,
						settledAt: NOW + 1_000,
						deliveryAttemptCount: 3,
						lastDeliveryFailureNote: "输入框争用超时",
						dispatchIdempotencyKey: "old-key",
					},
				],
			},
		};
	}

	it("dismiss 只丢终态条目", () => {
		const next = applyQueuedTaskPromptDeliveryMutation(
			withFailedEntry(),
			{ kind: "dismiss_settled_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "q1" },
			NOW + 2_000,
		);
		expect(taskEntries(next)).toHaveLength(0);
	});

	// 误传一个还在排队的 id 不该把它抹掉——那是「取消」的语义。
	it("dismiss 对仍在排队的条目无效", () => {
		const seeded = seedSnapshot([{ queueEntryId: "q1", text: "A" }]);
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{ kind: "dismiss_settled_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "q1" },
			NOW + 2_000,
		);
		expect(queueEntryIds(next)).toEqual(["q1"]);
	});

	it("retry 排出一条全新条目、清空尝试痕迹，并保留原失败条目供对照", () => {
		const next = applyQueuedTaskPromptDeliveryMutation(
			withFailedEntry(),
			{
				kind: "retry_settled_failed_queued_prompt_delivery",
				taskId: TASK_ID,
				queueEntryId: "q1",
				replacementQueueEntryId: "q1-retry",
			},
			NOW + 2_000,
		);
		expect(queueEntryIds(next)).toEqual(["q1", "q1-retry"]);
		expect(taskEntries(next)[0].deliveryState).toBe("settled_failed");
		expect(taskEntries(next)[1]).toMatchObject({
			deliveryState: "queued",
			text: "A",
			deliveryAttemptCount: 0,
			dispatchIdempotencyKey: null,
			lastDeliveryFailureNote: null,
			enqueuedAt: NOW + 2_000,
			expiresAt: NOW + 2_000 + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS,
			// 人手动重排的这一刻就是「人看见了」，不该再为这条新条目要一次确认。
			survivedRuntimeRestartAtEpochMs: null,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		});
	});

	// 回归钉子：原条目重排后**仍是 settled_failed**（刻意保留供对照），所以只查原条目的话，
	// 第二次重发照样命中 → 排出两条同 id 的 queued 条目 → 按 id 认领会把它们一起认领，同一段话发两遍。
	it("retry 重发时按 replacementQueueEntryId 幂等，不排出两条同 id 条目", () => {
		const retryMutation = {
			kind: "retry_settled_failed_queued_prompt_delivery",
			taskId: TASK_ID,
			queueEntryId: "q1",
			replacementQueueEntryId: "q1-retry",
		} as const;
		const once = applyQueuedTaskPromptDeliveryMutation(withFailedEntry(), retryMutation, NOW + 2_000);
		const twice = applyQueuedTaskPromptDeliveryMutation(once, retryMutation, NOW + 3_000);
		expect(twice).toBe(once);
		expect(queueEntryIds(twice).filter((id) => id === "q1-retry")).toHaveLength(1);
	});

	it("retry 一个并非 settled_failed 的条目是无操作", () => {
		const seeded = seedSnapshot([{ queueEntryId: "q1", text: "A" }]);
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{
				kind: "retry_settled_failed_queued_prompt_delivery",
				taskId: TASK_ID,
				queueEntryId: "q1",
				replacementQueueEntryId: "q1-retry",
			},
			NOW + 2_000,
		);
		expect(next).toBe(seeded);
	});
});

describe("queued-task-prompt-delivery-store — 重启后再确认", () => {
	function stamped(): WorkspaceQueuedTaskPromptDeliverySnapshot {
		const seeded = seedSnapshot([
			{ queueEntryId: "q1", text: "A" },
			{ queueEntryId: "q2", text: "B" },
		]);
		return {
			entriesByTaskId: {
				[TASK_ID]: taskEntries(seeded).map((entry) => ({
					...entry,
					survivedRuntimeRestartAtEpochMs: NOW + 100,
				})),
			},
		};
	}

	it("只写确认时间戳，不动顺序 / 正文 / 状态", () => {
		const before = stamped();
		const next = applyQueuedTaskPromptDeliveryMutation(
			before,
			{
				kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart",
				taskId: TASK_ID,
				queueEntryIds: ["q1", "q2"],
			},
			NOW + 5_000,
		);
		expect(queueEntryIds(next)).toEqual(["q1", "q2"]);
		expect(taskEntries(next).map((entry) => entry.deliveryState)).toEqual(["queued", "queued"]);
		expect(taskEntries(next).map((entry) => entry.text)).toEqual(["A", "B"]);
		expect(taskEntries(next).map((entry) => entry.humanReconfirmedAfterRuntimeRestartAtEpochMs)).toEqual([
			NOW + 5_000,
			NOW + 5_000,
		]);
	});

	// 保留人**第一次**看见它的时刻，那才是这个字段的意义。
	it("已确认过的不被二次盖章", () => {
		const once = applyQueuedTaskPromptDeliveryMutation(
			stamped(),
			{ kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart", taskId: TASK_ID, queueEntryIds: ["q1"] },
			NOW + 5_000,
		);
		const twice = applyQueuedTaskPromptDeliveryMutation(
			once,
			{ kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart", taskId: TASK_ID, queueEntryIds: ["q1"] },
			NOW + 9_000,
		);
		expect(taskEntries(twice)[0].humanReconfirmedAfterRuntimeRestartAtEpochMs).toBe(NOW + 5_000);
	});

	it("没盖过 restart-crossing 章的条目不会被凭空写上确认时间", () => {
		const seeded = seedSnapshot([{ queueEntryId: "q1", text: "A" }]);
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{ kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart", taskId: TASK_ID, queueEntryIds: ["q1"] },
			NOW + 5_000,
		);
		expect(taskEntries(next)[0].humanReconfirmedAfterRuntimeRestartAtEpochMs).toBeNull();
	});
});

describe("queued-task-prompt-delivery-store — 过期与上限裁剪", () => {
	it("过期的 queued 条目在下一次读-改-写时收敛成 expired", () => {
		const seeded = seedSnapshot([{ queueEntryId: "q1", text: "A" }]);
		const wayLater = NOW + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS + 1;
		const next = applyQueuedTaskPromptDeliveryMutation(seeded, enqueue("q2", "B"), wayLater);
		expect(taskEntries(next)[0]).toMatchObject({ deliveryState: "expired", settledAt: wayLater });
		expect(taskEntries(next)[1].deliveryState).toBe("queued");
	});

	// per-task 上限对**队列本身**的约束由入队处拒绝承担，裁剪层一条非终态都不丢。
	it("队列排满后新入队被拒绝，且已排的一条都不丢", () => {
		let snapshot = emptySnapshot();
		for (let index = 0; index < MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK; index += 1) {
			snapshot = applyQueuedTaskPromptDeliveryMutation(snapshot, enqueue(`q${index}`, `text-${index}`), NOW + index);
		}
		expect(isQueuedTaskPromptDeliveryQueueFullForTask(snapshot, TASK_ID)).toBe(true);
		const rejected = applyQueuedTaskPromptDeliveryMutation(snapshot, enqueue("overflow", "排不进去"), NOW + 999);
		expect(rejected).toBe(snapshot);
		expect(queueEntryIds(snapshot)).toHaveLength(MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK);
		expect(queueEntryIds(snapshot)[0]).toBe("q0");
	});

	// 回归钉子（reviewer 双方独立报出的 high）：终态条目落定后原地保留 24h 供 UI 展示，于是一个任务
	// 在一天内正常发过 20 条 prompt 之后，队首起就摆着 20 条终态记录。曾经的 `slice(0, 20)` 会把用户
	// 新排的那条追加到队尾后当场裁掉——没有错误、没有痕迹。24h 内发 20 条是正常用量，不是边角情况。
	it("终态条目占满上限时，新入队仍排得进来，被裁的是最老的终态条目", () => {
		let snapshot = emptySnapshot();
		for (let index = 0; index < MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK; index += 1) {
			snapshot = applyQueuedTaskPromptDeliveryMutation(
				snapshot,
				enqueue(`old${index}`, `t${index}`),
				NOW + index * 2,
			);
			snapshot = applyQueuedTaskPromptDeliveryMutation(
				snapshot,
				{ kind: "cancel_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: `old${index}` },
				NOW + index * 2 + 1,
			);
		}
		expect(taskEntries(snapshot).every((entry) => entry.deliveryState === "cancelled")).toBe(true);
		// 全是终态 ⇒ 队列并没有满，入队必须成功。
		expect(isQueuedTaskPromptDeliveryQueueFullForTask(snapshot, TASK_ID)).toBe(false);
		const next = applyQueuedTaskPromptDeliveryMutation(snapshot, enqueue("BRAND-NEW", "用户刚排的"), NOW + 100_000);
		expect(queueEntryIds(next)).toContain("BRAND-NEW");
		// 被牺牲的是最老的那条终态记录，不是用户刚排的意图。
		expect(queueEntryIds(next)).not.toContain("old0");
		expect(queueEntryIds(next)).toHaveLength(MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK);
	});

	it("非终态条目在任何裁剪路径下都不被丢弃（哪怕因此超限）", () => {
		const overCapEntries = Array.from(
			{ length: MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK + 3 },
			(_unused, index) => ({
				...seedSnapshot([{ queueEntryId: `q${index}`, text: `t${index}` }]).entriesByTaskId[TASK_ID][0],
				queueEntryId: `q${index}`,
			}),
		);
		// 直接构造一份已经超限的全非终态快照（模拟历史数据 / 上限调小），再走一次读-改-写。
		const seeded = { entriesByTaskId: { [TASK_ID]: overCapEntries } };
		const next = applyQueuedTaskPromptDeliveryMutation(
			seeded,
			{ kind: "reorder_queued_prompt_deliveries", taskId: TASK_ID, orderedQueueEntryIds: [] },
			NOW + 1_000,
		);
		expect(queueEntryIds(next)).toHaveLength(overCapEntries.length);
	});

	// workspace 级溢出裁剪此前零断言，而正是这个缺口放过了上面那条 high。
	it("workspace 级溢出按最老的终态条目先走裁，非终态一条不动", () => {
		const entriesByTaskId: Record<string, QueuedTaskPromptDeliveryEntry[]> = {};
		const template = seedSnapshot([{ queueEntryId: "seed", text: "x" }]).entriesByTaskId[TASK_ID][0];
		// 30 个任务 × 8 条终态 = 240 条，超过 workspace 上限 200。
		for (let taskIndex = 0; taskIndex < 30; taskIndex += 1) {
			entriesByTaskId[`task-${taskIndex}`] = Array.from({ length: 8 }, (_unused, entryIndex) => ({
				...template,
				taskId: `task-${taskIndex}`,
				queueEntryId: `t${taskIndex}-e${entryIndex}`,
				deliveryState: "settled_delivered" as const,
				settledAt: NOW + taskIndex * 100 + entryIndex,
			}));
		}
		// 外加一条非终态，它必须活下来。
		entriesByTaskId["task-live"] = [{ ...template, taskId: "task-live", queueEntryId: "live-1" }];
		const next = applyQueuedTaskPromptDeliveryMutation(
			{ entriesByTaskId },
			{
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: "task-live",
				queueEntryId: "live-2",
				text: "y",
			},
			NOW + 500_000,
		);
		const totalRetained = Object.values(next.entriesByTaskId).reduce((sum, list) => sum + list.length, 0);
		expect(totalRetained).toBeLessThanOrEqual(MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_WORKSPACE);
		expect(next.entriesByTaskId["task-live"].map((entry) => entry.queueEntryId)).toEqual(["live-1", "live-2"]);
		// 最老的终态先走：task-0 的那批必然先被裁。
		expect(next.entriesByTaskId["task-0"] ?? []).toHaveLength(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// IO 与 dispatcher 原子操作
// ────────────────────────────────────────────────────────────────────────────

describe("queued-task-prompt-delivery-store — 持久化与并发", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-queued-prompt-store-"));
		await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("写入后可读回；文件不存在时读成空队列", async () => {
		expect(await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID)).toEqual(emptySnapshot());
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "跑测试"), NOW);
		const readBack = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
		expect(queueEntryIds(readBack)).toEqual(["q1"]);
	});

	// workspaceId 会一路走到 join()，一个 "../.." 就能把写操作带出 workspaces 根。
	it("路径守卫拒绝越出 workspaces 根的 workspaceId", () => {
		expect(() => getWorkspaceQueuedTaskPromptDeliveriesPath("../../escape")).toThrow(/outside workspaces root/);
	});

	it("逐条丢弃坏条目，好条目不受连累", async () => {
		const good = applyQueuedTaskPromptDeliveryMutation(emptySnapshot(), enqueue("q1", "好的"), NOW);
		await writeFile(
			getWorkspaceQueuedTaskPromptDeliveriesPath(WORKSPACE_ID),
			JSON.stringify({
				entriesByTaskId: { [TASK_ID]: [{ queueEntryId: "坏条目", 缺: "一堆必填字段" }, taskEntries(good)[0]] },
			}),
			"utf8",
		);
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
		expect(queueEntryIds(snapshot)).toEqual(["q1"]);
	});

	// 拿「读坏了 → 空队列」这份降级快照去原子覆盖损坏文件，等于把还能人工修复的状态变成不可逆的丢失。
	it("整份文件读不出来时先旁路留存原字节再写新内容", async () => {
		const queuePath = getWorkspaceQueuedTaskPromptDeliveriesPath(WORKSPACE_ID);
		await writeFile(queuePath, "{ 这不是合法 JSON", "utf8");
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "新的"), NOW);
		const workspaceDirectory = join(testRuntimeHome.path, "workspaces", WORKSPACE_ID);
		const quarantined = (await readdir(workspaceDirectory)).filter((name) =>
			name.includes("unreadable-quarantined-before-overwrite"),
		);
		expect(quarantined).toHaveLength(1);
		expect(await readFile(join(workspaceDirectory, quarantined[0]), "utf8")).toBe("{ 这不是合法 JSON");
		expect(queueEntryIds(await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID))).toEqual(["q1"]);
	});

	it("并发意图不互相覆盖（锁内读-改-写自然合并）", async () => {
		await Promise.all(
			Array.from({ length: 8 }, (_unused, index) =>
				mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue(`q${index}`, `text-${index}`), NOW + index),
			),
		);
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
		expect(queueEntryIds(snapshot).sort()).toEqual(["q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
	});

	it("认领队首：默认串长为 1，并快照会话身份双判据", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q2", "B"), NOW + 1);
		const claimed = await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 3,
			nowEpochMs: NOW + 10,
		});
		expect(claimed?.claimedEntries.map((entry) => entry.queueEntryId)).toEqual(["q1"]);
		expect(claimed?.claimedEntries[0]).toMatchObject({
			deliveryState: "claimed_for_dispatch",
			claimedForSessionIncarnationId: "incarnation-1",
			claimedAtTurnSequence: 3,
			// 认领只是占位，一个字节都还没写出去 ⇒ 此刻不该有 idempotency key。
			dispatchIdempotencyKey: null,
			deliveryAttemptCount: 0,
		});
		expect(taskEntries(claimed?.snapshot ?? emptySnapshot())[1].deliveryState).toBe("queued");
	});

	it("链住的相邻条目被一次性认领", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q2", "B"), NOW + 1);
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q3", "C"), NOW + 2);
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{
				kind: "set_queued_prompt_delivery_merge_with_next",
				taskId: TASK_ID,
				queueEntryId: "q1",
				deliverTogetherWithNextQueuedEntry: true,
			},
			NOW + 3,
		);
		const claimed = await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 10,
		});
		expect(claimed?.claimedEntries.map((entry) => entry.queueEntryId)).toEqual(["q1", "q2"]);
	});

	// durable 层的互斥：dispatcher 的内存互斥拦得住同进程重入，拦不住第二个 runtime 实例。
	it("并发认领只有一个赢", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		const [first, second] = await Promise.all([
			claimNextQueuedTaskPromptDeliveryRunForDispatch({
				workspaceId: WORKSPACE_ID,
				taskId: TASK_ID,
				sessionIncarnationId: "incarnation-1",
				turnSequence: 1,
				nowEpochMs: NOW + 10,
			}),
			claimNextQueuedTaskPromptDeliveryRunForDispatch({
				workspaceId: WORKSPACE_ID,
				taskId: TASK_ID,
				sessionIncarnationId: "incarnation-1",
				turnSequence: 1,
				nowEpochMs: NOW + 11,
			}),
		]);
		expect([first, second].filter((claim) => claim !== null)).toHaveLength(1);
	});

	it("释放认领把条目原样放回 queued，且不消耗重试预算", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 10,
		});
		const released = await releaseQueuedTaskPromptDeliveryClaim({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			nowEpochMs: NOW + 20,
		});
		expect(taskEntries(released)[0]).toMatchObject({
			deliveryState: "queued",
			claimedForSessionIncarnationId: null,
			claimedAtTurnSequence: null,
			deliveryAttemptCount: 0,
		});
	});

	it("交给 transport 时才写 idempotency key 并记一次尝试", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 10,
		});
		const handed = await markQueuedTaskPromptDeliveryHandedToTransport({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			dispatchIdempotencyKey: "idem-1",
			nowEpochMs: NOW + 20,
		});
		expect(taskEntries(handed)[0]).toMatchObject({
			deliveryState: "handed_to_transport",
			dispatchIdempotencyKey: "idem-1",
			deliveryAttemptCount: 1,
			lastAttemptedAt: NOW + 20,
		});
	});

	async function seedHandedEntry(attemptCount = 1): Promise<void> {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		for (let attempt = 0; attempt < attemptCount; attempt += 1) {
			await claimNextQueuedTaskPromptDeliveryRunForDispatch({
				workspaceId: WORKSPACE_ID,
				taskId: TASK_ID,
				sessionIncarnationId: "incarnation-1",
				turnSequence: 1,
				nowEpochMs: NOW + 10 + attempt,
			});
			await markQueuedTaskPromptDeliveryHandedToTransport({
				workspaceId: WORKSPACE_ID,
				taskId: TASK_ID,
				queueEntryIds: ["q1"],
				dispatchIdempotencyKey: `idem-${attempt}`,
				nowEpochMs: NOW + 20 + attempt,
			});
			if (attempt < attemptCount - 1) {
				await settleQueuedTaskPromptDelivery({
					workspaceId: WORKSPACE_ID,
					taskId: TASK_ID,
					queueEntryIds: ["q1"],
					settlement: { outcome: "retryable_failure", failureNote: "再来一次" },
					nowEpochMs: NOW + 30 + attempt,
				});
			}
		}
	}

	it("成功落 settled_delivered 并清掉失败说明", async () => {
		await seedHandedEntry();
		const settled = await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			settlement: { outcome: "delivered", failureNote: null },
			nowEpochMs: NOW + 40,
		});
		expect(taskEntries(settled)[0]).toMatchObject({
			deliveryState: "settled_delivered",
			settledAt: NOW + 40,
			lastDeliveryFailureNote: null,
		});
	});

	it("可重试失败回到 queued 并保留失败说明", async () => {
		await seedHandedEntry();
		const settled = await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			settlement: { outcome: "retryable_failure", failureNote: "输入框被占着" },
			nowEpochMs: NOW + 40,
		});
		expect(taskEntries(settled)[0]).toMatchObject({
			deliveryState: "queued",
			dispatchIdempotencyKey: null,
			claimedForSessionIncarnationId: null,
			lastDeliveryFailureNote: "输入框被占着",
			deliveryAttemptCount: 1,
		});
	});

	// 一条注定发不出去的 prompt 不该在每个 turn 边沿都试一次、把队列变成每轮报一次错的机器。
	it("重试预算耗尽后即便是可重试失败也落 settled_failed", async () => {
		await seedHandedEntry(MAX_QUEUED_TASK_PROMPT_DELIVERY_ATTEMPTS);
		const settled = await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			settlement: { outcome: "retryable_failure", failureNote: "还是不行" },
			nowEpochMs: NOW + 100,
		});
		expect(taskEntries(settled)[0]).toMatchObject({
			deliveryState: "settled_failed",
			deliveryAttemptCount: MAX_QUEUED_TASK_PROMPT_DELIVERY_ATTEMPTS,
		});
	});

	// 用户在它已经交给 transport 之后点了取消、transport 也确认拦下了：那是用户自己要的结果，
	// 显示成「发送失败 · 重新排队？」是在反问他。
	it("取消落 cancelled（不是 settled_failed），且不留失败说明", async () => {
		await seedHandedEntry();
		const settled = await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			settlement: { outcome: "cancelled", failureNote: null },
			nowEpochMs: NOW + 40,
		});
		expect(taskEntries(settled)[0]).toMatchObject({
			deliveryState: "cancelled",
			settledAt: NOW + 40,
			lastDeliveryFailureNote: null,
		});
	});

	// 回执可能来自一条早已被取代的在途投递。
	it("终态写一次即定：第二次回执改不动已落定的条目", async () => {
		await seedHandedEntry();
		await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			settlement: { outcome: "delivered", failureNote: null },
			nowEpochMs: NOW + 40,
		});
		const again = await settleQueuedTaskPromptDelivery({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			settlement: { outcome: "terminal_failure", failureNote: "迟到的失败回执" },
			nowEpochMs: NOW + 50,
		});
		expect(taskEntries(again)[0]).toMatchObject({
			deliveryState: "settled_delivered",
			settledAt: NOW + 40,
			lastDeliveryFailureNote: null,
		});
	});
});

describe("queued-task-prompt-delivery-store — restart-crossing 盖章", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-queued-prompt-stamp-"));
		await mkdir(join(testRuntimeHome.path, "workspaces", WORKSPACE_ID), { recursive: true });
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("给本进程启动之前入队的非终态条目盖章", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		const { snapshot, stampedCount } = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			liveRuntimeProcessInstanceIds: NO_LIVE_RUNTIME_PROCESS_INSTANCES,
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 2_000,
		});
		expect(stampedCount).toBe(1);
		expect(taskEntries(snapshot)[0].survivedRuntimeRestartAtEpochMs).toBe(NOW + 2_000);
	});

	// 这一条就是「补心跳」要买到的东西：常驻实例正排着队，另一个实例（dev:full / dogfood / 集成测试）
	// 启动并跑清扫时，绝不能把人家的队盖成 restart-crossing。判据不是「谁比谁老」，而是「托管它的那个
	// 实例此刻还在不在心跳里」。
	it("托管者仍活着时不盖章（同机多实例不再误标）", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		const { stampedCount, snapshot } = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: "another-instance-starting-alongside",
			// 条目比「本进程」老（老口径会盖章），但托管它的实例还在心跳里。
			liveRuntimeProcessInstanceIds: new Set([getThisRuntimeProcessInstanceId()]),
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 2_000,
		});
		expect(stampedCount).toBe(0);
		expect(taskEntries(snapshot)[0].survivedRuntimeRestartAtEpochMs).toBeNull();
	});

	it("入队时记下托管它的 runtime 进程实例", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		const snapshot = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
		expect(taskEntries(snapshot)[0].custodianRuntimeProcessInstanceId).toBe(getThisRuntimeProcessInstanceId());
	});

	// 升级前存下的条目缺归属字段。对它们退回按年龄的老口径——多盖章（fail-safe），绝不漏盖。
	it("没有托管者的旧条目退回按年龄判，且仍会被盖章", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		const seeded = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
		await writeFile(
			getWorkspaceQueuedTaskPromptDeliveriesPath(WORKSPACE_ID),
			JSON.stringify({
				entriesByTaskId: {
					[TASK_ID]: taskEntries(seeded).map((entry) => {
						const { custodianRuntimeProcessInstanceId: _dropped, ...withoutOwner } = entry;
						return withoutOwner;
					}),
				},
			}),
			"utf8",
		);
		const { stampedCount } = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			// 心跳里「什么都活着」也拦不住它——旧条目根本没有托管者可比，只能按年龄判。
			liveRuntimeProcessInstanceIds: new Set([getThisRuntimeProcessInstanceId()]),
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 2_000,
		});
		expect(stampedCount).toBe(1);
	});

	// 回归钉子（reviewer codex-cli 报的 medium）：所有权若从不转移，条目就**永久归属那个已经死掉的
	// 原始实例**，于是任何一个「启动时刻晚于上次盖章」的并存实例都会再判一次 owner 不活跃、重新盖章并
	// 清空用户刚做的确认——正是补心跳要消除的多实例误标，只是换了个触发条件卷土重来。
	it("盖章后托管权转移给当前实例，后起的并存实例不再重复盖章、不清掉已有确认", async () => {
		const DEAD_ORIGINAL_INSTANCE = "instance-that-enqueued-then-died";
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		// 把归属改成一个已经死掉的实例，模拟「A 排的队，A 随后挂了」。
		const seeded = await readWorkspaceQueuedTaskPromptDeliverySnapshot(WORKSPACE_ID);
		await writeFile(
			getWorkspaceQueuedTaskPromptDeliveriesPath(WORKSPACE_ID),
			JSON.stringify({
				entriesByTaskId: {
					[TASK_ID]: taskEntries(seeded).map((entry) => ({
						...entry,
						custodianRuntimeProcessInstanceId: DEAD_ORIGINAL_INSTANCE,
					})),
				},
			}),
			"utf8",
		);
		// 实例 B 启动、清扫：原 custodian 已死 ⇒ 盖章，并接管托管权。
		const afterB = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: "instance-B",
			liveRuntimeProcessInstanceIds: new Set(["instance-B"]),
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 2_000,
		});
		expect(afterB.stampedCount).toBe(1);
		expect(taskEntries(afterB.snapshot)[0].custodianRuntimeProcessInstanceId).toBe("instance-B");
		// 用户确认。
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart", taskId: TASK_ID, queueEntryIds: ["q1"] },
			NOW + 3_000,
		);
		// 实例 C（dev:full / dogfood）在 B 仍活着时启动并清扫：托管者 B 活着 ⇒ 什么都不该动。
		const afterC = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: "instance-C",
			liveRuntimeProcessInstanceIds: new Set(["instance-B", "instance-C"]),
			runtimeProcessStartedAtEpochMs: NOW + 10_000,
			nowEpochMs: NOW + 11_000,
		});
		expect(afterC.stampedCount).toBe(0);
		expect(taskEntries(afterC.snapshot)[0]).toMatchObject({
			custodianRuntimeProcessInstanceId: "instance-B",
			humanReconfirmedAfterRuntimeRestartAtEpochMs: NOW + 3_000,
		});
		// 而 B 真的死掉之后，D 启动仍然照常盖章并清确认（真实重启不能被漏掉）。
		const afterD = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: "instance-D",
			liveRuntimeProcessInstanceIds: new Set(["instance-D"]),
			runtimeProcessStartedAtEpochMs: NOW + 20_000,
			nowEpochMs: NOW + 21_000,
		});
		expect(afterD.stampedCount).toBe(1);
		expect(taskEntries(afterD.snapshot)[0]).toMatchObject({
			custodianRuntimeProcessInstanceId: "instance-D",
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		});
	});

	it("终态条目不盖章（它们已经不会再发出去了）", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "cancel_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "q1" },
			NOW + 100,
		);
		const { stampedCount } = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			liveRuntimeProcessInstanceIds: NO_LIVE_RUNTIME_PROCESS_INSTANCES,
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 2_000,
		});
		expect(stampedCount).toBe(0);
	});

	// 回归钉子（reviewer oh-my-pi 报的 high）：曾经的判据是「survivedRuntimeRestartAtEpochMs 非 null 即跳过」，
	// 一辈子只盖一次。于是重启 #2 时条目仍带着 #1 的章 → 跳过盖章，而 humanReconfirmed 又还留着
	// → 门控 0 直接放行。用户第二次重启后**一次提醒都没有**，队列照发——而「重启后先提醒人」正是
	// 这套机制存在的全部理由。
	it("第二次真实重启会重新盖章，并清掉上一次重启的人工确认", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		// 重启 #1：盖章 → 用户确认
		await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			liveRuntimeProcessInstanceIds: NO_LIVE_RUNTIME_PROCESS_INSTANCES,
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 2_000,
		});
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart", taskId: TASK_ID, queueEntryIds: ["q1"] },
			NOW + 3_000,
		);
		// 重启 #2：一个**新的**进程启动时刻
		const { stampedCount, snapshot } = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			liveRuntimeProcessInstanceIds: NO_LIVE_RUNTIME_PROCESS_INSTANCES,
			runtimeProcessStartedAtEpochMs: NOW + 10_000,
			nowEpochMs: NOW + 11_000,
		});
		expect(stampedCount).toBe(1);
		expect(taskEntries(snapshot)[0]).toMatchObject({
			survivedRuntimeRestartAtEpochMs: NOW + 11_000,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: null,
		});
	});

	it("同一进程内重复清扫仍然幂等（不重复盖、不抹掉本轮已有的确认）", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			liveRuntimeProcessInstanceIds: NO_LIVE_RUNTIME_PROCESS_INSTANCES,
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 2_000,
		});
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "reconfirm_queued_prompt_deliveries_after_runtime_restart", taskId: TASK_ID, queueEntryIds: ["q1"] },
			NOW + 3_000,
		);
		// 同一个 runtimeProcessStartedAtEpochMs ⇒ 同一进程的第二趟清扫（延迟复扫）
		const { stampedCount, snapshot } = await stampQueuedTaskPromptDeliveriesThatSurvivedRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			sweepingRuntimeProcessInstanceId: getThisRuntimeProcessInstanceId(),
			liveRuntimeProcessInstanceIds: NO_LIVE_RUNTIME_PROCESS_INSTANCES,
			runtimeProcessStartedAtEpochMs: NOW + 1_000,
			nowEpochMs: NOW + 4_000,
		});
		expect(stampedCount).toBe(0);
		expect(taskEntries(snapshot)[0]).toMatchObject({
			survivedRuntimeRestartAtEpochMs: NOW + 2_000,
			humanReconfirmedAfterRuntimeRestartAtEpochMs: NOW + 3_000,
		});
	});

	// 回归钉子（reviewer kimi-code 报的 medium）：runtime 在 handed_to_transport 与回执之间崩溃后，
	// 认领门会被这条僵尸条目永远挡住，而 cancel（只覆盖 queued/claimed）、dismiss（只覆盖终态）、
	// reconfirm（只写时间戳）对它全部无效 —— 该 task 的队列就此永久卡死。
	it("僵尸在途条目会被启动清扫收敛，队列不再永久卡死", async () => {
		const BUDGET_MS = 200_000;
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 10,
		});
		await markQueuedTaskPromptDeliveryHandedToTransport({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			dispatchIdempotencyKey: "idem-1",
			nowEpochMs: NOW + 20,
		});
		// 崩溃前：用户三条出路对它全部无效，且新条目认领不动。
		for (const deadEndMutation of [
			{ kind: "cancel_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "q1" },
			{ kind: "dismiss_settled_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "q1" },
		] as const) {
			await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, deadEndMutation, NOW + 30);
		}
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q2", "B"), NOW + 40);
		expect(
			await claimNextQueuedTaskPromptDeliveryRunForDispatch({
				workspaceId: WORKSPACE_ID,
				taskId: TASK_ID,
				sessionIncarnationId: "incarnation-2",
				turnSequence: 1,
				nowEpochMs: NOW + 50,
			}),
		).toBeNull();
		// 启动清扫给出逃逸口。
		const swept = await settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			inFlightSettlementBudgetMs: BUDGET_MS,
			strandedDeliveryFailureNote: "kanban 重启前这条已经交出去了，回执没回来",
			nowEpochMs: NOW + 20 + BUDGET_MS + 1,
		});
		expect(swept.failedStrandedDeliveryCount).toBe(1);
		expect(taskEntries(swept.snapshot)[0]).toMatchObject({
			deliveryState: "settled_failed",
			lastDeliveryFailureNote: "kanban 重启前这条已经交出去了，回执没回来",
		});
		// 队列解冻：后面那条能被认领了。
		const claimed = await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-2",
			turnSequence: 1,
			nowEpochMs: NOW + 20 + BUDGET_MS + 2,
		});
		expect(claimed?.claimedEntries.map((entry) => entry.queueEntryId)).toEqual(["q2"]);
	});

	// 认领与交付拆成两步写盘的全部意义：崩溃后两者归宿必须不同。
	it("被撂下的认领是释放回 queued（不计尝试），不是判失败", async () => {
		const BUDGET_MS = 200_000;
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 10,
		});
		const swept = await settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			inFlightSettlementBudgetMs: BUDGET_MS,
			strandedDeliveryFailureNote: "不该用到",
			nowEpochMs: NOW + BUDGET_MS + 1,
		});
		expect(swept).toMatchObject({ releasedClaimCount: 1, failedStrandedDeliveryCount: 0 });
		expect(taskEntries(swept.snapshot)[0]).toMatchObject({
			deliveryState: "queued",
			deliveryAttemptCount: 0,
			claimedForSessionIncarnationId: null,
		});
	});

	it("预算内的在途条目不被清扫误判（同机多实例的正常在途投递不受影响）", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 1,
			nowEpochMs: NOW + 10,
		});
		await markQueuedTaskPromptDeliveryHandedToTransport({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			dispatchIdempotencyKey: "idem-1",
			nowEpochMs: NOW + 20,
		});
		const swept = await settleQueuedTaskPromptDeliveriesStrandedByRuntimeRestart({
			workspaceId: WORKSPACE_ID,
			inFlightSettlementBudgetMs: 200_000,
			strandedDeliveryFailureNote: "不该用到",
			nowEpochMs: NOW + 1_000,
		});
		expect(swept).toMatchObject({ releasedClaimCount: 0, failedStrandedDeliveryCount: 0 });
		expect(taskEntries(swept.snapshot)[0].deliveryState).toBe("handed_to_transport");
	});

	it("release 对非 claimed_for_dispatch 的条目是 no-op", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		const released = await releaseQueuedTaskPromptDeliveryClaim({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			queueEntryIds: ["q1"],
			nowEpochMs: NOW + 100,
		});
		expect(taskEntries(released)[0].deliveryState).toBe("queued");
	});

	// reorder 不区分状态。这条钉住「重排不会把一条已认领的条目挪走或改状态」——它只换顺序。
	it("reorder 不改动已认领条目的状态与认领快照", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q2", "B"), NOW + 1);
		await claimNextQueuedTaskPromptDeliveryRunForDispatch({
			workspaceId: WORKSPACE_ID,
			taskId: TASK_ID,
			sessionIncarnationId: "incarnation-1",
			turnSequence: 3,
			nowEpochMs: NOW + 10,
		});
		const reordered = await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{ kind: "reorder_queued_prompt_deliveries", taskId: TASK_ID, orderedQueueEntryIds: ["q2", "q1"] },
			NOW + 20,
		);
		expect(queueEntryIds(reordered)).toEqual(["q2", "q1"]);
		const claimedEntry = taskEntries(reordered).find((entry) => entry.queueEntryId === "q1");
		expect(claimedEntry).toMatchObject({
			deliveryState: "claimed_for_dispatch",
			claimedForSessionIncarnationId: "incarnation-1",
			claimedAtTurnSequence: 3,
		});
	});

	it("任务离开看板时整条队列被丢弃", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(WORKSPACE_ID, enqueue("q1", "A"), NOW);
		const discarded = await discardQueuedTaskPromptDeliveriesForTasks({
			workspaceId: WORKSPACE_ID,
			taskIds: [TASK_ID],
			nowEpochMs: NOW + 1_000,
		});
		expect(discarded.entriesByTaskId).toEqual({});
	});

	// 删除路径手上只有看板任务 id；by-the-way 子会话的队列键是它自己的会话 id。不按条目记下的
	// workspaceTaskId 匹配，子会话的队列会在主任务删掉之后继续留着等 stop。
	it("主任务离开看板时，它名下 by-the-way 子会话的队列一并丢弃；别的任务不受影响", async () => {
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: "btw-session-1",
				queueEntryId: "sub-1",
				text: "子会话里排的",
				workspaceTaskId: TASK_ID,
			},
			NOW,
		);
		await mutateWorkspaceQueuedTaskPromptDeliveries(
			WORKSPACE_ID,
			{
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: "task-other",
				queueEntryId: "o-1",
				text: "别的任务",
			},
			NOW,
		);
		const discarded = await discardQueuedTaskPromptDeliveriesForTasks({
			workspaceId: WORKSPACE_ID,
			taskIds: [TASK_ID],
			nowEpochMs: NOW + 1_000,
		});
		expect(Object.keys(discarded.entriesByTaskId)).toEqual(["task-other"]);
	});
});

describe("queued-task-prompt-delivery-store — 本轮 RVF 修复的钉子", () => {
	it("入队时记下所属看板任务：缺省即会话自己", () => {
		const snapshot = applyQueuedTaskPromptDeliveryMutation(emptySnapshot(), enqueue("q1", "A"), NOW);
		expect(taskEntries(snapshot)[0]?.workspaceTaskId).toBe(TASK_ID);
	});

	// per-workspace 上限只靠裁剪约束不住（裁剪只丢终态条目）：10 个任务各排满 20 条之后，第 11 个任务照样能入队。
	it("整个 workspace 的非终态条目到上限后，任何任务的入队都被拒绝", () => {
		const perTask = MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK;
		const taskCount = Math.ceil(MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_WORKSPACE / perTask);
		let snapshot = emptySnapshot();
		for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
			for (let entryIndex = 0; entryIndex < perTask; entryIndex += 1) {
				snapshot = applyQueuedTaskPromptDeliveryMutation(
					snapshot,
					{
						kind: "enqueue_prompt_for_delivery_after_current_turn",
						taskId: `task-${taskIndex}`,
						queueEntryId: `q-${taskIndex}-${entryIndex}`,
						text: "x",
					},
					NOW,
				);
			}
		}
		expect(isQueuedTaskPromptDeliveryWorkspaceQueueFull(snapshot)).toBe(true);
		expect(isQueuedTaskPromptDeliveryQueueCapacityExhaustedForTask(snapshot, "task-new")).toBe(true);
		const refused = applyQueuedTaskPromptDeliveryMutation(
			snapshot,
			{
				kind: "enqueue_prompt_for_delivery_after_current_turn",
				taskId: "task-new",
				queueEntryId: "overflow",
				text: "x",
			},
			NOW,
		);
		expect(refused.entriesByTaskId["task-new"]).toBeUndefined();
	});

	// 过期却仍标着 queued 的条目：投影显示 expired（UI 给 Dismiss），底层若不先收敛，Dismiss 无操作，
	// 20 条这样的条目还会占满容量、永久拒绝新入队。
	it("mutation 之前先把过期条目收敛：过期条目不占容量、可以 Dismiss", () => {
		let snapshot = emptySnapshot();
		for (let index = 0; index < MAX_QUEUED_TASK_PROMPT_DELIVERIES_PER_TASK; index += 1) {
			snapshot = applyQueuedTaskPromptDeliveryMutation(snapshot, enqueue(`old-${index}`, "x"), NOW);
		}
		const afterExpiry = NOW + QUEUED_TASK_PROMPT_DELIVERY_EXPIRY_MS + 1;
		const accepted = applyQueuedTaskPromptDeliveryMutation(snapshot, enqueue("fresh", "新的一条"), afterExpiry);
		expect(taskEntries(accepted).find((entry) => entry.queueEntryId === "fresh")?.deliveryState).toBe("queued");
		const dismissed = applyQueuedTaskPromptDeliveryMutation(
			snapshot,
			{ kind: "dismiss_settled_queued_prompt_delivery", taskId: TASK_ID, queueEntryId: "old-0" },
			afterExpiry,
		);
		expect(queueEntryIds(dismissed)).not.toContain("old-0");
	});

	// 已认领 / 已交付的那一串在认领时就冻结了：此时改开关，磁盘与 UI 显示的与实际发出去的不一致。
	it("合并开关只作用于仍在排队的条目", () => {
		const snapshot = seedSnapshot([
			{ queueEntryId: "q1", text: "A" },
			{ queueEntryId: "q2", text: "B" },
		]);
		const inFlight: WorkspaceQueuedTaskPromptDeliverySnapshot = {
			entriesByTaskId: {
				[TASK_ID]: taskEntries(snapshot).map((entry) =>
					entry.queueEntryId === "q1" ? { ...entry, deliveryState: "handed_to_transport" as const } : entry,
				),
			},
		};
		const toggled = applyQueuedTaskPromptDeliveryMutation(
			inFlight,
			{
				kind: "set_queued_prompt_delivery_merge_with_next",
				taskId: TASK_ID,
				queueEntryId: "q1",
				deliverTogetherWithNextQueuedEntry: true,
			},
			NOW,
		);
		expect(taskEntries(toggled)[0]?.deliverTogetherWithNextQueuedEntry).toBe(false);
	});
});
