import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createDailyWorkProgressCollectionCostRecorder,
	type DailyWorkProgressCollectionCostWindow,
	measureDailyWorkProgressAsynchronousStage,
	measureDailyWorkProgressSynchronousStage,
	readUtf8FileWithDailyWorkProgressCostObservation,
	recordDailyWorkProgressFileRead,
} from "../../../src/diagnostics/daily-work-progress-collection-cost-recorder";

afterEach(() => vi.useRealTimers());
it("采集结束后的派生异步回调不污染窗口，已经开始的读取仍归原阶段", async () => {
	const windows: DailyWorkProgressCollectionCostWindow[] = [];
	const recorder = createDailyWorkProgressCollectionCostRecorder({ writeWindow: (window) => windows.push(window) });
	let release: () => void = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	let deferredCallback: Promise<void> = Promise.resolve();
	let startedRead: Promise<void> = Promise.resolve();
	try {
		await recorder.run("refresh", async () => {
			deferredCallback = barrier.then(() => {
				recordDailyWorkProgressFileRead(999);
			});
			startedRead = measureDailyWorkProgressAsynchronousStage("workspace_board_read", async () => {
				await barrier;
				recordDailyWorkProgressFileRead(7);
			});
		});
		recorder.flush();
		expect(windows[0]?.inFlightAsynchronousStages).toBe(1);
		release();
		await Promise.all([deferredCallback, startedRead]);
		recorder.flush();
		expect(windows[1]?.stages.refresh?.readBytes ?? 0).toBe(0);
		expect(windows[1]?.stages.workspace_board_read?.readBytes).toBe(7);
		expect(windows[1]?.inFlightAsynchronousStages).toBe(0);
	} finally {
		release();
		recorder.close();
	}
});
it("60 秒窗口分离同步与异步成本，失败仍计量且不记录正文", async () => {
	vi.useFakeTimers();
	const windows: DailyWorkProgressCollectionCostWindow[] = [];
	const recorder = createDailyWorkProgressCollectionCostRecorder({
		readRuntimeIdentity: () => ({ runtimeProcessInstanceId: "runtime-test", runtimeOrigin: "http://127.0.0.1:0" }),
		writeWindow: (window) => windows.push(window),
	});
	try {
		await recorder.run("refresh", async () => {
			await measureDailyWorkProgressAsynchronousStage("workspace_board_read", async () => {
				recordDailyWorkProgressFileRead("不保存的正文");
			});
			expect(() =>
				measureDailyWorkProgressSynchronousStage("statistics_parse", () => {
					throw new Error("诊断测试");
				}),
			).toThrow();
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(windows).toHaveLength(1);
		expect(windows[0]?.runtimeIdentity?.runtimeProcessInstanceId).toBe("runtime-test");
		expect(windows[0]?.stages.workspace_board_read).toMatchObject({
			calls: 1,
			synchronousWallTimeMs: 0,
			readBytes: Buffer.byteLength("不保存的正文"),
			readOperations: 1,
		});
		expect(windows[0]?.stages.statistics_parse?.failures).toBe(1);
		expect(JSON.stringify(windows)).not.toContain("不保存的正文");
		expect(windows[0]?.inFlightOperations).toBe(0);
	} finally {
		recorder.close();
	}
});
it("关闭刻度时不创建窗口，诊断 writer 抛错也不改变业务结果", async () => {
	const disabledWriter = vi.fn();
	const disabled = createDailyWorkProgressCollectionCostRecorder({ enabled: false, writeWindow: disabledWriter });
	expect(await disabled.run("refresh", async () => 42)).toBe(42);
	disabled.flush();
	disabled.close();
	expect(disabledWriter).not.toHaveBeenCalled();
	const failedWriter = createDailyWorkProgressCollectionCostRecorder({
		writeWindow: () => {
			throw new Error("不可用");
		},
	});
	expect(await failedWriter.run("refresh", async () => 42)).toBe(42);
	expect(() => failedWriter.close()).not.toThrow();
});

it("即使 UTF-8 无效，也按解码前真实字节计量，关闭刻度的读取行为保持一致", async () => {
	const directory = await mkdtemp(join(tmpdir(), "daily-progress-actual-read-bytes-"));
	const windows: DailyWorkProgressCollectionCostWindow[] = [];
	const recorder = createDailyWorkProgressCollectionCostRecorder({ writeWindow: (window) => windows.push(window) });
	try {
		const path = join(directory, "invalid-utf8.json");
		await writeFile(path, Buffer.from([0x22, 0xff, 0x22]));
		const unobserved = await readUtf8FileWithDailyWorkProgressCostObservation(path);
		const observed = await recorder.run("refresh", () => readUtf8FileWithDailyWorkProgressCostObservation(path));
		expect(observed).toBe(unobserved);
		expect(Buffer.byteLength(observed)).toBe(5);
		recorder.close();
		expect(windows[0]?.stages.refresh?.readBytes).toBe(3);
	} finally {
		recorder.close();
		await rm(directory, { recursive: true, force: true });
	}
});
