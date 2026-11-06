import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodexConfigurationSourceObservationRecoveryController,
	createCodexConfigurationSourceObservationRecoveryController,
} from "@/hooks/codex-configuration-source-observation-recovery";
import type { CodexConfigurationBatchActionResult, CodexConfigurationSyncState } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const queries = vi.hoisted(() => ({ fetch: vi.fn(), batch: vi.fn(), source: vi.fn(), receipt: vi.fn() }));

function createDeferredResponse<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		runtime: {
			getCodexConfigurationSyncActiveState: { query: queries.fetch },
			getCodexConfigurationSourceObservation: { query: queries.source },
			getCodexConfigurationMutationReceipt: { query: queries.receipt },
			batchCodexConfigurationAction: { mutate: queries.batch },
		},
	}),
}));

let state: CodexConfigurationSyncState;
let controller: CodexConfigurationSourceObservationRecoveryController;
let unsubscribe: () => void;
const persistedKey = LocalStorageKey.CodexConfigurationUnconfirmedSourceObservationActions;
const item = { entryKind: "source_observation" as const, changeId: "source", expectedVersion: 1 };
const handledState = (disposition: "confirmed" | "deferred" = "confirmed"): CodexConfigurationSyncState => ({
	...state,
	revision: 2,
	sourceObservations: state.sourceObservations.map((entry) => ({
		...entry,
		version: 2,
		acknowledgedAt: 42,
		reminderDisposition: disposition,
	})),
});
function startController(workspaceId: string | null = "isolated-workspace") {
	controller = createCodexConfigurationSourceObservationRecoveryController(workspaceId);
	unsubscribe = controller.subscribe(() => {});
	return controller;
}
beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	state = {
		revision: 1,
		observationProblem: null,
		changes: [],
		sourceObservations: [
			{
				observationId: "source",
				version: 1,
				sourceLabel: "隔离来源",
				firstObservedAt: 1,
				observedAt: 1,
				observationCount: 1,
				detectedLocationCount: 1,
				acknowledgedAt: null,
				reminderDisposition: "unread",
			},
		],
	};
	queries.fetch.mockReset().mockImplementation(async () => state);
	queries.batch.mockReset();
	queries.source.mockReset().mockResolvedValue(null);
	queries.receipt.mockReset().mockResolvedValue(null);
	startController().acceptState(state);
});
afterEach(() => {
	unsubscribe();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("来源回执的有界核验与持久恢复", () => {
	it("底层忽略取消时仍在十五秒结束等待，补读已处理事实后不重送", async () => {
		queries.batch.mockImplementation(() => new Promise(() => {}));
		queries.fetch.mockResolvedValue(handledState());
		const operation = controller.batch("confirm_source", [item]);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(queries.fetch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await operation;
		expect(controller.getSnapshot().sourceOperations).toEqual({});
		expect(controller.getSnapshot().state?.sourceObservations[0]?.acknowledgedAt).toBe(42);
		expect(controller.getSnapshot().sourceActionMessages.source).toContain("补读核验");
		expect(queries.batch).toHaveBeenCalledTimes(1);
		expect(JSON.parse(localStorage.getItem(persistedKey)!)).toEqual([]);
	});
	it("读回仍为原版本才以原请求重送一次，普通重绘和手动核验都不重置额度", async () => {
		queries.batch.mockRejectedValue(new Error("隔离断线"));
		const operation = controller.batch("confirm_source", [item]);
		await vi.runAllTimersAsync();
		await operation;
		expect(queries.batch).toHaveBeenCalledTimes(2);
		expect(queries.batch.mock.calls[1]![0]).toEqual(queries.batch.mock.calls[0]![0]);
		expect(queries.fetch).toHaveBeenCalledTimes(3);
		expect(controller.getSnapshot().sourceOperations.source?.phase).toBe("unknown");
		expect(JSON.parse(localStorage.getItem(persistedKey)!)[0].automaticResendCount).toBe(1);
		controller.acceptState(state);
		expect(queries.fetch).toHaveBeenCalledTimes(3);
		controller.resumeUnconfirmedActions("source");
		await vi.runAllTimersAsync();
		expect(queries.fetch).toHaveBeenCalledTimes(6);
		expect(queries.batch).toHaveBeenCalledTimes(2);
	});
	it.each(["online", "visibilitychange"])("三个补读均挂起后保留未知，%s 后自动补读", async (eventName) => {
		queries.batch.mockImplementation(() => new Promise(() => {}));
		queries.fetch.mockImplementation(() => new Promise(() => {}));
		const operation = controller.batch("defer", [item]);
		await vi.runAllTimersAsync();
		await operation;
		expect(queries.fetch).toHaveBeenCalledTimes(3);
		expect(queries.batch).toHaveBeenCalledTimes(1);
		expect(controller.getSnapshot().sourceOperations.source?.phase).toBe("unknown");
		queries.fetch.mockResolvedValue(handledState("deferred"));
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		(eventName === "online" ? window : document).dispatchEvent(new Event(eventName));
		await vi.runAllTimersAsync();
		expect(controller.getSnapshot().sourceOperations).toEqual({});
		expect(queries.batch).toHaveBeenCalledTimes(1);
	});
	it.each(["new_observation", "opposite_disposition"])("补读出现 %s 时接受新事实，不套用旧决定", async (scenario) => {
		queries.batch.mockRejectedValue(new Error("隔离回执丢失"));
		const next = handledState("deferred");
		if (scenario === "new_observation")
			next.sourceObservations[0] = {
				...next.sourceObservations[0]!,
				observationCount: 2,
				observedAt: 3,
				acknowledgedAt: null,
				reminderDisposition: "unread",
			};
		queries.fetch.mockResolvedValue(next);
		const operation = controller.batch("confirm_source", [item]);
		await vi.runAllTimersAsync();
		await operation;
		expect(controller.getSnapshot().state).toBe(next);
		expect(controller.getSnapshot().sourceOperations).toEqual({});
		expect(queries.batch).toHaveBeenCalledTimes(1);
	});
	it.each(["stale_version", "idempotency_conflict", "not_found"] as const)(
		"明确 %s 回执结束旧意图，不自动重送",
		async (status) => {
			queries.batch.mockResolvedValue({ state, results: [{ changeId: "source", status, message: "隔离冲突结果" }] });
			await controller.batch("confirm_source", [item]);
			expect(queries.batch).toHaveBeenCalledTimes(1);
			expect(controller.getSnapshot().sourceOperations).toEqual({});
			expect(controller.getSnapshot().sourceActionMessages.source).toBe("隔离冲突结果");
		},
	);
	it("旧回执不得覆盖新观测，也不得清除新版本操作", async () => {
		const original = createDeferredResponse<CodexConfigurationBatchActionResult>();
		queries.batch.mockImplementationOnce(() => original.promise).mockImplementation(() => new Promise(() => {}));
		const earlier = controller.batch("confirm_source", [item]);
		const newer = {
			...state,
			revision: 3,
			sourceObservations: [{ ...state.sourceObservations[0]!, version: 3, observationCount: 2, observedAt: 3 }],
		};
		controller.acceptState(newer);
		void controller.batch("defer", [{ ...item, expectedVersion: 3 }]);
		const currentIdentity = controller.getSnapshot().sourceOperations.source?.item.idempotencyKey;
		original.resolve({
			state: handledState(),
			results: [{ changeId: "source", status: "applied", message: "旧回执" }],
		});
		await earlier;
		expect(controller.getSnapshot().state).toBe(newer);
		expect(controller.getSnapshot().sourceOperations.source?.item.idempotencyKey).toBe(currentIdentity);
		expect(controller.getSnapshot().sourceOperations.source?.phase).toBe("sending");
	});
	it("刷新后先读再恢复冻结身份，已用的重送额度跨重启保留", async () => {
		queries.batch.mockRejectedValue(new Error("隔离断线"));
		const operation = controller.batch("confirm_source", [item]);
		await vi.runAllTimersAsync();
		await operation;
		const frozen = JSON.parse(localStorage.getItem(persistedKey)!)[0];
		unsubscribe();
		startController();
		await vi.runAllTimersAsync();
		expect(queries.batch).toHaveBeenCalledTimes(2);
		expect(controller.getSnapshot().sourceOperations.source?.item).toEqual(frozen.item);
		expect(controller.getSnapshot().sourceOperations.source?.automaticResendCount).toBe(1);
		expect(controller.getSnapshot().sourceOperations.source?.phase).toBe("unknown");
	});
	it("刷新时原写入结果未知，先读回原版本，再且仅再送一次原身份", async () => {
		queries.batch.mockImplementationOnce(() => new Promise(() => {}));
		const original = controller.batch("confirm_source", [item]);
		const frozen = JSON.parse(localStorage.getItem(persistedKey)!)[0];
		unsubscribe();
		await original;
		queries.batch.mockResolvedValue({
			state: handledState(),
			results: [{ changeId: "source", status: "replayed", message: "隔离幂等回执" }],
		});
		const callOrder: string[] = [];
		queries.fetch.mockImplementation(async () => {
			callOrder.push("read");
			return state;
		});
		startController();
		await vi.runAllTimersAsync();
		expect(callOrder[0]).toBe("read");
		expect(queries.batch.mock.calls[1]![0]).toEqual({
			action: frozen.action,
			items: [frozen.item],
			stateResponseScope: "active",
		});
		expect(controller.getSnapshot().sourceOperations).toEqual({});
	});
	it("不同 workspace 和未指定 workspace 的持久身份互不混用", async () => {
		queries.batch.mockImplementation(() => new Promise(() => {}));
		const original = controller.batch("confirm_source", [item]);
		unsubscribe();
		await original;
		startController(null);
		await vi.runAllTimersAsync();
		expect(controller.getSnapshot().sourceOperations).toEqual({});
		expect(queries.fetch).not.toHaveBeenCalled();
	});
	it("无法持久保存时保留说明，不发送无法跨重启恢复的决定", async () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("隔离存储不可用");
		});
		await controller.batch("confirm_source", [item]);
		expect(queries.batch).not.toHaveBeenCalled();
		expect(controller.getSnapshot().sourceActionMessages.source).toContain("尚未发送");
	});
});

