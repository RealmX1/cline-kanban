// runtime 进程实例心跳注册表：判活、宽限期、优雅退出立即销号、以及各种读失败下的**保守**方向。
//
// 这套断言存在的理由是排队 prompt 的 restart-crossing 盖章：判活错一次的后果是「常驻实例正排着的队
// 被另一个实例误标」或「一次真实重启被漏掉」。前者只是多让人确认一次，后者是重启后不提醒直接发。
// 所以每一条读失败路径都必须落在**判死**（多盖章）那一侧，不能落在判活那一侧。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 心跳目录落在 ~/.cline/kanban 之下。重定向到临时目录，而不是去动 homedir()——否则本套件会读到
// 用户真实运行中的实例，甚至把它们的心跳文件删掉。
const testRuntimeHome = { path: "" };
vi.mock("../../../src/state/workspace-state", () => ({
	getRuntimeHomePath: () => testRuntimeHome.path,
}));

const {
	getRuntimeProcessInstanceHeartbeatsDirectoryPath,
	getThisRuntimeProcessInstanceId,
	readLiveRuntimeProcessInstanceIds,
	readRuntimeProcessInstanceLiveness,
	RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS,
	RUNTIME_PROCESS_INSTANCE_HEARTBEAT_INTERVAL_MS,
	startRuntimeProcessInstanceHeartbeat,
} = await import("../../../src/state/runtime-process-instance-heartbeat-registry");

const NOW = 1_700_000_000_000;

async function writeHeartbeatFile(fileName: string, content: unknown): Promise<void> {
	const directoryPath = getRuntimeProcessInstanceHeartbeatsDirectoryPath();
	await mkdir(directoryPath, { recursive: true });
	await writeFile(
		join(directoryPath, fileName),
		typeof content === "string" ? content : JSON.stringify(content),
		"utf8",
	);
}

describe("runtime-process-instance-heartbeat-registry — 常量", () => {
	// 宽限期必须**远大于**续期节拍，否则一次普通的事件循环卡顿就会让活着的实例被判死。
	it("宽限期是续期节拍的数倍", () => {
		expect(RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS).toBeGreaterThanOrEqual(
			3 * RUNTIME_PROCESS_INSTANCE_HEARTBEAT_INTERVAL_MS,
		);
	});
});

describe("runtime-process-instance-heartbeat-registry — 身份", () => {
	it("本进程的实例 id 恒定", () => {
		expect(getThisRuntimeProcessInstanceId()).toBe(getThisRuntimeProcessInstanceId());
		expect(getThisRuntimeProcessInstanceId()).toHaveLength(36);
	});
});

