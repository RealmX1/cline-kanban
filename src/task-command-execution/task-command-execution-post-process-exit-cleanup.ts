import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type TaskCommandExecutionRecord,
	taskCommandExecutionOwnedProcessesExitConfirmationSchema,
} from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { taskCommandExecutionArtifactDirectory } from "./task-command-execution-store";
import {
	inspectOwnedCommandSupervisor,
	launchOwnedCommandSupervisor,
	readSystemBootIdentity,
} from "./task-command-execution-supervisor";

/** 仅接续已登记的退出后动作；不修改业务命令、业务结果、撤销事实或恢复预算。 */
export async function recoverOwnedCommandPostProcessExitCleanup(
	record: Pick<
		TaskCommandExecutionRecord,
		"workspaceId" | "executionId" | "launchNonce" | "revocationFile" | "launchAttemptCount" | "specification"
	>,
	authorizedDeferredPostProcessExitCleanupCommand?: string[],
): Promise<void> {
	const registeredCleanupCommand = record.specification.postProcessExitCleanupCommand;
	const command = registeredCleanupCommand ?? authorizedDeferredPostProcessExitCleanupCommand;
	if (!command || record.launchAttemptCount === 0 || (await inspectOwnedCommandSupervisor(record)) !== "exited")
		return;
	const directory = taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	let launch: {
		executionId?: string;
		launchNonce?: string;
		materialSha256?: string;
		postProcessExitCleanupCommand?: string[];
	};
	try {
		launch = JSON.parse(await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (
		launch.executionId !== record.executionId ||
		launch.launchNonce !== record.launchNonce ||
		launch.materialSha256 !== record.specification.materialSha256 ||
		JSON.stringify(launch.postProcessExitCleanupCommand) !== JSON.stringify(registeredCleanupCommand)
	)
		throw new Error("退出后清理命令与原生启动材料不匹配");
	const businessProgress = JSON.parse(
		await readFile(join(directory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
	) as { businessDispatchSequenceNumber?: number };
	const businessDispatchSequenceNumber = businessProgress.businessDispatchSequenceNumber;
	if (!businessDispatchSequenceNumber || !Number.isSafeInteger(businessDispatchSequenceNumber)) return;
	const cleanupDirectory = join(
		directory,
		"post-process-exit-cleanup",
		record.launchNonce,
		`dispatch-${businessDispatchSequenceNumber}`,
	);
	const inspection = await inspectOwnedCommandSupervisor(record, { artifactDirectory: cleanupDirectory });
	if (inspection === "running" || inspection === "unknown") return;
	try {
		const progress = JSON.parse(
			await readFile(join(cleanupDirectory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
		) as { status?: string; returncode?: number; timedOut?: boolean };
		if (progress.status === "exited" && progress.returncode === 0 && !progress.timedOut) return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
	}
	const confirmationPath = join(
		directory,
		`post-process-exit-cleanup-confirmation-${record.launchNonce}-dispatch-${businessDispatchSequenceNumber}.json`,
	);
	for (const stream of ["stdout", "stderr"]) {
		const original = await open(join(directory, `command-${record.launchNonce}.${stream}.txt`), "r+");
		try {
			await original.sync();
		} finally {
			await original.close();
		}
	}
	try {
		await readFile(confirmationPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await lockedFileSystem.writeJsonFileAtomic(
			confirmationPath,
			taskCommandExecutionOwnedProcessesExitConfirmationSchema.parse({
				schemaVersion: 1,
				executionId: record.executionId,
				launchNonce: record.launchNonce,
				businessDispatchSequenceNumber,
				materialSha256: record.specification.materialSha256,
				command: record.launchAttemptCount > 1 ? record.specification.resumeCommand : record.specification.command,
				systemBootIdentity: await readSystemBootIdentity(),
				ownedProcessesExited: true,
				originalOutputDurablySaved: true,
				confirmedAtEpochMs: Date.now(),
			}),
			{ durable: true, fileMode: 0o600 },
		);
	}
	await launchOwnedCommandSupervisor(
		{
			...record,
			revocationFile: join(cleanupDirectory, "cleanup-revocation.json"),
			specification: {
				...record.specification,
				command,
				resumeCommand: command,
				supervisorMaintainsSemanticRecovery: false,
				postProcessExitCleanupCommand: undefined,
				producerExecutionRevocationFile: undefined,
			},
		},
		async () => {
			if ((await inspectOwnedCommandSupervisor(record)) !== "exited")
				throw new Error("原命令及子进程的退出证据已变化，保留退出后动作待证");
		},
		{
			artifactDirectory: cleanupDirectory,
			superviseProcessGroup: true,
			environment: { KANBAN_COMMAND_EXECUTION_EXIT_CONFIRMATION_FILE: confirmationPath },
			deadlineAtEpochMs: Date.now() + 300_000,
		},
	);
}
