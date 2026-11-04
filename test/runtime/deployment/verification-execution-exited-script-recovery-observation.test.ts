import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	allocateVerificationExecutionAttempt,
	verificationExecutionAttemptDirectory,
} from "../../../src/deployment/verification-execution-attempt-store";
import { observeVerificationExecutionAttempt } from "../../../src/deployment/verification-execution-recovery";
import * as commandSupervisor from "../../../src/task-command-execution/task-command-execution-supervisor";
import { createTempDir } from "../../utilities/temp-dir";

let isolatedRuntimeHome: ReturnType<typeof createTempDir>;

beforeEach(() => {
	isolatedRuntimeHome = createTempDir("verification-exited-script-recovery-observation-");
	for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"])
		vi.stubEnv(key, isolatedRuntimeHome.path);
	vi.spyOn(commandSupervisor, "readSystemBootIdentity").mockResolvedValue("unchanged-system-boot");
	vi.spyOn(commandSupervisor, "inspectOwnedCommandSupervisor").mockResolvedValue("running");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	isolatedRuntimeHome.cleanup();
});

it("正文已退出但监督者仍核验后代时，在超时之前也发布具体恢复观察", async () => {
	const attempt = await allocateVerificationExecutionAttempt({
		workspaceId: "isolated-observation-workspace",
		deploymentId: "isolated-observation-deployment",
		taskId: "isolated-observation-task",
		postDeployVerificationTaskInstanceId: randomUUID(),
		verificationId: randomUUID(),
		itemId: "isolated-observation-item",
		verificationDefinitionFingerprint: "isolated-observation-definition",
		startedAtIso: new Date().toISOString(),
		script: { entrypoint: "run.cjs", interpreter: "node", timeoutMs: 300_000 },
	});
	const executionAttemptId = attempt.verificationExecutionAttemptId;
	const artifactDirectory = verificationExecutionAttemptDirectory(executionAttemptId);
	const supervisorIdentity = {
		launchNonce: executionAttemptId,
		pid: 999_991,
		startAndCommand: "Sat Oct 31 12:00:00 2026 isolated-supervisor",
		nativeProcessGenerationIdentity: "isolated-native-supervisor-generation",
	};
	vi.spyOn(commandSupervisor, "readProcessIdentity").mockImplementation(async (pid) =>
		pid === supervisorIdentity.pid ? supervisorIdentity : null,
	);
	await writeFile(
		join(artifactDirectory, `supervisor-identity-${executionAttemptId}.json`),
		JSON.stringify(supervisorIdentity),
	);
	await writeFile(
		join(artifactDirectory, `supervisor-progress-${executionAttemptId}.json`),
		JSON.stringify({
			launchNonce: executionAttemptId,
			status: "running",
			ownedProcesses: [],
			returncode: 0,
			nativeOwnershipUnproven: true,
			unprovenOwnershipProcesses: [
				{
					pid: 999_992,
					processStartIdentity: "Sat Oct 31 12:00:01 2026",
					nativeProcessGenerationIdentity: "isolated-unproven-native-generation",
					reason: "original_parent_lineage_not_proven",
				},
			],
			updatedAtEpochMs: Date.now(),
		}),
	);

	const observedRun = await observeVerificationExecutionAttempt(executionAttemptId);

	expect(observedRun.status).toBe("running");
	expect(observedRun.recoveryObservation).toMatchObject({
		reason: "awaiting_exit_confirmation",
		unprovenProcessIdentities: [
			{ processPid: 999_992, nativeProcessGenerationIdentity: "isolated-unproven-native-generation" },
		],
	});
	expect(observedRun.recoveryObservation?.message).toContain("正在核验退出");
	expect(observedRun.recoveryObservation?.message).toContain("999992");
});