describe("runtime-process-instance-heartbeat-registry — 判活", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-runtime-heartbeat-"));
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	it("目录不存在时返回空集（还没有任何实例写过心跳）", async () => {
		expect(await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW })).toEqual(new Set());
	});
	it("查卡判活保留损坏心跳的未知态，只有缺失和过期才判死", async () => {
		const ownerId = "b2572b72-6c2d-4d75-9363-57f2dab76f72";
		expect(await readRuntimeProcessInstanceLiveness(ownerId)).toBe("dead");
		await writeHeartbeatFile(`${ownerId}.json`, "incomplete-json");
		expect(await readRuntimeProcessInstanceLiveness(ownerId)).toBe("unknown");
		await writeHeartbeatFile(`${ownerId}.json`, {
			runtimeProcessInstanceId: ownerId,
			pid: 1,
			startedAtEpochMs: Date.now(),
			lastHeartbeatAtEpochMs: Date.now(),
		});
		expect(await readRuntimeProcessInstanceLiveness(ownerId)).toBe("live");
		await writeHeartbeatFile(`${ownerId}.json`, {
			runtimeProcessInstanceId: ownerId,
			pid: 1,
			startedAtEpochMs: NOW,
			lastHeartbeatAtEpochMs: NOW,
		});
		expect(await readRuntimeProcessInstanceLiveness(ownerId)).toBe("dead");
	});

	it("宽限期内的心跳判活，宽限期外的判死", async () => {
		await writeHeartbeatFile("fresh.json", {
			runtimeProcessInstanceId: "fresh",
			pid: 111,
			startedAtEpochMs: NOW - 60_000,
			lastHeartbeatAtEpochMs: NOW - 1_000,
		});
		await writeHeartbeatFile("stale.json", {
			runtimeProcessInstanceId: "stale",
			pid: 222,
			startedAtEpochMs: NOW - 600_000,
			lastHeartbeatAtEpochMs: NOW - RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS - 1,
		});
		const live = await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW });
		expect(live).toEqual(new Set(["fresh"]));
	});

	it("恰好卡在宽限期边界上判死（判死是保守方向）", async () => {
		await writeHeartbeatFile("edge.json", {
			runtimeProcessInstanceId: "edge",
			pid: 333,
			startedAtEpochMs: NOW - 600_000,
			lastHeartbeatAtEpochMs: NOW - RUNTIME_PROCESS_INSTANCE_CONSIDERED_DEAD_AFTER_MS,
		});
		expect(await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW })).toEqual(new Set());
	});

	// 一份坏文件不该让其余实例集体判死——那会把它们正排着的队全部误标。
	it("单份心跳读坏了只跳过它，不连累其余实例", async () => {
		await writeHeartbeatFile("broken.json", "{ 这不是合法 JSON");
		await writeHeartbeatFile("shape-wrong.json", { runtimeProcessInstanceId: "x", 缺: "必填字段" });
		await writeHeartbeatFile("good.json", {
			runtimeProcessInstanceId: "good",
			pid: 444,
			startedAtEpochMs: NOW - 60_000,
			lastHeartbeatAtEpochMs: NOW - 1_000,
		});
		expect(await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW })).toEqual(new Set(["good"]));
	});

	it("非 .json 文件被忽略", async () => {
		await writeHeartbeatFile("README.txt", "无关文件");
		expect(await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW })).toEqual(new Set());
	});

	// 判活按文件里的 runtimeProcessInstanceId，不按文件名——文件名可能被人手工改过。
	it("判活取文件内容里的实例 id，不取文件名", async () => {
		await writeHeartbeatFile("renamed-by-hand.json", {
			runtimeProcessInstanceId: "real-id",
			pid: 555,
			startedAtEpochMs: NOW - 60_000,
			lastHeartbeatAtEpochMs: NOW - 1_000,
		});
		expect(await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW })).toEqual(new Set(["real-id"]));
	});
});

describe("runtime-process-instance-heartbeat-registry — 启停", () => {
	beforeEach(async () => {
		testRuntimeHome.path = await mkdtemp(join(tmpdir(), "kanban-runtime-heartbeat-"));
	});

	afterEach(async () => {
		await rm(testRuntimeHome.path, { recursive: true, force: true });
	});

	// 立刻写一次而不是等第一个节拍：同刻启动的另一个实例必须马上就能看见我，否则它会在那一拍里
	// 把我刚排的队判成 restart-crossing。
	it("启动即写一次心跳，本实例当场可见", async () => {
		const heartbeat = await startRuntimeProcessInstanceHeartbeat({ nowEpochMs: NOW });
		try {
			expect(heartbeat.runtimeProcessInstanceId).toBe(getThisRuntimeProcessInstanceId());
			const live = await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW });
			expect(live.has(getThisRuntimeProcessInstanceId())).toBe(true);
		} finally {
			await heartbeat.stop();
		}
	});

	// 优雅退出主动销号：下一个实例不必等满宽限期才敢判我死，重启后的提醒因此立刻生效而不是迟到两分钟。
	it("stop() 主动删掉自己的心跳，立刻判死", async () => {
		const heartbeat = await startRuntimeProcessInstanceHeartbeat({ nowEpochMs: NOW });
		await heartbeat.stop();
		const live = await readLiveRuntimeProcessInstanceIds({ nowEpochMs: NOW });
		expect(live.has(getThisRuntimeProcessInstanceId())).toBe(false);
	});

	it("stop() 可重复调用而不抛（关停路径可能走两次）", async () => {
		const heartbeat = await startRuntimeProcessInstanceHeartbeat({ nowEpochMs: NOW });
		await heartbeat.stop();
		await expect(heartbeat.stop()).resolves.toBeUndefined();
	});

	it("续期会推进 lastHeartbeatAt，使实例持续判活", async () => {
		const heartbeat = await startRuntimeProcessInstanceHeartbeat({ nowEpochMs: NOW, intervalMs: 5 });
		try {
			// 用一个「远在未来」的 now 去读：只有真的续期过，实例才还在宽限期内。
			await vi.waitFor(
				async () => {
					const live = await readLiveRuntimeProcessInstanceIds({ consideredDeadAfterMs: 200 });
					expect(live.has(getThisRuntimeProcessInstanceId())).toBe(true);
				},
				{ timeout: 2_000, interval: 20 },
			);
		} finally {
			await heartbeat.stop();
		}
	});
});
