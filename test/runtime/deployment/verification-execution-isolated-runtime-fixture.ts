import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimePostDeployVerificationState } from "../../../src/core/api-contract";
import { buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults } from "../../../src/deployment/post-deploy-verification-deployment-group-task-assembly";
import { getPostDeployVerificationStatePath } from "../../../src/deployment/post-deploy-verification-state";
import { ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";

import {
	cancelVerificationExecutionAttempt,
	listVerificationExecutionAttempts,
	verificationExecutionAttemptCancellationPath,
	verificationExecutionAttemptDirectory,
} from "../../../src/deployment/verification-execution-attempt-store";
import {
	cancelOwnedCommandProcesses,
	hasSameProcessGeneration,
	type OwnedProcessIdentity,
	readProcessIdentity,
} from "../../../src/task-command-execution/task-command-execution-supervisor";

export async function seedIsolatedVerificationExecutionTask(input: { scriptBody: string; timeoutMs?: number }) {
	const verificationId = randomUUID();
	const deploymentId = randomUUID();
	const workspaceId = "verification-execution-test-workspace";
	const taskId = "verification-execution-test-task";
	const itemId = `authored:${verificationId}`;
	const taskIncarnationCreatedAtEpochMs = 123;
	const assetsDir = await ensureVerificationAssetsDir(verificationId);
	await writeFile(join(assetsDir, "run.js"), input.scriptBody);
	const state: RuntimePostDeployVerificationState = {
		deploymentGroups: [
			{
				deploymentId,
				workspaceId,
				deployedSourceCommit: "a".repeat(40),
				previousDeployedSourceCommit: null,
				deployedAtIso: new Date().toISOString(),
				foldedAtIso: null,
				tasks: [
					{
						...buildPostDeployVerificationTaskFieldsAddedForDeploymentAttributionAndClosureWithDefaults(),
						taskId,
						columnIdAtMatch: "validation",
						matchedCommits: [],
						inclusionReason: "validation_column",
						checklist: [
							{
								id: itemId,
								label: "隔离执行监督验证",
								checked: false,
								source: "authored",
								kind: "automated_script",
								guidance: null,
								script: { entrypoint: "run.js", interpreter: "node", timeoutMs: input.timeoutMs ?? 60_000 },
								run: null,
								cleanup: { mode: "retain", assetsDir, manualSteps: [] },
							},
						],
						verifiedAt: null,
						boardMovedToDoneAt: null,
						pendingConfirmation: null,
						droppedReason: null,
					},
				],
			},
		],
	};
	await mkdir(dirname(getPostDeployVerificationStatePath()), { recursive: true });
	await writeFile(getPostDeployVerificationStatePath(), JSON.stringify(state));
	return {
		state,
		deploymentId,
		workspaceId,
		taskId,
		itemId,
		verificationId,
		taskIncarnationCreatedAtEpochMs,
		scope: { workspaceId, workspacePath: process.cwd() },
		request: { deploymentId, taskId, itemId },
	};
}

// 独立监督没有父 ChildProcess 句柄；只按本隔离 HOME 的持久原件回收本测试创建的进程。
export async function cleanupIsolatedVerificationExecutionAttempts(): Promise<void> {
	for (const attempt of await listVerificationExecutionAttempts()) {
		const directory = verificationExecutionAttemptDirectory(attempt.verificationExecutionAttemptId);
		await cancelVerificationExecutionAttempt(
			attempt.verificationExecutionAttemptId,
			"isolated_test_cleanup",
			new Date().toISOString(),
		);
		let nativeProbePath: string | null | undefined;
		try {
			nativeProbePath = JSON.parse(
				await readFile(join(directory, `launch-materials-${attempt.verificationExecutionAttemptId}.json`), "utf8"),
			).darwinOriginalParentGenerationProbePath;
		} catch {
			/* 未派发。 */
		}
		if (attempt.launchStage !== "terminal")
			await cancelOwnedCommandProcesses(
				{
					workspaceId: attempt.workspaceId,
					executionId: attempt.verificationExecutionAttemptId,
					launchNonce: attempt.verificationExecutionAttemptId,
					previousLaunchNonces: [],
					revocationFile: verificationExecutionAttemptCancellationPath(attempt.verificationExecutionAttemptId),
					specification: { workingDirectory: directory },
				},
				{ artifactDirectory: directory, superviseProcessGroup: true },
			);
		try {
			const owner = JSON.parse(
				await readFile(
					join(directory, `supervisor-identity-${attempt.verificationExecutionAttemptId}.json`),
					"utf8",
				),
			) as OwnedProcessIdentity;
			if (
				hasSameProcessGeneration(
					await readProcessIdentity(
						owner.pid,
						nativeProbePath,
						owner.nativeProcessGenerationIdentity !== undefined,
					),
					owner,
				)
			)
				process.kill(owner.pid, "SIGKILL");
		} catch {
			/* 已退出或尚未派发。 */
		}
	}
}
