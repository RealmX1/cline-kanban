import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { RuntimePostDeployVerificationState } from "../../../src/core/api-contract";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import { listVerificationExecutionAttempts } from "../../../src/deployment/verification-execution-attempt-store";
import * as verificationRunner from "../../../src/deployment/verification-script-runner";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";
import { createTempDir } from "../../utilities/temp-dir";
import { seedIsolatedVerificationExecutionTask } from "./verification-execution-isolated-runtime-fixture";

it("等待读取任务身份期间定义缩短超时，受理锁内拒绝旧请求且不创建 attempt", async () => {
	const sandbox = createTempDir("pdv-admission-definition-change-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
	try {
		const fixture = await seedIsolatedVerificationExecutionTask({ scriptBody: "process.exit(0)", timeoutMs: 60_000 });
		const runner = vi.spyOn(verificationRunner, "runVerificationScript").mockImplementation(async (input) => {
			if (!input.executionAttempt) throw new Error("缺少持久 attempt");
			return verificationRunner.buildVerificationExecutionRecoveryRunSnapshot(input.executionAttempt);
		});
		let definitionChanged = false;
		const api = createDeploymentApi({
			loadBoardTasksForWorkspace: async () => {
				if (!definitionChanged) {
					definitionChanged = true;
					const state: RuntimePostDeployVerificationState = JSON.parse(
						await readFile(getPostDeployVerificationStatePath(), "utf8"),
					);
					const script = state.deploymentGroups[0]?.tasks[0]?.checklist[0]?.script;
					if (!script) throw new Error("缺少隔离脚本定义");
					script.timeoutMs = 1000;
					await writeFile(getPostDeployVerificationStatePath(), JSON.stringify(state));
				}
				return [{ taskId: fixture.taskId, columnId: "validation", taskIncarnationCreatedAtEpochMs: 123 }];
			},
			loadTaskAgentResponsePreview: async () => null,
		});
		const result = await api.runPostDeployVerificationItem(fixture.scope, fixture.request);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("定义已变更");
		expect(runner).not.toHaveBeenCalled();
		expect(await listVerificationExecutionAttempts()).toEqual([]);
		const state: RuntimePostDeployVerificationState = JSON.parse(
			await readFile(getPostDeployVerificationStatePath(), "utf8"),
		);
		expect(state.deploymentGroups[0]?.tasks[0]?.checklist[0]?.run).toBeNull();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		sandbox.cleanup();
	}
});
