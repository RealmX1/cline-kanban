import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	hasSameProcessGeneration,
	observeOwnedProcessGenerations,
	readProcessIdentity,
} from "../../../src/task-command-execution/task-command-execution-supervisor";

const queries = vi.hoisted(() => ({
	count: 0,
	active: 0,
	maximumActive: 0,
	unreadable: false,
	malformed: false,
	zombie: false,
}));
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
	execFile: (
		_command: string,
		args: string[],
		_options: unknown,
		callback: (error: Error | null, result?: { stdout: string }) => void,
	) => {
		queries.count++;
		queries.active++;
		queries.maximumActive = Math.max(queries.maximumActive, queries.active);
		setImmediate(() => {
			queries.active--;
			if (queries.unreadable) return callback(Object.assign(new Error("进程表不可读"), { code: "EACCES" }));
			callback(null, {
				stdout: queries.malformed
					? "无法解析的进程表"
					: args[0] === "-axo"
						? [400, 401, 402]
								.map((pid) => `${pid} ${queries.zombie ? "Z" : "S"} Wed Oct 28 12:00:00 2026 execed-worker`)
								.join("\n")
						: `${queries.zombie ? "Z" : "S"} Wed Oct 28 12:00:00 2026 execed-worker`,
			});
		});
	},
}));
beforeEach(() =>
	Object.assign(queries, {
		count: 0,
		active: 0,
		maximumActive: 0,
		unreadable: false,
		malformed: false,
		zombie: false,
	}),
);
afterEach(() => vi.restoreAllMocks());

it("批量观察与信号前复核均将僵尸识别为已退出", async () => {
	queries.zombie = true;
	const [observed] = await observeOwnedProcessGenerations([
		{ pid: 400, startAndCommand: "Wed Oct 28 12:00:00 2026 worker" },
	]);
	expect(observed?.current).toBeNull();
	expect(await readProcessIdentity(400)).toBeNull();
});

it.each([0, 100, 1582, 10_000])(
	"历史身份 %i 条时，一次进程表同时排除退出世代并保留三个活体",
	async (historicalCount) => {
		const identities = [...Array.from({ length: historicalCount }, (_, index) => 100_000 + index), 400, 401, 402].map(
			(pid) => ({ pid, startAndCommand: "Wed Oct 28 12:00:00 2026 original-worker" }),
		);
		const observed = await observeOwnedProcessGenerations(identities);
		expect(queries.count).toBe(1);
		expect(
			observed.filter(
				(entry) => entry.current !== "unreadable" && hasSameProcessGeneration(entry.current, entry.expected),
			),
		).toHaveLength(3);
		expect(observed.filter((entry) => entry.current === null)).toHaveLength(historicalCount);
	},
);

it.each(["unreadable", "malformed"] as const)("%s 的批量快照不能证明进程已退出", async (failure) => {
	queries[failure] = true;
	expect(
		await observeOwnedProcessGenerations([{ pid: 400, startAndCommand: "Wed Oct 28 12:00:00 2026 worker" }]),
	).toEqual([{ expected: expect.any(Object), current: "unreadable" }]);
});

it("精确代际缺证和 PID 复用均不授予归属", async () => {
	const expected = { pid: 400, startAndCommand: "Wed Oct 28 12:00:01 2026 different-generation" };
	const [observed] = await observeOwnedProcessGenerations([expected]);
	expect(observed?.current).not.toBe("unreadable");
	if (observed?.current === "unreadable") throw new Error("夹具进程表应可读");
	expect(hasSameProcessGeneration(observed?.current, expected)).toBe(false);
	expect(
		hasSameProcessGeneration(observed?.current, {
			...expected,
			nativeProcessGenerationIdentity: "unproven-native-generation",
		}),
	).toBe(false);
});

it("必要的定向 ps 查询全局最多并发八路", async () => {
	await Promise.all(Array.from({ length: 100 }, (_, index) => readProcessIdentity(10_000 + index)));
	expect(queries.maximumActive).toBe(8);
	expect(queries.active).toBe(0);
});