it("活跃列表缺项和回执未知时保留持久操作，不当作已被替代", async () => {
	queries.batch.mockRejectedValue(new Error("隔离丢失响应"));
	queries.fetch.mockResolvedValue({ ...state, stateResponseScope: "active", sourceObservations: [] });
	const pending = controller.batch("confirm_source", [item]);
	await vi.runAllTimersAsync();
	await pending;
	expect(controller.getSnapshot().sourceOperations.source?.phase).toBe("unknown");
	expect(JSON.parse(localStorage.getItem(persistedKey)!)).toHaveLength(1);
	expect(queries.receipt).toHaveBeenCalled();
	expect(queries.source).toHaveBeenCalled();
	expect(queries.batch).toHaveBeenCalledTimes(1);
});
it("历史稍后条目不在活跃列表时仍携带原版本提交", async () => {
	const observation = handledState("deferred").sourceObservations[0]!;
	controller.acceptState({ ...state, stateResponseScope: "active", sourceObservations: [] });
	queries.batch.mockResolvedValue({
		state: { ...state, revision: 3, stateResponseScope: "active", sourceObservations: [] },
		results: [{ changeId: "source", status: "applied", message: "已标记已读" }],
	});
	await controller.batch("confirm_source", [{ ...item, expectedVersion: observation.version, observation }]);
	expect(queries.batch).toHaveBeenCalledTimes(1);
	expect(queries.batch.mock.calls[0]?.[0].items[0]).toMatchObject({ changeId: "source", expectedVersion: 2 });
	expect(controller.getSnapshot().sourceOperations).toEqual({});
});
it("同一存储按提交代数淘汰迟到响应，数据库外同代数展示仍可更新", () => {
	controller.acceptState({ ...state, storageIdentity: "same", storageGeneration: 10, revision: 2 });
	controller.acceptState({ ...state, storageIdentity: "same", storageGeneration: 9, revision: 100 });
	expect(controller.getSnapshot().state?.revision).toBe(2);
	controller.acceptState({
		...state,
		storageIdentity: "same",
		storageGeneration: 10,
		revision: 2,
		observationProblem: "展示上下文已更新",
	});
	expect(controller.getSnapshot().state?.observationProblem).toBe("展示上下文已更新");
});

it("换库先建立新的请求代际，旧存储迟到响应不能覆盖已绑定的新存储", () => {
	controller.acceptState({ ...state, storageIdentity: "original", storageGeneration: 100 });
	expect(controller.acceptState({ ...state, storageIdentity: "replacement", storageGeneration: 1 })).toBeNull();
	controller.resetForRuntimeReconnect();
	controller.acceptState({ ...state, storageIdentity: "replacement", storageGeneration: 1 });
	expect(controller.acceptState({ ...state, storageIdentity: "original", storageGeneration: 101 })).toBeNull();
	expect(controller.getSnapshot().state?.storageIdentity).toBe("replacement");
});
