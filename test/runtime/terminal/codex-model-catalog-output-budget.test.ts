import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCachedAgentCliCapabilityProbeOutcomes } from "../../../src/terminal/agent-cli-capability-probe-runner";
import { getTerminalAgentModelSelectionOptions } from "../../../src/terminal/terminal-agent-model-selection";

const output = vi.hoisted(() => ({ paddingBytes: 0, maximumBytes: 0 }));
vi.mock("node:child_process", () => ({
	execFile: (
		_binary: string,
		_arguments: string[],
		options: { maxBuffer: number },
		callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
	) => {
		output.maximumBytes = options.maxBuffer;
		const stdout = JSON.stringify({
			padding: "x".repeat(output.paddingBytes),
			models: [
				{
					slug: "native-fixture",
					visibility: "list",
					supported_reasoning_levels: [{ effort: "ultra" }, { effort: "future-effort" }],
				},
			],
		});
		callback(Buffer.byteLength(stdout) > options.maxBuffer ? new Error("stdout maxBuffer length exceeded") : null, {
			stdout,
			stderr: "",
		});
	},
}));
beforeEach(() => clearCachedAgentCliCapabilityProbeOutcomes());
describe("Codex 模型目录读取预算", () => {
	it("超过 1 MiB 的有效目录保留原生推理档位", async () => {
		output.paddingBytes = 2 * 1024 * 1024;
		const response = await getTerminalAgentModelSelectionOptions("codex");
		expect(output.maximumBytes).toBe(4 * 1024 * 1024);
		expect(response.warning).toBeUndefined();
		expect(response.options[0]?.supportedReasoningEfforts?.map((option) => option.effort)).toEqual([
			"ultra",
			"future-effort",
		]);
	});
	it("超预算仍返回可恢复的失败", async () => {
		output.paddingBytes = 4 * 1024 * 1024;
		expect((await getTerminalAgentModelSelectionOptions("codex")).warning).toContain("maxBuffer");
	});
});
