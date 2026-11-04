import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import {
	allocateVerificationExecutionAttempt,
	cancelVerificationExecutionAttempt,
} from "../../../src/deployment/verification-execution-attempt-store";
import {
	runVerificationScript,
	type VerificationScriptRunOutcome,
} from "../../../src/deployment/verification-script-runner";
import * as ownedCommandSupervisor from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

it("validator 挂起也在绝对 deadline 加五秒返回 running，后续解挂不重新派发", async () => {
	const sandbox = createTempDir("pdv-absolute-deadline-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
	let releaseValidator: () => void = () => undefined;
	let markValidatorEntered: () => void = () => undefined;
	const validatorBlocked = new Promise<void>((resolve) => {
		releaseValidator = resolve;
	});
	const validatorEntered = new Promise<void>((resolve) => {
		markValidatorEntered = resolve;
	});
	const launch = vi
		.spyOn(ownedCommandSupervisor, "launchOwnedCommandSupervisor")
		.mockImplementation(async (_record, validate) => {
			await validate();
		});
	let pendingOutcome: Promise<VerificationScriptRunOutcome> | undefined;
	const verificationId = randomUUID();
	const script = { entrypoint: "run.js", interpreter: "node" as const, timeoutMs: 1000 };
	const attempt = await allocateVerificationExecutionAttempt({
		workspaceId: "workspace",
		deploymentId: "deployment",
		taskId: "task",
		postDeployVerificationTaskInstanceId: randomUUID(),
		itemId: "item",
		verificationId,
		script,
		verificationDefinitionFingerprint: "definition",
		startedAtIso: new Date().toISOString(),
	});
	try {
		const assetsDir = await ensureVerificationAssetsDir(verificationId);
		await writeFile(join(assetsDir, "run.js"), "process.exit(0)");
		vi.useFakeTimers();
		let observed: VerificationScriptRunOutcome | undefined;
		pendingOutcome = runVerificationScript({
			verificationId,
			script,
			executionAttempt: attempt,
			startedAtIso: attempt.startedAtIso,
			finishedAtIsoProvider: () => new Date().toISOString(),
			validateBeforeDispatch: async () => {
				markValidatorEntered();
				await validatorBlocked;
			},
		});
		void pendingOutcome.then((outcome) => {
			observed = outcome;
		});
		await validatorEntered;
		await vi.advanceTimersByTimeAsync(6000);
		expect(observed?.status).toBe("running");
		expect(observed?.verificationExecutionAttemptId).toBe(attempt.verificationExecutionAttemptId);
	} finally {
		await cancelVerificationExecutionAttempt(
			attempt.verificationExecutionAttemptId,
			"test_cleanup",
			new Date().toISOString(),
		);
		releaseValidator();
		await pendingOutcome;
		vi.useRealTimers();
		expect(launch).toHaveBeenCalledTimes(1);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		sandbox.cleanup();
	}
});
