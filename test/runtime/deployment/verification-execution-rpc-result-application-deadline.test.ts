import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import * as verificationState from "../../../src/deployment/post-deploy-verification-state";
import * as verificationRunner from "../../../src/deployment/verification-script-runner";
import { createDeploymentApi } from "../../../src/trpc/deployment-api";
import { createTempDir } from "../../utilities/temp-dir";
import { seedIsolatedVerificationExecutionTask } from "./verification-execution-isolated-runtime-fixture";

it("结果应用等待全局锁时 RPC 仍按绝对预算返回已知 running，恢复器负责后续应用", async () => {
	const sandbox = createTempDir("pdv-result-application-deadline-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
	let releaseApplication: () => void = () => undefined;
	let markApplicationEntered: () => void = () => undefined;
	const applicationBlocked = new Promise<void>((resolve) => {
		releaseApplication = resolve;
	});
	const applicationEntered = new Promise<void>((resolve) => {
		markApplicationEntered = resolve;
	});
	try {
		const fixture = await seedIsolatedVerificationExecutionTask({ scriptBody: "process.exit(0)", timeoutMs: 1000 });
		vi.spyOn(verificationRunner, "runVerificationScript").mockImplementation(async (input) => {
			if (!input.executionAttempt) throw new Error("没有持久 attempt");
			return {
				...verificationRunner.buildVerificationExecutionRunSnapshot(input.executionAttempt, {
					status: "passed",
					exitCode: 0,
					finishedAtIso: new Date().toISOString(),
					outputExcerpt: "ok",
				}),
				status: "passed",
			};
		});
		vi.spyOn(verificationState, "applyVerificationRunResult").mockImplementation(async () => {
			markApplicationEntered();
			await applicationBlocked;
			return { ok: false, task: null, error: "隔离测试结束" };
		});
		const api = createDeploymentApi({
			loadBoardTasksForWorkspace: async () => [
				{ taskId: fixture.taskId, columnId: "validation", taskIncarnationCreatedAtEpochMs: 123 },
			],
			loadTaskAgentResponsePreview: async () => null,
		});
		vi.useFakeTimers();
		const pending = api.runPostDeployVerificationItem(fixture.scope, fixture.request);
		let response: Awaited<typeof pending> | undefined;
		void pending.then((value) => {
			response = value;
		});
		await applicationEntered;
		await vi.advanceTimersByTimeAsync(6000);
		expect(response?.ok).toBe(true);
		expect(response?.task?.checklist[0]?.run?.status).toBe("running");
		expect(response?.task?.checklist[0]?.run?.recoveryObservation?.reason).toBe("awaiting_exit_confirmation");
		const state = JSON.parse(await readFile(verificationState.getPostDeployVerificationStatePath(), "utf8"));
		expect(state.deploymentGroups[0].tasks[0].checklist[0].checked).toBe(false);
		releaseApplication();
		await pending;
	} finally {
		releaseApplication();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		sandbox.cleanup();
	}
});
