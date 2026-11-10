import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStateStreamVersionedReceiver } from "@/runtime/runtime-state-stream-versioned-receiver";
import type { RuntimeStateStreamMessage } from "@/runtime/types";

const generation = "00000000-0000-4000-8000-000000000001";
const snapshot: RuntimeStateStreamMessage = {
	type: "state_snapshot_v2",
	runtimeGenerationId: generation,
	workspaceId: null,
	sequenceNumber: 1,
	snapshot: {
		type: "snapshot",
		currentProjectId: null,
		projects: [],
		workspaceState: null,
		workspaceMetadata: null,
		notificationLog: [],
	},
};
const delta: RuntimeStateStreamMessage = {
	type: "state_delta_v2",
	runtimeGenerationId: generation,
	workspaceId: null,
	previousSequenceNumber: 1,
	sequenceNumber: 2,
	update: {
		type: "projects_patch",
		currentProjectId: null,
		projects: { upserts: [], removedKeys: [] },
		projectDetails: [],
	},
};
afterEach(() => vi.useRealTimers());

describe("状态流 v2 有界恢复", () => {
	it("首帧失败最多补证三次，范围或来源变化恢复预算，成功快照取消后续重试", async () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const reportError = vi.fn();
		const receiver = new RuntimeStateStreamVersionedReceiver(send, reportError);
		receiver.recoverMissingInitialSnapshot();
		receiver.recoverMissingInitialSnapshot();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(send).toHaveBeenCalledTimes(3);
		expect(reportError).toHaveBeenLastCalledWith(expect.stringContaining("已保留现有内容"));
		receiver.recoverMissingInitialSnapshot();
		expect(send).toHaveBeenCalledTimes(3);
		receiver.resumeRecoveryAfterScopeChange();
		expect(send).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(send).toHaveBeenCalledTimes(6);
		receiver.receive({
			type: "state_version_v2",
			runtimeGenerationId: generation,
			workspaceId: null,
			sequenceNumber: 1,
		});
		expect(send).toHaveBeenCalledTimes(7);
		expect(receiver.receive(snapshot)?.type).toBe("snapshot");
		await vi.advanceTimersByTimeAsync(20_000);
		receiver.recoverMissingInitialSnapshot();
		expect(send).toHaveBeenCalledTimes(7);
		receiver.dispose();
	});

	it("第三次补证尚在等待时记录新来源，超时后自动接续", async () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const receiver = new RuntimeStateStreamVersionedReceiver(send, vi.fn());
		receiver.recoverMissingInitialSnapshot();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(send).toHaveBeenCalledTimes(3);
		receiver.receive({
			type: "state_version_v2",
			runtimeGenerationId: generation,
			workspaceId: null,
			sequenceNumber: 1,
		});
		await vi.advanceTimersByTimeAsync(5_000);
		expect(send).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(send).toHaveBeenCalledTimes(6);
		receiver.dispose();
	});

	it("旧协议首帧抵达后取消缺基线补证，后续普通错误不会触发 v2 请求", async () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const receiver = new RuntimeStateStreamVersionedReceiver(send, vi.fn());
		receiver.recoverMissingInitialSnapshot();
		expect(receiver.receive(snapshot.snapshot)).toBe(snapshot.snapshot);
		receiver.recoverMissingInitialSnapshot();
		receiver.resumeRecoveryAfterScopeChange();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(send).toHaveBeenCalledTimes(1);
		receiver.dispose();
	});

	it("有序应用，缺口暂停应用并补快照；三次后等待新来源证据", async () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const receiver = new RuntimeStateStreamVersionedReceiver(send, vi.fn());
		expect(receiver.receive(snapshot)?.type).toBe("snapshot");
		expect(receiver.receive(delta)?.type).toBe("projects_updated");
		const gap = { ...delta, previousSequenceNumber: 3, sequenceNumber: 4 };
		expect(receiver.receive(gap)).toBeNull();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(send).toHaveBeenCalledTimes(3);
		receiver.receive(gap);
		expect(send).toHaveBeenCalledTimes(3);
		receiver.receive({ ...gap, previousSequenceNumber: 4, sequenceNumber: 5 });
		expect(send).toHaveBeenCalledTimes(4);
		expect(receiver.receive({ ...snapshot, sequenceNumber: 6 })?.type).toBe("snapshot");
		receiver.confirmVersion();
		expect(send).toHaveBeenLastCalledWith({
			type: "confirm_state_version_v2",
			runtimeGenerationId: generation,
			sequenceNumber: 6,
		});
		receiver.dispose();
	});
	it("运行时代际变化先补基线，旧协议保持兼容", () => {
		const send = vi.fn();
		const receiver = new RuntimeStateStreamVersionedReceiver(send, vi.fn());
		receiver.receive(snapshot);
		expect(receiver.receive({ ...delta, runtimeGenerationId: "00000000-0000-4000-8000-000000000002" })).toBeNull();
		expect(send).toHaveBeenCalledWith({ type: "request_state_snapshot_v2" });
		const legacy = { type: "projects_updated" as const, currentProjectId: null, projects: [] };
		expect(receiver.receive(legacy)).toBe(legacy);
		receiver.dispose();
	});
});
