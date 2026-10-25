import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRuntimeStateBroadcastCostRecorder,
	type RuntimeStateBroadcastCostRecorder,
	type RuntimeStateBroadcastCostWindowSample,
} from "../../../src/diagnostics/runtime-state-broadcast-cost-recorder";

const recorders: RuntimeStateBroadcastCostRecorder[] = [];

function createRecorderFixture(writeWindowSample?: (sample: RuntimeStateBroadcastCostWindowSample) => void) {
	let nowMs = 0;
	const samples: RuntimeStateBroadcastCostWindowSample[] = [];
	const recorder = createRuntimeStateBroadcastCostRecorder({
		monotonicNowMs: () => nowMs,
		epochNowMs: () => Date.UTC(2026, 9, 25) + nowMs,
		writeWindowSample: writeWindowSample ?? ((sample) => samples.push(sample)),
	});
	recorders.push(recorder);
	return {
		recorder,
		samples,
		advance: (durationMs: number) => {
			nowMs += durationMs;
		},
	};
}

afterEach(() => {
	for (const recorder of recorders.splice(0)) recorder.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("广播成本窗口记录", () => {
	it("同次调用的构建、序列化、比较及多客户端发送可对账，业务正文不进入记录", async () => {
		const { recorder, samples, advance } = createRecorderFixture();
		const operation = recorder.beginOperation("projects_updated");
		await operation.measureAsynchronousStage("projects_payload_build", async () => {
			advance(11);
		});
		const stringify = vi.spyOn(JSON, "stringify");
		const serialized = operation.serializePayload({ prompt: "私密合成正文🔐" });
		expect(stringify).toHaveBeenCalledTimes(1);
		operation.measureSynchronousStage("projects_fingerprint_compare", () => {
			advance(2);
		});
		operation.measureSynchronousStage("websocket_send_loop", () => {
			operation.recordWebSocketSendOutcome("accepted");
			operation.recordWebSocketSendOutcome("accepted");
			operation.recordWebSocketSendOutcome("client_not_open");
			operation.recordWebSocketSendOutcome("threw");
			operation.recordInitialSnapshotAwaitingClientSkip();
			advance(3);
		});
		operation.finish("completed");
		operation.finish("failed");
		recorder.flushWindow();
		const window = samples[0].operations.projects_updated;
		expect(window).toMatchObject({
			startedOperationCount: 1,
			completedOperationCount: 1,
			inFlightOperationCountAtWindowEnd: 0,
			serializedPayloadCount: 1,
			totalSerializedPayloadBytes: Buffer.byteLength(serialized),
			webSocketSendAttemptCount: 3,
			webSocketAcceptedSendCount: 2,
			webSocketClosedClientSkipCount: 1,
			webSocketThrownSendCount: 1,
			webSocketAcceptedSendPayloadBytes: 2 * Buffer.byteLength(serialized),
			initialSnapshotAwaitingClientSkipCount: 1,
			totalOperationDurationMs: 16,
		});
		expect(window.stages.projects_payload_build.totalDurationMs).toBe(11);
		expect(window.stages.projects_fingerprint_compare.totalDurationMs).toBe(2);
		expect(window.stages.websocket_send_loop.totalDurationMs).toBe(3);
		expect(window.firstCompletedOperationSample?.operationSequenceNumber).toBe(1);
		expect(JSON.stringify(samples)).not.toContain("私密合成正文");
	});

	it("跨窗调用只在完成窗口计入阶段成本，在途数保留开始与完成之间的差额", async () => {
		const { recorder, samples, advance } = createRecorderFixture();
		const operation = recorder.beginOperation("workspace_state_updated");
		let release = () => {};
		const pending = operation.measureAsynchronousStage(
			"workspace_payload_build",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		advance(60_000);
		recorder.flushWindow();
		expect(samples[0].operations.workspace_state_updated).toMatchObject({
			startedOperationCount: 1,
			completedOperationCount: 0,
			inFlightOperationCountAtWindowEnd: 1,
		});
		advance(5);
		release();
		await pending;
		operation.finish("completed");
		recorder.flushWindow();
		expect(samples[1].operations.workspace_state_updated).toMatchObject({
			startedOperationCount: 0,
			completedOperationCount: 1,
			inFlightOperationCountAtWindowEnd: 0,
		});
		expect(samples[1].operations.workspace_state_updated.stages.workspace_payload_build.totalDurationMs).toBe(60_005);
		expect(samples[0].operations.workspace_state_updated.stages.workspace_payload_build.completedStageCount).toBe(0);
	});

	it("并行首帧一支失败后另一支继续计量，不延后业务的失败或修改已发窗口", async () => {
		const { recorder, samples, advance } = createRecorderFixture();
		const operation = recorder.beginOperation("initial_snapshot");
		let release = () => {};
		const delayed = operation.measureAsynchronousStage(
			"workspace_payload_build",
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const originalError = new Error("不能记录的凭据");
		await expect(
			Promise.all([
				operation.measureAsynchronousStage("projects_payload_build", async () => {
					throw originalError;
				}),
				delayed,
			]),
		).rejects.toBe(originalError);
		operation.finish("failed");
		recorder.flushWindow();
		expect(samples[0].operations.initial_snapshot.inFlightOperationCountAtWindowEnd).toBe(1);
		advance(10);
		release();
		await delayed;
		recorder.flushWindow();
		const completed = samples[1].operations.initial_snapshot;
		expect(completed.outcomeCounts.failed).toBe(1);
		expect(completed.stages.projects_payload_build.failedStageCount).toBe(1);
		expect(completed.stages.workspace_payload_build.completedStageCount).toBe(1);
		expect(samples[0].operations.initial_snapshot.completedOperationCount).toBe(0);
		expect(JSON.stringify(samples)).not.toContain(originalError.message);
	});

	it("失败序列化保留阶段失败，不产生伪发送字节", () => {
		const { recorder, samples } = createRecorderFixture();
		const operation = recorder.beginOperation("projects_updated");
		const originalError = new Error("私密错误");
		expect(() =>
			operation.serializePayload({
				toJSON: () => {
					throw originalError;
				},
			}),
		).toThrow(originalError);
		operation.finish("failed");
		recorder.flushWindow();
		const window = samples[0].operations.projects_updated;
		expect(window.stages.payload_json_stringify.failedStageCount).toBe(1);
		expect(window.totalSerializedPayloadBytes).toBe(0);
		expect(window.webSocketAcceptedSendCount).toBe(0);
		expect(JSON.stringify(samples)).not.toContain(originalError.message);
	});

	it("大量调用仍只保留固定维度的首条和最慢样本，无连接早退不构造阶段样本", () => {
		const { recorder, samples, advance } = createRecorderFixture();
		for (let index = 1; index <= 1_000; index += 1) {
			const operation = recorder.beginOperation("projects_updated");
			advance(index);
			operation.finish("deduplicated");
			recorder.recordBroadcastSkippedWithoutClients("workspace_state_updated");
		}
		recorder.flushWindow();
		const window = samples[0].operations.projects_updated;
		expect(Object.keys(samples[0].operations)).toHaveLength(3);
		expect(window.completedOperationCount).toBe(1_000);
		expect(window.firstCompletedOperationSample?.operationSequenceNumber).toBe(1);
		expect(window.slowestCompletedOperationSample?.operationSequenceNumber).toBe(1_000);
		expect(samples[0].operations.workspace_state_updated.outcomeCounts.no_clients).toBe(1_000);
		expect(samples[0].operations.workspace_state_updated.firstCompletedOperationSample).toBeNull();
	});

	it("写入失败不传播或积攒旧窗口，后续窗口继续记录", () => {
		let fail = true;
		const emitted: RuntimeStateBroadcastCostWindowSample[] = [];
		const { recorder } = createRecorderFixture((sample) => {
			if (fail) throw new Error("写入失败");
			emitted.push(sample);
		});
		recorder.recordBroadcastSkippedWithoutClients("projects_updated");
		expect(() => recorder.flushWindow()).not.toThrow();
		fail = false;
		recorder.flushWindow();
		expect(emitted[0].operations.projects_updated.completedOperationCount).toBe(0);
	});

	it("每分钟发窗，关闭时发剩余窗口并释放定时器，迟到完成不冒充关停前成功", async () => {
		vi.useFakeTimers();
		const { recorder, samples, advance } = createRecorderFixture();
		advance(60_000);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(samples).toHaveLength(1);
		const pending = recorder.beginOperation("projects_updated");
		advance(7);
		recorder.close();
		expect(samples[1].flushReason).toBe("hub_closed");
		expect(samples[1].observedWindowDurationMs).toBe(7);
		expect(samples[1].operations.projects_updated.inFlightOperationCountAtWindowEnd).toBe(1);
		pending.finish("completed");
		recorder.close();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(samples).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(0);
	});
});
