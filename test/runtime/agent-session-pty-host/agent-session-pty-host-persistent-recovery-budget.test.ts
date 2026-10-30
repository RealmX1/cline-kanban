import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentSessionPtyHostPersistentRecoveryBudget } from "../../../src/agent-session-pty-host/runtime-client/agent-session-pty-host-persistent-recovery-budget";
import { createTempDir } from "../../utilities/temp-dir";

describe("独立 PTY host 的持久恢复预算", () => {
	it("最多三次并遵守三十秒总预算，重启不重置，响应或证据变化后自动接续", async () => {
		const directory = createTempDir("kanban-pty-host-recovery-budget-");
		let now = 100_000;
		let fingerprint = "相同 build 与依赖";
		let readonlyProbeReady = false;
		let attempts = 0;
		const retryDelays: number[] = [];
		const options = {
			recoveryStateFilePath: `${directory.path}/recovery.json`,
			readEvidenceFingerprint: () => fingerprint,
			readNowEpochMs: () => now,
			waitBeforeRetry: async (milliseconds: number) => {
				retryDelays.push(milliseconds);
				now += milliseconds;
			},
			onProgress: () => {},
		};
		const failingAttempt = async () => {
			attempts += 1;
			now += 8_000;
			throw new Error("依赖不可用");
		};
		try {
			const firstRuntime = await AgentSessionPtyHostPersistentRecoveryBudget.load(options);
			expect((await firstRuntime.recover(failingAttempt, async () => readonlyProbeReady)).kind).toBe(
				"budget_exhausted",
			);
			expect(attempts).toBe(3);
			expect(retryDelays).toEqual([1_000, 3_000]);
			expect(now).toBeLessThanOrEqual(130_000);
			const restartedRuntime = await AgentSessionPtyHostPersistentRecoveryBudget.load(options);
			await restartedRuntime.recover(failingAttempt, async () => readonlyProbeReady);
			expect(attempts).toBe(3);
			now += 30_000;
			await restartedRuntime.recover(failingAttempt, async () => readonlyProbeReady);
			expect(attempts).toBe(3);
			readonlyProbeReady = true;
			now += 30_000;
			expect(
				await restartedRuntime.recover(
					async () => "已恢复",
					async () => readonlyProbeReady,
				),
			).toEqual({ kind: "ready", value: "已恢复" });
			fingerprint = "新 build";
			expect(
				await restartedRuntime.recover(
					async () => "新证据",
					async () => false,
				),
			).toEqual({ kind: "ready", value: "新证据" });
			const history = await readFile(`${directory.path}/recovery-progress-history.jsonl`, "utf8");
			expect(history).toContain("依赖不可用");
			expect(history).toContain("相同 build 与依赖");
			expect(history).toContain("新 build");
		} finally {
			directory.cleanup();
		}
	});
});
