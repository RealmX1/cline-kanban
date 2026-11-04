import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimePostDeployVerificationState } from "../../../src/core/api-contract";
import {
	applyVerificationRunResult,
	getPostDeployVerificationStatePath,
	reconcileGroup,
	setVerificationRunState,
	validateVerificationExecutionAttemptForDispatch,
} from "../../../src/deployment/post-deploy-verification-state";
import {
	mutateVerificationExecutionAttempt,
	readVerificationExecutionAttempt,
} from "../../../src/deployment/verification-execution-attempt-store";
import { buildVerificationExecutionRunSnapshot } from "../../../src/deployment/verification-script-runner";
import { createTempDir } from "../../utilities/temp-dir";
import { seedIsolatedVerificationExecutionTask } from "./verification-execution-isolated-runtime-fixture";

let sandbox: ReturnType<typeof createTempDir>;
beforeEach(() => {
	sandbox = createTempDir("pdv-result-ownership-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
});
afterEach(() => {
	vi.unstubAllEnvs();
	sandbox.cleanup();
});
async function admitAttempt() {
	const fixture = await seedIsolatedVerificationExecutionTask({ scriptBody: "process.exit(0)" });
	const started = await setVerificationRunState(
		{
			...fixture.request,
			workspaceId: fixture.workspaceId,
			taskIncarnationCreatedAtEpochMs: 123,
			startedAtIso: new Date().toISOString(),
		},
		new Date().toISOString(),
	);
	if (!started.executionAttempt) throw new Error(started.error ?? "未分配 attempt");
	return { ...fixture, attempt: started.executionAttempt };
}
async function persistTrustedPassedReceipt(attemptId: string) {
	return mutateVerificationExecutionAttempt(attemptId, (attempt) => {
		attempt.launchStage = "terminal";
		attempt.terminalRun = buildVerificationExecutionRunSnapshot(attempt, {
			status: "passed",
			exitCode: 0,
			finishedAtIso: new Date().toISOString(),
			outputExcerpt: "ok",
		});
		return attempt.terminalRun;
	});
}
async function readState() {
	return JSON.parse(
		await readFile(getPostDeployVerificationStatePath(), "utf8"),
	) as RuntimePostDeployVerificationState;
}

describe("执行结果身份与结案门禁", () => {
	it("同 ID 不同 createdAt 且没有中间缺席对账，派发与旧结果均被拒绝", async () => {
		const fixture = await admitAttempt();
		await expect(
			validateVerificationExecutionAttemptForDispatch(
				fixture.attempt.verificationExecutionAttemptId,
				async () => 124,
			),
		).rejects.toThrow("已失效");
		const run = await persistTrustedPassedReceipt(fixture.attempt.verificationExecutionAttemptId);
		const applied = await applyVerificationRunResult(
			{ ...fixture.request, run, readCurrentTaskIncarnationCreatedAtEpochMs: async () => 124 },
			new Date().toISOString(),
		);
		expect(applied.ok).toBe(false);
		const currentTask = (await readState()).deploymentGroups[0]?.tasks[0];
		expect(currentTask?.taskIncarnationCreatedAtEpochMs).toBe(124);
		expect(currentTask?.postDeployVerificationTaskInstanceId).not.toBe(
			fixture.attempt.postDeployVerificationTaskInstanceId,
		);
		expect(currentTask?.checklist[0]?.checked).toBe(false);
	});

	it.each(["new_attempt", "new_entry_instance", "closed_task", "unconfirmed_exit"])(
		"晚到 passed 不覆盖 %s",
		async (changedOwnership) => {
			const fixture = await admitAttempt();
			const run = await persistTrustedPassedReceipt(fixture.attempt.verificationExecutionAttemptId);
			const state = await readState();
			const task = state.deploymentGroups[0]?.tasks[0];
			if (!task || !task.checklist[0]?.run) throw new Error("缺少 running");
			if (changedOwnership === "new_attempt") task.checklist[0].run.verificationExecutionAttemptId = randomUUID();
			if (changedOwnership === "new_entry_instance") task.postDeployVerificationTaskInstanceId = randomUUID();
			if (changedOwnership === "closed_task") task.verifiedAt = "2026-10-01T00:00:00.000Z";
			if (changedOwnership === "unconfirmed_exit")
				await mutateVerificationExecutionAttempt(fixture.attempt.verificationExecutionAttemptId, (attempt) => {
					attempt.launchStage = "observing";
					attempt.terminalRun = null;
				});
			await writeFile(getPostDeployVerificationStatePath(), JSON.stringify(state));
			const applied = await applyVerificationRunResult(
				{ ...fixture.request, run, currentTaskIncarnationCreatedAtEpochMs: 123 },
				new Date().toISOString(),
			);
			expect(applied.ok).toBe(false);
			expect((await readState()).deploymentGroups[0]?.tasks[0]?.checklist[0]?.checked).toBe(false);
			if (changedOwnership === "closed_task")
				expect((await readState()).deploymentGroups[0]?.tasks[0]?.verifiedAt).toBe("2026-10-01T00:00:00.000Z");
		},
	);

	it("跨部署沿原归属链只写最新副本，保留实际卡片 createdAt", async () => {
		const fixture = await admitAttempt();
		const state = await readState();
		const original = state.deploymentGroups[0];
		if (!original?.tasks[0]) throw new Error("缺少原部署组");
		const carried = structuredClone(original);
		carried.deploymentId = randomUUID();
		original.tasks[0].carriedForwardIntoDeploymentId = carried.deploymentId;
		state.deploymentGroups.push(carried);
		await writeFile(getPostDeployVerificationStatePath(), JSON.stringify(state));
		const run = await persistTrustedPassedReceipt(fixture.attempt.verificationExecutionAttemptId);
		const applied = await applyVerificationRunResult(
			{ ...fixture.request, run, currentTaskIncarnationCreatedAtEpochMs: 123 },
			new Date().toISOString(),
		);
		expect(applied.ok).toBe(true);
		const after = await readState();
		expect(after.deploymentGroups[1]?.tasks[0]?.checklist[0]?.checked).toBe(true);
		expect(after.deploymentGroups[0]?.tasks[0]?.checklist[0]?.checked).toBe(false);
		expect(after.deploymentGroups[1]?.tasks[0]?.taskIncarnationCreatedAtEpochMs).toBe(123);
	});

	it("对账也检测同 ID 换代，并先保存取消意图", async () => {
		const fixture = await admitAttempt();
		await reconcileGroup({
			deploymentId: fixture.deploymentId,
			workspaceId: fixture.workspaceId,
			nowIso: new Date().toISOString(),
			currentBoardTasks: [{ taskId: fixture.taskId, columnId: "validation", taskIncarnationCreatedAtEpochMs: 124 }],
		});
		expect(
			(await readVerificationExecutionAttempt(fixture.attempt.verificationExecutionAttemptId)).cancellationIntent,
		).not.toBeNull();
		expect((await readState()).deploymentGroups[0]?.tasks[0]?.checklist[0]?.run).toBeNull();
	});
});
