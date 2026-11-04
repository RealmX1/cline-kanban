import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
	allocateVerificationExecutionAttempt,
	readVerificationExecutionAttempt,
	verificationExecutionAttemptDirectory,
} from "../../../src/deployment/verification-execution-attempt-store";
import { observeVerificationExecutionAttempt } from "../../../src/deployment/verification-execution-recovery";
import * as commandSupervisor from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

it("初读后才落盘的最终回执优先于监督者已退出的兜底错误", async () => {
	const isolatedRuntimeHome = createTempDir("verification-terminal-receipt-after-owner-exit-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"])
		vi.stubEnv(key, isolatedRuntimeHome.path);
	vi.spyOn(commandSupervisor, "readSystemBootIdentity").mockResolvedValue("same-system-boot");
	vi.spyOn(commandSupervisor, "readProcessIdentity").mockResolvedValue(null);
	try {
		const attempt = await allocateVerificationExecutionAttempt({
			workspaceId: "isolated-terminal-receipt-workspace",
			deploymentId: "isolated-terminal-receipt-deployment",
			taskId: "isolated-terminal-receipt-task",
			postDeployVerificationTaskInstanceId: randomUUID(),
			verificationId: randomUUID(),
			itemId: "isolated-terminal-receipt-item",
			verificationDefinitionFingerprint: "isolated-terminal-receipt-definition",
			startedAtIso: new Date().toISOString(),
			script: { entrypoint: "run.cjs", interpreter: "node", timeoutMs: 300_000 },
		});
		const executionAttemptId = attempt.verificationExecutionAttemptId;
		vi.spyOn(commandSupervisor, "inspectOwnedCommandSupervisor").mockImplementation(async () => {
			await writeFile(
				join(
					verificationExecutionAttemptDirectory(executionAttemptId),
					`supervisor-progress-${executionAttemptId}.json`,
				),
				JSON.stringify({
					launchNonce: executionAttemptId,
					status: "exited",
					ownedProcesses: [],
					returncode: 0,
					outputTail: "脚本已完成且全部后代退出",
					updatedAtEpochMs: Date.now(),
				}),
			);
			return "exited";
		});

		const observedRun = await observeVerificationExecutionAttempt(executionAttemptId);

		expect(observedRun.status).toBe("passed");
		expect(observedRun.exitCode).toBe(0);
		expect(observedRun.outputExcerpt).toContain("脚本已完成");
		expect((await readVerificationExecutionAttempt(executionAttemptId)).terminalRun?.status).toBe("passed");
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		isolatedRuntimeHome.cleanup();
	}
});
