// 单独一个文件，因为它要 `vi.mock("node:fs/promises")` 把 `mkdir` 变成可控的慢操作——那是 file 级
// 的 hoist，不能和别的用例共处一个文件。
//
// 要钉死的是 reviewer codex-cli 报的那条 medium：`stop()` 与「已经开始的那一次续期」之间的竞态。
//
// 为什么非得造这个 seam：这个交错的窗口只有「一次续期已进到函数体、正停在 mkdir 的 await 上」那一瞬，
// 而真实 mkdir 在已存在的目录上是亚毫秒级的。我先写过一版黑盒压力测试（极短节拍 + 反复启停 40 轮），
// 实测**在修复前也照样通过**——撞不到窗口的测试不是钉子，是装饰。把 mkdir 换成一道可以由测试自己
// 开闸的门之后，这个交错才成为确定性的。
//
// 交错为什么要紧：`clearInterval` 只阻止**下一次**触发。一次已在途的续期若在 `rm` 之后才落地，
// 就会给一个**已经退出的进程**重新造出一份崭新心跳，让它在磁盘上"活着"整整一个宽限期。
// 于是真正的重启会被清扫判成「托管者仍活着」而**漏掉 restart-crossing 盖章**——队列在重启后不提醒
// 就直接发，正是整套机制要防的那件事，也是本设计里唯一的 fail-unsafe 方向。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
}));

// 一道由测试开闸的门。armed 时，下一次 mkdir 会停在这里，直到测试放行。
const heartbeatWriteGate = {
	armed: false,
	enteredCount: 0,
	release: () => {},
	blockUntilReleased: Promise.resolve(),
};

function armHeartbeatWriteGate(): void {
	heartbeatWriteGate.enteredCount = 0;
	heartbeatWriteGate.blockUntilReleased = new Promise<void>((resolve) => {
		heartbeatWriteGate.release = () => resolve();
	});
	heartbeatWriteGate.armed = true;
}

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
			if (heartbeatWriteGate.armed) {
				heartbeatWriteGate.enteredCount += 1;
				// 只拦第一次进来的那一个，其余放行（否则 armHeartbeatWriteGate 之后的清理也会被卡住）。
				heartbeatWriteGate.armed = false;
				await heartbeatWriteGate.blockUntilReleased;
			}
			return await actual.mkdir(...args);
		},
	};
});

const { getThisRuntimeProcessInstanceId, readLiveRuntimeProcessInstanceIds, startRuntimeProcessInstanceHeartbeat } =
	await import("../../../src/state/runtime-process-instance-heartbeat-registry");

describe("心跳 stop() 必须排空在途续期", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-heartbeat-stop-race-"));
	});

	afterEach(async () => {
		heartbeatWriteGate.armed = false;
		heartbeatWriteGate.release();
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("一次续期卡在写入途中时，stop() 等它落地后再销号，不会被重新创建", async () => {
		const heartbeat = await startRuntimeProcessInstanceHeartbeat({ intervalMs: 5 });
		// 让下一次续期停在写入途中。
		armHeartbeatWriteGate();
		await vi.waitFor(() => expect(heartbeatWriteGate.enteredCount).toBe(1), { timeout: 2_000, interval: 5 });

		// 此刻：一次续期正卡在门后。发起关停但**先不等它**——修复的关键正是 stop() 会在这里等下去。
		const stopping = heartbeat.stop();
		let stopResolved = false;
		void stopping.then(() => {
			stopResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		// 修复前：stop() 早已 rm 完并 resolve，此处会是 true，而被卡住的那次续期随后把心跳写回来。
		expect(stopResolved).toBe(false);

		// 放行那次续期，stop() 才应当继续走到 rm。
		heartbeatWriteGate.release();
		await stopping;

		// 销号必须是最后一步：被卡住的那次写已经落地，然后才被删掉。
		const live = await readLiveRuntimeProcessInstanceIds();
		expect(live.has(getThisRuntimeProcessInstanceId())).toBe(false);

		// 再给事件循环几拍，确认没有任何漏网的写把它造回来。
		await new Promise((resolve) => setTimeout(resolve, 30));
		const liveAfterSettling = await readLiveRuntimeProcessInstanceIds();
		expect(liveAfterSettling.has(getThisRuntimeProcessInstanceId())).toBe(false);
	});
});
