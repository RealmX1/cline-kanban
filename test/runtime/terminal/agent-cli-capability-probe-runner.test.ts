import { beforeEach, describe, expect, it, vi } from "vitest";

// driver 是「跑 CLI 子命令 + 收敛所有横切关注点」的执行器，所以测试要观察的正是**是否真的 spawn 了**
// 以及 spawn 失败时会不会把异常泄漏出去。把 node:child_process 换成受控替身即可两者兼顾，且完全 hermetic。
const execFileMockState = vi.hoisted(() => ({
	callCount: 0,
	respond: async (_binary: string, _args: readonly string[]): Promise<{ stdout: string; stderr: string }> => ({
		stdout: "",
		stderr: "",
	}),
}));

vi.mock("node:child_process", () => ({
	execFile: (
		binary: string,
		args: readonly string[],
		_options: unknown,
		callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
	) => {
		execFileMockState.callCount += 1;
		execFileMockState.respond(binary, args).then(
			(result) => callback(null, result),
			(error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
		);
	},
}));

const { clearCachedAgentCliCapabilityProbeOutcomes, runAgentCliCapabilityProbe } = await import(
	"../../../src/terminal/agent-cli-capability-probe-runner"
);

function buildProbeContract(probeId: string, parseStdout: (stdout: string) => string[] = (stdout) => [stdout]) {
	return {
		probeId,
		binary: "fake-agent",
		args: ["list-models"] as const,
		timeoutMs: 1_000,
		maxBufferBytes: 1024,
		parseStdout,
	};
}

beforeEach(() => {
	clearCachedAgentCliCapabilityProbeOutcomes();
	execFileMockState.callCount = 0;
	execFileMockState.respond = async () => ({ stdout: "", stderr: "" });
});

describe("runAgentCliCapabilityProbe", () => {
	it("returns the parsed value on success", async () => {
		execFileMockState.respond = async () => ({ stdout: "one\ntwo", stderr: "" });

		const outcome = await runAgentCliCapabilityProbe(
			buildProbeContract("probe-success", (stdout) => stdout.split("\n")),
		);

		expect(outcome).toEqual({ ok: true, value: ["one", "two"] });
	});

	it("strips ANSI style sequences before parsing when the contract asks for it", async () => {
		const ansiEscapeCharacter = String.fromCharCode(27);
		execFileMockState.respond = async () => ({
			stdout: `${ansiEscapeCharacter}[36mcursor-grok-4.6-high${ansiEscapeCharacter}[39m`,
			stderr: "",
		});

		const outcome = await runAgentCliCapabilityProbe({
			...buildProbeContract("probe-ansi"),
			stripAnsiStyleEscapeSequencesFromStdout: true,
		});

		expect(outcome).toEqual({ ok: true, value: ["cursor-grok-4.6-high"] });
	});

	it("keeps ANSI style sequences when the contract does not ask for stripping", async () => {
		const ansiEscapeCharacter = String.fromCharCode(27);
		execFileMockState.respond = async () => ({
			stdout: `${ansiEscapeCharacter}[36mraw${ansiEscapeCharacter}[39m`,
			stderr: "",
		});

		const outcome = await runAgentCliCapabilityProbe(buildProbeContract("probe-ansi-kept"));

		expect(outcome).toEqual({ ok: true, value: [`${ansiEscapeCharacter}[36mraw${ansiEscapeCharacter}[39m`] });
	});

	// 这条是本 driver 最要紧的契约：前端靠响应里的 `warning`（而非异常）判定「这是降级结果、别写回
	// localStorage」。一旦 driver 改成抛异常，一次 CLI 抖动就会把整份模型列表污染成单条 Default 并持久化。
	it("degrades a failed spawn into a warning instead of rejecting", async () => {
		execFileMockState.respond = async () => {
			throw new Error("spawn fake-agent ENOENT");
		};

		const outcome = await runAgentCliCapabilityProbe(buildProbeContract("probe-spawn-failure"));

		expect(outcome).toEqual({ ok: false, warning: "spawn fake-agent ENOENT" });
	});

	it("degrades a throwing parser into a warning instead of rejecting", async () => {
		execFileMockState.respond = async () => ({ stdout: "not json", stderr: "" });

		const outcome = await runAgentCliCapabilityProbe(
			buildProbeContract("probe-parse-failure", () => {
				throw new Error("Unexpected token o in JSON");
			}),
		);

		expect(outcome).toEqual({ ok: false, warning: "Unexpected token o in JSON" });
	});

	it("serves a cached success without spawning again", async () => {
		execFileMockState.respond = async () => ({ stdout: "cached", stderr: "" });

		const first = await runAgentCliCapabilityProbe(buildProbeContract("probe-cache-hit"));
		const second = await runAgentCliCapabilityProbe(buildProbeContract("probe-cache-hit"));

		expect(first).toEqual(second);
		expect(execFileMockState.callCount).toBe(1);
	});

	it("caches per probe id so two agents never share a result", async () => {
		execFileMockState.respond = async (_binary, args) => ({ stdout: args.join(" "), stderr: "" });

		await runAgentCliCapabilityProbe({ ...buildProbeContract("probe-agent-one"), args: ["one"] });
		const other = await runAgentCliCapabilityProbe({ ...buildProbeContract("probe-agent-two"), args: ["two"] });

		expect(other).toEqual({ ok: true, value: ["two"] });
		expect(execFileMockState.callCount).toBe(2);
	});

	// 模型选择器与会话启动路径会在同一瞬间各打一次同一条探测；没有 in-flight 去重就是两次真 spawn。
	it("collapses concurrent calls for the same probe into a single spawn", async () => {
		const pendingProbe: { release: (() => void) | null } = { release: null };
		execFileMockState.respond = () =>
			new Promise((resolve) => {
				pendingProbe.release = () => resolve({ stdout: "shared", stderr: "" });
			});

		const firstRun = runAgentCliCapabilityProbe(buildProbeContract("probe-in-flight"));
		const secondRun = runAgentCliCapabilityProbe(buildProbeContract("probe-in-flight"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		pendingProbe.release?.();

		expect(await firstRun).toEqual({ ok: true, value: ["shared"] });
		expect(await secondRun).toEqual({ ok: true, value: ["shared"] });
		expect(execFileMockState.callCount).toBe(1);
	});

	it("spawns again after the cached outcome is explicitly cleared", async () => {
		execFileMockState.respond = async () => ({ stdout: "first", stderr: "" });
		await runAgentCliCapabilityProbe(buildProbeContract("probe-cleared"));

		clearCachedAgentCliCapabilityProbeOutcomes("probe-cleared");
		execFileMockState.respond = async () => ({ stdout: "second", stderr: "" });
		const afterClear = await runAgentCliCapabilityProbe(buildProbeContract("probe-cleared"));

		expect(afterClear).toEqual({ ok: true, value: ["second"] });
		expect(execFileMockState.callCount).toBe(2);
	});
});
